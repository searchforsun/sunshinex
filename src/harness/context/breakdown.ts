import { ContextItem, HistoryStep } from '../../types';
import { estimateTokens } from './window';
import { chainToHistoryItems } from './index';

/** 上下文构成观测（/context 单一数据源，纯计算零副作用）：
 *  按 buildMessages 消息面同构分段——稳定段（system#1）→ 冻结快照三段（instructions/skills/memory）→
 *  压缩块 → 会话链 → 待注入技能块；token 口径与 ctx 水位同源（estimateTokens 近似）。
 *  只读约定：调用方传只读视图（chainView/compactedView/snapshotPartsView/peekSkill），
 *  本面禁 assemble（会消费技能块）、禁写链——观测不改变被观测者。 */

/** 构成分段标识（固定顺序即呈现顺序：前置冻结段在前、动态段在后，对齐装配序） */
export type BreakdownPartId = 'stable' | 'instructions' | 'skills' | 'memory' | 'compacted' | 'chain' | 'skill';

export interface BreakdownPart {
  id: BreakdownPartId;
  tokens: number;
  /** 条目数：instructions/skills/memory/compacted=条目数、chain=链行数、skill=0|1、stable 恒 1 */
  count: number;
}

/** 会话链按动作词汇细分（task/reply/phase/tool-call/tool-result/notice/skill/note… 原样键控，未登记动作归 note） */
export interface ChainActionStat {
  action: string;
  steps: number;
  tokens: number;
}

export interface ContextBreakdown {
  /** 构成分段（固定装配序；skill 段仅在待注入块存在时呈现，tokens=0 的段保留——空态也是事实） */
  parts: BreakdownPart[];
  /** 链内动作细分（tokens 降序；Σ 与 chain 段严格相等） */
  chainByAction: ChainActionStat[];
  /** Σ parts.tokens（模型消息面估算总量，含稳定段） */
  total: number;
  /** 窗口预算（SUNSHINEX_CONTEXT_WINDOW / 缺省 200k，与 Reactor 压缩判定同源） */
  window: number;
  /** 窗口余量（window − total，下限 0） */
  free: number;
  /** 压缩水位：链前 N 行已折叠进压缩块（chainView 不含这部分） */
  chainFrom: number;
}

export function contextBreakdown(input: {
  stableSegment: string;
  instructions: ContextItem[];
  skills: ContextItem[];
  memory: ContextItem[];
  compacted: ContextItem[];
  chain: HistoryStep[];
  skill: string | null;
  window: number;
  chainFrom: number;
}): ContextBreakdown {
  const tokensOf = (items: ContextItem[]): number => items.reduce((s, i) => s + estimateTokens(i.content), 0);
  // 链行 token 按行精确对齐：chainToHistoryItems 与 chain 等长 1:1 映射，逐行计费不整体近似
  const chainLines = chainToHistoryItems(input.chain);
  const byAction = new Map<string, { steps: number; tokens: number }>();
  for (let i = 0; i < input.chain.length; i++) {
    const key = input.chain[i].action ?? 'note';
    const tokens = estimateTokens(chainLines[i].content);
    const cur = byAction.get(key) ?? { steps: 0, tokens: 0 };
    cur.steps += 1;
    cur.tokens += tokens;
    byAction.set(key, cur);
  }
  const parts: BreakdownPart[] = [
    { id: 'stable', tokens: estimateTokens(input.stableSegment), count: 1 },
    { id: 'instructions', tokens: tokensOf(input.instructions), count: input.instructions.length },
    { id: 'skills', tokens: tokensOf(input.skills), count: input.skills.length },
    { id: 'memory', tokens: tokensOf(input.memory), count: input.memory.length },
    { id: 'compacted', tokens: tokensOf(input.compacted), count: input.compacted.length },
    { id: 'chain', tokens: chainLines.reduce((s, l) => s + estimateTokens(l.content), 0), count: input.chain.length },
    ...(input.skill !== null ? [{ id: 'skill' as const, tokens: estimateTokens(input.skill), count: 1 }] : []),
  ];
  const total = parts.reduce((s, p) => s + p.tokens, 0);
  return {
    parts,
    chainByAction: [...byAction.entries()].map(([action, v]) => ({ action, ...v })).sort((a, b) => b.tokens - a.tokens || (a.action < b.action ? -1 : 1)),
    total,
    window: input.window,
    free: Math.max(0, input.window - total),
    chainFrom: input.chainFrom,
  };
}
