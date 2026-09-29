import CliTable3 from 'cli-table3';
import { displayWidth, wrapByWidth } from './text-band';
import MarkdownIt from 'markdown-it';

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
  | { type: 'list'; ordered: boolean; items: MdInline[][]; start?: number }
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

// 未闭合围栏：流式生成中开栏行即围栏开始（下游按围栏体即时高亮渲染），原样透传
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
        // 未闭合围栏：原样透传，由 parseFence 按围栏开始处理（流式生成中即时高亮渲染）
        for (let k = i; k < lines.length; k++) out.push(lines[k]);
        i = lines.length;
      }
      continue;
    }
    // 全角表格符号归一（2026-09-30「表格没了」二期实锤）：中文模型常发出全角管道/破折号分隔行
    // （|───|───|、|———|———|、|－－－|－－－|），CommonMark 只认 ASCII 竖线与连字符——
    // 不归一即整表降级裸文本（探针五分隔线变体实测：ASCII 渲染成表、全角变体全裸）。
    // 管道行内：全角管道 → |、破折号系 → -；仅含管道/空格/破折号/冒号（任意宽度）的行即分隔行，
    // 全角冒号对齐标记一并归一。围栏内不经过此分支（上方已整块透传），代码内容零误伤
    if (/^\s*[｜|]/.test(line)) {
      // 管道行内全角冒号（对齐标记 ：---/---：）别无语义，并入无条件归一
      const normalized = line.replace(/｜/g, '|').replace(/[—–―─━－﹘]/g, '-').replace(/：/g, ':');
      out.push(normalized);
      i++;
      continue;
    }
    // 全角空格/零宽字符等不可见空白行归一为空行：CommonMark 空白行判定只认 ASCII 空白，
    // 中文模型按全角空格排版时空行被当正文逐行渲染成大段空白（2026-09-28 真机「结论与表格间大段空白」病根）
    if (/^[\s\u3000\u200B\u200C\u200D\uFEFF]+$/.test(line)) {
      out.push('');
      i++;
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

/** 列表块 → items（嵌套 list 平铺进 items，保持 IR 扁平形状）；start=有序列表真实首号
 *  （markdown-it start 属性，首号 ≠1 时在位）——逐行流式分裂的列表续块据此承接真实编号 */
function parseListBlock(tokens: MdToken[], i: number): { ordered: boolean; items: MdInline[][]; start?: number; next: number } {
  const open = tokens[i];
  const ordered = open.type === 'ordered_list_open';
  const closeType = ordered ? 'ordered_list_close' : 'bullet_list_close';
  const level = open.level;
  const startAttr = ordered ? open.attrGet('start') : null;
  // markdown-it 版本差异：start 属性可能存 string 或 number（attrSet 侧决定），两态都收
  const start = startAttr !== null && startAttr !== undefined && /^\d+$/.test(String(startAttr)) ? Number(startAttr) : undefined;
  const items: MdInline[][] = [];
  let j = i + 1;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.type === closeType && t.level === level) return { ordered, items, start, next: j + 1 };
    if (t.type === 'list_item_open') {
      const item = parseListItem(tokens, j + 1, t.level);
      items.push(item.inlines, ...item.nested);
      j = item.next;
      continue;
    }
    j++;
  }
  return { ordered, items, start, next: j };
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
      blocks.push({ type: 'list', ordered: res.ordered, items: res.items, ...(res.start !== undefined ? { start: res.start } : {}) });
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

/** 单元格规范化：去 VS16 变体选择符。⚠️/❤️ 等含 VS16 的歧义宽 emoji，string-width 记宽 2 而
 * Windows 控制台等终端按窄字符渲染，测量与显示不一致会导致表格边框错位；表格内统一按文本呈现（宽 1） */
export function stripVariationSelector(s: string): string {
  return s.replace(/\uFE0F/g, '');
}

/** 表格边框：圆角 box-drawing（对标 Claude Code 输出风格），着色由渲染层负责，此处只出素字符 */
const TABLE_CHARS = {
  top: '─',
  'top-mid': '┬',
  'top-left': '╭',
  'top-right': '╮',
  bottom: '─',
  'bottom-mid': '┴',
  'bottom-left': '╰',
  'bottom-right': '╯',
  left: '│',
  'left-mid': '├',
  mid: '─',
  'mid-mid': '┼',
  right: '│',
  'right-mid': '┤',
  middle: '│',
};

/** 表格按显示宽度对齐（cli-table3 + string-width，与 ink 测量同源）：返回 [顶边框, 表头, 表头分隔线,
 * 数据行（行间以实线分隔）, 底边框]；空表头或列数 × 最小宽(2) 超 columns 时返回空数组（降级信号，渲染层回退逐行原文） */
export function alignTable(headers: string[], rows: string[][], columns: number): string[] {
  const colCount = headers.length;
  if (colCount === 0 || colCount * 2 > columns) return [];
  const build = (hs: string[], rs: string[][]): string[] => {
    const table = new CliTable3({ head: hs, style: { head: [], border: [] }, chars: TABLE_CHARS });
    for (const r of rs) table.push(r);
    return table.toString().split('\n');
  };
  const h = headers.map(stripVariationSelector);
  const r = rows.map((row) => row.map((c) => stripVariationSelector(c ?? '')));
  const lines = build(h, r);
  const widest = lines.reduce((m, l) => Math.max(m, displayWidth(l)), 0);
  if (widest <= columns) return lines;
  // 超宽：按列内容需求比例分配预算，单元格按显示宽度预折行（cli-table3 以多行单元格绘制，框线与行间分隔保持完整）
  const inner = columns - (colCount + 1) - colCount * 2;
  if (inner < colCount * 4) return []; // 预算过小仍降级（渲染层回退逐行原文）
  const MIN_COL = 4;
  const needs = h.map((_, c) => {
    let m = displayWidth(h[c] ?? '');
    for (const row of r) m = Math.max(m, displayWidth(row[c] ?? ''));
    return Math.max(MIN_COL, m);
  });
  const needSum = needs.reduce((a, b) => a + b, 0);
  let widths = needs;
  if (needSum > inner) {
    // 等比压缩后若仍超预算（小列被 MIN_COL 托底抬高），从最宽列逐字符回收，保证总宽硬上限
    widths = needs.map((n) => Math.max(MIN_COL, Math.floor((n / needSum) * inner)));
    let sum = widths.reduce((a, b) => a + b, 0);
    while (sum > inner) {
      let maxI = 0;
      for (let c = 1; c < widths.length; c++) if (widths[c] > widths[maxI]) maxI = c;
      if (widths[maxI] <= MIN_COL) break;
      widths[maxI] -= 1;
      sum -= 1;
    }
  }
  const wrapCell = (cell: string, c: number): string =>
    cell.split('\n').flatMap((seg) => wrapByWidth(seg, widths[c])).join('\n');
  return build(h.map(wrapCell), r.map((row) => row.map(wrapCell)));
}

/** Markdown 正文渲染行数估算（与 MarkdownText 渲染规则同源单点）：块间空行档位（i>0 的 marginTop 1）、
 *  表格按 alignTable 实际框线行数（降级与渲染层回退逐行原文同口径）、围栏按代码行数、散文按列宽折行——
 *  折行预算收 2 列安全余量吸收 ink 断行边界差。视口预算消费此口径，估算低估即帧超高溢出动态区
 *  （残影/内容两遍观感，2026-09-28 全屏视图真机病根）。columns 为渲染列宽 */
export function markdownRowCount(text: string, columns: number): number {
  const blocks = parseMarkdown(text);
  const safe = Math.max(4, columns - 2);
  const wrapCount = (s: string): number =>
    s.split('\n').reduce((n, l) => n + wrapByWidth(l, safe).length, 0);
  let total = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (i > 0) total += 1; // 块间空行档位
    switch (b.type) {
      case 'heading':
      case 'paragraph':
        total += wrapCount(inlineText(b.inlines));
        break;
      case 'fence':
        // 与 Fence 渲染同源（2026-09-30 崩溃根治）：代码行也按列宽硬折，长 minified 行的估算不低估
        total += Math.max(1, b.code.split('\n').reduce((n, l) => n + wrapByWidth(l, safe).length, 0));
        break;
      case 'list':
        for (const item of b.items) total += wrapCount(inlineText(item));
        break;
      case 'quote':
        total += wrapCount(inlineText(b.inlines));
        break;
      case 'table': {
        const headers = b.headers.map(inlineText);
        const rows = b.rows.map((row) => row.map(inlineText));
        const aligned = alignTable(headers, rows, columns);
        total +=
          aligned.length > 0
            ? aligned.length
            : [headers, ...rows]
                .map((cells) => wrapCount(cells.join(' | ')))
                .reduce((sum, n) => sum + n, 0);
        break;
      }
      case 'hr':
        total += 1;
        break;
    }
  }
  return Math.max(1, total);
}
