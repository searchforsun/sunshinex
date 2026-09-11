import { LimitReason } from '../types';

export interface GuardrailInput {
  /** 当前绝对时刻（ms epoch） */
  now: number;
  /** 绝对截止时刻；缺省＝不设时间限 */
  deadlineAt?: number;
  /** 本 run 的累计真实用量 */
  tokensUsed: number;
  /** 累计 token 硬上限；缺省＝不设预算限。与上下文窗口 budget 无关（两量纲） */
  tokenCap?: number;
  /** 已完成单位数（Reactor 步 / Loop 节点 / Graph 节点，语义一致：只数已完成的） */
  iteration: number;
  /** 单位数上限；缺省＝不设步数限 */
  maxIterations?: number;
}

/**
 * 护栏判定（纯函数）：顺序固定 超时 → 预算 → 迭代/步数（D7 时间优先）。
 * 各维度一律按 >= 判定，与 loop/graph 两引擎既有比较语义一致（graph 原用 `>`，本计划统一为 `>=`）。
 * 只回答「该不该停、为什么停」，不产生任何状态——状态映射由调用方负责。
 */
export function guardrailStop(input: GuardrailInput): LimitReason | null {
  const { now, deadlineAt, tokensUsed, tokenCap, iteration, maxIterations } = input;
  if (deadlineAt !== undefined && now >= deadlineAt) return 'deadline';
  if (tokenCap !== undefined && tokensUsed >= tokenCap) return 'budget';
  if (maxIterations !== undefined && iteration >= maxIterations) return 'max-steps';
  return null;
}
