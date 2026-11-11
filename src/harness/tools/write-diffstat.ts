/**
 * 写工具 diff 行级统计（G14 工具行改版底层）：write 落盘前后各一次行切分，LCS 长度求
 * 「增=新行-LCS / 删=旧行-LCS」，GUI 折叠行与 TUI ⎿ 行同源展示（结果串 `written +A -D`）。
 * 护栏：old×new 行数超 16M（约 4000×4000）不做 O(n·m) 展开，回 undefined——执行器回落纯
 * `written`，宁可缺 stat 不拖工具执行。
 */

/** 行切分：尾随换行不产空行（'a\nb\n' → ['a','b']）；行尾 \r 剥离(2026-11-12 用户裁定「+3 -1 应为
 *  +2 -0」根因:edit 重写文件 CRLF→LF 归一,未动行成幻影 -1+1)——与 git autocrlf 同口径 */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export function writeDiffStat(oldText: string | undefined, newText: string): string | undefined {
  const counts = lineDiffCounts(oldText, newText);
  if (counts === undefined) return undefined;
  return `+${counts.added} -${counts.deleted}`;
}

/** 行级增删数值面(2026-11-10 轮次 checkpoint 消费):writeDiffStat 的数值形态单点——
 *  oldText 缺场=新建(+全行 -0),newText 缺场=删除(+0 -全行);超护栏(裁剪后 16M 格)回 undefined(宁缺 stat 不拖执行) */
export function lineDiffCounts(oldText: string | undefined, newText?: string): { added: number; deleted: number } | undefined {
  const newLines = splitLines(newText ?? '');
  if (oldText === undefined) return { added: newLines.length, deleted: 0 };
  const oldLines = splitLines(oldText);
  // 公共前后缀裁剪(2026-11-11 根修,git xdiff 同款前置):真实编辑只动中段小窗——整文件 LCS
  // (如 5954×5955≈35M 格)超护栏回 undefined=工具行无 ±/轮数字 +0-0 的根因;裁剪后 DP 只算
  // 改动窗,常规编辑不再触护栏(整文件重写仍回 undefined 宁缺勿拖)
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endO = oldLines.length;
  let endN = newLines.length;
  while (endO > start && endN > start && oldLines[endO - 1] === newLines[endN - 1]) {
    endO -= 1;
    endN -= 1;
  }
  const midOld = oldLines.slice(start, endO);
  const midNew = newLines.slice(start, endN);
  if (midOld.length * midNew.length > 16_000_000) return undefined;
  // LCS 长度表（滚动两行省内存）：Int32Array 两行各 n+1
  let prev = new Int32Array(midNew.length + 1);
  let cur = new Int32Array(midNew.length + 1);
  for (let i = 1; i <= midOld.length; i++) {
    for (let j = 1; j <= midNew.length; j++) {
      cur[j] = midOld[i - 1] === midNew[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  const lcs = prev[midNew.length]!;
  return { added: midNew.length - lcs, deleted: midOld.length - lcs };
}
