/** 显示宽度：CJK/全角记 2，其余记 1（终端色带补齐与折行按显示宽度计算） */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += isWide(c) ? 2 : 1;
  }
  return w;
}

function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/** 按显示宽度折行（不拆宽字符）；width<=0 时返回原文本单行 */
export function wrapByWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let cur = '';
  let w = 0;
  for (const ch of text) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > width && cur.length > 0) {
      lines.push(cur);
      cur = '';
      w = 0;
    }
    cur += ch;
    w += cw;
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
