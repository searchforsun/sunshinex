/**
 * 写工具 diff 行级统计（G14 工具行改版底层）：write 落盘前后各一次行切分，LCS 长度求
 * 「增=新行-LCS / 删=旧行-LCS」，GUI 折叠行与 TUI ⎿ 行同源展示（结果串 `written +A -D`）。
 * 护栏：old×new 行数超 16M（约 4000×4000）不做 O(n·m) 展开，回 undefined——执行器回落纯
 * `written`，宁可缺 stat 不拖工具执行。
 */

/** 行切分：尾随换行不产空行（'a\nb\n' → ['a','b']） */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function writeDiffStat(oldText: string | undefined, newText: string): string | undefined {
  const newLines = splitLines(newText);
  if (oldText === undefined) return `+${newLines.length} -0`;
  const oldLines = splitLines(oldText);
  if (oldLines.length * newLines.length > 16_000_000) return undefined;
  // LCS 长度表（滚动两行省内存）：Int32Array 两行各 n+1
  let prev = new Int32Array(newLines.length + 1);
  let cur = new Int32Array(newLines.length + 1);
  for (let i = 1; i <= oldLines.length; i++) {
    for (let j = 1; j <= newLines.length; j++) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  const lcs = prev[newLines.length]!;
  return `+${newLines.length - lcs} -${oldLines.length - lcs}`;
}
