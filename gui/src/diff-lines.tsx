import { useMemo } from 'react';
import { highlightCode } from './highlight';

/**
 * G14.51 自绘行级 diff(工具行内嵌消费;替代 Monaco——编辑器 chrome 太脏):
 * 行号列 + 左缘变动色条 + 逐行语法高亮;高度=内容高,maxHeight 封顶内滚(项目风滚动条)。
 * 算法=前后缀裁剪(公共头尾 same,中段 del+add 块)——工具写场景(整写/局部改)形态干净;
 * 超长内容 >800 行截断(与 Files 截断同纪律),行号照常连续。
 */

export interface DiffRow {
  kind: 'same' | 'add' | 'del';
  text: string;
  numOld?: number;
  numNew?: number;
}

const MAX_ROWS = 800;

export function diffRows(oldText: string, newText: string): { rows: DiffRow[]; truncated: boolean } {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let endA = a.length;
  let endB = b.length;
  while (endA > 0 && endB > 0 && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  let start = 0;
  while (start < endA && start < endB && a[start] === b[start]) start += 1;
  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i += 1) rows.push({ kind: 'same', text: a[i] ?? '', numOld: i + 1, numNew: i + 1 });
  for (let i = start; i < endA; i += 1) rows.push({ kind: 'del', text: a[i] ?? '', numOld: i + 1 });
  for (let j = start; j < endB; j += 1) rows.push({ kind: 'add', text: b[j] ?? '', numNew: j + 1 });
  for (let k = 0; endA + k < a.length; k += 1) {
    rows.push({ kind: 'same', text: a[endA + k] ?? '', numOld: endA + k + 1, numNew: endB + k + 1 });
  }
  const truncated = rows.length > MAX_ROWS;
  return { rows: truncated ? rows.slice(0, MAX_ROWS) : rows, truncated };
}

export function DiffLines({ oldStr, newStr, path, maxHeight = 280 }: { oldStr?: string; newStr: string; path?: string; maxHeight?: number }): JSX.Element {
  const { rows, truncated } = useMemo(() => diffRows(oldStr ?? '', newStr), [oldStr, newStr]);
  return (
    <div className="diff-lines" style={{ maxHeight }} aria-label="diff lines">
      {rows.map((r, i) => (
        <div key={i} className={`diff-line ${r.kind}`}>
          <span className="diff-mark" aria-hidden="true" />
          <span className="diff-ln" aria-hidden="true">{r.kind === 'del' ? r.numOld : r.numNew}</span>
          <span className="diff-code">
            <code dangerouslySetInnerHTML={{ __html: highlightCode(r.text, path) }} />
          </span>
        </div>
      ))}
      {truncated && <div className="diff-line trunc">…</div>}
    </div>
  );
}
