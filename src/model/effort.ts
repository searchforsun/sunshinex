/** 思考强度（effort）档位原语：档序/解析/降级序列/不支持识别——自 adapter.ts 纯搬移（H4 拆件）。
 *  叶子模块（仅依赖 src/types.ts）：config/providers.ts 经此直取（消 J5 的 config→adapter 耦合点）；
 *  adapter.ts 对本件公开符号按原路径再导出，既有 './adapter' 导入点零改动 */
import type { ReasoningEffort } from '../types';

/** 思考强度（OpenAI 兼容 reasoning_effort 请求参数）：请求级字段、不进提示词，前缀缓存零影响；类型本体登记 src/types.ts */
export const EFFORT_ORDER: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LOW_INDEX = EFFORT_ORDER.indexOf('low');

/** 解析思考强度档位：大小写不敏感；非法/空值回 undefined（配置缺省态，不生效） */
export function parseEffort(v: string | undefined | null): ReasoningEffort | undefined {
  const t = (v ?? '').trim().toLowerCase() as ReasoningEffort;
  return (EFFORT_ORDER as readonly string[]).includes(t) ? t : undefined;
}

/** effort 降级序列（端点不支持该参数时的逐档回退）：不高于 low 的请求向上逐档试到 max；高于 low 的向下逐档试到 low */
export function buildFallbackSequence(requested: ReasoningEffort): ReasoningEffort[] {
  const idx = EFFORT_ORDER.indexOf(requested);
  if (idx <= EFFORT_LOW_INDEX) return EFFORT_ORDER.slice(idx);
  return EFFORT_ORDER.slice(EFFORT_LOW_INDEX, idx + 1).reverse();
}

/** 端点不支持 reasoning_effort 参数的识别：仅 400/422 且错误消息指向该参数；网络/鉴权/限流/服务端错误不降级、照常抛出 */
export function isUnsupportedEffortError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : '';
  const m = /OpenAI request failed: (\d{3})/.exec(msg);
  if (!m) return false;
  const status = Number(m[1]);
  return (status === 400 || status === 422) && /reasoning[_ ]effort/i.test(msg);
}
