import * as path from 'path';
import { DEFAULT_GOAL_TEMPLATE, resolveTemplate } from '../../loop/templates';
import { buildDeps } from '../../runtime';
import { resolveWorktreeLaunchRoot } from '../worktree-launch';
import { resolveDirArg } from '../index';
import { t } from '../../i18n';
import type { CliArgs } from '../index';

/** 模板工厂上移 loop 层（规格 D4）；再导出保既有导入点（run-loop.test.ts）不变 */
export { resolveTemplate };

export async function runLoop(args: CliArgs): Promise<void> {
  // 目录来源统一单点（规格 §6.2）：--workdir 优先于位置路径，裸词报「无法识别命令」不启动
  const d = resolveDirArg(args);
  if (d.unrecognized) {
    console.error(t('Unrecognized command. Run sunshinex help for usage.', '无法识别命令，使用 sunshinex help 查看使用方法'));
    process.exitCode = 1;
    return;
  }
  if (d.ignored) console.warn(t(`--workdir takes precedence; ignoring positional dir ${d.ignored}`, `--workdir 优先，位置参数目录 ${d.ignored} 已忽略`));
  const dir = d.dir;
  if (!dir) throw new Error('用法：sunshinex run <dir> --goal="一句可度量的目标终态（复杂目标可内嵌：验收标准：id=描述）"');
  const root = path.resolve(dir);
  // 入口一（规格 §7/D5）：--worktree 装配前解析，root 替换为 worktree 路径后走既有装配链（fail-fast 于建树失败）
  const launchRoot = resolveWorktreeLaunchRoot(args, root);
  const goal = String(args.flags.goal ?? '');
  if (!goal) throw new Error('缺少 --goal="目标（验收标准：id=描述）"');
  // 模板为内部装配机制（规格 2026-09-16-goal-template D4）：CLI 用户面恒走标准环，--template 不再是用户参数
  // root 替换（规格 D5）：--worktree 装配前建树后，既有装配链以树路径整体继承（banner/事实行/沙箱 cwd 全链路同源）
  const deps = buildDeps(launchRoot, args.flags);
  const tpl = resolveTemplate(deps, DEFAULT_GOAL_TEMPLATE);
  console.log(`[run] root=${launchRoot}`);
  // fork 模型（CLAUDE.md §11）：goal 槽取消，任务指令以链行承载（单发 run 空链起，行为对外不变）
  deps.context.appendInstructionLine(goal);
  const r = await tpl.engine.run(goal);
  console.log(JSON.stringify({ status: r.status, iterations: r.iterations, tokensUsed: r.tokensUsed, criteria: r.criteria, reply: r.reply, error: r.error }, null, 2));
  // 收尾消化后台沉淀队列（规格 §3.5）：此时用户本就在等命令结束，不构成新增阻塞
  if (deps.pipeline) await deps.pipeline.drain();
  if (r.status !== 'done') process.exitCode = 1;
}
