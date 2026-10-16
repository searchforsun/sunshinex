import { t } from './i18n';
import { useMemo, useState } from 'react';
import { ChevronUp, MoreHorizontal } from 'lucide-react';
import { highlightCode } from './highlight';

/**
 * G14.51 自绘行级 diff(工具行内嵌消费;替代 Monaco——编辑器 chrome 太脏):
 * 行号列 + 左缘变动色条 + 逐行语法高亮;高度=内容高,maxHeight 封顶内滚(项目风滚动条)。
 * 超长内容 >800 行截断(与 Files 截断同纪律),行号照常连续。
 * G14.109 折叠:连续 unchanged 段聚合为可展开条(changes 侧栏消费)。
 * G14.120 重排:算法改 LCS——中段逐行最优配对(del/add 交错如实,行号双列不错位);
 * 折叠改 hunk 语义(改动上下文各留 CONTEXT 行,长 unchanged 中段才折叠);flat 变体
 * (changes 侧栏):透明平铺无内滚——纵向滚动统一交外层,展开卡单开。
 */

export interface DiffRow {
  kind: 'same' | 'add' | 'del';
  text: string;
  numOld?: number;
  numNew?: number;
}

const MAX_ROWS = 800;
const CONTEXT = 4;
/** LCS DP 单元上限:超过则回退整块 del+add(旧算法)——千行级文件 DP 也在毫秒程,防御性闸 */
const LCS_CELL_CAP = 4_000_000;

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
  const n = endA - start;
  const m = endB - start;
  if (n * m <= LCS_CELL_CAP) {
    // LCS DP(自底向上)+ 回溯:等值走对角;不等时优先 del(旧先行)——配对稳定可复现
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * w + j] = a[start + i] === b[start + j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        rows.push({ kind: 'same', text: a[start + i], numOld: start + i + 1, numNew: start + j + 1 });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        rows.push({ kind: 'del', text: a[start + i], numOld: start + i + 1 });
        i += 1;
      } else {
        rows.push({ kind: 'add', text: b[start + j], numNew: start + j + 1 });
        j += 1;
      }
    }
    while (i < n) {
      rows.push({ kind: 'del', text: a[start + i], numOld: start + i + 1 });
      i += 1;
    }
    while (j < m) {
      rows.push({ kind: 'add', text: b[start + j], numNew: start + j + 1 });
      j += 1;
    }
  } else {
    for (let i = start; i < endA; i += 1) rows.push({ kind: 'del', text: a[i] ?? '', numOld: i + 1 });
    for (let j = start; j < endB; j += 1) rows.push({ kind: 'add', text: b[j] ?? '', numNew: j + 1 });
  }
  for (let k = 0; endA + k < a.length; k += 1) {
    rows.push({ kind: 'same', text: a[endA + k] ?? '', numOld: endA + k + 1, numNew: endB + k + 1 });
  }
  const truncated = rows.length > MAX_ROWS;
  return { rows: truncated ? rows.slice(0, MAX_ROWS) : rows, truncated };
}

interface Segment {
  kind: 'rows' | 'folded';
  rows: DiffRow[];
}

/** G14.120 hunk 折叠:每段改动上下文各留 CONTEXT 行;长 unchanged 中段(两侧上下文之间)
 *  折叠为可展开条。尾部 run 无后继改动,只留头 CONTEXT(尾部上下文无意义)。 */
function hunkSegments(rows: DiffRow[]): Segment[] {
  const segs: Segment[] = [];
  let sameBuf: DiffRow[] = [];
  let changeRun: DiffRow[] = [];
  const flushChange = (): void => {
    if (changeRun.length === 0) return;
    segs.push({ kind: 'rows', rows: changeRun });
    changeRun = [];
  };
  const flushSame = (tail: boolean): void => {
    if (sameBuf.length === 0) return;
    if (sameBuf.length > CONTEXT * 2) {
      segs.push({ kind: 'rows', rows: sameBuf.slice(0, CONTEXT) });
      segs.push({ kind: 'folded', rows: sameBuf.slice(CONTEXT, sameBuf.length - (tail ? 0 : CONTEXT)) });
      if (!tail) segs.push({ kind: 'rows', rows: sameBuf.slice(sameBuf.length - CONTEXT) });
    } else {
      segs.push({ kind: 'rows', rows: sameBuf });
    }
    sameBuf = [];
  };
  for (const r of rows) {
    if (r.kind === 'same') {
      flushChange();
      sameBuf.push(r);
    } else {
      flushSame(false);
      changeRun.push(r);
    }
  }
  flushChange();
  flushSame(true);
  return segs;
}

export function DiffLines({
  oldStr,
  newStr,
  path,
  maxHeight = 280,
  collapsible = false,
  variant = 'inline',
}: {
  oldStr?: string;
  newStr: string;
  path?: string;
  maxHeight?: number;
  /** G14.109 hunk 折叠开启(changes 侧栏消费;主对话 write 小 diff 恒平铺) */
  collapsible?: boolean;
  /** G14.120 flat(changes 侧栏):透明平铺无内滚+双列行号;inline(工具行)维持单列紧凑 */
  variant?: 'inline' | 'flat';
}): JSX.Element {
  const { rows, truncated } = useMemo(() => diffRows(oldStr ?? '', newStr), [oldStr, newStr]);
  const segs = useMemo(() => (collapsible ? hunkSegments(rows) : null), [rows, collapsible]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const flat = variant === 'flat';
  const line = (r: DiffRow, i: number): JSX.Element =>
    flat ? (
      <div key={i} className={`diff-line ${r.kind}`}>
        <span className="diff-ln old" aria-hidden="true">{r.numOld ?? ''}</span>
        <span className="diff-ln new" aria-hidden="true">{r.numNew ?? ''}</span>
        <span className="diff-code">
          <code dangerouslySetInnerHTML={{ __html: highlightCode(r.text, path) }} />
        </span>
      </div>
    ) : (
      <div key={i} className={`diff-line ${r.kind}`}>
        <span className="diff-mark" aria-hidden="true" />
        <span className="diff-ln" aria-hidden="true">{r.kind === 'del' ? r.numOld : r.numNew}</span>
        <span className="diff-code">
          <code dangerouslySetInnerHTML={{ __html: highlightCode(r.text, path) }} />
        </span>
      </div>
    );
  /** G14.154 折叠条整行 sticky 悬浮(横向滚动钉住可视宽),文字照常保留 */
  const foldBar = (segKey: number, count: number): JSX.Element => (
    <button
      type="button"
      className="diff-fold"
      onClick={() => setExpanded((s) => new Set(s).add(segKey))}
    >
      <MoreHorizontal size={12} strokeWidth={1.75} aria-hidden="true" />
      <span>{t(`${count} unchanged lines`, `展开 ${count} 行未变更`)}</span>
    </button>
  );
  const unfoldBar = (segKey: number): JSX.Element => (
    <button
      type="button"
      className="diff-fold"
      onClick={() => setExpanded((s) => {
        const n = new Set(s);
        n.delete(segKey);
        return n;
      })}
    >
      <ChevronUp size={12} strokeWidth={1.75} aria-hidden="true" />
      <span>{t('collapse', '收起')}</span>
    </button>
  );
  let key = 0;
  const renderSegs = (): JSX.Element[] =>
    segs === null
      ? []
      : segs.map((seg) => {
        if (seg.kind === 'rows') {
          const k = key;
          key += 1;
          return <div key={`s${k}`}>{seg.rows.map((r, i) => line(r, k * 10000 + i))}</div>;
        }
        const segKey = key;
        key += 1;
        return expanded.has(segKey) ? (
          <div key={`f${segKey}`}>
            {seg.rows.map((r, i) => line(r, segKey * 10000 + i))}
            {unfoldBar(segKey)}
          </div>
        ) : (
          foldBar(segKey, seg.rows.length)
        );
      });
  return (
    <div
      className={`diff-lines${flat ? ' flat' : ''}`}
      style={flat ? undefined : { maxHeight }}
      aria-label="diff lines"
    >
      {segs === null ? rows.map((r, i) => line(r, i)) : renderSegs()}
      {truncated && <div className="diff-line trunc">…</div>}
    </div>
  );
}
