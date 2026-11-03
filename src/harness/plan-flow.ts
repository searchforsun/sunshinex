/** planFlow 共享模块（spec 2026-10-24-plan-mode-redesign §4;2026-11-03 修订 /plan 三态与批准卡选档）：计划流程编排单点,TUI/serve 薄壳消费。
 *  纯流程零 IO 政策——规划任务/待办面/档位覆盖/链注入/审批全部走接缝;状态机:
 *  planning → awaiting-approval →(批准)approved |(拒绝+反馈)revising → planning |(拒绝无反馈)aborted-discarded;
 *  中断/超限/无产物 aborted。依赖方向:harness 内自洽,宿主(tui/serve)注入接缝。 */

export interface PlanStep { text: string; status: 'pending' | 'in_progress' | 'completed' }

/** 规划接缝单轮返回（2026-11-03 交稿协议扩员）：宿主 runPlanningTask 在 stopReason==='plan-presented'
 *  时读 harness 暂存槽转译——reply=计划书全文（权威通道,与纯 reply 兜底同形）,name=模型 exit_plan
 *  出牌的计划名（纯 reply 兜底由宿主从 goal 派生） */
export interface PlanningRoundOutcome {
  done: boolean;
  stopReason?: string;
  reply?: string;
  name?: string;
}

/** 批准落档档位（2026-11-03 修订:批准卡三选,缺省 acceptEdits——full-access 必须显式选择） */
export type PlanLandMode = 'acceptEdits' | 'full-access';

export type PlanFlowEvent =
  | { type: 'planning'; round: number }
  | { type: 'awaiting-approval'; name: string; doc: string; items: string[]; path?: string }
  | { type: 'revising'; round: number }
  | { type: 'approved'; doc: string; items: string[] }
  /** aborted：中断/超限/无产物/规划任务非中断失败/拒绝无反馈放弃。stopReason=规划 run 的原始终止原因透传
   *  （spec §7 如实回执——宿主回执措辞据此区分「已中断」与「规划失败: <原因>」,不再一律谎报 interrupted;
   *  discarded=2026-11-03 修订:空反馈驳回=放弃本轮,不烧修订轮,武装是否保持属宿主语义） */
  | { type: 'aborted'; reason: 'interrupted' | 'exhausted' | 'empty' | 'failed' | 'discarded'; stopReason?: string };

export interface PlanDecision { approved: boolean; mode?: PlanLandMode; feedback?: string }

export interface PlanFlowSeams {
  runPlanningTask(prompt: string, signal?: AbortSignal): Promise<PlanningRoundOutcome>;
  enterReadOnly(): void;
  exitReadOnly(): void;
  todosSnapshot(): PlanStep[];
  chainAppendPlan(doc: string): void;
  emit(e: PlanFlowEvent): void;
  awaitApproval(doc: string, items: string[]): Promise<PlanDecision>;
  /** 计划书落盘接缝（2026-11-03 交稿协议）：宿主写 <dataDir>/sessions/<journalId>.plan.md 并回传绝对路径;
   *  awaitCard 时调用（每轮修订覆盖写）——state 机只透传 name/path,零 IO 政策不变 */
  persistPlan?: (name: string, doc: string) => { path?: string };
  signal?: AbortSignal;
}

export const PLAN_MAX_ROUNDS = 3;

/** /plan 规划轮任务标签（D10:规划提示词与宿主任务标签共用单源;自 chat-model 迁入,tui re-export） */
export const PLAN_TASK_LABEL = 'Produce an investigation-backed plan document';

function planPrompt(goal: string, feedback?: string): string {
  return (
    `${PLAN_TASK_LABEL} for the goal below. First investigate the relevant code with Read/Grep/Glob (the session is temporarily read-only). ` +
    `Then reply with the full plan document in markdown — sections: Background, Approach, Files, Steps (numbered "1. ..."), Risks, Verification. ` +
    `Also call todo_write once with the full step list (every item pending), one todo per step, matching the Steps section.` +
    (feedback ? `\nThe previous plan was rejected with this feedback — revise the plan accordingly:\n${feedback}` : '') +
    `\nGoal: ${goal}`
  );
}

/** 计划名兜底派生（纯 reply 路径无 exit_plan 名）：goal 压缩空白截 24 字符 */
export function derivePlanName(goal: string): string {
  const flat = goal.replace(/\s+/g, ' ').trim();
  return flat.length <= 24 ? (flat === '' ? 'Plan' : flat) : flat.slice(0, 24) + '…';
}

/** 正文编号行解析（todos 兜底路径;**逐字迁移** src/tui/session.ts:620-624 现实现——split→trim→去编号前缀→滤空,行为等价勿加戏） */
export function parseNumberedSteps(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .map((l) => l.replace(/^\d+[.、]\s*/, '').trim())
    .filter((l) => l.length > 0);
}

export async function runPlanFlow(goal: string, seams: PlanFlowSeams, feedback?: string): Promise<{ doc: string; items: string[]; mode: PlanLandMode } | null> {
  for (let round = 1; round <= PLAN_MAX_ROUNDS; round++) {
    if (seams.signal?.aborted) {
      seams.emit({ type: 'aborted', reason: 'interrupted' });
      return null;
    }
    seams.emit(round === 1 ? { type: 'planning', round } : { type: 'revising', round });
    seams.enterReadOnly();
    let out: PlanningRoundOutcome;
    try {
      // feedback 变量随轮更新:首轮=入参初始反馈,修订轮=上一轮拒绝反馈(拒绝后重写)——修订重入必须携带反馈
      out = await seams.runPlanningTask(planPrompt(goal, feedback), seams.signal);
    } finally {
      seams.exitReadOnly();
    }
    // 判定拆分（终审修复,spec §7 如实回执）：信号置位/中断 → interrupted;其余未完成（model-error/
    // max-steps/deadline/budget…）→ failed 并透传 stopReason——不再一律谎报 interrupted
    if (seams.signal?.aborted || out.stopReason === 'interrupted') {
      seams.emit({ type: 'aborted', reason: 'interrupted', ...(out.stopReason !== undefined ? { stopReason: out.stopReason } : {}) });
      return null;
    }
    if (!out.done) {
      seams.emit({ type: 'aborted', reason: 'failed', ...(out.stopReason !== undefined ? { stopReason: out.stopReason } : {}) });
      return null;
    }
    const doc = out.reply ?? '';
    // 计划名（2026-11-03 交稿协议）：exit_plan 出牌名权威;纯 reply 兜底从 goal 派生（截 24 字符）
    const planName = out.name !== undefined && out.name.trim() !== '' ? out.name.trim() : derivePlanName(goal);
    // todos 权威:todo_write 快照优先于正文解析(空文本项滤除)
    const items = seams.todosSnapshot().map((t) => t.text).filter((t) => t.trim() !== '');
    // todos 空 → 正文编号行兜底:先筛编号行再交 parseNumberedSteps 去前缀——散文/标题行不作步骤
    // (锚:主路径 '# 计划' 标题不入 items;纯散文回复「没有步骤」无编号行 → empty)。筛选在调用侧,
    // parseNumberedSteps 本体保持 session.ts 逐字迁移语义供宿主共用。
    const numberedLines = doc.split('\n').filter((l) => /^\s*\d+[.、]/.test(l));
    const finalItems = items.length > 0 ? items : parseNumberedSteps(numberedLines.join('\n'));
    if (finalItems.length === 0) {
      seams.emit({ type: 'aborted', reason: 'empty' });
      return null;
    }
    // 计划书落盘（2026-11-03 交稿协议）：emit 前写盘（宿主接缝,每轮修订覆盖写）,卡与合成链行携 name/path;
    // 接缝缺省（旧宿主/单测）=不落盘,name 仍透传（卡头展示用）
    const persisted = seams.persistPlan?.(planName, doc);
    seams.emit({ type: 'awaiting-approval', name: planName, doc, items: finalItems, ...(persisted?.path !== undefined ? { path: persisted.path } : {}) });
    const d = await seams.awaitApproval(doc, finalItems);
    // 判定序（2026-11-03 修订）：信号中止最优先（TUI Esc/serve interrupt 先 abort 再回填拒绝——
    // 产物不得注入、执行不得启动,沿 approval.ts rider 语义）;其次空反馈驳回=放弃本轮（discarded,
    // 不烧修订轮额度）;有反馈才进修订环
    if (seams.signal?.aborted) {
      seams.emit({ type: 'aborted', reason: 'interrupted' });
      return null;
    }
    if (!d.approved && d.feedback === undefined) {
      seams.emit({ type: 'aborted', reason: 'discarded' });
      return null;
    }
    if (d.approved) {
      const mode: PlanLandMode = d.mode ?? 'acceptEdits';
      seams.chainAppendPlan(doc);
      seams.emit({ type: 'approved', doc, items: finalItems });
      return { doc, items: finalItems, mode };
    }
    feedback = d.feedback;
  }
  seams.emit({ type: 'aborted', reason: 'exhausted' });
  return null;
}
