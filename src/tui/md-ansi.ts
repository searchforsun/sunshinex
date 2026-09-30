// src/tui/md-ansi.ts
import { render as mdRender } from 'markdansi';
import stringWidth from 'string-width';
import { highlightLine, HiKind } from './highlight';

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

/** 行级全角归一（中文模型全角表格符号，CommonMark 只认 ASCII；围栏内代码内容不归一） */
export function normalizeCjkLine(line: string, inFence: boolean): string {
  if (inFence) return line;
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

/** 源 markdown → ANSI 单点出口（归一 + render + 爆栈兜底）；高亮经闭包绑定（streamer options 不透传，实测定形） */
export function renderMd(src: string, width: number): string {
  return wrapAnsiLines(mdRender(normalizeMd(src), { width, highlighter: mdHighlighter }), width);
}

/** streamer 消费的 render 工厂：闭包绑定 width/highlighter（createMarkdownStreamer 的 options 不透传） */
export function createMdRender(width: number): (md: string) => string {
  return (md) => wrapAnsiLines(mdRender(normalizeMd(md), { width, highlighter: mdHighlighter }), width);
}

/** 尾部未完结构原文（动态区预览）：自尾向前找「结构起点」——已开表格的表头行 / 未闭合围栏开栏行 / 最近换行后的未完行 */
export function tailPartial(src: string): string {
  const lines = src.split('\n');
  const last = lines[lines.length - 1] ?? '';
  // 未闭合围栏：最后一个开栏行起
  let fenceIdx = -1;
  for (let i = 0; i < lines.length; i++) if (isFenceLine(lines[i]!)) fenceIdx = fenceIdx >= 0 ? -1 : i;
  if (fenceIdx >= 0) return lines.slice(fenceIdx).join('\n');
  // 已开表格（表头+分隔行成对后未闭合）：自表头行起
  for (let i = lines.length - 2; i >= 0; i--) {
    if (/^\s*[|｜]/.test(lines[i] ?? '') && /^\s*[|｜][-–—―─━－﹘＿\s:：|]+[|｜]\s*$/.test(lines[i + 1] ?? '')) {
      return lines.slice(i).join('\n');
    }
  }
  // 未完行（最后换行之后）
  return last;
}
