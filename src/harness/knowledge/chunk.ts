/** Markdown 感知分块：标题节聚合，节超长按 MAX_CHUNK 硬切，硬切保留 OVERLAP 字符重叠（检索召回的上下文连续性） */

export const MAX_CHUNK = 1200;
export const OVERLAP = 100;

/** 依 Markdown 标题聚合分块：节 = #/## 标题行至下一同级标题前（### 及以下视为节内结构）；节超长按 MAX_CHUNK 硬切，后块带 OVERLAP 前缀重叠 */
export function chunkMarkdown(text: string): string[] {
  if (text.trim().length === 0) return [];

  const lines = text.split(/\r?\n/);
  const heading = /^(\#{1,2})\s+(.*)$/;
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (heading.test(line) && current.length > 0) {
      sections.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current);

  const out: string[] = [];
  for (const sec of sections) {
    const body = sec.join('\n').trim();
    if (body.length === 0) continue;
    for (let i = 0; i < body.length; i += MAX_CHUNK - OVERLAP) {
      const end = Math.min(i + MAX_CHUNK, body.length);
      out.push(body.slice(i, end));
      if (end === body.length) break;
    }
  }
  return out;
}
