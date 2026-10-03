/** 用量提取三件套：OpenAI 兼容响应 JSON 的 usage 字段解析——自 adapter.ts 纯搬移（H4 拆件），
 *  零依赖叶子模块；adapter.ts 对本件公开符号按原路径再导出，既有 './adapter' 导入点零改动 */

/** 从 OpenAI 兼容响应 JSON 解析 usage.total_tokens；缺失/非数字回 0（无占位计数） */
export function extractUsage(data: unknown): number {
  const tokens = (data as { usage?: { total_tokens?: unknown } } | null)?.usage?.total_tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0;
}

/** 从 OpenAI 兼容响应 JSON 解析 usage.prompt_tokens（缓存命中率分母，与 cached_tokens 同量纲）；缺失/非数字回 0 */
export function extractPromptTokens(data: unknown): number {
  const tokens = (data as { usage?: { prompt_tokens?: unknown } } | null)?.usage?.prompt_tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0;
}

/** 从 OpenAI 标准响应解析 prompt 缓存命中 tokens：仅认 usage.prompt_tokens_details.cached_tokens（缺失或三方私有字段一律回 0，不做任何第三方 API 适配） */
export function extractCacheTokens(data: unknown): number {
  const usage = (data as { usage?: Record<string, unknown> } | null)?.usage;
  const cached = (usage?.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens;
  return typeof cached === 'number' && Number.isFinite(cached) ? cached : 0;
}
