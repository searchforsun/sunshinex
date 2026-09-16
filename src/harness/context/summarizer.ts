import { pick } from '../../i18n';
import type { ModelAdapter } from '../../model/adapter';
import { ContextChunk, estimateTokens } from './window';

/** 装配决策点（规格 §4.4 语义）：仅 'openai' 通道视为真实模型——stub/scripted/测试桩一律走确定性路径。
 *  模拟模型通道的测试经 provider:'openai' 的假适配器显式加入（complete 为注入桩，不发真实网络）。 */
export function isModelSummarizer(model: ModelAdapter | undefined): boolean {
  return !!model && model.provider === 'openai' && typeof model.complete === 'function';
}

/** 六要素交接摘要 prompt（模型侧文案 pick 就地成对；语言为启动期常量，前缀缓存安全）。
 *  'handoff summary' 为固定标记：测试桩据此区分压缩调用与主链调用。 */
export function buildSummaryPrompt(chunks: ContextChunk[], budgetTokens: number): string {
  const material = chunks.map((c) => `- [${c.type}] ${c.summary}`).join('\n');
  return pick(
    [
      'You are compressing the selected context of an engineering session into a handoff summary for a fresh context window.',
      'Write exactly six markdown sections with these exact headings, keeping only facts and conclusions:',
      '## Goal',
      '## Constraints',
      '## Progress',
      '## Verified',
      '## Open',
      '## Rationale',
      'Section semantics: Goal = what is being accomplished now, so a fresh window stays on track;',
      'Constraints = user requirements, boundaries and hard limits; Progress = what has been done and what artifacts exist;',
      'Verified = confirmed conclusions and trustworthy data; Open = blockers, gaps, next actions;',
      'Rationale = why the current approach was chosen, which approaches already failed and must not be repeated, and pointers to original records (files/locations).',
      `Rules: keep the whole summary under about ${budgetTokens} tokens; output only the summary text (no preamble, no code fences).`,
      'Selected context:',
      material,
    ].join('\n'),
    [
      '你正在把一次工程会话的选中上下文压缩为交接摘要（handoff summary），供全新上下文窗口接续使用。',
      '输出恰好六个 Markdown 小节，标题逐字使用以下英文节名，只保留事实与结论：',
      '## Goal',
      '## Constraints',
      '## Progress',
      '## Verified',
      '## Open',
      '## Rationale',
      '小节语义：Goal=当前要完成什么（防止新窗口跑偏）；Constraints=用户要求、边界条件与不可碰的红线；',
      'Progress=已推进到哪一步、已产出什么；Verified=已确认的结论与可信数据；Open=卡点、缺口与下一步动作；',
      'Rationale=为什么选当前路线、哪些方案已失败不要再重复、原始记录入口（文件/位置引用）。',
      `规则：全文控制在约 ${budgetTokens} tokens 以内；只输出摘要正文（无前言、无代码围栏）。`,
      '选中上下文：',
      material,
    ].join('\n'),
  );
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

/** 模型摘要：一次 complete()；空输出/抛错/截断后为空一律 null（调用方回退确定性 join）——压缩永不因摘要失败而失败 */
export async function summarizeWithModel(model: ModelAdapter, chunks: ContextChunk[], budgetTokens: number): Promise<string | null> {
  if (chunks.length === 0) return null;
  try {
    const raw = await model.complete(buildSummaryPrompt(chunks, budgetTokens));
    const text = (raw ?? '').trim();
    if (!text) return null;
    const out = trimToTokenBudget(text, budgetTokens);
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}
