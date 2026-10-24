/** planFlow 共享模块（spec 2026-10-24-plan-mode-redesign §4）：计划流程编排单点,TUI/serve 薄壳消费。
 *  纯流程零 IO 政策——规划任务/待办面/档位覆盖/链注入/审批全部走接缝;状态机:
 *  planning → awaiting-approval →(批准)approved |(拒绝+反馈)revising → planning;
 *  中断/超限/无产物 aborted。依赖方向:harness 内自洽,宿主(tui/serve)注入接缝。 */

export interface PlanStep { text: string; status: 'pending' | 'in_progress' | 'completed' }

export type PlanFlowEvent =
  | { type: 'planning'; round: number }
  | { type: 'awaiting-approval'; doc: string; items: string[] }
  | { type: 'revising'; round: number }
  | { type: 'approved'; doc: string; items: string[] }
  | { type: 'aborted'; reason: 'interrupted' | 'exhausted' | 'empty' };

export interface PlanDecision { approved: boolean; feedback?: string }

export interface PlanFlowSeams {
  runPlanningTask(prompt: string, signal?: AbortSignal): Promise<{ done: boolean; stopReason?: string; reply?: string }>;
  enterReadOnly(): void;
  exitReadOnly(): void;
  todosSnapshot(): PlanStep[];
  chainAppendPlan(doc: string): void;
  emit(e: PlanFlowEvent): void;
  awaitApproval(doc: string, items: string[]): Promise<PlanDecision>;
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

/** 正文编号行解析（todos 兜底路径;**逐字迁移** src/tui/session.ts:620-624 现实现——split→trim→去编号前缀→滤空,行为等价勿加戏） */
export function parseNumberedSteps(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .map((l) => l.replace(/^\d+[.、]\s*/, '').trim())
    .filter((l) => l.length > 0);
}

export async function runPlanFlow(goal: string, seams: PlanFlowSeams, feedback?: string): Promise<{ doc: string; items: string[] } | null> {
  for (let round = 1; round <= PLAN_MAX_ROUNDS; round++) {
    if (seams.signal?.aborted) {
      seams.emit({ type: 'aborted', reason: 'interrupted' });
      return null;
    }
    seams.emit(round === 1 ? { type: 'planning', round } : { type: 'revising', round });
    seams.enterReadOnly();
    let out: { done: boolean; stopReason?: string; reply?: string };
    try {
      // feedback 变量随轮更新:首轮=入参初始反馈,修订轮=上一轮拒绝反馈(拒绝后重写)——修订重入必须携带反馈
      out = await seams.runPlanningTask(planPrompt(goal, feedback), seams.signal);
    } finally {
      seams.exitReadOnly();
    }
    if (!out.done || out.stopReason === 'interrupted' || seams.signal?.aborted) {
      seams.emit({ type: 'aborted', reason: 'interrupted' });
      return null;
    }
    const doc = out.reply ?? '';
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
    seams.emit({ type: 'awaiting-approval', doc, items: finalItems });
    const d = await seams.awaitApproval(doc, finalItems);
    if (d.approved) {
      seams.chainAppendPlan(doc);
      seams.emit({ type: 'approved', doc, items: finalItems });
      return { doc, items: finalItems };
    }
    feedback = d.feedback;
  }
  seams.emit({ type: 'aborted', reason: 'exhausted' });
  return null;
}
