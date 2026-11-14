// bg-wake spec §5/§6：唤醒的纯函数面与控制器——判定=「终态×未 receipted×空闲」，零模型意图依赖。
// 本模块零 IO（timer 除外），宿主（daemon/tui）经 opts 注入 busy/receipted/fire 三个接缝。
import type { KernelEntry, WakeRef } from './entry';
// 回执单点不在本模块：宿主起轮处注入 receiptOf（=receiptBody(t, 'task_wait')，Task 3 导出）——
// wake.ts 对 harness 零依赖（session 层纯件，通知文形态由 receiptOf 抽象隔离）

/** 唤醒轮 runTask 的 goal：check 节点无内嵌段时 goal 即单一隐式判据（走模型判据）——文案与通知文收尾指令同义 */
export const WAKE_GOAL = 'Follow up on the finished background task(s) noted in the latest task-notification; when nothing remains, reply briefly.';

/** run 条目直接前驱为唤醒 notice → 返回其 wake 引用（写入顺序固定 notice→run，spec §5.3，配对零歧义） */
export function wakeOfRun(entries: readonly KernelEntry[], runIdx: number): WakeRef[] | undefined {
  const prev = entries[runIdx - 1];
  return prev !== undefined && prev.kind === 'notice' && prev.wake !== undefined ? prev.wake : undefined;
}

/** 任务名解析（spec §5.1）：exec=title 缺省无名（label 是命令原文永不上屏）；subagent=title??label
 *  （回退段 'subagent' 无名）；板任务（boardDispatch）=板名优先（label 是板 id） */
export function resolveWakeName(
  t: { kind: 'exec' | 'subagent'; label: string; title?: string },
  boardDispatch: boolean,
  boardTitle?: string,
): string | undefined {
  if (boardDispatch) return boardTitle !== undefined && boardTitle !== '' ? boardTitle : undefined;
  if (t.kind === 'exec') return t.title !== undefined && t.title !== '' ? t.title : undefined;
  if (t.title !== undefined && t.title !== '') return t.title;
  return t.label !== 'subagent' ? t.label : undefined;
}

/** 登记任务 → 唤醒引用（boardRef=label 的 dispatchTag 形态，TaskBoardTab 定位 norm 面直接命中） */
export function toWakeRefs(
  tasks: ReadonlyArray<{ id: string; kind: 'exec' | 'subagent'; label: string; title?: string; boardDispatch?: boolean }>,
  boardTitleOf: (ledgerId: string) => string | undefined,
): WakeRef[] {
  return tasks.map((t) => {
    if (t.boardDispatch === true) {
      const name = resolveWakeName(t, true, boardTitleOf(t.id));
      return { id: t.id, board: true as const, boardRef: t.label, ...(name !== undefined ? { name } : {}) };
    }
    const name = resolveWakeName(t, false);
    return { id: t.id, ...(name !== undefined ? { name } : {}) };
  });
}

/** 模型面通知文（spec §5.2）：定性说明在正文内、回执由 receiptOf 注入（=task_wait receiptBody 同构）、系统提示零改动 */
export function buildWakeNotification(refs: readonly WakeRef[], receiptOf: (id: string) => string): string {
  return [
    '<task-notification>',
    'Automated notice, not a user message: background work you started earlier has finished.',
    ...refs.map((r) => receiptOf(r.id)),
    'Continue any work that was waiting on this result; if nothing remains, reply briefly.',
    '</task-notification>',
  ].join('\n');
}

/** 唤醒登记输入（=bg-task 事件载荷超集：ownerRun/boardDispatch 供归属判定） */
export interface WakeTaskInput {
  id: string;
  kind: 'exec' | 'subagent';
  label: string;
  title?: string;
  status: string;
  ownerRun?: string;
  boardDispatch?: boolean;
}

export interface WakeControllerOpts {
  /** 宿主运行态：run 在途即 busy（空闲 false） */
  busy(): boolean;
  /** 任务是否已被 task_wait/agent_team_task_wait 回执消费（宿主接 TaskRegistry.isReceipted） */
  receipted(id: string): boolean;
  /** 起唤醒轮；入参=过筛后的登记任务（板名解析在宿主侧：宿主内 toWakeRefs 后起轮）；
   *  返回 false=宿主未受理（如 plan 武装态）→ 批次回队待下次轮收束 */
  fire(tasks: WakeTaskInput[]): boolean;
  /** 触达连续唤醒上限（中间无用户消息） */
  onLimit?(): void;
  /** 合批窗口 ms（缺省 1500，spec §10-3 缺省裁定） */
  batchMs?: number;
  /** 连续唤醒上限（缺省 10，spec §10-2 缺省裁定） */
  maxChain?: number;
}

/** 唤醒控制器（session 层单点，daemon/TUI 各一实例）：登记/合批/用户优先/复检/防循环。
 *  零 IO（timer 除外）；宿主 teardown 调 reset() 清 timer（防句柄泄漏） */
export class WakeController {
  private pending: WakeTaskInput[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain = 0;
  /** 在途唤醒闩：fire 受理置位；onTurnEnded 入口一次性读清（含 interrupted——中断即无跟进，不留陈旧 true） */
  private waking = false;

  constructor(private readonly opts: WakeControllerOpts) {}

  /** 用户消息提交点调用（宿主 submit 用户路径）：连续唤醒计数归零 */
  markUserActivity(): void {
    this.chain = 0;
  }

  /** 任务终态入口（宿主接 harness opts.wake.onFinished）：非终态/非主链非板/重复登记一律忽略 */
  onTaskFinished(task: WakeTaskInput): void {
    if (task.status !== 'done' && task.status !== 'failed') return; // stopped=主动收口不唤醒（§3.1）
    if (task.ownerRun !== 'main' && task.boardDispatch !== true) return; // fork 名下由子智能体自己等待
    // 去重按寻址命名空间限定（板/主链两本账：板任务 id 归板台账、exec id 归 harness 账本，
    // 同串不同物——同命名空间重复才去重，跨命名空间共存）
    if (this.pending.some((p) => p.id === task.id && (p.boardDispatch === true) === (task.boardDispatch === true))) return;
    this.pending.push(task);
    if (!this.opts.busy()) this.scheduleFire(); // 空闲即开合批窗；运行中留存待轮收束
  }

  /** 轮收束续跑口（宿主在 steer 优先分支之后调用）；interrupted 保留 pending（§10-1 缺省裁定）。
   *  返回=本轮收束是否已有/将有唤醒轮跟进。闩在入口一次性读清：timer 已受理的在途批只报告一次，
   *  interrupted/消费后即回落 false，不向后续轮收束谎报跟进 */
  onTurnEnded(stopReason?: string): boolean {
    const r = this.waking; // 一次性读清（先取后清：interrupted 分支同清，空批分支经 tryFire 回报 r）
    this.waking = false;
    if (stopReason === 'interrupted') return false;
    return this.tryFire(r);
  }

  private scheduleFire(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tryFire(false); // timer 直调：空批返回值弃置，闭读写归 onTurnEnded 专管
    }, this.opts.batchMs ?? 1500);
  }

  private tryFire(prevWaking: boolean): boolean {
    if (this.opts.busy()) return false; // 计时器与用户提交竞态：busy 即本轮收束再取
    const batch = this.pending.filter((t) => !this.opts.receipted(t.id));
    this.pending = [];
    if (batch.length === 0) return prevWaking; // 空批（timer 已先受理/全部已 receipted）：回报入口读得的在途态，不新起轮
    if (this.chain >= (this.opts.maxChain ?? 10)) {
      this.opts.onLimit?.();
      this.waking = false;
      return false;
    }
    const ok = this.opts.fire(batch);
    this.waking = ok;
    if (ok) this.chain += 1;
    else this.pending = batch; // 未受理回队
    return ok;
  }

  reset(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.chain = 0;
    this.waking = false;
  }
}
