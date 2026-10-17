import type { SessionEvent } from '../types';
import { applyEvent, applySeed, initialKernelState, type KernelEntry, type KernelState } from './entry';

/** 等待队列条目(P5 内核化,spec §12):seq=位置下标(每次变更整列重排,端点寻址键);
 *  front=插入发送(reactor 步边界 drain 注入当前轮),false 仅排队等轮收束补跑。 */
export interface SteerItem {
  seq: number;
  text: string;
  front: boolean;
}

/** 内核事件(spec §3.1b 词汇收缩——视图/持久化层只消费这些,token 级遥测不出内核):
 *  段级四型差分自 applyEvent 前后态推导,条目引用未变的零噪声;steer 型为队列变更整列快照。 */
export type KernelEvent =
  | { t: 'seg-open'; entry: KernelEntry; open: boolean } // 条目新建;open=true 开启段(落档等 seg-close),false 即终态(立即落)
  | { t: 'seg-close'; entry: KernelEntry } // 正文/思考段闭合(终态 md/seconds;done 终稿合并同发)
  | { t: 'seg-update'; entry: KernelEntry } // 工具条回填(name/input/result——重放按 seq upsert)
  | { t: 'truncate'; upToSeq: number } // rewind/compact/reset 视界截断(upToSeq=0 即全清)
  | { t: 'steer'; items: SteerItem[] }; // 等待队列变更(整列重写快照;持久化整列落一行,广播走全量列表)

/**
 * SessionKernel:会话转录唯一投影 + 事件泵(spec 2026-10-17-session-kernel §3/§6)。
 * 事件经 pump 单点驱动纯 reducer(entry.ts);seq 由状态机自分配;replay 只读快照;
 * truncate 承载 rewind/compact/reset 的视图截断;onKernelEvent 为段级事件外抛面
 * (P2 daemon 持久化写者经它落 v2 行;seed 回种不触发——防双写)。
 * 收编进度:P1-P5 落地(daemon 唯一 v2 写者/TUI 持久化+恢复/GUI 投影/steer 队列);
 * P8 收 TUI 静态归档面(thinking 折叠已收编,tool/done/notice 面见 plans/2026-10-18-session-kernel-p8)。
 */
export class SessionKernel {
  private state: KernelState = initialKernelState();
  /** 等待队列(P5 内核化,spec §12):内核同体持有但不进 KernelState——队列非转录,不参与
   *  applyEvent 纯面;变更走 steer 事件外抛(持久化+广播双消费),装载经 steerRestore 回种防双写 */
  private steerItems: SteerItem[] = [];
  private readonly onKernelEvent?: (ev: KernelEvent) => void;

  constructor(opts?: { onKernelEvent?: (ev: KernelEvent) => void }) {
    this.onKernelEvent = opts?.onKernelEvent;
  }

  /** 提交回显(collector.submit 平移):user 条 `> <goal>`——与 user 事件同路径,事件语义单点 */
  submit(goal: string): void {
    this.pump({ type: 'user', text: goal, ts: Date.now() });
  }

  /** 事件泵单点:apply 后差分前后态发段级事件——新条目 → seg-open;条目引用变且非开启段 →
   *  正文/思考段 seg-close(含 done 终稿合并)、工具条 seg-update;run 条 meta 填充(runmeta 侧行
   *  面既有)不另发。差分 O(n)(prev seq→条目 Map),条目引用未变的零事件 */
  pump(e: SessionEvent): void {
    const prev = this.state;
    this.state = applyEvent(this.state, e);
    if (prev.entries === this.state.entries) return;
    const prevBySeq = new Map(prev.entries.map((x) => [x.seq, x]));
    for (const entry of this.state.entries) {
      const before = prevBySeq.get(entry.seq);
      if (before === undefined) {
        // 开启态:run 条(openRun 游标在场)与正文/思考开启段;done 无开启段直建的终答条目以闭合态出生
        const open = entry.kind === 'run' ? this.state.openRun === entry.seq : this.state.openSeg === entry.seq;
        this.emit({ t: 'seg-open', entry, open });
        continue;
      }
      if (before === entry) continue;
      if (entry.kind === 'assistant' || entry.kind === 'thinking') {
        if (this.state.openSeg !== entry.seq) this.emit({ t: 'seg-close', entry }); // 开启中的增量拼接不发(落档等闭合)
      } else if (entry.kind === 'tool') {
        this.emit({ t: 'seg-update', entry });
      }
      // run 条 meta 填充(runmeta 行既有持久化路径)与其余 kind 不变异,不另发
    }
  }

  /** 历史播种(v2 档装载/attach 派生):seq>0 沿用(v2 行与 live 同源),缺省续发;不触发事件(防双写) */
  seed(entries: ReadonlyArray<Omit<KernelEntry, 'seq'> & { seq?: number }>): void {
    this.state = applySeed(this.state, entries);
  }

  /** 只读快照(浅拷贝;条目视为不可变——回填只发生在 reducer 内部) */
  replay(): KernelEntry[] {
    return [...this.state.entries];
  }

  /** 现有条目数(装载互斥判据与测试面) */
  count(): number {
    return this.state.entries.length;
  }

  /** 流式派生面(§3.1b):开启中 run / 正文·思考段的 seq(-1 无)——视图光标态由此推导 */
  openRun(): number {
    return this.state.openRun;
  }

  openSeg(): number {
    return this.state.openSeg;
  }

  /** 视图截断(rewind/compact/reset):保留 seq<=upToSeq(0=全清);序号不复用;发 truncate 事件落行 */
  truncate(upToSeq: number): void {
    const st = this.state;
    this.state = {
      ...st,
      entries: st.entries.filter((x) => x.seq <= upToSeq),
      pending: st.pending.filter((p) => p.seq <= upToSeq),
      openRun: st.openRun <= upToSeq ? st.openRun : -1,
      openSeg: st.openSeg <= upToSeq ? st.openSeg : -1,
    };
    this.emit({ t: 'truncate', upToSeq });
  }

  // ---- 等待队列(P5 内核化,spec §12):变更即发 steer 事件(整列快照),读面不外抛 ----

  /** 入队一条用户穿插行(空白忽略,保持入队序;缺省仅排队——轮收束自动发下一轮) */
  steerEnqueue(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.steerItems = [...this.steerItems, { seq: this.steerItems.length, text: t, front: false }];
    this.emitSteer();
  }

  /** 编辑第 seq 条文本(越界 false;front 标记保留) */
  steerEditAt(seq: number, text: string): boolean {
    const t = text.trim();
    const idx = this.steerItems.findIndex((x) => x.seq === seq);
    if (idx < 0 || !t) return false;
    this.steerItems = this.steerItems.map((x) => (x.seq === seq ? { ...x, text: t } : x));
    this.emitSteer();
    return true;
  }

  /** 重排 from → to(下标越界按边界夹紧)——排队条目拖拽排序 */
  steerMove(from: number, to: number): boolean {
    if (from < 0 || from >= this.steerItems.length) return false;
    const t = Math.max(0, Math.min(to, this.steerItems.length - 1));
    if (from === t) return false;
    const arr = [...this.steerItems];
    const [item] = arr.splice(from, 1);
    arr.splice(t, 0, item!);
    this.steerItems = arr;
    this.emitSteer();
    return true;
  }

  /** 置首并标记步边界可注入(插入发送=不等轮次完成,下一步立即注入当前轮) */
  steerMoveToFront(seq: number): boolean {
    const idx = this.steerItems.findIndex((x) => x.seq === seq);
    if (idx < 0) return false;
    const item = this.steerItems[idx]!;
    this.steerItems = [{ ...item, front: true }, ...this.steerItems.filter((x) => x.seq !== seq)];
    this.emitSteer();
    return true;
  }

  /** 撤回第 seq 条(越界 false) */
  steerRemoveAt(seq: number): boolean {
    if (!this.steerItems.some((x) => x.seq === seq)) return false;
    this.steerItems = this.steerItems.filter((x) => x.seq !== seq);
    this.emitSteer();
    return true;
  }

  /** 步边界 drain(reactor 消费口):仅取走置首条目按序返回文本——普通排队条目留待轮收束补跑 */
  steerDrain(): string[] {
    if (!this.steerItems.some((x) => x.front)) return [];
    const out = this.steerItems.filter((x) => x.front).map((x) => x.text);
    this.steerItems = this.steerItems.filter((x) => !x.front);
    this.emitSteer();
    return out;
  }

  /** 取走全部未投递行(轮收束补跑/中断丢弃/撤回取回共用),按入队序 */
  steerTakePending(): SteerItem[] {
    if (this.steerItems.length === 0) return [];
    const out = this.steerItems;
    this.steerItems = [];
    this.emitSteer();
    return out;
  }

  /** 待投递快照(非破坏拷贝,不发事件——队列面板/ chips 展示面) */
  steerPendingItems(): SteerItem[] {
    return this.steerItems.map((x) => ({ ...x }));
  }

  /** 装载回种(v2 steer 行重放/attach):整列替换并按位置归一 seq,不发事件(防装载双写) */
  steerRestore(items: ReadonlyArray<SteerItem>): void {
    this.steerItems = items.map((x, i) => ({ ...x, seq: i }));
  }

  /** 队列变更外抛单点:先按位置归一 seq(重排/删撤后的位置即寻址键,spec §12 seq=位置下标),再发整列快照 */
  private emitSteer(): void {
    this.steerItems = this.steerItems.map((x, i) => (x.seq === i ? x : { ...x, seq: i }));
    this.emit({ t: 'steer', items: this.steerPendingItems() });
  }

  private emit(ev: KernelEvent): void {
    this.onKernelEvent?.(ev);
  }
}
