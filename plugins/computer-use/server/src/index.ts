import * as http from 'node:http';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools';
import { dispatchTool, newShotSession, setScreenshotDir, type ShotSession } from './dispatch';
import { createWorker } from './worker';
import type { WorkerClient } from './types';

/** computer-use MCP server（stdio）：协议+安全元数据面；执行器为注入的 worker（spec §5.1）。 */
export const SERVER_INFO = { name: 'sunshinex-computer-use', version: '0.1.0' } as const;

/** stdio server 装配（worker 依赖注入——测试可传 fake）。
 *  工具清单随 TOOLS 原样下发；CallToolRequest 单点分流到 dispatchTool。
 *  session 缺省=进程缺省会话态(stdio 单会话);HTTP 宿主每条连接传自己的会话态 */
export function createServer(worker: WorkerClient, session?: ShotSession): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as Tool[] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return dispatchTool(worker, name, (args ?? {}) as Record<string, unknown>, session);
  });
  return server;
}

/** HTTP 宿主(2026-11-03 单进程多会话):每个进程(daemon/CLI)一个,全部会话各连一条 MCP 连接。
 *  桌面与 PowerShell worker 全局共享(worker 按请求 id 配对,并发安全);每条连接一份会话态——
 *  最近截图坐标系(动作坐标按「本会话最近一次截图」反算)+ 截图落盘目录
 *  <dataDir>/plugins/computer-use/screenshots/<key>/(查询参数 key=会话键、dataDir=项目数据目录)。
 *  仅绑 127.0.0.1,Authorization: Bearer <token> 鉴权 */
export function startHttpServer(worker: WorkerClient, token: string): Promise<{ port: number; close: () => Promise<void> }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      req.on('end', () => {
        try { resolve(raw === '' ? undefined : JSON.parse(raw)); } catch { resolve(undefined); }
      });
    });
  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        if (token !== '' && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const sid = req.headers['mcp-session-id'];
        let t = typeof sid === 'string' ? transports.get(sid) : undefined;
        if (t === undefined) {
          if (req.method !== 'POST' || (body as { method?: unknown } | undefined)?.method !== 'initialize') {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'unknown or missing MCP session' }, id: null }));
            return;
          }
          const key = url.searchParams.get('key') || `anon-${randomUUID().slice(0, 8)}`;
          const dataDir = url.searchParams.get('dataDir') ?? '';
          const session = newShotSession(dataDir !== '' ? path.join(dataDir, 'plugins', 'computer-use', 'screenshots', key) : null);
          const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => { transports.set(id, transport); },
          });
          transport.onclose = () => {
            if (transport.sessionId !== undefined) transports.delete(transport.sessionId);
          };
          await createServer(worker, session).connect(transport);
          t = transport;
        }
        await t.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: e instanceof Error ? e.message : String(e) }, id: null }));
        }
      }
    })();
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      resolve({
        port: typeof addr === 'object' && addr !== null ? addr.port : 0,
        close: async () => {
          for (const t of transports.values()) await t.close().catch(() => {});
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}

/** 入口：生产 worker 在此 lazy 创建（Task 18 评审随手修——模块顶层即拉真进程会让任何 import 本模块
 *  的面（含测试收集）都 spawn PowerShell；挪进 main() 后 import 零副作用，真进程只随真启动起）。
 *  --http:HTTP 宿主形态(stdout 首行 {"port":N});缺省 stdio 单会话(--output-dir 指截图目录)。
 *  两种形态的生命周期都随父进程管道:stdin EOF → 退出 → worker stdin EOF → PS 主循环退出,无孤儿 */
async function main(): Promise<void> {
  const worker: WorkerClient = createWorker();
  const argOf = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  if (process.argv.includes('--http')) {
    const { port } = await startHttpServer(worker, argOf('--token') ?? '');
    process.stdout.write(JSON.stringify({ port }) + '\n');
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
    return;
  }
  const outputDir = argOf('--output-dir');
  if (outputDir !== undefined) setScreenshotDir(outputDir);
  const server = createServer(worker);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.on('end', () => {
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
