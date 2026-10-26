import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolRegistry, CodedToolError, RegisteredTool } from '../tools';
import { ExecResult, McpServerConfig, ToolCategory, ToolInput } from '../../types';
import { MAX_IMAGES } from '../../images';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_ARGS_BYTES = 64 * 1024;

interface McpHostOptions {
  /** 单次 tools/call 超时（缺省 30s；测试注入短超时用） */
  callTimeoutMs?: number;
}

interface McpConn {
  client: Client;
  config: McpServerConfig;
}

/** MCP 结果内容提取：text 块 join + image 块收 dataURL（MCP 规范原生支持；此前 textOf 丢图） */
export function contentOf(content: unknown): { text: string; images?: string[] } {
  const parts = Array.isArray(content) ? content : [];
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of parts) {
    if (typeof c !== 'object' || c === null) continue;
    const o = (c as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown });
    if (o.type === 'text') texts.push(String(o.text ?? ''));
    else if (o.type === 'image' && typeof o.data === 'string' && typeof o.mimeType === 'string' && images.length < MAX_IMAGES) {
      images.push(`data:${o.mimeType};base64,${o.data}`);
    }
  }
  const text = texts.filter((t) => t.length > 0).join('\n');
  return { text, ...(images.length > 0 ? { images } : {}) };
}

/** CallToolResult → ExecResult 结果映射单点：isError 抛 CodedToolError 保失败语义（BatchRunner 据错误码置 failed/分桶），
 *  images 随错误对象随行不丢（错误亦可带图）；成功态 text/images 收进 ExecResult。抽导出即测：makeTool 私有 executor 的映射逻辑钉点 */
export function execResultFromMcp(fqName: string, res: unknown): ExecResult {
  const r = (res ?? {}) as { content?: unknown; isError?: unknown };
  const { text, images } = contentOf(r.content);
  if (r.isError === true) {
    throw new CodedToolError('MCP_TOOL_ERROR', text || `MCP tool returned an error: ${fqName}`, images);
  }
  return { exitCode: 0, stdout: text, stderr: '', timedOut: false, ...(images !== undefined ? { images } : {}) };
}

/** 超时收束：竞速拒绝转 CodedToolError，计时器必清 */
function withTimeout<T>(p: Promise<T>, ms: number, code: string, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CodedToolError(code, message)), ms);
  });
  return Promise.race([p, gate]).finally(() => clearTimeout(timer));
}

/**
 * MCP 宿主：官方 SDK 传输接缝（stdio / streamable http / sse 三分支收敛于本文件，替换客户端实现不动主链）。
 * 注册链 = 懒 spawn → 握手身份校验（配置名 ≠ serverInfo.name 即拒，防冒名绕过 guard 登记制）
 * → tools/list → 以 mcp__<server>__<tool> 规范名注册（category external，闸门在 guard）。
 */
/** 逐服务器装配结果：注册数与警告单（降级语义——服务器失败只损失该服务器工具，警告上屏后继续装配） */
interface McpAssemblyReport {
  registered: number;
  /** 逐服务器失败警告（连接/握手/拉取/重名），按配置顺序收集 */
  warnings: string[];
}

/**
 * stdio 子进程环境（债 D21）：显式传 env 才能覆盖 SDK 缺省的「安全子集继承」——
 * 宿主环境整份继承再叠加 cfg.env 专属覆盖（对齐主流 MCP 客户端：API key 一类服务器配置零丢失）；
 * process.env 值域含 undefined（可unset），须剔除后才能满足传输参数的 Record<string,string> 形态。
 */
function mergedChildEnv(cfg: McpServerConfig): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v;
  }
  return { ...merged, ...(cfg.env ?? {}) };
}

export class McpHost {
  private conns = new Map<string, McpConn>();

  constructor(
    private servers: McpServerConfig[],
    private registry: ToolRegistry,
    private opts: McpHostOptions = {},
  ) {}

  /** 传输工厂：stdio/http/sse 三分支收敛一处；形态字段缺失或 url 非法均装配期 fail-fast（与连接失败同码 MCP_CONNECT_FAILED，失败语义不分传输）。
   *  2026-10-26：cfg.headers 随 http/sse 请求透传（requestInit.headers——Bearer 鉴权面，gitnexus
   *  风格 `{url, headers}` 主流形态）；SDK 对 SSE 的 GET 流同样吃 requestInit 头 */
  private makeTransport(cfg: McpServerConfig): Transport {
    const fail = (msg: string): CodedToolError =>
      new CodedToolError('MCP_CONNECT_FAILED', `MCP server connection failed (${cfg.name}): ${msg}`);
    switch (cfg.transport ?? 'stdio') {
      case 'http':
      case 'sse': {
        if (!cfg.url) throw fail(`${cfg.transport} transport requires a url`);
        try {
          const url = new URL(cfg.url);
          const reqInit = cfg.headers !== undefined ? { requestInit: { headers: cfg.headers } } : undefined;
          return cfg.transport === 'sse'
            ? new SSEClientTransport(url, reqInit)
            : new StreamableHTTPClientTransport(url, reqInit);
        } catch (e) {
          throw fail(`Invalid url: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      case 'stdio':
      default:
        if (!cfg.command) throw fail('stdio transport requires a command');
        // cwd 仅插件贡献 server 携带（合成期已解析为绝对路径）；SDK 1.30 StdioServerParameters 原生支持，缺省不落键保持既有 spawn 语义
        return new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: mergedChildEnv(cfg),
          ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
        });
    }
  }

  /** 逐服务器连接并注册工具：单台失败只损失该服务器工具（降级语义），失败收进警告单返回、不中断其余服务器装配。
   *  2026-10-26 两处放宽（用户实测主流服务器被拦）：①enabled=false 整机跳过（不连接不注册，软提示）；
   *  ②握手身份不符不再硬拒——serverInfo.name 与配置键不同是主流服务器的常态（lark-project-mcp 等），
   *  主流客户端均不做此校验，改为软提示照常注册（guard 名单按配置键，冒名面本就由登记制承载） */
  async registerTools(): Promise<McpAssemblyReport> {
    const report: McpAssemblyReport = { registered: 0, warnings: [] };
    for (const cfg of this.servers) {
      if (this.conns.has(cfg.name)) {
        report.warnings.push(`duplicate MCP server name (${cfg.name}) skipped`);
        continue;
      }
      if (cfg.enabled === false) {
        report.warnings.push(`server disabled (${cfg.name}): enabled=false, skipped`);
        continue;
      }
      try {
        const transport = this.makeTransport(cfg);
        const client = new Client({ name: 'sunshinex-mcp-host', version: '0.1.0' });
        try {
          await client.connect(transport);
        } catch (e) {
          // 失败路径须显式关闭半开传输：SSE 的 EventSource 重连循环会残留 Socket 句柄，挂住测试进程不退出
          await client.close().catch(() => {});
          const msg = e instanceof Error ? e.message : String(e);
          report.warnings.push(`connection failed (${cfg.name}): ${msg.slice(0, 120)}`);
          continue;
        }
        const actual = client.getServerVersion()?.name;
        if (actual !== cfg.name) {
          // 身份软提示（不再跳过）：照常 listTools+注册，差异上屏供诊断
          report.warnings.push(`identity note (${cfg.name}): serverInfo.name=${actual ?? '(unknown)'} (accepted)`);
        }
        this.conns.set(cfg.name, { client, config: cfg });
        const listed = await client.listTools();
        const disabled = new Set(cfg.disabledTools ?? []);
        for (const t of listed.tools) {
          if (disabled.has(t.name)) continue; // 逐工具停用（短名过滤）：装配期不注册即模型不可见
          this.registry.register(this.makeTool(cfg.name, client, t.name, t.description));
          report.registered += 1;
        }
      } catch (e) {
        // 形态守卫/清单拉取等残余失败同样只损失本服务器（降级语义），收警告继续
        const msg = e instanceof Error ? e.message : String(e);
        report.warnings.push(`assembly failed (${cfg.name}): ${msg.slice(0, 120)}`);
      }
    }
    return report;
  }

  async close(): Promise<void> {
    for (const { client } of this.conns.values()) {
      await client.close().catch(() => {}); // 退出路径的连接清理：单点失败不阻塞其余关闭
    }
    this.conns.clear();
  }

  /** 单工具注册面：执行器做参数体积闸门与超时收束，安全闸门（登记制/模式豁免）统一在 guard */
  private makeTool(server: string, client: Client, toolName: string, description?: string): RegisteredTool {
    const fqName = `mcp__${server}__${toolName}`;
    const timeoutMs = this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    return {
      name: fqName,
      description: description ?? `MCP tool ${toolName} (server ${server})`,
      category: 'external' as ToolCategory,
      executor: async (input: ToolInput): Promise<ExecResult> => {
        const args = input ?? {};
        if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGS_BYTES) {
          throw new CodedToolError('MCP_ARGS_TOO_LARGE', `MCP args too large (>${MAX_ARGS_BYTES} bytes): ${fqName}`);
        }
        const res = await withTimeout(
          client.callTool({ name: toolName, arguments: args }),
          timeoutMs,
          'MCP_TIMEOUT',
          `MCP call timed out (${timeoutMs}ms): ${fqName}`,
        );
        return execResultFromMcp(fqName, res);
      },
    };
  }
}
