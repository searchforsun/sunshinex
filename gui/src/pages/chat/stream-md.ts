/**
 * 流式 markdown 块切分：空行晋升头块，但未闭合围栏不得拦腰切断——
 * 否则 ```mermaid / 代码围栏上半截成图、下半截源码外泄，围栏后正文也被拆丢。
 */

/** CommonMark 围栏开/闭行（行首最多 3 空格 + 3 及以上 ` 或 ~） */
const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** 文本是否含未闭合的 fenced code（开闭配对手算） */
export function hasUnclosedFence(md: string): boolean {
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  for (const line of md.split('\n')) {
    const m = FENCE_LINE.exec(line);
    if (m === null) continue;
    const marker = m[2]!;
    const rest = m[3] ?? '';
    if (!inFence) {
      inFence = true;
      fenceChar = marker[0]!;
      fenceLen = marker.length;
      continue;
    }
    if (marker[0] === fenceChar && marker.length >= fenceLen && rest.trim() === '') {
      inFence = false;
    }
  }
  return inFence;
}

/** 最后一个不落在未闭合围栏内的空行切分；无安全切点则整段进尾块 */
export function streamMdCut(md: string): { head: string; tail: string } {
  let cut = md.lastIndexOf('\n\n');
  while (cut >= 0) {
    const head = md.slice(0, cut);
    if (!hasUnclosedFence(head)) {
      return { head, tail: md.slice(cut).replace(/^\n+/, '') };
    }
    cut = md.lastIndexOf('\n\n', cut - 1);
  }
  return { head: '', tail: md };
}

/** 在途图片占位 src(MdImage 识别为「语法未写完」→ 占位框,不触发读文件) */
export const PENDING_IMAGE_SRC = 'sx-pending-image:';

/** 尾部未写完的图片语法(`![alt`/`![alt](路径` 截至文末,不跨行) */
const PARTIAL_IMAGE_TAIL = /!\[([^\]\n]*)(\](\([^)\n]*)?)?$/;

/** 流式尾块图片语法收口(2026-11-07 用户报障「正文图片中间出现 md 链接原文」):`![alt](路径` 未闭合
 *  期间 CommonMark 不认图片,原文逐字外露——替换为占位图(alt 已写完则保留);末字符单个 `!` 可能
 *  是图片起笔,先藏一帧。未闭合围栏内/行内反引号内的文本是代码,原样保留 */
export function sealPartialImage(tail: string): string {
  if (hasUnclosedFence(tail)) return tail;
  const lineStart = tail.lastIndexOf('\n') + 1;
  const inInlineCode = (at: number): boolean => ((tail.slice(lineStart, at).match(/`/g) ?? []).length % 2) === 1;
  const m = PARTIAL_IMAGE_TAIL.exec(tail);
  if (m !== null && !inInlineCode(m.index)) {
    const alt = m[2] !== undefined ? m[1]! : '';
    return `${tail.slice(0, m.index)}![${alt}](${PENDING_IMAGE_SRC})`;
  }
  if (tail.endsWith('!') && !inInlineCode(tail.length - 1)) return tail.slice(0, -1);
  return tail;
}
