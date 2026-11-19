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
  /** 内容估算高(px,建块时按 md 长度算;实测表命中时不用它)。2026-11-19 冷开长帧轮:
   *  旧估算按块种类给常数(正文恒 150),巨型正文(大表格/代码)在首帧被当成 150px——
   *  视口±overscan 的切片一口气挂十几个大单元(实测 x0e2 冷开 225ms 长任务)。按字符量
   *  估算后首帧切片即贴着真实占比,只挂真正进视口的那几个;实测后仍由高度表覆盖 */
  readonly est?: number;
}

/** 段聚合判据(与 DayGroupBlock 同口径):工具/思考/折叠态正文·用户·旁白并入折叠段 */
export function isSegmentEntry(e: ChatEntry, hiddenKeys: ReadonlySet<string>): boolean {
  return e.kind === 'tool' || e.kind === 'thinking' || ((e.kind === 'assistant' || e.kind === 'user' || e.kind === 'notice') && hiddenKeys.has(e.key));
}

/** 内容估算(px):字符量 × 每字符占高。样本口径=实测正文 3058 字≈2479px(0.81);正文取略
 *  保守的 0.7(表格留白多、代码折行少),用户气泡窄取 0.5,折叠段按行数主算 */
const estUser = (md: string): number => Math.max(96, 72 + Math.ceil(md.length * 0.5));
const estAssistant = (md: string, entryKind?: ChatEntry['kind']): number =>
  entryKind === 'notice' ? 48 : Math.max(150, 120 + Math.ceil(md.length * 0.7));
const estSeg = (count: number, chars: number): number => 44 + count * 30 + Math.ceil(chars * 0.2);
/** 单条块内容估算(日分隔/命令/run 与渲染高度基本无关,沿常数) */
function estOfEntry(entry: ChatEntry, kind: UnitKind): number {
  if (kind === 'user') return estUser(entry.md);
  if (kind === 'assistant') return estAssistant(entry.md, entry.kind);
  if (kind === 'cmd') return 40;
  if (kind === 'run') return 30;
  return 80;
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
    let chars = 0;
    for (let k = segStart; k < end; k += 1) chars += entries[k]!.md.length;
    // 整段折叠态=只渲染「Worked」头,高度与行数无关;展开态按行+字符估
    out.push({
      key: `seg:${entries[segStart]!.key}`,
      kind: 'seg',
      group: groupIndex,
      start: segStart,
      end,
      label: '',
      est: segHidden ? 44 : estSeg(end - segStart, chars),
    });
    segStart = -1;
  };
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (office && isOfficeHidden(entry.kind, entry.md)) continue;
    if (isCommand(entry)) {
      flushSeg(i);
      out.push({ key: entry.key, kind: 'cmd', group: groupIndex, start: i, end: i + 1, label: '', entryKind: entry.kind, est: 40 });
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
    out.push({ key: entry.key, kind, group: groupIndex, start: i, end: i + 1, label: '', entryKind: entry.kind, est: estOfEntry(entry, kind) });
  }
  flushSeg(entries.length);
  return out;
}

/** 未实测单位的估算高度(px;实测后由高度表覆盖)。块自带 est(按 md 长度算)优先;
 *  缺省常数仅作老调用面/日分隔兜底。值影响首帧切片与滚动条比例,偏差在块挂载测量后按
 *  「上方变化回钉」校正,不产生视觉跳动 */
export function unitEstimate(kind: UnitKind, entryKind?: ChatEntry['kind'], est?: number): number {
  if (est !== undefined && est > 0) return est;
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
    const h = heights.get(u.key) ?? unitEstimate(u.kind, u.entryKind, u.est);
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
 *  二分定位:首块 = 底部越过视口顶-(behind 缺省=overscan) 的第一块;末块 = 顶部越过视口底+overscan
 *  的第一块。behind 独立入参供「停顿期向前预挂载」用(2026-11-19 大块滑动轮:只往前扩,
 *  不往前缩)。 */
export function sliceRange(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
  behind: number = overscan,
): { first: number; last: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { first: 0, last: 0 };
  const lo = scrollTop - behind;
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
