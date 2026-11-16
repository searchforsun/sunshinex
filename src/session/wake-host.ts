// bg-wake 宿主装配件（D70 收敛，2026-11-15）：daemon（serve/session.ts）与 TUI（tui/session.ts）
// 的宿主接线中「板任务名解析 + 唤醒通知文装配」两块近逐字双写收敛单点；宿主差异面（板投影来源、
// pump/fire/busy 接缝）留在各自宿主。本模块为宿主侧（daemon/TUI）专用，不经浏览器包（receiptBody
// 连带 fs 读档）。
import { WAKE_HINT_RECEIPT_TOOL, type TaskRegistry } from '../harness/tasks';
import { receiptBody } from '../harness/tools/task-wait';
import { buildWakeNotification } from './wake';
import type { WakeRef } from './entry';

/** 板任务名解析单点（daemon/TUI 同构）：台账 id（板派发 dispatchTag 形 task-tN）→ 板 id → 板投影
 *  title；非派发 id 原样寻址，缺省 undefined=无名 */
export function boardTaskTitleOf(ledgerId: string, boardTasks: Record<string, { title?: string }>): string | undefined {
  const m = /^task-(t\d+)$/.exec(ledgerId);
  const boardId = m !== null ? m[1]! : ledgerId;
  return boardTasks[boardId]?.title;
}

/** 唤醒通知文装配单点（spec §5.2）：refs → task_wait 回执体（receiptBody）逐任务拼装；
 *  台账 id 失配兜底 `(ledger) finished` 行（与两宿主既有兜底同文案） */
export function buildWakeNotice(refs: readonly WakeRef[], tasks: TaskRegistry): string {
  return buildWakeNotification(refs, (id) => {
    const t = tasks.get(id);
    return t !== undefined ? receiptBody(t, WAKE_HINT_RECEIPT_TOOL) : `${id} (ledger) finished`;
  });
}
