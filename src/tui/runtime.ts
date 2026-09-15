import { Harness } from '../harness';
import { LoopDeps } from '../loop/engine';
import { longTaskTemplate } from '../loop/templates';
import { ModelAdapter } from '../model/adapter';
import { ApprovalDecision, ApprovalRequest, HistoryStep, ModelTier, RunOutcome, SessionEvent } from '../types';

export interface TuiRuntimeOpts {
  root: string;
  model?: ModelAdapter;
  /** 事件流旁路注入：TUI 渲染层经 SessionController 消费；缺省零副作用 */
  onEvent?: (e: SessionEvent) => void;
  /** 权限模式（缺省 dontAsk）；manual 时配合 onApproval 走终端化审批 */
  mode?: 'dontAsk' | 'manual' | 'plan';
  /** 用户级模型档位（run 级常量，对标 Claude Code 的模型选择）：/model 会话内切换经 runTask 逐次覆盖 */
  tier?: ModelTier;
  /** manual 模式审批回调（guard asker 装配点）；会话结束由调用方 clearSessionAllows */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

/** `RunOutcome` 按全局约束登记在 `src/types.ts`（跨模块共享）；此处按原路径再导出，既有 `./runtime` 导入点无需改动 */
export type { RunOutcome };

export interface TuiRuntime {
  harness: Harness;
  /** scope 线程：session=主链（缺省）；fork=私有执行（零主链回写）——/init 与规划轮 fork 隔离用 */
  runTask(goal: string, opts?: { maxSteps?: number; seedHistory?: HistoryStep[]; tier?: ModelTier; scope?: 'session' | 'fork' }): Promise<RunOutcome>;
}

/** TUI 运行时接缝：同进程装配 Harness（数据底座全局数据目录天然同源）；GUI 阶段如需隔离可换 daemon 实现同契约 */
export function createRuntime(opts: TuiRuntimeOpts): TuiRuntime {
  const harness = new Harness({
    root: opts.root,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  if (opts.mode === 'manual' && opts.onApproval) harness.security.setAsker(opts.onApproval);

  // 主链唯一入口（D5）：提交经 Loop 长任务模板（内嵌 Reactor），不再直连 harness.reactor
  const loopDeps: LoopDeps = {
    safety: harness.safety,
    registry: harness.tools,
    context: harness.context,
    model: harness.model,
    root: opts.root,
    ...(harness.ledger ? { ledger: harness.ledger } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  };

  return {
    harness,
    runTask: async (goal, o) => {
      // 档位（run 级常量）：/model 的会话级切换以逐次覆盖下传（缺省沿用装配点 tier）；scope 线程至 LoopDeps
      const runDeps: LoopDeps = {
        ...loopDeps,
        ...(o?.tier ? { tier: o.tier } : {}),
        ...(o?.scope ? { scope: o.scope } : {}),
      };
      const tpl = longTaskTemplate(runDeps, o?.maxSteps !== undefined ? { agentMaxSteps: o.maxSteps } : {});
      const r = await tpl.engine.run(
        goal,
        o?.seedHistory && o.seedHistory.length > 0 ? { state: { seedHistory: o.seedHistory } } : undefined,
      );
      return {
        done: r.status === 'done',
        ...(r.reply !== undefined ? { reply: r.reply } : {}),
        tokensUsed: r.tokensUsed,
        ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
        ...(r.history !== undefined && r.history.length > 0 ? { history: r.history } : {}),
      };
    },
  };
}
