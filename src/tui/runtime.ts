import { Harness } from '../harness';
import { LoopDeps } from '../loop/engine';
import { longTaskTemplate } from '../loop/templates';
import { ModelAdapter } from '../model/adapter';
import { ApprovalDecision, ApprovalRequest, RunOutcome, SessionEvent } from '../types';

export interface TuiRuntimeOpts {
  root: string;
  model?: ModelAdapter;
  /** 事件流旁路注入：TUI 渲染层经 SessionController 消费；缺省零副作用 */
  onEvent?: (e: SessionEvent) => void;
  /** 权限模式（缺省 dontAsk）；manual 时配合 onApproval 走终端化审批 */
  mode?: 'dontAsk' | 'manual' | 'plan';
  /** manual 模式审批回调（guard asker 装配点）；会话结束由调用方 clearSessionAllows */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

/** `RunOutcome` 按全局约束登记在 `src/types.ts`（跨模块共享）；此处按原路径再导出，既有 `./runtime` 导入点无需改动 */
export type { RunOutcome };

export interface TuiRuntime {
  harness: Harness;
  runTask(goal: string, opts?: { maxSteps?: number }): Promise<RunOutcome>;
}

/** TUI 运行时接缝：同进程装配 Harness（数据底座 .data 天然同源）；GUI 阶段如需隔离可换 daemon 实现同契约 */
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
      const tpl = longTaskTemplate(loopDeps, o?.maxSteps !== undefined ? { agentMaxSteps: o.maxSteps } : {});
      const r = await tpl.engine.run(goal);
      return {
        done: r.status === 'done',
        ...(r.reply !== undefined ? { reply: r.reply } : {}),
        tokensUsed: r.tokensUsed,
        ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
      };
    },
  };
}
