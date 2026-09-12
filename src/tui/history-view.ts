import { ChatItem } from './session';

/** 翻阅视口窗口最大轮数：窗口锚定焦点块所在轮向前取（轮数上限防帧高失控） */
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

/** 进入翻阅时默认展开的最近块数（焦点块可额外展开一个，同时至多 DEFAULT + 1 块展开） */
export const REVIEW_DEFAULT_EXPANDED = 3;

/** 可折叠块引用：翻阅与展开判定的最小单元 = 单条思考/工具消息（其余角色始终全文） */
export interface BlockRef {
  /** 所在轮下标（splitRounds 序） */
  round: number;
  /** 轮内消息下标 */
  item: number;
}

/** 可折叠块清单（自上而下）：有原文可展开的思考/工具结果块——⏺ 调用行与无 detail 行无折叠态，不占焦点步进 */
export function collapsibleBlocks(rounds: ChatRound[]): BlockRef[] {
  const blocks: BlockRef[] = [];
  rounds.forEach((r, ri) =>
    r.items.forEach((m, ii) => {
      if ((m.role === 'thinking' || m.role === 'tool') && m.detail !== undefined) blocks.push({ round: ri, item: ii });
    }),
  );
  return blocks;
}

/** 块键：展开集与焦点判定的稳定标识 */
const blockKey = (b: BlockRef): string => `${b.round}:${b.item}`;

/**
 * 块粒度翻阅视口：窗口末轮锚定焦点块所在轮（无块取末轮），向前至多 HISTORY_VIEWPORT_ROUNDS 轮；
 * 展开集 = 最新 REVIEW_DEFAULT_EXPANDED 块 ∪ 焦点块
 */
export function reviewViewport(
  rounds: ChatRound[],
  focus: number,
): { start: number; end: number; view: ChatRound[]; blocks: BlockRef[]; expanded: Set<string> } {
  const blocks = collapsibleBlocks(rounds);
  if (rounds.length === 0) return { start: 0, end: -1, view: [], blocks, expanded: new Set() };
  const fc = Math.min(Math.max(focus, 0), blocks.length - 1);
  const focusRef = blocks[fc];
  const end = focusRef ? focusRef.round : rounds.length - 1;
  const start = Math.max(0, end - (HISTORY_VIEWPORT_ROUNDS - 1));
  const expanded = new Set<string>();
  blocks.forEach((b, i) => {
    if (i >= blocks.length - REVIEW_DEFAULT_EXPANDED || i === fc) expanded.add(blockKey(b));
  });
  return { start, end, view: rounds.slice(start, end + 1), blocks, expanded };
}
