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
