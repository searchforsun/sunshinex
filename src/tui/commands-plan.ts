import { t } from '../i18n';
import { derivePlanName, parseNumberedSteps } from '../harness/plan-flow';
import type { PlanDecision, PlanLandMode } from '../harness/plan-flow';
import { writePlanDoc } from './session-journal';
import { resolveDataDir } from '../config/data-dir';
import { suspendAskerFor, interrupt } from './approval';
import type { SessionController } from './session';

// D52 拆分件（D17 commands-* 族先例;2026-11-03 无感化收敛,ask_question 同构;2026-11-04 泛化）：
// exit_plan=通用提案工具（任何档可调）,审批面=计划卡本体,按钮集按当前档自适应（只读域=选落档三键;
// 可写域=维持当前档两键）。计划模式=「read-only 覆盖 + 计划提示 note」纪律档（armed 提交走会话作用域
// run,override 在座）——exit_plan executor 弹卡阻塞等裁决,confirmPlan 回填裁决并落档,executor 恢复后
// 模型同 run 无感继续（批准=放权原地实施;重新计划=带反馈原地修订再出牌;空反馈=中断 run 放弃本轮）。
// 本件只留:TUI 侧挂起接缝（卡/落盘/awaitDecision）与落所选档。
//
// ⚠ 验收红线：①执行写操作仍全过安全链（guard 活读,批准落档后放权）;②armed 只读强制=override
// （判别力锚:armed run 中 write 被拒）;③空反馈=中断 run 放弃本轮（decide 回填+信号,非静默）。

/** 卡面键位按当前档自适应（2026-11-04 泛化）：只读域（plan/read-only）三键=选落档实施;
 *  可写域（acceptEdits/full-access）两键=维持当前档实施（f 隐藏——档位切换不混入计划卡） */
function planKeyline(items: string[], mode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan'): string {
  if (mode === 'acceptEdits' || mode === 'full-access') {
    const impl = mode === 'full-access' ? t('implement (full access)', '实施（完全访问）') : t('implement (workspace edits)', '实施（工作区编辑）');
    return t(`${items.length} items; y ${impl} / n re-plan with feedback / Esc discard`, `${items.length} 项；y ${impl} / n 重新计划（附反馈）/ Esc 放弃`);
  }
  return t(`${items.length} items; y implement (workspace edits) / f implement (full access) / n re-plan with feedback / Esc discard`, `${items.length} 项；y 实施（工作区编辑）/ f 实施（完全访问）/ n 重新计划（附反馈）/ Esc 放弃`);
}

/** 出牌确认卡文案（计划名行+计划书全文+键位） */
function planCardText(name: string, doc: string, items: string[], mode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan'): string {
  return [
    t('Plan confirmation (/plan)', '计划确认卡（/plan）'),
    t(`Plan: ${name}`, `计划：${name}`),
    doc,
    '---',
    ...items.map((item, i) => `${i + 1}. ${item}`),
    planKeyline(items, mode),
  ].join('\n');
}

/** TUI 侧 exit_plan 挂起接缝（2026-11-03 无感化,ask_question 同构;2026-11-04 卡键位随当前档自适应）：落盘计划文件+挂卡
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
  ctrl.pushMsg('system', planCardText(dName, doc, items, ctrl.runtime.harness.security.mode));
  ctrl.state = { ...ctrl.state, status: 'awaiting-plan' };
  ctrl.notify();
  const decision: PlanDecision = await new Promise((resolve) => { ctrl.planDecide = resolve; });
  // 摘卡即回 running（2026-11-03 卡间单义化）：裁决间隙 status 不再停留 awaiting-plan——修订环两卡
  // 之间「awaiting-plan」只指新卡在挂(测试等待面/UI pill 单义,重新计划回喂轮不被误认)
  if (ctrl.state.status === 'awaiting-plan') {
    ctrl.state = { ...ctrl.state, status: 'running' };
    ctrl.notify();
  }
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
 *  空反馈=放弃本轮:中断 run 回输入态——decide 回填与信号双通道汇于 executor 收尾 */
export async function confirmPlanOn(ctrl: SessionController, yes: boolean, feedback?: string, mode?: PlanLandMode): Promise<void> {
  if (!ctrl.pendingPlan) return;
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
    // 空反馈=放弃本轮:中断 run(执行中计划/调研即刻中止)回输入态
    interrupt(ctrl);
    ctrl.state = { ...ctrl.state, status: 'idle', pauseConfirm: undefined };
    ctrl.pushMsg('system', t('Plan discarded, back to input', '已放弃执行计划，回到输入态'));
  }
}

/** 批准落所选档（2026-11-03 批准卡三选;2026-11-04 泛化:可写域=维持当前档,同值幂等直落）：
 *  退出只读覆盖+真档 setBaseMode+arm 解除（acceptEdits
 *  补挂 asker——full-access 侧宁停语义与 CLI --mode=full-access 一致） */
export function landModeOn(ctrl: SessionController, mode: PlanLandMode): void {
  ctrl.runtime.harness.security.exitModeOverride();
  ctrl.planArmed = false;
  if (ctrl.runtime.harness.security.mode === mode) return;
  ctrl.runtime.harness.security.setBaseMode(mode);
  if (mode === 'acceptEdits') ctrl.runtime.harness.security.setAsker(suspendAskerFor(ctrl));
  ctrl.pushMsg('system', mode === 'full-access' ? t('Switched to full access mode', '已切换到完全访问档') : t('Switched to workspace edit mode', '已切换到工作区编辑档'));
}
