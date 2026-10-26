import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WorkerClient } from './types';
import { TOOLS } from './tools';

/** 工具分发单点：CallToolRequest → 执行 → MCP CallToolResult。
 *
 *  Task 17 骨架态：工具清单/协议面全通，但执行落 Task 18（worker 协议）与 Task 19/20（观察/动作落地）——
 *  本任务对全部已登记工具返回统一模式占位回执 `not implemented: <name>`，不触 worker（参数整形、
 *  toPhysical 反算、lastMeta 记账随 Task 19/20 在此充实；fake worker 测试面也是本函数）。 */
export async function dispatchTool(worker: WorkerClient, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  void worker;
  void args;
  if (!TOOLS.some((t) => t.name === name)) {
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  }
  return { content: [{ type: 'text', text: `not implemented: ${name}` }] };
}
