import type { SessionEvent } from '../types';
import { applyEvent, applySeed, initialKernelState, type KernelEntry, type KernelState } from './entry';

/** 内核段级事件(spec §3.1b 词汇收缩——视图/持久化层只消费这些,token 级遥测不出内核):
 *  差分自 applyEvent 前后态推导,条目引用未变的零噪声。 */
export type KernelEvent =
  | { t: 'seg-open'; entry: KernelEntry; open: boolean } // 条目新建;open=true 开启段(落档等 seg-close),false 即终态(立即落)
  | { t: 'seg-close'; entry: KernelEntry } // 正文/思考段闭合(终态 md/seconds;done 终稿合并同发)
  | { t: 'seg-update'; entry: KernelEntry } // 工具条回填(name/input/result——重放按 seq upsert)
  | { t: 'truncate'; upToSeq: number }; // rewind/compact/reset 视界截断(upToSeq=0 即全清)

/**
 * SessionKernel:会话转录唯一投影 + 事件泵(spec 2026-10-17-session-kernel §3/§6)。
 * 事件经 pump 单点驱动纯 reducer(entry.ts);seq 由状态机自分配;replay 只读快照;
 * truncate 承载 rewind/compact/reset 的视图截断;onKernelEvent 为段级事件外抛面
 * (P2 daemon 持久化写者经它落 v2 行;seed 回种不触发——防双写)。
 * P1-P2 消费者:daemon(v2 写者);TUI/GUI 旧投影仍在,P3/P4 逐个退役。
 */
export class SessionKernel {
  private state: KernelState = initialKernelState();
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

  private emit(ev: KernelEvent): void {
    this.onKernelEvent?.(ev);
  }
}
