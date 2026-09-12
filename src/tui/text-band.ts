import stringWidth from 'string-width';

/** 显示宽度：委托 string-width（与 ink 同源口径：CJK/全角/emoji 序列记 2，零宽记 0），色带补齐与表格对齐统一走它 */
export function displayWidth(s: string): number {
  return stringWidth(s);
}

/** 图素簇切分器：终端按图素簇渲染（Segmenter 默认粒度即 grapheme），emoji 序列/国旗/ZWJ 家族不可拆散计宽 */
const graphemes = new Intl.Segmenter();

/** 按显示宽度折行：以图素簇为最小显示单元（不拆 CJK 宽字符与 emoji 序列）；width<=0 时返回原文本单行 */
export function wrapByWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let cur = '';
  let w = 0;
  for (const { segment } of graphemes.segment(text)) {
    const uw = displayWidth(segment);
    if (w + uw > width && cur.length > 0) {
      lines.push(cur);
      cur = '';
      w = 0;
    }
    cur += segment;
    w += uw;
  }
  lines.push(cur);
  return lines;
}

/** 用户消息色带行：按 columns-2 折行，每行左右各留 1 空格并补齐至 columns（ink3 仅 Text 支持 backgroundColor，整行文本铺色） */
export function bandLines(text: string, columns: number): string[] {
  const inner = Math.max(1, columns - 2);
  return text
    .split('\n')
    .flatMap((seg) => wrapByWidth(seg, inner))
    .map((l) => ` ${l}${' '.repeat(Math.max(0, inner - displayWidth(l)))} `);
}
