/**
 * 记忆/技能文本闸门单点（规格 §3.3）：正则与判定顺序自 memory/extractor.ts 原样迁出。
 * 复用方：记忆提取（跳过命中项）、learned 语义提炼（命中即回退确定性写盘）、memory_write 工具（命中即拒绝）。
 */

/** 临时/会话限定词黑名单（规格 §6 防线②写时机械扫描，zh+en；与注入/不可见 Unicode 扫描同闸门合并执行，纯规则零模型二次调用） */
// i18n-exempt: 匹配中文记忆内容的特征正则
export const TEMPORAL_MARKERS = /昨天|上周|上月|刚才|现在|本次会话|这个会话|上述|yesterday|last week|just now|this session/i;
/** 提示注入特征（记忆并入冻结快照≈进系统提示词，须防持久化注入——Hermes 同款） */
// i18n-exempt: 匹配中文记忆内容的特征正则
export const INJECTION_MARKERS = /ignore (all )?previous|disregard .{0,24}instructions|忽略(之前|以上|前面)(的)?(指令|内容)|无视(之前|以上)(的)?(指令|内容)/i;
/** 不可见 Unicode（零宽/双向控制字符） */
const INVISIBLE_UNICODE = /[\u200b-\u200f\u202a-\u202e\u2060]/;

/** 写时机械扫描（规格 §6 防线②）：手动 add 与自动提取共用同一闸门，纯规则零模型调用；命中返回原因码 */
export function scanMemoryText(text: string): 'temporal' | 'injection' | null {
  if (TEMPORAL_MARKERS.test(text)) return 'temporal';
  if (INJECTION_MARKERS.test(text) || INVISIBLE_UNICODE.test(text)) return 'injection';
  return null;
}
