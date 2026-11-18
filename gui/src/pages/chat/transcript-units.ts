import type { ChatEntry } from '../../chat-reducer';

/**
 * 转录块模型(2026-11-18 结构性改造第一层):把「窗口内条目」切成虚拟列表的挂载单位。
 *
 * 为什么以「块」为单位而不是条目:现有渲染把连续的工具/思考/折叠旁白聚成一个 ToolSegBlock
 * (段内折叠开合是一个整体),虚拟窗口若按条目切会在段中间劈开——同一段被拆成两个块,折叠态
 * 与高度过渡都会裂。块边界 = DayGroupBlock 现有聚合规则(日分隔/命令三态/折叠段/run/用户/
 * 正文),两侧镜像同一口径;本模块是纯投影(不建 React 元素),可单测。
 *
 * 高度模型:单位高度 = 实测优先(heights),未实测走估算。前缀和给出块顶部偏移,视口切片用
 * 二分(O(log N)),spacer 高度 = 前缀和差值。与 react-virtuoso/@tanstack/react-virtual 同型
 * 的变高列表模型(差在块声明由宿主给定,无需逐行测量)。
 */

/** 块种类(估算高度与渲染分支同键) */
export type UnitKind = 'day' | 'seg' | 'cmd' | 'run' | 'user' | 'assistant';

export interface UnitSpan {
  /** 稳定键(React key / 高度表键):日=day:<groupKey>,段=seg:<首条 key>,其余=条目 key */
  readonly key: string;
  readonly kind: UnitKind;
  /** 所属日分组序号(渲染时取 groupEntries) */
  readonly group: number;
  /** 组内条目区间 [start, end)(日分隔块 start=end=组起点) */
  readonly start: number;
  readonly end: number;
  /** 日分隔块文案(仅 kind='day') */
  readonly label: string;
  /** 条目种类(估算用;单条块) */
  readonly entryKind?: ChatEntry['kind'];
}

/** 段聚合判据(与 DayGroupBlock 同口径):工具/思考/折叠态正文·用户·旁白并入折叠段 */
export function isSegmentEntry(e: ChatEntry, hiddenKeys: ReadonlySet<string>): boolean {
  return e.kind === 'tool' || e.kind === 'thinking' || ((e.kind === 'assistant' || e.kind === 'user' || e.kind === 'notice') && hiddenKeys.has(e.key));
}

/**
 * 把某日分组切成块(镜像 DayGroupBlock 的节点装配循环):
 * - 日分隔符(label !== '')独立成首块;
 * - 办公模式隐藏旁白整条跳过(不切断段);
 * - 命令三态行独立成块;
 * - 折叠段按「首条 hidden 态」分段(相异即断段);
 * - run/用户/正文各成一块。
 */
export function dayUnitSpans(
  groupIndex: number,
  groupKey: string,
  label: string,
  entries: readonly ChatEntry[],
  hiddenKeys: ReadonlySet<string>,
  office: boolean,
  isCommand: (e: ChatEntry) => boolean,
  isOfficeHidden: (kind: ChatEntry['kind'], md: string) => boolean,
): UnitSpan[] {
  const out: UnitSpan[] = [];
  if (label !== '') out.push({ key: `day:${groupKey}`, kind: 'day', group: groupIndex, start: 0, end: 0, label });
  let segStart = -1;
  let segHidden = false;
  const flushSeg = (end: number): void => {
    if (segStart < 0) return;
    out.push({ key: `seg:${entries[segStart]!.key}`, kind: 'seg', group: groupIndex, start: segStart, end, label: '' });
    segStart = -1;
  };
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (office && isOfficeHidden(entry.kind, entry.md)) continue;
    if (isCommand(entry)) {
      flushSeg(i);
      out.push({ key: entry.key, kind: 'cmd', group: groupIndex, start: i, end: i + 1, label: '', entryKind: entry.kind });
      continue;
    }
    if (isSegmentEntry(entry, hiddenKeys)) {
      const hidden = hiddenKeys.has(entry.key);
      // 折叠态相异即分段(运行中折叠留出的末条工具/思考行与其前的折叠区不同段)
      if (segStart >= 0 && segHidden !== hidden) flushSeg(i);
      if (segStart < 0) {
        segStart = i;
        segHidden = hidden;
      }
      continue;
    }
    flushSeg(i);
    const kind: UnitKind = entry.kind === 'run' ? 'run' : entry.kind === 'user' ? 'user' : 'assistant';
    out.push({ key: entry.key, kind, group: groupIndex, start: i, end: i + 1, label: '', entryKind: entry.kind });
  }
  flushSeg(entries.length);
  return out;
}

/** 未实测单位的估算高度(px;实测后由高度表覆盖)。值取各块典型渲染高度,仅影响首帧 spacer 与
 *  滚动条比例,偏差在块挂载测量后按「上方变化回钉」校正,不产生视觉跳动 */
export function unitEstimate(kind: UnitKind, entryKind?: ChatEntry['kind']): number {
  switch (kind) {
    case 'day':
      return 46;
    case 'seg':
      return 44;
    case 'cmd':
      return 40;
    case 'run':
      return 30;
    case 'user':
      return 96;
    case 'assistant':
      return entryKind === 'notice' ? 48 : 150;
    default:
      return 80;
  }
}

/** 前缀和(长度 n+1;offsets[i]=第 i 块顶部,offsets[n]=总高)。实测优先,缺省估算 */
export function prefixOffsets(units: readonly UnitSpan[], heights: ReadonlyMap<string, number>): number[] {
  const offsets = new Array<number>(units.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i]!;
    const h = heights.get(u.key) ?? unitEstimate(u.kind, u.entryKind);
    offsets[i + 1] = offsets[i]! + h;
  }
  return offsets;
}

/** 视口顶所在块:第一个底边越过 scrollTop 的块(二分;阅读态锚定用) */
export function firstUnitAt(offsets: readonly number[], scrollTop: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let a = 0;
  let b = n - 1;
  let ans = n - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (offsets[mid + 1]! > scrollTop) {
      ans = mid;
      b = mid - 1;
    } else {
      a = mid + 1;
    }
  }
  return ans;
}

/** 视口切片:返回 [first, last) 块区间(含 overscan 像素上下余量;至少 1 块)。
 *  二分定位:首块 = 底部越过视口顶-overscan 的第一块;末块 = 顶部越过视口底+overscan 的第一块。 */
export function sliceRange(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
): { first: number; last: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { first: 0, last: 0 };
  const lo = scrollTop - overscan;
  const hi = scrollTop + Math.max(viewport, 0) + overscan;
  // 第一个 offsets[i+1] > lo 的 i(scrollTop 之前的块不挂)
  let a = 0;
  let b = n - 1;
  let first = n - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (offsets[mid + 1]! > lo) {
      first = mid;
      b = mid - 1;
    } else {
      a = mid + 1;
    }
  }
  // 第一个 offsets[i] >= hi 的 i(其后的块不挂)
  a = first;
  b = n;
  let last = n;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (mid >= n || offsets[mid]! >= hi) {
      last = mid;
      b = mid - 1;
    } else {
      a = mid + 1;
    }
  }
  if (last <= first) last = Math.min(n, first + 1);
  return { first, last };
}
