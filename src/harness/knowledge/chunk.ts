/** Markdown 感知分块：标题节聚合；节超长按句子边界切分（保证句子完整），无边界时按上限硬切；块间保留重叠以维持检索召回的上下文连续性 */

export const MAX_CHUNK = 1200;
export const OVERLAP = 100;

const SENTENCE_ENDINGS = '。！？；!?;';

/** 将段落切为句子（保留终止标点；行结构字符附着于后续句子，不丢失原文） */
function splitSentences(paragraph: string): string[] {
  const sentences: string[] = [];
  let buffer = '';
  for (const char of paragraph) {
    buffer += char;
    if (SENTENCE_ENDINGS.includes(char)) {
      sentences.push(buffer);
      buffer = '';
    }
  }
  if (buffer.length > 0) sentences.push(buffer);
  return sentences;
}

/** 超长正文切分：优先句子边界贪心装箱；单句超上限时句子边界失效，退化为固定宽度硬切。后块以前块尾部重叠开头（残段仅作后续内容前缀，避免孤立尾块） */
function hardCut(body: string, chunks: string[]): void {
  let current = '';
  let pendingOverlap = '';
  for (const sentence of splitSentences(body)) {
    if (sentence.length > MAX_CHUNK) {
      if (current.length > 0) chunks.push(current);
      let piece = '';
      for (let start = 0; start < sentence.length; start += MAX_CHUNK - OVERLAP) {
        piece = sentence.slice(start, start + MAX_CHUNK);
        chunks.push(piece);
      }
      pendingOverlap = piece.slice(-OVERLAP);
      current = '';
      continue;
    }
    const prefix = pendingOverlap.length > 0 ? pendingOverlap : current;
    const flush = pendingOverlap.length === 0 && prefix.length > 0 && prefix.length + sentence.length > MAX_CHUNK;
    if (flush) chunks.push(prefix);
    const maxTail = MAX_CHUNK - sentence.length;
    const tail = prefix.length > maxTail ? prefix.slice(prefix.length - maxTail) : prefix;
    current = tail + sentence;
    pendingOverlap = '';
  }
  if (current.length > 0) chunks.push(current);
}

/** 依 Markdown 标题聚合分块：节 = #/## 标题行至下一同级标题前（### 及以下视为节内结构）；首标题前的导语独立成块 */
export function chunkMarkdown(text: string): string[] {
  if (text.trim().length === 0) return [];

  const heading = /^#{1,2}\s+/;
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (heading.test(line) && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join('\n'));

  const chunks: string[] = [];
  for (const section of sections) {
    const body = section.trim();
    if (body.length === 0) continue;
    if (body.length <= MAX_CHUNK) {
      chunks.push(body);
    } else {
      hardCut(body, chunks);
    }
  }
  return chunks;
}
