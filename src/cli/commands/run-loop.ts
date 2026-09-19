import * as path from 'path';
import { DEFAULT_GOAL_TEMPLATE, resolveTemplate } from '../../loop/templates';
import { buildDeps } from '../../runtime';
import type { CliArgs } from '../index';

/** 模板工厂上移 loop 层（规格 D4）；再导出保既有导入点（run-loop.test.ts）不变 */
export { resolveTemplate };

export async function runLoop(args: CliArgs): Promise<void> {
  const dir = args.positional[0];
  if (!dir) throw new Error('用法：sunshinex run <dir> --goal="一句可度量的目标终态（复杂目标可内嵌：验收标准：id=描述）"');
  const root = path.resolve(dir);
  const goal = String(args.flags.goal ?? '');
  if (!goal) throw new Error('缺少 --goal="目标（验收标准：id=描述）"');
  // 模板为内部装配机制（规格 2026-09-16-goal-template D4）：CLI 用户面恒走标准环，--template 不再是用户参数
  const deps = buildDeps(root, args.flags);
  const tpl = resolveTemplate(deps, DEFAULT_GOAL_TEMPLATE);
  console.log(`[run] root=${root}`);
  // fork 模型（CLAUDE.md §11）：goal 槽取消，任务指令以链行承载（单发 run 空链起，行为对外不变）
  deps.context.appendInstructionLine(goal);
  const r = await tpl.engine.run(goal);
  console.log(JSON.stringify({ status: r.status, iterations: r.iterations, tokensUsed: r.tokensUsed, criteria: r.criteria, reply: r.reply, error: r.error }, null, 2));
  // 收尾消化后台沉淀队列（规格 §3.5）：此时用户本就在等命令结束，不构成新增阻塞
  if (deps.pipeline) await deps.pipeline.drain();
  if (r.status !== 'done') process.exitCode = 1;
}
