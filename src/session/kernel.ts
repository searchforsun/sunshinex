import type { SessionEvent } from '../types';
import { applyEvent, applySeed, initialKernelState, type KernelEntry, type KernelState } from './entry';

/**
 * SessionKernel:会话转录唯一投影 + 事件泵(spec 2026-10-17-session-kernel §3/§6 P1)。
 * 事件经 pump 单点驱动纯 reducer(entry.ts);seq 由状态机自分配;replay 只读快照;
 * truncate 承载 rewind/compact 的视图截断(P2-P3 接线);onAppend 为增量持久化钩子
 * (P2 接 v2 单档写者,seed 回种不回调——collector G14.213b 语义平移)。
 * P1 不接任何消费者:三份旧投影并行存在,P2(daemon)/P3(TUI)/P4(GUI) 逐个退役。
 */
export class SessionKernel {
  private state: KernelState = initialKernelState();
  private readonly onAppend?: (entry: KernelEntry) => void;

  constructor(opts?: { onAppend?: (entry: KernelEntry) => void }) {
    this.onAppend = opts?.onAppend;
  }

  /** 事件泵单点:apply 后对新入列条目逐条回调。回填/合并只改既有条目(不改 seq)不回调——
   *  v2 档「回执独立成行、重放回填」由 P2 写面另行承载 */
  pump(e: SessionEvent): void {
    const high = this.state.nextSeq - 1;
    this.state = applyEvent(this.state, e);
    const fresh = this.state.nextSeq - 1 - high; // 新条目数(追加恒在尾部,裁剪只丢头部)
    if (fresh <= 0) return;
    for (const entry of this.state.entries.slice(-fresh)) this.onAppend?.(entry);
  }

  /** 历史播种(v2 档装载/attach 链派生):重编号续计数、过同一上限;不触发 onAppend(防双写) */
  seed(entries: ReadonlyArray<Omit<KernelEntry, 'seq'>>): void {
    this.state = applySeed(this.state, entries);
  }

  /** 只读快照(浅拷贝;条目视为不可变——回填只发生在 reducer 内部) */
  replay(): KernelEntry[] {
    return [...this.state.entries];
  }

  /** 现有条目数(持久化回种与 attach 播种的互斥判据消费面) */
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

  /** 视图截断(rewind/compact 预留):保留 seq<=upToSeq;序号不复用,后续条目续接单调序列 */
  truncate(upToSeq: number): void {
    const st = this.state;
    this.state = {
      ...st,
      entries: st.entries.filter((x) => x.seq <= upToSeq),
      pending: st.pending.filter((p) => p.seq <= upToSeq),
      openRun: st.openRun <= upToSeq ? st.openRun : -1,
      openSeg: st.openSeg <= upToSeq ? st.openSeg : -1,
    };
  }
}
