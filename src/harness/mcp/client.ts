import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolRegistry, CodedToolError, RegisteredTool } from '../tools';
import { ExecResult, McpServerConfig, ToolCategory, ToolInput } from '../../types';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_ARGS_BYTES = 64 * 1024;

export interface McpHostOptions {
  /** 单次 tools/call 超时（缺省 30s；测试注入短超时用） */
  callTimeoutMs?: number;
}

interface McpConn {
  client: Client;
  config: McpServerConfig;
}

function textOf(content: unknown): string {
  const parts = Array.isArray(content) ? content : [];
  return parts
    .map((c) => (typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
    .filter((t) => t.length > 0)
    .join('\n');
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
 * MCP 宿主：官方 SDK stdio 接缝（依赖收敛于本文件，替换客户端实现不动主链）。
 * 注册链 = 懒 spawn → 握手身份校验（配置名 ≠ serverInfo.name 即拒，防冒名绕过 guard 登记制）
 * → tools/list → 以 mcp__<server>__<tool> 规范名注册（category external，闸门在 guard）。
 */
export class McpHost {
  private conns = new Map<string, McpConn>();

  constructor(
    private servers: McpServerConfig[],
    private registry: ToolRegistry,
    private opts: McpHostOptions = {},
  ) {}

  /** 逐服务器连接并注册工具，返回注册数；任一环节失败即抛（装配期 fail-fast，禁静默缺漏） */
  async registerTools(): Promise<number> {
    let count = 0;
    for (const cfg of this.servers) {
      if (this.conns.has(cfg.name)) throw new CodedToolError('MCP_DUP_SERVER', `MCP 服务器名重复：${cfg.name}`);
      const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [] });
      const client = new Client({ name: 'sunshinex-mcp-host', version: '0.1.0' });
      try {
        await client.connect(transport);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new CodedToolError('MCP_CONNECT_FAILED', `MCP 服务器连接失败（${cfg.name}）：${msg.slice(0, 120)}`);
      }
      const actual = client.getServerVersion()?.name;
      if (actual !== cfg.name) {
        await client.close().catch(() => {});
        throw new CodedToolError('MCP_SERVER_MISMATCH', `握手身份与配置不符（${cfg.name}）：实际 serverInfo.name=${actual ?? '(未知)'}`);
      }
      this.conns.set(cfg.name, { client, config: cfg });
      const listed = await client.listTools();
      for (const t of listed.tools) {
        this.registry.register(this.makeTool(cfg.name, client, t.name, t.description));
        count += 1;
      }
    }
    return count;
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
      description: description ?? `MCP 工具 ${toolName}（服务器 ${server}）`,
      category: 'external' as ToolCategory,
      executor: async (input: ToolInput): Promise<ExecResult> => {
        const args = input ?? {};
        if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGS_BYTES) {
          throw new CodedToolError('MCP_ARGS_TOO_LARGE', `MCP 调用参数超限（>${MAX_ARGS_BYTES} 字节）：${fqName}`);
        }
        const res = await withTimeout(
          client.callTool({ name: toolName, arguments: args }),
          timeoutMs,
          'MCP_TIMEOUT',
          `MCP 调用超时（${timeoutMs}ms）：${fqName}`,
        );
        const text = textOf(res.content);
        if (res.isError) throw new CodedToolError('MCP_TOOL_ERROR', text || `MCP 工具返回错误：${fqName}`);
        return { exitCode: 0, stdout: text, stderr: '', timedOut: false };
      },
    };
  }
}
