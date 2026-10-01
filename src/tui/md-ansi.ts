// src/tui/md-ansi.ts
import { render as mdRender } from 'markdansi';
import stringWidth from 'string-width';
import { highlightLine, HiKind } from './highlight';
import { alignTable, inlineText, parseMarkdown } from './markdown';
import { displayWidth } from './text-band';

/** HiKind → SGR 前景码（与 MarkdownText HI_COLOR 同色系：magenta/green/gray/yellow） */
const HI_SGR: Record<HiKind, string> = {
  keyword: '\x1b[35m', string: '\x1b[32m', comment: '\x1b[90m', number: '\x1b[33m', plain: '',
};

/** markdansi highlighter 适配：行级 HiSpan → ANSI 着色文本 */
function mdHighlighter(code: string, lang?: string): string {
  return code
    .split('\n')
    .map((l) => highlightLine(lang ?? '', l).map((s) => `${HI_SGR[s.kind]}${s.text}${s.kind === 'plain' ? '' : '\x1b[0m'}`).join(''))
    .join('\n');
}

/** 剥 ANSI 转义（SGR 与光标类） */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
}

export function ansiLineCount(fragment: string): number {
  return stripAnsi(fragment).replace(/\n$/, '').split('\n').length;
}

/** ANSI 安全按显示宽折行（爆栈护栏：无空格超长 token markdansi 段落不折、ink Static yoga 计宽即 RangeError） */
export function wrapAnsiLines(fragment: string, width: number): string {
  return fragment
    .split('\n')
    .flatMap((l) => (stringWidth(stripAnsi(l)) <= width ? [l] : hardSlice(l, width)))
    .join('\n');
}

/** 单遍按显示宽切块：转义序列原子搬运（不切半截码）、代理对不拆；切块后不回补 SGR 开码（护栏路径，仅无空格超长 token 触发） */
function hardSlice(line: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  let curWidth = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      // CSI 序列（ESC [ 参数... 字母）整段搬运；非 CSI 的孤 ESC 单字符保留
      let j = i + 1;
      if (line[j] === '[') {
        j += 1;
        while (j < line.length && ((line[j]! >= '0' && line[j]! <= '9') || line[j] === ';')) j += 1;
        if (j < line.length && /[a-zA-Z]/.test(line[j]!)) j += 1;
      }
      cur += line.slice(i, j);
      i = j;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = stringWidth(ch);
    if (curWidth > 0 && curWidth + w > width) {
      out.push(cur);
      cur = '';
      curWidth = 0;
    }
    cur += ch;
    curWidth += w;
    i += ch.length;
  }
  if (cur.length > 0 || out.length === 0) out.push(cur);
  return out;
}

/** 行级全角归一（中文模型全角表格符号，CommonMark 只认 ASCII；围栏内代码内容不归一）。
 *  第二条规则（终审 F2，承接旧 markdown.ts preprocess 2026-09-28 真机修复）：仅含全角空格/零宽字符等
 *  不可见空白的行归一为空行——CommonMark 空白行判定只认 ASCII 空白，中文模型按全角空格排版时
 *  这类行被当正文逐行渲染（renderMd 面段落合并 / 大段空白病根）。
 *  行域语义（N1 补丁）：流式路径（session.mdConsume）逐行**带尾 \n** 喂入，而 \s 含 \n——整行测正则会
 *  连尾换行一起吞成 ''，空行不达 streamer（markdansi push('') no-op）→ 表格 flushTable 失效、段落粘连。
 *  故先剥尾 \n 只测行体，命中回补 '\n'（无尾换行的源级调用 normalizeMd 保持 ''），行域不塌 */
export function normalizeCjkLine(line: string, inFence: boolean): string {
  if (inFence) return line;
  const body = line.endsWith('\n') ? line.slice(0, -1) : line;
  if (/^[\s\u3000\u200B\u200C\u200D\uFEFF]+$/.test(body)) return body === line ? '' : '\n';
  if (!/^\s*[｜|]/.test(line)) return line;
  return line.replace(/｜/g, '|').replace(/[—–―─━－﹘]/g, '-').replace(/：/g, ':');
}

export function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/** 源级归一：逐行喂入 normalizeCjkLine，isFenceLine 跟踪围栏开闭（开栏行本身非表格行，归一无副作用） */
function normalizeMd(src: string): string {
  let inFence = false;
  return src
    .split('\n')
    .map((l) => {
      const fence = isFenceLine(l);
      const out = normalizeCjkLine(l, inFence);
      if (fence) inFence = !inFence;
      return out;
    })
    .join('\n');
}

/** 主题覆盖（2026-09-30 用户裁决）：标题/表头不再用黄色（与系统警告 warn 撞色），与加粗正文同色系 */
const RENDER_THEME = { heading: { bold: true }, tableHeader: { bold: true } };

/** 正文行距档位（2026-10-01 用户裁决三连：「增加一定的行距」→「不同区域不同行距，整体协调」→
 *  「有序列表还是有多余的行距」终裁）：prose 逻辑行间插入的空行数——按区域分级施加：**列表项
 *  （无序与有序同档）紧排成组**（同类枚举聚拢），段落/标题/引用行间单空行（论述呼吸）。
 *  代码/表格整段豁免。1 = 分区单空行档；0 = 全紧排。全局唯一档位，调此一处 */
export const BODY_LINE_SPACING = 1;

/** 列表项判定（wrap:false 逻辑行，marker 尚为源形态 `- `/`1. `/`[ ] `；SGR 前缀容差、嵌套缩进容差）。
 *  返回 marker 类别（ul/ol/task）——紧排分组的成员资格 = 连续两个**同类**列表项；异类组相邻即
 *  不同区域（源里本以空行分块），插行距档 */
function listKindOf(line: string): 'ul' | 'ol' | 'task' | undefined {
  const plain = stripAnsi(line);
  if (/^\s*[-+•*]\s/.test(plain)) return 'ul';
  if (/^\s*\d{1,3}[.)]\s/.test(plain)) return 'ol';
  if (/^\s*\[[ xX]\]\s/.test(plain)) return 'task';
  return undefined;
}

/** 续行悬挂缩进：列表项（• /- /n.，SGR 前缀容差）按 marker 实宽悬挂、任务项随 `[ ] ` 4 格、
 *  引用行随前缀 2 格、其余顶格 */
function hangingIndentOf(line: string): number {
  const plain = stripAnsi(line);
  const lead = /^\s*/.exec(plain)![0];
  const item = /^(\s*)(?:• |- |\d{1,3}\. |\[[ xX]\] )/.exec(plain);
  if (item) return displayWidth(item[0]);
  if (/^\s*│/.test(plain)) return displayWidth(lead) + 2;
  return 0;
}

/** ANSI 安全软折（2026-10-01 行距律配套）：markdansi wrap:false 出逻辑行后按真实列宽回折——
 *  SGR 序列零宽原子搬运（与 hardSlice 同扫描器，不切半截码）；断点=空白后或宽字符（CJK/全角/emoji）
 *  边界（拉丁词内不断、CJK 字间/中英之间可断）；无断点超宽词回退逐字硬切（爆栈护栏语义不变）。
 *  indent 为续行悬挂缩进（列表项续行对齐项文） */
export function softWrapAnsi(line: string, width: number, indent = 0): string[] {
  if (width <= 0 || displayWidth(stripAnsi(line)) <= width) return [line];
  const pad = ' '.repeat(Math.max(0, indent));
  const lines: string[] = [];
  let cur = pad;
  let curW = Math.max(0, indent);
  let breakAt = -1; // cur 内最近可断点（code unit 下标；其前入行、其后随续行）
  let prevW = 0; // 前一可见图素簇宽（宽字符边界判定）
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      let j = i + 1;
      if (line[j] === '[') {
        j += 1;
        while (j < line.length && ((line[j]! >= '0' && line[j]! <= '9') || line[j] === ';')) j += 1;
        if (j < line.length && /[a-zA-Z]/.test(line[j]!)) j += 1;
      }
      cur += line.slice(i, j);
      i = j;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = stringWidth(ch);
    if (curW > Math.max(0, indent) && curW + w > width) {
      if (breakAt >= 0) {
        lines.push(cur.slice(0, breakAt).replace(/ +$/, ''));
        const rest = cur.slice(breakAt);
        cur = pad + rest;
        curW = Math.max(0, indent) + displayWidth(stripAnsi(rest));
      } else {
        lines.push(cur);
        cur = pad;
        curW = Math.max(0, indent);
      }
      breakAt = -1;
      prevW = 0;
    }
    cur += ch;
    curW += w;
    if (ch === ' ') breakAt = cur.length;
    else if (w >= 2) breakAt = cur.length - ch.length; // 宽字符前可断（CJK 字间/中英之间）
    prevW = w;
    i += ch.length;
  }
  lines.push(cur);
  return lines;
}

/** prose 段渲染（2026-10-01 正文行距律·分区版）：wrap:false 出逻辑行（markdansi 不自行折行，段落/
 *  列表项/标题/引用各自单行）→ 行间档位按区域判定：连续列表项（不分有序无序）之间紧排（\n，
 *  同类枚举聚拢成组）、其余相邻逻辑行之间 BODY_LINE_SPACING 档空行（段落/标题/引用呼吸）→
 *  softWrapAnsi 按真实列宽回折（续行归属同逻辑组，折行不进行距节奏；列表项续行悬挂对齐项文）→
 *  `• ` 标记替换。产物不带尾换行——段间空行由 renderSource 拼接承担，主路径尾 \n 由 mdPushFragment
 *  归一补齐（子代理视图裸用产物，尾随空行即双行距病根），空段返回 ''（不出孤边距） */
function renderProseSegment(src: string, width: number): string {
  const rendered = mdRender(normalizeMd(src), { wrap: false, highlighter: mdHighlighter, theme: RENDER_THEME });
  const logicals = rendered.split('\n').filter((l) => stripAnsi(l).trim().length > 0);
  if (logicals.length === 0) return '';
  const sepSpaced = '\n'.repeat(1 + BODY_LINE_SPACING);
  let spaced = '';
  let prevKind: 'ul' | 'ol' | 'task' | undefined;
  for (const l of logicals) {
    const wrapped = softWrapAnsi(l, width, hangingIndentOf(l)).join('\n');
    const kind = listKindOf(l);
    if (spaced.length > 0) spaced += kind !== undefined && kind === prevKind ? '\n' : sepSpaced;
    spaced += wrapped;
    prevKind = kind;
  }
  return spaced.replace(/^(\s*)(?:\[[0-9;]*[a-zA-Z])*- /gm, '$1• ');
}

/** markdansi 段渲染（围栏区专用，wrap:true 真宽折行——codeBox 完好、长代码行盒内折）：归一 + 主题 +
 *  高亮 + 爆栈兜底。无序列表标记 - → •（2026-09-30 用户裁决「通用点」）：渲染输出侧行首替换
 *  （ANSI 容忍——listMarker 可能着色码在前）；代码盒内容行有 │ 前缀不受影响 */
function renderMdRun(src: string, width: number): string {
  const out = wrapAnsiLines(mdRender(normalizeMd(src), { width, highlighter: mdHighlighter, theme: RENDER_THEME }), width);
  return out.replace(/^(\s*)(?:\[[0-9;]*[a-zA-Z])*- /gm, '$1• ');
}

/** 表格区网格渲染（2026-09-30 用户裁决「不只是表头有横线」）：markdansi 表格只有表头分隔线，
 *  且截断/换行二选一——表格区回路由旧 alignTable（全网格 + 单元格换行，子代理视图验证过的形态） */
function renderGridTable(src: string, width: number): string {
  const blocks = parseMarkdown(normalizeMd(src));
  const t = blocks.find((b) => b.type === 'table');
  if (!t) return renderProseSegment(src, width);
  const headers = t.headers.map(inlineText);
  const rows = t.rows.map((r) => r.map(inlineText));
  const aligned = alignTable(headers, rows, Math.max(20, width));
  if (aligned.length === 0) return renderProseSegment(src, width);
  return aligned.join('\n') + '\n';
}

function isDividerLine(line: string): boolean {
  return /^\s*\|[\s:\-|]*\|\s*$/.test(line);
}

/** 源 markdown → ANSI 单点出口（区域路由：表格区网格渲染、其余 markdansi；围栏内不参与路由）。
 *  标题/表头主题覆盖见 RENDER_THEME；爆栈兜底 wrapAnsiLines */
export function renderMd(src: string, width: number): string {
  return renderSource(src, width);
}

/** streamer 消费的 render 工厂：width 支持函数动态求值（streamer 只在首个 reply 块创建一次，
 *  静态捕获会冻结创建时宽度——真机「表格被截断且只占半屏」实锤：宽终端下表格按冻结的窄宽截断） */
export function createMdRender(width: number | (() => number)): (md: string) => string {
  return (md) => renderSource(md, typeof width === 'function' ? width() : width);
}

/** 分割线判定（CommonMark hr：3+ 同字符独占一行；表格分隔行以竖线开头不受影响、围栏内不参与路由） */
function isHrLine(line: string): boolean {
  return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function renderSource(src: string, width: number): string {
  const lines = src.split('\n');
  type Seg = { kind: 'table' | 'prose' | 'fence' | 'hr'; lines: string[] };
  const segs: Seg[] = [];
  let inFence = false;
  for (const line of lines) {
    // 围栏行（开/闭）与围栏体独立成段（2026-10-01 行距律：代码不是正文，不进行距重排——
    // 照旧 wrap:true 真宽整块渲染，codeBox 完好、长代码行盒内折）；行距只作用 prose 段
    const isFence = isFenceLine(line);
    const cls: Seg['kind'] = isFence || inFence
      ? 'fence'
      : isHrLine(line)
        ? 'hr'
        : /^\s*[|｜]/.test(line)
          ? 'table'
          : 'prose';
    if (isFence) inFence = !inFence;
    const last = segs[segs.length - 1];
    if (last && last.kind === cls) last.lines.push(line);
    else segs.push({ kind: cls, lines: [line] } as Seg);
  }
  const parts = segs.map((seg) => {
    const text = seg.lines.join('\n');
    if (seg.kind === 'fence') return renderMdRun(text, width);
    if (seg.kind === 'hr') {
      // markdansi 分割线带 HR_WIDTH=40 硬上限且用 em-dash——自绘全宽盒线（与 MarkdownText hr 同形态：dim + ─×宽）
      return `\x1b[2m${'─'.repeat(Math.max(1, width))}\x1b[0m`;
    }
    if (seg.kind !== 'table') return renderProseSegment(text, width);
    // 纯管道行 ≥2 且第二行为分隔行才是 GFM 表格；否则（孤行/畸形）按 prose 走行距律原样呈现
    const normalized = seg.lines.map((l) => normalizeCjkLine(l, false));
    if (normalized.length >= 2 && isDividerLine(normalized[1] ?? '')) return renderGridTable(normalized.join('\n'), width);
    return renderProseSegment(normalized.join('\n'), width);
  });
  // 段间以单空行拼（段内行距律不受影响）；出参不带尾换行——主路径由 mdPushFragment 归一补齐，
  // 子代理视图（ChildTranscript/ChildInspector）裸用产物，尾随空行即双行距病根（2026-10-01）
  return parts
    .filter((p) => p.length > 0)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '');
}

/** 尾部未完结构原文（动态区预览）：自尾向前找「结构起点」——已开表格的表头行 / 未闭合围栏开栏行 / 最近换行后的未完行 */
