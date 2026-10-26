import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools';
import { dispatchTool } from './dispatch';
import { createWorker } from './worker';
import type { WorkerClient } from './types';

/** computer-use MCP server（stdio）：协议+安全元数据面；执行器为注入的 worker（spec §5.1）。 */
export const SERVER_INFO = { name: 'sunshinex-computer-use', version: '0.1.0' } as const;

/** stdio server 装配（worker 依赖注入——测试可传 fake）。
 *  工具清单随 TOOLS 原样下发；CallToolRequest 单点分流到 dispatchTool。 */
export function createServer(worker: WorkerClient): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as Tool[] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return dispatchTool(worker, name, (args ?? {}) as Record<string, unknown>);
  });
  return server;
}

/** stdio 入口：生产 worker 在此 lazy 创建（Task 18 评审随手修——模块顶层即拉真进程会让任何 import 本模块
 *  的面（含测试收集）都 spawn PowerShell；挪进 main() 后 import 零副作用，真进程只随真启动起）。
 *  持久 PowerShell 子进程（createWorker，Task 18）协议面已通；worker 生命周期随本进程收口
 *  （宿主关管道 → process.exit → worker stdin EOF → PS 主循环退出，无孤儿进程）。 */
async function main(): Promise<void> {
  const worker: WorkerClient = createWorker();
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
