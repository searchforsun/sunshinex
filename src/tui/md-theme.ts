/**
 * Markdown 渲染主题知识单点（R10 短期收敛立表，D29 并轨后单链化，2026-10-04）：
 * 此前主链 md-ansi.ts（markdansi → ANSI）与回看链 components/MarkdownText.tsx（markdown-it IR → ink）
 * 各持「同色系」两份样式知识，靠 md-theme 双形态表（sgr + inkName）钉同源——D29 渲染双链并轨后
 * 回看链退役（step 行与旧档回放改走 renderMd 烘焙直嵌），inkName 形态消费方清零、表收缩为
 * sgr 单形态；改色仍只动本文件，主链渲染输出同步变化。
 * md-theme.test.ts 以「表查询结果=旧硬编码值」特征化钉保收缩零漂移。
 */
import { HiKind } from './highlight';

/**
 * 高亮 token → ANSI SGR 前景开码（md-ansi 主链消费；ink 色名形态已随回看链退役摘除——
 * 35=magenta / 32=green / 90=gray(bright-black) / 33=yellow），plain 空串（不着色）
 */
export const HI_TOKEN_SGR: Record<HiKind, string> = {
  keyword: '\x1b[35m',
  string: '\x1b[32m',
  comment: '\x1b[90m',
  number: '\x1b[33m',
  plain: '',
};

/** 高亮 token → ANSI SGR 开码（HI_TOKEN_SGR 的查询视图） */
export function hiSgr(kind: HiKind): string {
  return HI_TOKEN_SGR[kind];
}

/** 分割线字符（R10 证据②：hr 渲染两份逐字重复）：主链以 `\x1b[2m` + 本字符 × 宽铺满列宽（dim 形态），
 *  字符单源（回看链 dimColor 形态已随 D29 退役） */
export const MD_HR_CHAR = '─';

/** 正文尾窗预览行数上限 28（R10/R11 交叉面）：MessageList MdBufferPreview 缺省回落公式
 *  min(28, max(8, rows-6)) 的上界。同值仍散在 App.tsx / ChildInspector.tsx（REPLY_PREVIEW_MAX_ROWS）/
 *  MessageList.test.tsx——后三者不在本批允许改动面，收拢留 R11 立项，此处先立正字源 */
export const REPLY_PREVIEW_MAX_ROWS = 28;

/** 正文尾窗预览行数下限 8：同上回落公式的下界（ChildInspector 非 thinking 态 max(8, rows-5) 同值） */
export const REPLY_PREVIEW_MIN_ROWS = 8;
