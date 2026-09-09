import { Harness } from '../harness';
import { ModelAdapter } from '../model/adapter';
import { ApprovalDecision, ApprovalRequest, SessionEvent } from '../types';
import { RunResult } from '../harness/reactor';

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

export interface TuiRuntime {
  harness: Harness;
  runTask(goal: string, opts?: { maxSteps?: number }): Promise<RunResult>;
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
  return {
    harness,
    runTask: (goal, o) => harness.reactor.run({ goal }, { maxSteps: o?.maxSteps ?? 12 }),
  };
}
