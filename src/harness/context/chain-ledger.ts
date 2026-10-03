import { ChainAction, HistoryStep } from '../../types';

/** 会话链账本（D25/H3 拆分自 ContextManager 职责③）：主链对话事实的 append-only 存储本体——
 *  链数组、压缩水位（chainFrom）、行序号（chainSeq）三态的唯一样本。纯状态机：不发事件、不碰磁盘、
 *  零外部依赖；变更事件（append/compact）由门面在委托返回后组合 ContextChange 分发，件间零引用。 */
export class ChainLedger {
  /** 会话链（CLAUDE.md §11 只增不改）：主链对话事实的 append-only 账本 */
  private chain: HistoryStep[] = [];
  /** 压缩水位：chain 前 from 条已被压缩块代表（trimFront 推进，不回退） */
  private from = 0;
  /** 行序号：链内绝对步号发生器（restore 按链内最大步号续排） */
  private seq = 0;

  /** 链尾追加入账（唯一写入口）：行号由链内序号定死，追加后不重排（裁剪后允许跳号）；
   *  reasoning（该轮模型思考原文）随行透传——思考模式续轮回传载荷的持久化通道；
   *  action 收窄为 ChainAction 闭集（types.ts N11③ 单点登记）——新动作进链前须先在登记处扩员。
   *  返回实际推入的步（空入参零追加；是否发 append 事件由门面按返回值决定）。 */
  append(entries: Array<{ action?: ChainAction; observation: string; reasoning?: string }>): HistoryStep[] {
    const pushed: HistoryStep[] = [];
    for (const e of entries) {
      const step: HistoryStep = { step: ++this.seq, ...(e.action !== undefined ? { action: e.action } : {}), observation: e.observation, ...(e.reasoning !== undefined ? { reasoning: e.reasoning } : {}) };
      this.chain.push(step);
      pushed.push(step);
    }
    return pushed;
  }

  /** 压缩水位推进（折叠协调入口）：压缩块已代表的链前缀条目数，推进防「链+压缩块」双份；n<=0 不动 */
  trimFront(n: number): void {
    if (n <= 0) return;
    this.from = Math.min(this.from + n, this.chain.length);
  }

  /** 存续条目只读视图：自压缩水位起（reactor 缺省 seed 的单一来源）；slice 拷贝，账本外禁改写 */
  view(): HistoryStep[] {
    return this.chain.slice(this.from);
  }

  /** 压缩水位只读视图：链前 N 行已折叠进压缩块（view 不含这部分） */
  fromView(): number {
    return this.from;
  }

  /** 会话恢复直注入（/resume / --continue）：journal 归约产物整链替换（浅拷贝隔离），seq 按链内最大步号续排；
   *  事件分发与压缩块注入由门面统筹（恢复不触发订阅） */
  restore(chain: HistoryStep[], from: number): void {
    this.chain = chain.map((st) => ({ ...st }));
    this.from = from;
    this.seq = this.chain.reduce((m, st) => Math.max(m, st.step), 0);
  }

  /** 会话级重置（/new）：清链、水位与序号；快照刷新与压缩块清理由门面统筹 */
  reset(): void {
    this.chain = [];
    this.from = 0;
    this.seq = 0;
  }
}
