import * as path from 'path';
import * as readline from 'node:readline/promises';
import { GraphTemplate, softwarePipelineTemplate } from '../../graph/templates';
import { LoopDeps } from '../../loop/engine';
import { buildDeps } from './run-loop';
import type { CliArgs } from '../index';

/** 交互审批：gate 名单 → {gate: bool}；readline 注入便于测试 */
export async function confirmApprovals(
  gates: string[],
  rl: { question(q: string): Promise<string> },
): Promise<Record<string, boolean>> {
  const approvals: Record<string, boolean> = {};
  for (const g of gates) {
    const ans = (await rl.question(`[审批] ${g} 批准交付？(y/N) `)).trim().toLowerCase();
    approvals[g] = ans === 'y' || ans === 'yes';
  }
  return approvals;
}

/** 流水线装配（独立导出供离线测试）：goal 须含「验收标准：id=描述」段 */
export function runPipelineAssembly(
  deps: LoopDeps,
  opts: { goal: string; ruleCheckers?: Record<string, (io: { ctx: unknown; goal: string }) => Promise<boolean> | boolean> },
): GraphTemplate {
  return softwarePipelineTemplate(deps, {
    goal: opts.goal,
    ruleCheckers: opts.ruleCheckers as never,
    maxSteps: 8,
    termination: { maxTokens: 200_000, timeoutMs: 600_000 },
  });
}

export async function runPipeline(args: CliArgs): Promise<void> {
  const dir = args.positional[0];
  if (!dir) throw new Error('用法：sunshinex pipeline <dir> --goal="目标（验收标准：id=描述）" [--yes]');
  const root = path.resolve(dir);
  const goal = String(args.flags.goal ?? '');
  if (!goal) throw new Error('缺少 --goal="目标（验收标准：id=描述）"——check 依赖结构化验收清单');
  const deps = buildDeps(root, args.flags);
  const tpl = runPipelineAssembly(deps, { goal });

  console.log(`[pipeline] root=${root} nodes=${tpl.nodes.map((n) => n.id).join('→')}`);
  const r1 = await tpl.engine.run(goal);
  console.log(`run   : ${r1.status} tokens=${r1.tokensUsed} pendingGates=[${r1.pendingGates}]`);

  if (r1.status === 'paused') {
    const approvals = args.flags.yes
      ? Object.fromEntries(r1.pendingGates.map((g) => [g, true]))
      : await confirmApprovals(r1.pendingGates, readline.createInterface({ input: process.stdin, output: process.stdout }));
    const r2 = await tpl.engine.resume(approvals);
    console.log(`resume: ${r2.status} tokens=${r2.tokensUsed} failedNodes=[${r2.failedNodes}]`);
    if (r2.status !== 'done') process.exitCode = 1;
    return;
  }
  if (r1.status !== 'done') process.exitCode = 1;
}
