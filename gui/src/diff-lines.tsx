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

/** 改动组下移对齐(2026-11-11 用户报障「+10 −1 与渲染不一致」根修,git xdl_change_compact 简化款):
 *  LCS 在重复行场景(如成片的 `x = null;` 清理行)会把新增行配到别处旧行——渲染 ± 少于 numstat。
 *  后处理:每个连续改动组,若组后首行 same 与组内该侧首行同文,则交换(组整体下移一行),循环至
 *  不动——改动 hunk 归位到真实发生处,渲染 ± 与 git numstat 对齐 */
function compactShift(rows: DiffRow[]): DiffRow[] {
  const arr = [...rows];
  let moved = true;
  while (moved) {
    moved = false;
    let i = 0;
    while (i < arr.length) {
      if (arr[i]!.kind === 'same') {
        i += 1;
        continue;
      }
      let j = i;
      while (j < arr.length && arr[j]!.kind !== 'same') j += 1;
      if (j < arr.length) {
        const nxt = arr[j]!;
        const idx = arr.findIndex(
          (r, k) =>
            k >= i && k < j && r.kind !== 'same' && r.text === nxt.text &&
            ((r.kind === 'del' && nxt.numOld !== undefined) || (r.kind === 'add' && nxt.numNew !== undefined)),
        );
        if (idx >= 0) {
          const chg = arr[idx]!;
          if (chg.kind === 'del') {
            arr[j] = { kind: 'del', text: nxt.text, numOld: nxt.numOld! };
            arr[idx] = { kind: 'same', text: chg.text, numOld: chg.numOld!, numNew: nxt.numNew! };
          } else {
            arr[j] = { kind: 'add', text: nxt.text, numNew: nxt.numNew! };
            arr[idx] = { kind: 'same', text: chg.text, numOld: nxt.numOld!, numNew: chg.numNew! };
          }
          moved = true;
        }
      }
      i = j;
    }
  }
  return arr;
}

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
  const compacted = compactShift(rows);
  const truncated = compacted.length > MAX_ROWS;
  return { rows: truncated ? compacted.slice(0, MAX_ROWS) : compacted, truncated };
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
  hunksOnly = false,
}: {
  oldStr?: string;
  newStr: string;
  path?: string;
  maxHeight?: number;
  /** G14.109 hunk 折叠开启(changes 侧栏消费;主对话 write 小 diff 恒平铺) */
  collapsible?: boolean;
  /** G14.120 flat(changes 侧栏):透明平铺无内滚;inline(工具行) maxHeight 封顶内滚——行结构两版同构 */
  variant?: 'inline' | 'flat';
  /** 每刀截断面(2026-11-11 用户裁定「只展示变化前后4行正文,不可展开,直接截断省略」):工具行/
   *  单文件 diff 页签消费——只渲染改动 hunk ±CONTEXT 行,其余段以不可点省略条收尾;完整原文仍在
   *  冻结快照 blob 里(撤销读快照不受展示截断影响),与审查页(可展开折叠)分开 */
  hunksOnly?: boolean;
}): JSX.Element {
  const { rows, truncated } = useMemo(() => diffRows(oldStr ?? '', newStr), [oldStr, newStr]);
  const segs = useMemo(() => {
    if (!collapsible && !hunksOnly) return null;
    const all = hunkSegments(rows);
    if (!hunksOnly) return all;
    // 截断面去尾部省略(2026-11-11 用户裁定「去掉最后的 792 省略和三个点」):尾部 fold 段整段
    // 不渲染——尾部上下文行照显,只有尾部 fold 条与末尾 … 截断点退场(审查页可展开折叠条不受影响)
    const last = all[all.length - 1];
    return last !== undefined && last.kind === 'folded' ? all.slice(0, -1) : all;
  }, [rows, collapsible, hunksOnly]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const flat = variant === 'flat';
  // 行渲染单点(2026-11-10 用户裁定「审查 diff 与工具行统一叠加单列序号」):flat/inline 同构——色条+单序号
  // (删除行显旧号、其余显新号),差异只剩 flat 无内滚透明平铺
  const line = (r: DiffRow, i: number): JSX.Element => (
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
      <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
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
      <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
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
        if (hunksOnly) {
          // 截断面:省略条不可点(「不可展开,直接截断」)——仅示条数
          return (
            <div key={`f${segKey}`} className="diff-fold static">
              <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{t(`${seg.rows.length} unchanged lines`, `${seg.rows.length} 行未变更`)}</span>
            </div>
          );
        }
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
      {truncated && !hunksOnly && <div className="diff-line trunc">…</div>}
    </div>
  );
}
