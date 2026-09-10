import MarkdownIt from 'markdown-it';
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

/** markdown-it 解析器实例：关闭链接/图片/HTML/自动链接/引用定义/setext 标题，保留目标语法子集 */
const md = new MarkdownIt().disable([
  'link',
  'image',
  'html_inline',
  'html_block',
  'autolink',
  'linkify',
  'reference',
  'lheading',
]);

/** markdown-it token 类型（从实例方法返回值推导，规避 CJS 命名空间类型访问差异） */
type MdToken = ReturnType<typeof md.parse>[number];

/** 找到与 open 配对的 close token 下标（处理同型嵌套）；未找到返回 children.length */
function findClose(children: MdToken[], start: number, openType: string, closeType: string): number {
  let depth = 1;
  for (let i = start; i < children.length; i++) {
    const t = children[i];
    if (t.type === openType) depth++;
    else if (t.type === closeType) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return children.length;
}

/** 行内 token 序列 → MdInline[]（递归下降，处理 strong/em/s 的 open/close 配对） */
function inlineChildrenToMdInline(children: MdToken[]): MdInline[] {
  const out: MdInline[] = [];
  let i = 0;
  while (i < children.length) {
    const t = children[i];
    if (t.type === 'text') {
      if (t.content) out.push({ kind: 'text', text: t.content });
      i++;
      continue;
    }
    if (t.type === 'code_inline') {
      out.push({ kind: 'code', text: t.content });
      i++;
      continue;
    }
    if (t.type === 'softbreak' || t.type === 'hardbreak') {
      out.push({ kind: 'text', text: '\n' });
      i++;
      continue;
    }
    if (t.type === 'strong_open') {
      const end = findClose(children, i + 1, 'strong_open', 'strong_close');
      out.push({ kind: 'bold', children: inlineChildrenToMdInline(children.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (t.type === 'em_open') {
      const end = findClose(children, i + 1, 'em_open', 'em_close');
      out.push({ kind: 'italic', children: inlineChildrenToMdInline(children.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (t.type === 's_open') {
      const end = findClose(children, i + 1, 's_open', 's_close');
      out.push({ kind: 'strike', children: inlineChildrenToMdInline(children.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    // 其它 token（link/image 已关闭，理论不出现）：透传 content
    if (t.content) out.push({ kind: 'text', text: t.content });
    i++;
  }
  return out;
}

/** 行内解析：委托 markdown-it（未闭合标记由 markdown-it 自动按字面回退，不吞字） */
export function parseInline(text: string): MdInline[] {
  const tokens = md.parseInline(text, {});
  const inline = tokens.find((t) => t.type === 'inline');
  return inline && inline.children ? inlineChildrenToMdInline(inline.children) : [];
}

/** 转义围栏符（``` / ~~~），使 markdown-it 将其视为普通段落文本（未闭合围栏降级用） */
function escapeFence(line: string): string {
  return line.replace(/(```|~~~)/, (m) => m.split('').map((c) => '\\' + c).join(''));
}

/** 预处理：补偿 markdown-it 不覆盖的 spec 语义（顿号列表、七级标题归 6、未闭合围栏降级段落） */
function preprocess(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 围栏：整块原样跳过（已闭合）或转义开栏行整体降级（未闭合），避免内容被后续规则误改
    const fence = /^\s*(```|~~~)\s*(.*)$/.exec(line);
    if (fence) {
      const fenceChar = fence[1];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (lines[j].trim().startsWith(fenceChar)) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        for (let k = i; k <= j; k++) out.push(lines[k]);
        i = j + 1;
      } else {
        out.push(escapeFence(line));
        for (let k = i + 1; k < lines.length; k++) out.push(lines[k]);
        i = lines.length;
      }
      continue;
    }
    // 统一无序列表 marker（`* `/`+ ` → `- `），避免 markdown-it 按 marker 拆分多个 list
    const ul = /^(\s*)[*+]\s+/.exec(line);
    if (ul) {
      out.push(`${ul[1]}- ${line.slice(ul[0].length)}`);
      i++;
      continue;
    }
    // 顿号有序列表：`3、丙` → `3. 丙`（英文点号需空格才被 markdown-it 识别）
    const dn = /^(\s*)(\d+)、\s*(.*)$/.exec(line);
    if (dn) {
      out.push(`${dn[1]}${dn[2]}. ${dn[3]}`);
      i++;
      continue;
    }
    // 七级及以上标题：`#######` → `######`（级别归 6）
    const h7 = /^(\s*)#{7,}\s+(.*)$/.exec(line);
    if (h7) {
      out.push(`${h7[1]}###### ${h7[2]}`);
      i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

/** 列表块 → items（嵌套 list 平铺进 items，保持 IR 扁平形状） */
function parseListBlock(tokens: MdToken[], i: number): { ordered: boolean; items: MdInline[][]; next: number } {
  const open = tokens[i];
  const ordered = open.type === 'ordered_list_open';
  const closeType = ordered ? 'ordered_list_close' : 'bullet_list_close';
  const level = open.level;
  const items: MdInline[][] = [];
  let j = i + 1;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.type === closeType && t.level === level) return { ordered, items, next: j + 1 };
    if (t.type === 'list_item_open') {
      const item = parseListItem(tokens, j + 1, t.level);
      items.push(item.inlines, ...item.nested);
      j = item.next;
      continue;
    }
    j++;
  }
  return { ordered, items, next: j };
}

/** 列表项 → 正文 inline（取首个 inline，跳过其内部嵌套 list） */
function parseListItem(tokens: MdToken[], i: number, itemLevel: number): { inlines: MdInline[]; nested: MdInline[][]; next: number } {
  let inlines: MdInline[] = [];
  const nested: MdInline[][] = [];
  let gotInline = false;
  let j = i;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.type === 'list_item_close' && t.level === itemLevel) return { inlines, nested, next: j + 1 };
    if (t.type === 'inline' && !gotInline && t.children) {
      inlines = inlineChildrenToMdInline(t.children);
      gotInline = true;
    } else if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
      const sub = parseListBlock(tokens, j);
      nested.push(...sub.items);
      j = sub.next;
      continue;
    }
    j++;
  }
  return { inlines, nested, next: j };
}

/** 引用块 → 合并多行 inline（softbreak 已转 \n，多段之间补 \n） */
function parseBlockquote(tokens: MdToken[], i: number): { inlines: MdInline[]; next: number } {
  const level = tokens[i].level;
  const inlines: MdInline[] = [];
  let j = i + 1;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.type === 'blockquote_close' && t.level === level) break;
    if (t.type === 'inline' && t.children) {
      if (inlines.length > 0) inlines.push({ kind: 'text', text: '\n' });
      inlines.push(...inlineChildrenToMdInline(t.children));
    }
    j++;
  }
  while (j < tokens.length && !(tokens[j].type === 'blockquote_close' && tokens[j].level === level)) j++;
  return { inlines, next: j + 1 };
}

/** 表格块 → headers/rows */
function parseTableBlock(tokens: MdToken[], i: number): { headers: MdInline[][]; rows: MdInline[][][]; next: number } {
  const level = tokens[i].level;
  const headers: MdInline[][] = [];
  const rows: MdInline[][][] = [];
  let currentRow: MdInline[][] = [];
  let inHeader = false;
  let j = i + 1;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.type === 'table_close' && t.level === level) break;
    if (t.type === 'thead_open') inHeader = true;
    else if (t.type === 'tbody_open') inHeader = false;
    else if (t.type === 'tr_open') currentRow = [];
    else if (t.type === 'tr_close') {
      if (inHeader) headers.push(...currentRow);
      else rows.push(currentRow);
    } else if (t.type === 'th_open' || t.type === 'td_open') {
      const inline = tokens[j + 1];
      if (inline && inline.type === 'inline' && inline.children) currentRow.push(inlineChildrenToMdInline(inline.children));
    }
    j++;
  }
  while (j < tokens.length && !(tokens[j].type === 'table_close' && tokens[j].level === level)) j++;
  return { headers, rows, next: j + 1 };
}

/** 解析 Markdown 为块序列（纯函数，零 IO）；未闭合围栏由预处理降级为段落（流式容错） */
export function parseMarkdown(text: string): MdBlock[] {
  const tokens = md.parse(preprocess(text), {});
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'heading_open') {
      const level = Math.min(Number(t.tag.slice(1)), 6) as 1 | 2 | 3 | 4 | 5 | 6;
      const inline = tokens[i + 1];
      blocks.push({ type: 'heading', level, inlines: inline && inline.children ? inlineChildrenToMdInline(inline.children) : [] });
      i += 3;
      continue;
    }
    if (t.type === 'paragraph_open') {
      const inline = tokens[i + 1];
      blocks.push({ type: 'paragraph', inlines: inline && inline.children ? inlineChildrenToMdInline(inline.children) : [] });
      i += 3;
      continue;
    }
    if (t.type === 'fence') {
      blocks.push({ type: 'fence', lang: t.info ?? '', code: t.content.replace(/\n$/, '') });
      i += 1;
      continue;
    }
    if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
      const res = parseListBlock(tokens, i);
      blocks.push({ type: 'list', ordered: res.ordered, items: res.items });
      i = res.next;
      continue;
    }
    if (t.type === 'blockquote_open') {
      const res = parseBlockquote(tokens, i);
      blocks.push({ type: 'quote', inlines: res.inlines });
      i = res.next;
      continue;
    }
    if (t.type === 'table_open') {
      const res = parseTableBlock(tokens, i);
      blocks.push({ type: 'table', headers: res.headers, rows: res.rows });
      i = res.next;
      continue;
    }
    if (t.type === 'hr') {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }
    i++;
  }
  return blocks;
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
