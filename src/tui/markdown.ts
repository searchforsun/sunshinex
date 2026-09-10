import { displayWidth } from './text-band';

/** 行内节点：加粗/斜体/行内代码/删除线，可嵌套（code 内不再嵌套解析） */
export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: MdInline[] }
  | { kind: 'italic'; children: MdInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'strike'; children: MdInline[] };

/** 块级节点：标题/段落/围栏代码/列表/引用/表格/分割线 */
export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: MdInline[] }
  | { type: 'paragraph'; inlines: MdInline[] }
  | { type: 'fence'; lang: string; code: string }
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'quote'; inlines: MdInline[] }
  | { type: 'table'; headers: MdInline[][]; rows: MdInline[][][] }
  | { type: 'hr' };

/** 行内解析：按 bold → strike → code → italic 优先级扫描；任何未闭合标记按字面输出（不吞字） */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let i = 0;
  const buf: string[] = [];
  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ kind: 'text', text: buf.join('') });
      buf.length = 0;
    }
  };
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ kind: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      buf.push(text[i]);
      i++;
      continue;
    }
    if (text.startsWith('**', i) || text.startsWith('__', i)) {
      const marker = text.slice(i, i + 2);
      const close = text.indexOf(marker, i + 2);
      if (close > i) {
        flush();
        out.push({ kind: 'bold', children: parseInline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
      buf.push(marker);
      i += 2;
      continue;
    }
    if (text.startsWith('~~', i)) {
      const close = text.indexOf('~~', i + 2);
      if (close > i) {
        flush();
        out.push({ kind: 'strike', children: parseInline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
      buf.push('~~');
      i += 2;
      continue;
    }
    if (text[i] === '*' || text[i] === '_') {
      const marker = text[i];
      const close = text.indexOf(marker, i + 1);
      if (close > i) {
        flush();
        out.push({ kind: 'italic', children: parseInline(text.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
      buf.push(text[i]);
      i++;
      continue;
    }
    buf.push(text[i]);
    i++;
  }
  flush();
  return out;
}

/** 行内序列递归拼纯文本（表格对齐、降级渲染、宽度计算用） */
export function inlineText(inlines: MdInline[]): string {
  let out = '';
  for (const n of inlines) {
    if (n.kind === 'text' || n.kind === 'code') out += n.text;
    else out += inlineText(n.children);
  }
  return out;
}

/** 表格分隔行判定：仅含 | - : 与空白，且至少一个 - */
function isTableSeparator(l: string): boolean {
  const t = l.trim();
  return /^\|?[\s:|-]+\|?$/.test(t) && t.includes('-');
}

/** 表格行切分为单元格（去首尾 | 后按 | 分割并 trim） */
function splitRow(l: string): string[] {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

const isBlank = (l: string): boolean => l.trim() === '';
const isFenceStart = (l: string): boolean => /^\s*(```|~~~)/.test(l);
const isHeading = (l: string): boolean => /^#{1,}\s+/.test(l);
const isHr = (l: string): boolean => /^\s*(---|\*\*\*|___)\s*$/.test(l);
const isQuote = (l: string): boolean => /^\s*>\s?/.test(l);
const isUl = (l: string): boolean => /^\s*[-*+]\s+/.test(l);
/** 有序列表项正文提取：中文顿号后空格可选（`3、丙`），英文点号后需空格（`3.丙` 不视为列表） */
function matchOl(l: string): string | undefined {
  const t = l.trimStart();
  const dn = /^\d+、\s*(.*)$/.exec(t);
  if (dn) return dn[1];
  const en = /^\d+\.\s+(.*)$/.exec(t);
  return en ? en[1] : undefined;
}
const isOl = (l: string): boolean => matchOl(l) !== undefined;
/** 段落收集需排除的「明确块起始」行（表格行不排除：非表格的 | 行应归段落，真表格由主循环 table 分支先行捕获） */
const isBlockStart = (l: string): boolean =>
  isFenceStart(l) || isHeading(l) || isHr(l) || isQuote(l) || isUl(l) || isOl(l);

/** 解析 Markdown 为块序列（纯函数，零 IO）；未闭合围栏降级为段落（流式容错） */
export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fenceMatch = /^\s*(```|~~~)\s*(.*)$/.exec(line);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1];
      const lang = fenceMatch[2].trim();
      const codeLines: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (lines[j].trim().startsWith(fenceChar)) {
          closed = true;
          break;
        }
        codeLines.push(lines[j]);
        j++;
      }
      if (closed) {
        blocks.push({ type: 'fence', lang, code: codeLines.join('\n') });
        i = j + 1;
      } else {
        // 未闭合：把开栏行与已收集行按原文降级为普通段落（不二次解析，避免围栏反引号被误吞）
        blocks.push({ type: 'paragraph', inlines: [{ kind: 'text', text: [line, ...codeLines].join('\n') }] });
        i = j;
      }
      continue;
    }

    const headingMatch = /^(#{1,})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, inlines: parseInline(headingMatch[2]) });
      i++;
      continue;
    }

    if (isHr(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (isQuote(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && isQuote(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', inlines: parseInline(quoteLines.join('\n')) });
      continue;
    }

    if (isUl(line)) {
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const m = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }
    if (isOl(line)) {
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const body = matchOl(lines[i]);
        if (body === undefined) break;
        items.push(parseInline(body));
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // 表格：| 开头且下一行为分隔行
    if (line.trimStart().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitRow(line).map((c) => parseInline(c));
      const rows: MdInline[][][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trimStart().startsWith('|')) {
        rows.push(splitRow(lines[j]).map((c) => parseInline(c)));
        j++;
      }
      blocks.push({ type: 'table', headers, rows });
      i = j;
      continue;
    }

    if (isBlank(line)) {
      i++;
      continue;
    }

    // 段落：连续非空且非块起始的行合并
    const paraLines: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', inlines: parseInline(paraLines.join('\n')) });
  }
  return blocks;
}

/** 单元格按显示宽度补齐 */
function padCell(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - displayWidth(s)));
}

/** 表格按显示宽度对齐：返回 [表头, 分隔线, ...数据行]；列数 × 最小宽(2) 超 columns 时返回空数组（降级信号） */
export function alignTable(headers: string[], rows: string[][], columns: number): string[] {
  const all = [headers, ...rows];
  const colCount = Math.max(1, ...all.map((r) => r.length));
  if (colCount * 2 > columns) return [];
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let w = 0;
    for (const r of all) w = Math.max(w, displayWidth(r[c] ?? ''));
    widths.push(w);
  }
  const renderRow = (cells: string[]): string =>
    '| ' + widths.map((w, c) => padCell(cells[c] ?? '', w)).join(' | ') + ' |';
  const out: string[] = [];
  out.push(renderRow(headers));
  out.push('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
  for (const r of rows) out.push(renderRow(r));
  return out;
}
