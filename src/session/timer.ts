// sunx 定时调度原语（2026-11-15 P2 Task 3）：会话级定时器——与 WakeController 同居 session 层的
// 纯件控制器，零 IO（timer 除外），宿主（serve/session.ts）经 opts 注入 busy/fire 两接缝与
// setTimeout/clearTimeout/now 钟面三缝（测试假钟）。
// 语义裁定（brief §Controller rulings）：
// - 单活跃调度位：新 arm 替换旧（MVP——一会话至多一枚在途调度，被替换者由宿主落终态行防重放重发）；
// - 到点=宿主接缝 fire(rec, lateMs)：lateMs=now-fireAt（R7 错过重布防的延迟时长数据源）；
//   返回 false=宿主未受理（如 plan 武装态）→ 留位待下次轮收束（沿 WakeController「未受理回队」模式）；
// - busy 排队：到点遇 run 在途即 due 留位，宿主轮收束调 onTurnEnded() 补跑（沿 WakeController 空闲判定模式）；
// - 宿主 teardown/reset 调 reset() 清句柄（防句柄泄漏，WakeController 同纪律）。
import type { WakeScheduleRecord } from './seglog';

export type { WakeScheduleRecord };

/** 钟面三缝（缺省=全局 setTimeout/clearTimeout/Date.now；测试注入假钟） */
interface TimerClock {
  setTimeoutImpl(fn: () => void, ms: number): unknown;
  clearTimeoutImpl(handle: unknown): void;
  now(): number;
}

interface TimerControllerOpts {
  /** 宿主运行态：run 在途即 busy（空闲 false）——到点遇 busy 排队至轮收束 */
  busy(): boolean;
  /** 到点回调（宿主接缝）：lateMs=now-fireAt（≥0）。返回 false=未受理 → 留位待下次轮收束重试 */
  fire(rec: WakeScheduleRecord, lateMs: number): boolean;
  /** 钟面三缝（缺省全局实现）：setTimeoutImpl/clearTimeoutImpl/now 逐项可注入（测试假钟） */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  now?: () => number;
}

/** 定时调度控制器（session 层单点，daemon 每会话一实例）：arm/cancel/到点派发/busy 排队/轮收束补跑。
 *  零 IO（timer 除外）；宿主 teardown 调 reset() 清 timer（防句柄泄漏） */
export class TimerController {
  /** 单活跃调度位（新 arm 替换旧——MVP 裁定）；fire 受理即清空 */
  private current?: WakeScheduleRecord;
  private handle?: unknown;
  /** 到点未派发闩：busy 排队或受理失败留位——onTurnEnded 入口补跑（WakeController.waking 同族一次性语义） */
  private due = false;
  private readonly clock: TimerClock;

  constructor(private readonly opts: TimerControllerOpts) {
    this.clock = {
      setTimeoutImpl: opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeoutImpl: opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      now: opts.now ?? (() => Date.now()),
    };
  }

  /** 当前调度位外窥（宿主 arm 接缝读「被替换者」以落终态行；测试断言面） */
  get scheduled(): WakeScheduleRecord | undefined {
    return this.current;
  }

  /** 到点未派发外窥（busy 排队/受理失败留位——宿主测试断言面） */
  get isDue(): boolean {
    return this.due;
  }

  /** 装配调度（替换旧位）：fireAt 已过（停机跨越重布防）=延迟 0 异步即发——R7 补发一次的统一路径 */
  arm(rec: WakeScheduleRecord): void {
    this.clearHandle();
    this.current = rec;
    this.due = false;
    const delay = Math.max(0, rec.fireAt - this.clock.now());
    this.handle = this.clock.setTimeoutImpl(() => this.expire(), delay);
  }

  /** 撤销当前调度（清句柄+清位——宿主无显式撤销动词面，reset 兜底共用） */
  cancel(): void {
    this.clearHandle();
    this.current = undefined;
    this.due = false;
  }

  /** 轮收束补跑口（宿主 submit finally 调用，WakeController.onTurnEnded 同位）：due 且空闲才派发。
   *  返回=本次收束是否已完成派发（受理与否由 fire 返回值定去留——未受理继续留位） */
  onTurnEnded(): boolean {
    if (!this.due || this.current === undefined) return false;
    if (this.opts.busy()) return false;
    return this.dispatch();
  }

  /** 收口（宿主 teardown/reset 换铸）：清句柄/位/due——防句柄泄漏，旧调度零残留 */
  reset(): void {
    this.cancel();
  }

  private clearHandle(): void {
    if (this.handle !== undefined) this.clock.clearTimeoutImpl(this.handle);
    this.handle = undefined;
  }

  /** 到点：busy 即 due 留位待轮收束；空闲即派发 */
  private expire(): void {
    this.handle = undefined;
    if (this.current === undefined) return;
    if (this.opts.busy()) {
      this.due = true;
      return;
    }
    this.dispatch();
  }

  /** 派发单点：迟到时长现算（now-fireAt，准点≈0）→ 宿主回调定去留——受理清位，未受理 due 留位重试 */
  private dispatch(): boolean {
    const rec = this.current;
    if (rec === undefined) return false;
    const lateMs = Math.max(0, this.clock.now() - rec.fireAt);
    if (this.opts.fire(rec, lateMs)) {
      this.current = undefined;
      this.due = false;
      return true;
    }
    this.due = true;
    return false;
  }
}
