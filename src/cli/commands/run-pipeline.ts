import * as path from 'path';
import * as readline from 'node:readline/promises';
import { GraphTemplate, softwarePipelineTemplate } from '../../graph/templates';
import { LoopDeps } from '../../loop/engine';
import { buildDeps } from '../../runtime';
import { resolveDirArg } from '../index';
import { t } from '../../i18n';
import type { GraphRunResult } from '../../types';
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

/** 失败诊断透出：逐节点打印失败原因（reply 承载引擎捕获的异常消息），消除「failed tokens=0」式排障盲区 */
function printFailures(r: GraphRunResult): void {
  for (const id of r.failedNodes) {
    const reason = r.results?.[id]?.reply ?? '（无错误输出）';
    console.error(`[failed-node] ${id}: ${reason}`);
  }
}

/** 流水线装配（独立导出供离线测试）：goal 须含「验收标准：id=描述」段 */
export function runPipelineAssembly(
  deps: LoopDeps,
  opts: { goal: string; ruleCheckers?: Record<string, (io: { ctx: unknown; goal: string }) => Promise<boolean> | boolean> },
): GraphTemplate {
  return softwarePipelineTemplate(deps, {
    goal: opts.goal,
    ruleCheckers: opts.ruleCheckers as never,
  });
}

export async function runPipeline(args: CliArgs): Promise<void> {
  // 目录来源统一单点（规格 §6.2）：与顶层及 run 同判据——--workdir 优先，裸词报「无法识别命令」不启动
  const d = resolveDirArg(args);
  if (d.unrecognized) {
    console.error(t('Unrecognized command. Run sunshinex help for usage.', '无法识别命令，使用 sunshinex help 查看使用方法'));
    process.exitCode = 1;
    return;
  }
  if (d.ignored) console.warn(t(`--workdir takes precedence; ignoring positional dir ${d.ignored}`, `--workdir 优先，位置参数目录 ${d.ignored} 已忽略`));
  const dir = d.dir;
  if (!dir) throw new Error('用法：sunshinex pipeline <dir> --goal="目标（验收标准：id=描述）" [--yes]');
  const root = path.resolve(dir);
  const goal = String(args.flags.goal ?? '');
  if (!goal) throw new Error('缺少 --goal="目标（验收标准：id=描述）"——check 依赖结构化验收清单');
  const deps = buildDeps(root, args.flags);
  const tpl = runPipelineAssembly(deps, { goal });

  console.log(`[pipeline] root=${root} nodes=${tpl.nodes.map((n) => n.id).join('→')}`);
  // fork 模型（CLAUDE.md §11）：goal 槽取消，任务指令以链行承载（单发 pipeline 空链起，行为对外不变）
  deps.context.appendInstructionLine(goal);
  const r1 = await tpl.engine.run(goal);
  console.log(`run   : ${r1.status} tokens=${r1.tokensUsed} pendingGates=[${r1.pendingGates}]`);
  printFailures(r1);

  if (r1.status === 'paused') {
    const approvals = args.flags.yes
      ? Object.fromEntries(r1.pendingGates.map((g) => [g, true]))
      : await confirmApprovals(r1.pendingGates, readline.createInterface({ input: process.stdin, output: process.stdout }));
    const r2 = await tpl.engine.resume(approvals);
    console.log(`resume: ${r2.status} tokens=${r2.tokensUsed} failedNodes=[${r2.failedNodes}]`);
    printFailures(r2);
    // 收尾消化后台沉淀队列（规格 §3.5）：暂停续走分支同样在命令结束前清空
    if (deps.pipeline) await deps.pipeline.drain();
    // MCP 降级警告上屏：服务器失败只损失该服务器工具，警告不吞
    for (const w of (deps.mcpWarnings?.() ?? [])) console.warn('mcp warn:', w);
    // MCP 连接收口：关闭 stdio 子进程，防悬挂事件循环
    if (deps.mcpClose) await deps.mcpClose();
    if (r2.status !== 'done') process.exitCode = 1;
    return;
  }
  if (r1.status !== 'done') process.exitCode = 1;
  // 收尾消化后台沉淀队列（规格 §3.5）：此时用户本就在等命令结束，不构成新增阻塞
  if (deps.pipeline) await deps.pipeline.drain();
  // MCP 降级警告上屏：服务器失败只损失该服务器工具，警告不吞
  for (const w of (deps.mcpWarnings?.() ?? [])) console.warn('mcp warn:', w);
  // MCP 连接收口：关闭 stdio 子进程，防悬挂事件循环
  if (deps.mcpClose) await deps.mcpClose();
}
