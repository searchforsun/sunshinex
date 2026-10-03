/**
 * Markdown 渲染双链共享知识单点（R10 短期收敛，2026-10-04）：主链 md-ansi.ts（markdansi → ANSI）
 * 与回看链 components/MarkdownText.tsx（markdown-it IR → ink）各自持有「同色系」的两份样式知识，
 * 此前靠注释人肉同步（普查 R10 证据①②：高亮色映射两份、hr 渲染两份逐字重复）。
 * 本文件是两链唯一同源处——改色/改字符只动这里，两链渲染输出同步变化；
 * md-theme.test.ts 以「同源表查询结果=旧硬编码值」特征化钉保迁移零漂移。
 */
import { HiKind } from './highlight';

/**
 * 高亮 token → 颜色双形态同源表：sgr 为 ANSI SGR 前景开码（md-ansi 主链消费），
 * inkName 为 ink 前景色名（MarkdownText 回看链消费）——同一 token 的两形态指向同一终端色
 * （35=magenta / 32=green / 90=gray(bright-black) / 33=yellow），plain 两形态俱空（不着色）
 */
export const HI_TOKEN_COLOR: Record<HiKind, { readonly sgr: string; readonly inkName: string }> = {
  keyword: { sgr: '\x1b[35m', inkName: 'magenta' },
  string: { sgr: '\x1b[32m', inkName: 'green' },
  comment: { sgr: '\x1b[90m', inkName: 'gray' },
  number: { sgr: '\x1b[33m', inkName: 'yellow' },
  plain: { sgr: '', inkName: '' },
};

/** 高亮 token → ANSI SGR 开码（md-ansi 主链消费：HI_TOKEN_COLOR 的 sgr 形态视图） */
export function hiSgr(kind: HiKind): string {
  return HI_TOKEN_COLOR[kind].sgr;
}

/** 高亮 token → ink 前景色名（MarkdownText 回看链消费：HI_TOKEN_COLOR 的 inkName 形态视图；
 *  plain 为空串，调用方按「不着色」处理（|| undefined） */
export function hiInkName(kind: HiKind): string {
  return HI_TOKEN_COLOR[kind].inkName;
}

/** 分割线字符（R10 证据②：hr 渲染两份逐字重复）：两链各自以 dim 形态铺满列宽——
 *  md-ansi `\x1b[2m` + 本字符 × 宽、MarkdownText dimColor + 本字符 × 宽，字符同源 */
export const MD_HR_CHAR = '─';

/** 正文尾窗预览行数上限 28（R10/R11 交叉面）：MessageList MdBufferPreview 缺省回落公式
 *  min(28, max(8, rows-6)) 的上界。同值仍散在 App.tsx / ChildInspector.tsx（REPLY_PREVIEW_MAX_ROWS）/
 *  MessageList.test.tsx——后三者不在本批允许改动面，收拢留 R11 立项，此处先立正字源 */
export const REPLY_PREVIEW_MAX_ROWS = 28;

/** 正文尾窗预览行数下限 8：同上回落公式的下界（ChildInspector 非 thinking 态 max(8, rows-5) 同值） */
export const REPLY_PREVIEW_MIN_ROWS = 8;
