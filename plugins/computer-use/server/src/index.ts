import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools';
import { dispatchTool } from './dispatch';
import type { WorkerClient } from './types';

/** computer-use MCP server（stdio）：协议+安全元数据面；执行器为注入的 worker（spec §5.1）。 */
export const SERVER_INFO = { name: 'sunshinex-computer-use', version: '0.1.0' } as const;

/** stdio server 装配（worker 依赖注入——测试可传 fake，生产面 Task 18 换 createWorker() 产物）。
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

/** 生产 worker 占位（Task 18 落 createWorker() 后替换）：本任务协议冒烟只走清单/占位回执面，不触 worker。 */
const placeholderWorker: WorkerClient = {
  async op() {
    throw new Error('not implemented: worker protocol lands in task 18');
  },
  async close() {},
};

/** stdio 入口：connect 后挂 stdin EOF 兜底——宿主收口（关管道）即干净退出（Windows 管道悬挂防残留）。 */
async function main(): Promise<void> {
  const server = createServer(placeholderWorker);
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
