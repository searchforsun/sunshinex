import { t } from '../i18n';
import { derivePlanName, parseNumberedSteps } from '../harness/plan-flow';
import type { PlanDecision, PlanLandMode } from '../harness/plan-flow';
import { writePlanDoc } from './session-journal';
import { resolveDataDir } from '../config/data-dir';
import { suspendAskerFor, interrupt } from './approval';
import type { SessionController } from './session';

// D52 拆分件（D17 commands-* 族先例;2026-11-03 无感化收敛,ask_question 同构）：计划模式=「read-only
// 覆盖 + exit_plan 挂起工具」,无宿主编排状态机——armed 提交走会话作用域 run（override 在座+提示 note
// 注入,由 session.submit/runTaskFlow 承载）,exit_plan executor 弹卡阻塞等裁决,confirmPlan 回填裁决
// 并落档,executor 恢复后模型同 run 无感继续（批准=放权原地实施;驳回带反馈=原地修订再出牌;空反馈
// 驳回=中断 run 放弃本轮,arm 保持）。本件只留:TUI 侧挂起接缝（卡/落盘/awaitDecision）与落所选档。
//
// ⚠ 验收红线：①执行写操作仍全过安全链（guard 活读,批准落档后放权）;②armed 只读强制=override
// （判别力锚:armed run 中 write 被拒）;③空反馈驳回=中断 run 放弃本轮（decide 回填+信号,非静默）。

/** 交稿确认卡文案（计划名行+计划书全文+三选键位） */
function planCardText(name: string, doc: string, items: string[]): string {
  return [
    t('Plan confirmation (/plan)', '计划确认卡（/plan）'),
    t(`Plan: ${name}`, `计划：${name}`),
    doc,
    '---',
    ...items.map((item, i) => `${i + 1}. ${item}`),
    t(`${items.length} items; y implement (workspace edits) / f implement (full access) / n re-plan with feedback / Esc discard`, `${items.length} 项；y 实施（工作区编辑）/ f 实施（完全访问）/ n 重新计划（附反馈）/ Esc 放弃`),
  ].join('\n');
}

/** TUI 侧 exit_plan 挂起接缝（2026-11-03 无感化,ask_question 同构）：落盘计划文件+挂卡
 *  （pendingPlan+卡上屏+状态转 awaiting-plan 供卡键模态;run 仍 open——界面保持运行中转圈,
 *  ask_question「等待回答」同观感）+阻塞等 confirmPlan 回填裁决;批准在 executor 恢复前落档
 *  （退出只读覆盖+落所选档+todos 播种——无感继续的放权点） */
export async function planAwaitDecisionOn(ctrl: SessionController, name: string, doc: string): Promise<PlanDecision> {
  ctrl.ensureJournal();
  const items = parseNumberedSteps(doc);
  const dName = name !== '' ? name : derivePlanName(ctrl.activeGoal);
  let path: string | undefined;
  const jid = ctrl.journal?.currentId;
  if (jid !== undefined) path = writePlanDoc(resolveDataDir(ctrl.root), jid, dName, doc);
  ctrl.pendingPlan = { name: dName, path, doc, items };
  ctrl.pushMsg('system', planCardText(dName, doc, items));
  ctrl.state = { ...ctrl.state, status: 'awaiting-plan' };
  ctrl.notify();
  const decision: PlanDecision = await new Promise((resolve) => { ctrl.planDecide = resolve; });
  if (decision.approved) {
    // 落档在 executor 恢复前:退出只读覆盖（调研期强制解除）+落所选档+待办播种——
    // 模型恢复后写操作即时放行（guard 活读）
    ctrl.runtime.harness.security.exitModeOverride();
    landModeOn(ctrl, decision.mode ?? 'acceptEdits');
    ctrl.setTodos(items.map((it) => ({ text: it, status: 'pending' as const })));
    ctrl.pushMsg('system', t('Plan approved — implement; update todos with todo_write as you go', '计划已批准——开始实施；随进度用 todo_write 维护待办'));
  }
  return decision;
}

/** 计划卡裁决回填（2026-11-03 无感化）：摘卡清反馈态 → 裁决回填（executor 恢复）。
 *  空反馈驳回=放弃本轮:中断 run（arm 保持）回输入态——decide 回填与信号双通道汇于 executor 收尾 */
export async function confirmPlanOn(ctrl: SessionController, yes: boolean, feedback?: string, mode?: PlanLandMode): Promise<void> {
  const pending = ctrl.pendingPlan;
  if (!pending) return;
  ctrl.pendingPlan = undefined;
  ctrl.planFeedbackMode = undefined;
  const decide = ctrl.planDecide;
  ctrl.planDecide = undefined;
  decide?.({
    approved: yes,
    ...(mode !== undefined ? { mode } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
  });
  if (!yes && (feedback === undefined || feedback.trim() === '')) {
    // 空反馈驳回=放弃本轮:中断 run(执行中计划/调研即刻中止)回输入态
    interrupt(ctrl);
    ctrl.state = { ...ctrl.state, status: 'idle', pauseConfirm: undefined };
    ctrl.pushMsg('system', t('Plan discarded, back to input', '已放弃执行计划，回到输入态'));
    return;
  }
  void pending;
}

/** 批准落所选档（2026-11-03 批准卡三选）：退出只读覆盖+真档 setBaseMode+arm 解除（acceptEdits
 *  补挂 asker——full-access 侧宁停语义与 CLI --mode=full-access 一致） */
export function landModeOn(ctrl: SessionController, mode: PlanLandMode): void {
  ctrl.runtime.harness.security.exitModeOverride();
  ctrl.planArmed = false;
  if (ctrl.runtime.harness.security.mode === mode) return;
  ctrl.runtime.harness.security.setBaseMode(mode);
  if (mode === 'acceptEdits') ctrl.runtime.harness.security.setAsker(suspendAskerFor(ctrl));
  ctrl.pushMsg('system', mode === 'full-access' ? t('Switched to full access mode', '已切换到完全访问档') : t('Switched to workspace edit mode', '已切换到工作区编辑档'));
}
