import { t } from '../i18n';
import type { ApprovalDecision, ApprovalRequest, AskUserAnswer, AskUserRequest } from '../types';
import type { SessionController } from './session';

// D17 拆分件步5（docs/TECH-DEBT-SURVEY.md H1）：审批/问询/中断挂起族——suspendAsker 闭包、resolveApproval、
// autoAsker 咨询、askUser 问询管线、requestPause/cancelPause/hangPauseCard 暂停卡、interrupt 与中断回执。
// 挂起态字段仍在控制器（pendingApproval/pendingQuestion/pendingPlan/taskAbort），本族函数经 ctrl 单点协调，
// SessionController 保留同名公开薄委托（测试与渲染层调用面零变化）。

/** 终端化审批挂起（构造器装配给 security.setAsker 的闭包）：guard ask → 挂起（awaiting-approval + 审批卡）
 *  → 裁决回填 → 继续；有外部 asker（headless/脚本）时委托之，状态转换保持一致便于观测与渲染 */
export function suspendAskerFor(ctrl: SessionController): (req: ApprovalRequest) => Promise<ApprovalDecision> {
  return async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    ctrl.state = { ...ctrl.state, status: 'awaiting-approval', approval: req, task: ctrl.state.task.phase === 'tool-pending' ? { ...ctrl.state.task, phase: 'tool-awaiting' } : ctrl.state.task };
    ctrl.notify();
    // 挂起等回填（App 模态/测试直调）；opts.asker 为裁决权注入，回填后咨询并以其为最终裁决
    let d = await new Promise<ApprovalDecision>((resolve) => {
      ctrl.pendingApproval = { req, resolve };
    });
    if (ctrl.autoAsker) d = await ctrl.autoAsker(req);
    ctrl.state = { ...ctrl.state, approval: undefined, status: 'running', task: ctrl.state.task.phase === 'tool-awaiting' ? { ...ctrl.state.task, phase: 'tool-pending' } : ctrl.state.task };
    ctrl.notify();
    return d;
  };
}

/** 回填当前挂起审批；无挂起时静默忽略 */
export async function resolveApproval(ctrl: SessionController, d: ApprovalDecision): Promise<void> {
  const pending = ctrl.pendingApproval;
  if (!pending) return;
  ctrl.pendingApproval = undefined;
  ctrl.state = { ...ctrl.state, approval: undefined };
  ctrl.notify();
  pending.resolve(d);
}

/** AskQuestion 挂起管线（AskQuestion 线 D5，形态对标 suspendAsker）：prevStatus 记录挂起前态（running=任务中途问询、
 *  idle=/resume 选择器等本地问询），awaiting-question + 问题卡上屏 → 渲染层选择器接管键盘 → resolveAskAnswer 回填 → 恢复现场态 */
export function askUser(ctrl: SessionController, req: AskUserRequest): Promise<AskUserAnswer> {
  const prevStatus = ctrl.state.status;
  ctrl.state = { ...ctrl.state, status: 'awaiting-question', question: req };
  ctrl.notify();
  return new Promise<AskUserAnswer>((resolve) => {
    ctrl.pendingQuestion = {
      req,
      resolve: (a) => {
        ctrl.pendingQuestion = undefined;
        ctrl.state = { ...ctrl.state, question: undefined, status: prevStatus };
        ctrl.notify();
        resolve(a);
      },
    };
  });
}

/** 渲染层/测试裁决回填口：无挂起时静默忽略（幂等） */
export function resolveAskAnswer(ctrl: SessionController, a: AskUserAnswer): void {
  ctrl.pendingQuestion?.resolve(a);
}

/** 第一次 Ctrl+C（运行中）：挂起暂停确认卡——status 保持 running、abort 不触发，任务与子代理继续跑。
 *  已挂卡或非运行态返回 false（App 层据此回落既有分流） */
export function requestPause(ctrl: SessionController): boolean {
  if (ctrl.state.status !== 'running' || ctrl.state.pauseConfirm) return false;
  ctrl.state = { ...ctrl.state, pauseConfirm: true };
  ctrl.notify();
  return true;
}

/** 撤回暂停确认卡（Esc/n/继续项）：回运行现场，任务零影响 */
export function cancelPause(ctrl: SessionController): void {
  if (!ctrl.state.pauseConfirm) return;
  ctrl.state = { ...ctrl.state, pauseConfirm: undefined };
  ctrl.notify();
}

/** 子代理全屏视图挂卡（UI 面）：无 running 门槛——后台子代理跨回合存续，主链 idle 时单停子代理仍可达；
 *  与 requestPause（主视图、running 门槛）同一张卡两种入口，确认动作随按键所在视图分流（App 分发层） */
export function hangPauseCard(ctrl: SessionController): void {
  if (ctrl.state.pauseConfirm) return;
  ctrl.state = { ...ctrl.state, pauseConfirm: true };
  ctrl.notify();
}

/** 用户中断（Esc/Ctrl+C，对标 Claude Code）：中止在途模型调用与后续步、待审批按拒绝、待确认计划放弃、排队任务一并丢弃。
 *  运行外状态 no-op（App 层据此分流退出/清输入）；返回是否实际发生中断 */
export function interrupt(ctrl: SessionController): boolean {
  const active = ctrl.state.status === 'running' || ctrl.state.status === 'awaiting-approval' || ctrl.state.status === 'awaiting-plan' || ctrl.state.status === 'awaiting-question';
  if (!active) return false;
  // 暂停确认卡随真正中断一并清除（第二次 Ctrl+C 确认路径走这里）
  ctrl.state = { ...ctrl.state, pauseConfirm: undefined };
  ctrl.taskAbort?.abort();
  ctrl.taskAbort = undefined;
  // 待审批卡：中断即拒绝（deny 不落会话放行），任务经安全链 deny 语义自然停下
  const pending = ctrl.pendingApproval;
  if (pending) {
    ctrl.pendingApproval = undefined;
    ctrl.state = { ...ctrl.state, approval: undefined };
    pending.resolve('deny');
  }
  // 问询挂起：中断先以 dismissed 回填（管线自然恢复现场态），任务随 abort 信号停下；不遗留悬空 Promise
  if (ctrl.pendingQuestion) {
    const pendingQ = ctrl.pendingQuestion;
    ctrl.pendingQuestion = undefined;
    ctrl.state = { ...ctrl.state, question: undefined };
    pendingQ.resolve({ type: 'dismissed' });
  }
  // 待确认计划：中断即放弃（与 confirmPlan(false) 同语义）
  if (ctrl.pendingPlan) {
    ctrl.pendingPlan = undefined;
    ctrl.state = { ...ctrl.state, status: 'idle' };
    ctrl.pushMsg('system', t('Plan discarded, back to input', '已放弃执行计划，回到输入态'));
    ctrl.notify();
    return true;
  }
  // 待投递穿插行随中断一并丢弃（用户意图是停，不是继续跑）；已消费穿插行已随步入链，不受影响
  if (ctrl.runtime.harness.steering.pending() > 0) {
    const dropped = ctrl.runtime.harness.steering.takePending().length;
    ctrl.pushMsg('system', t(`Queued tasks dropped: ${dropped}`, `已丢弃排队任务：${dropped} 条`), { level: 'warn' });
  }
  ctrl.notify();
  return true;
}

/** 中断回执单点：interrupted 终态由各任务流调用；warn 级（用户主动操作，非故障） */
export function pushInterruptedNotice(ctrl: SessionController): void {
  ctrl.taskStatsSuppressed = true; // 中断路径不产出收尾统计行（规格 §3.2 边界）
  ctrl.pushMsg('system', t('Task interrupted (Esc/Ctrl+C) — completed steps kept on the chain', '已中断当前任务（Esc/Ctrl+C）——已完成步骤保留在会话链'), { level: 'warn' });
}
