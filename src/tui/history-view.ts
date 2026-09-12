import { ChatItem } from './session';

/** 翻阅视口默认展示的最近轮数（Tab 进入历史翻阅时按此窗口呈现） */
export const HISTORY_VIEWPORT_ROUNDS = 6;

/** 对话轮：一条用户消息开启，至下一条用户消息前结束；轮内消息随任务执行增长 */
export interface ChatRound {
  /** 轮首消息在 messages 中的下标（Static/React key 基准） */
  start: number;
  items: ChatItem[];
}

/** 消息流切轮：用户消息必为轮首；开头无用户消息的杂项（如软重置提示）兜底归入首轮 */
export function splitRounds(messages: ChatItem[]): ChatRound[] {
  const rounds: ChatRound[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' || rounds.length === 0) {
      rounds.push({ start: i, items: [m] });
      continue;
    }
    rounds[rounds.length - 1].items.push(m);
  }
  return rounds;
}

/** 翻阅视口窗口：以 endIdx（含）为末轮向前取 HISTORY_VIEWPORT_ROUNDS 轮；endIdx 越界钳制到合法区间 */
export function reviewWindow(
  rounds: ChatRound[],
  endIdx: number,
): { start: number; end: number; view: ChatRound[] } {
  if (rounds.length === 0) return { start: 0, end: -1, view: [] };
  const end = Math.min(Math.max(0, endIdx), rounds.length - 1);
  const start = Math.max(0, end - (HISTORY_VIEWPORT_ROUNDS - 1));
  return { start, end, view: rounds.slice(start, end + 1) };
}
