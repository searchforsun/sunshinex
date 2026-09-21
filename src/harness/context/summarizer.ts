import type { ModelAdapter } from '../../model/adapter';
import { ContextChunk, estimateTokens } from './window';

/** 装配决策点（T5 迁移）：具备 chat 面（真实模型）才走模型摘要——stub/scripted/测试桩一律走确定性路径。
 *  判据收窄为「实现 chat 调用」（tools 字段 submit_summary 出牌），provider 字符串门禁退役。 */
export function isModelSummarizer(model: ModelAdapter | undefined): model is ModelAdapter & { chat: NonNullable<ModelAdapter['chat']> } {
  return !!model && model.provider === 'openai' && typeof model.chat === 'function';
}

/** 确定性预算截断（与 window.compact 兜底同款二分口径）：超预算时按字符二分最大可保留前缀 */
export function trimToTokenBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budgetTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

import { buildSummaryPrompt, SUMMARY_TOOLS } from '../prompts/summarizer';

export { buildSummaryPrompt };

/** 模型摘要：chat 面一次调用 submit_summary；空产出/抛错/畸形一律 null（调用方回退确定性 join）——压缩永不因摘要失败而失败。
 *  focus 为用户补充关注点（/compact [focus]），措辞标注「优先覆盖」：与既有六要素冲突时以用户点名为准。 */
export async function summarizeWithModel(model: ModelAdapter, chunks: ContextChunk[], budgetTokens: number, focus?: string): Promise<string | null> {
  if (chunks.length === 0) return null;
  const prompt = buildSummaryPrompt(chunks, budgetTokens);
  const full = focus && focus.trim().length > 0 ? `${prompt}\n\nUser focus (overrides the outline above if conflicting): ${focus.trim()}` : prompt;
  try {
    const chat = model.chat;
    if (!chat) return null;
    const res = await chat.call(model, { messages: [{ role: 'user', content: full }], tools: SUMMARY_TOOLS });
    const call = res.toolCalls.find((t) => t.name === 'submit_summary');
    if (!call) return null;
    const j = JSON.parse(call.argsJson) as Record<string, unknown>;
    // 六要素按节重组为 Markdown（与确定性回退的节名逐字对齐，下游解析同源）
    const section = (k: string): string => {
      const v = j[k];
      return `## ${k.charAt(0).toUpperCase() + k.slice(1)}\n${typeof v === 'string' ? v.trim() : ''}`;
    };
    const text = ['goal', 'constraints', 'progress', 'verified', 'open', 'rationale'].map(section).join('\n\n');
    const out = trimToTokenBudget(text, budgetTokens);
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}
