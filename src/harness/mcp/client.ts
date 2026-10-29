import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolRegistry, CodedToolError, RegisteredTool } from '../tools';
import { ExecResult, JsonSchema, McpServerConfig, ToolCategory, ToolInput } from '../../types';
import { MAX_IMAGES } from '../../images';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_ARGS_BYTES = 64 * 1024;

interface McpHostOptions {
  /** 单次 tools/call 超时（缺省 30s；测试注入短超时用） */
  callTimeoutMs?: number;
}

interface McpConn {
  client: Client;
  /** 原始传输句柄：close 时取 stdio 子进程 pid（SDK close 内部先置空 _process，之后 pid getter 恒 null——须留存引用） */
  transport: Transport;
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

/**
 * 终结 stdio 子进程树（Task 28 bug 修复）。机理：MCP SDK 的 client.close() 在 Windows 上只 kill 直接
 * 子进程（Node kill() = TerminateProcess 单进程语义），而插件 server 常再拉孙进程（computer-use 的
 * 持久 PowerShell worker 等）——孙进程手里的 stdio 管道句柄挂住父进程事件循环，CLI 进程永不退出
 * （实测：.sunshinex/settings.json 启用 browser-use/computer-use 插件后 selfcheck 60s+ 悬挂，
 * 禁用插件 10s 干净退出）。故 SDK close 之后按 pid 树终结兜底：Windows 走 taskkill /T /F（树杀，
 * 覆盖孙进程），POSIX 走 SIGTERM（stdin 关闭语义下服务器通常自行退出，此处兜底防残留）。
 * 失败（进程已亡 ESRCH / taskkill 不在等）静默——树终结是兜底而非主路径，与 close 路径
 * 「单点失败不阻塞其余关闭」口径一致。taskkill 子孙 fire-and-forget + unref：避免杀树工具自己
 * 反过来挂住事件循环（自指悬挂）。
 */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      tk.on('error', () => {}); // 吞 spawn 失败的 error 事件（防 unhandled 'error' 崩进程）
      tk.unref(); // 不持事件循环引用：父进程先于 taskkill 退出也不影响杀树（OS 层完成）
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // 静默：pid 已失效（ESRCH）等，兜底路径不计失败
  }
}

/** 捕获 stdio 传输的子进程 pid：SDK StdioClientTransport 暴露 pid getter（启动后可得）；非 stdio 传输
 *  或未启动时无 pid 形态（null/undefined），静默跳过树终结。须在 client.close() 之前调用——SDK close()
 *  内部先把 _process 置空再 kill，之后 pid getter 恒为 null（再读即漏杀）。 */
function pidOf(transport: Transport): number | null {
  const t = transport as { pid?: unknown };
  return typeof t.pid === 'number' && Number.isFinite(t.pid) ? t.pid : null;
}

/** MCP tools/list 的 inputSchema → 主仓 JsonSchema（松散结构透传，2026-10-26 browser-use 装配联调裁定）：
 *  无 schema 注册会让模型面对无参工具——真机探活实测（Playwright MCP）参数化调用（browser_navigate {url} 等）
 *  全部以「expected string, received undefined」败退、仅零参调用可达；直击 executor 复现已排除传输面
 *  （args 原样到 server），根因即模型侧拿不到参数契约。形状非对象时丢弃（宁少配不可错配——无 schema
 *  工具仍注册可用，只是模型面参数降级为自由文本）。 */
function toToolSpecParameters(input: unknown): JsonSchema | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  return input as JsonSchema;
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
        // 防御性双闸（生产单点在 harness/index.ts 装配期 filter）：此处只服务测试直构 McpHost 的路径，
        // 生产行为不依赖本分支——enabled 语义的裁决与「软提示」文案演进以装配期为准
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
          const halfOpenPid = pidOf(transport);
          await client.close().catch(() => {});
          // 半开 stdio 子进程同样挂事件循环（握手超时但子进程已 spawn 的现场）——同 close 路径树终结
          if (halfOpenPid !== null) killProcessTree(halfOpenPid);
          const msg = e instanceof Error ? e.message : String(e);
          report.warnings.push(`connection failed (${cfg.name}): ${msg.slice(0, 120)}`);
          continue;
        }
        const actual = client.getServerVersion()?.name;
        if (actual !== cfg.name) {
          // 身份软提示（不再跳过）：照常 listTools+注册，差异上屏供诊断
          report.warnings.push(`identity note (${cfg.name}): serverInfo.name=${actual ?? '(unknown)'} (accepted)`);
        }
        this.conns.set(cfg.name, { client, transport, config: cfg });
        const listed = await client.listTools();
        const disabled = new Set(cfg.disabledTools ?? []);
        for (const t of listed.tools) {
          if (disabled.has(t.name)) continue; // 逐工具停用（短名过滤）：装配期不注册即模型不可见
          this.registry.register(this.makeTool(cfg.name, client, t.name, { description: t.description, inputSchema: t.inputSchema }));
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
    for (const { client, transport } of this.conns.values()) {
      // pid 须在 client.close() 之前捕获：SDK close() 内部先置空 _process 再 kill，之后 pid getter 恒 null
      const pid = pidOf(transport);
      await client.close().catch(() => {}); // 退出路径的连接清理：单点失败不阻塞其余关闭
      // Windows 下 SDK close 不终结 stdio 子进程树（孙进程残留 → 管道句柄挂住事件循环，进程永不退出
      // ——Task 28 bug），按 pid 树终结兜底；pid 不可得（http/sse 或未 spawn）静默跳过
      if (pid !== null) killProcessTree(pid);
    }
    this.conns.clear();
  }

  /** 单工具注册面：执行器做参数体积闸门与超时收束，安全闸门（登记制/模式豁免）统一在 guard */
  private makeTool(server: string, client: Client, toolName: string, tool?: { description?: string; inputSchema?: unknown }): RegisteredTool {
    const fqName = `mcp__${server}__${toolName}`;
    const timeoutMs = this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const parameters = toToolSpecParameters(tool?.inputSchema);
    return {
      name: fqName,
      description: tool?.description ?? `MCP tool ${toolName} (server ${server})`,
      ...(parameters !== undefined ? { parameters } : {}),
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
