// bg-wake spec §5/§6：唤醒的纯函数面与控制器——判定=「终态×未 receipted×空闲」，零模型意图依赖。
// 本模块零 IO（timer 除外），宿主（daemon/tui）经 opts 注入 busy/receipted/fire 三个接缝。
// 值导入恒零（taskboard/leader.test 零导入钉，46fa519d——session/entry 经 GUI chat-reducer 进浏览器包，
// 值导入链必须零 Node/UI 依赖；外观双语归显示层，不在纯件，fix round 2）。
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

/** 登记任务 → 唤醒引用。板任务板名解析键=台账 label（=dispatchTag 形态）：遗留 task-tN 命中宿主
 *  锚定正则剥前缀归一命中板，新方言板 id 原样透传直接命中 board.tasks 键——账本 id（slug-时间戳-
 *  随机尾）两种形态都不是，恒 miss；boardRef 同用 label（TaskBoardTab 定位 resolveId 面直接命中） */
export function toWakeRefs(
  tasks: ReadonlyArray<{ id: string; kind: 'exec' | 'subagent'; label: string; title?: string; boardDispatch?: boolean }>,
  boardTitleOf: (dispatchTag: string) => string | undefined,
): WakeRef[] {
  return tasks.map((t) => {
    if (t.boardDispatch === true) {
      const name = resolveWakeName(t, true, boardTitleOf(t.label));
      return { id: t.id, board: true as const, boardRef: t.label, ...(name !== undefined ? { name } : {}) };
    }
    const name = resolveWakeName(t, false);
    return { id: t.id, ...(name !== undefined ? { name } : {}) };
  });
}

/** 唤醒通知标签单点：构建端（buildWakeNotification）与过滤端（entry.ts isQuietNotice）同源引用，改文案不静默失配 */
export const WAKE_NOTICE_TAG = '<task-notification>';
const WAKE_NOTICE_TAG_END = '</task-notification>';

/** 定时唤醒通知标签（2026-11-15 sunx P2 Task 3）：与任务唤醒标签同族两员——构建端
 *  （buildScheduleWakeNotification）与过滤端（entry.ts isQuietNotice 安静清单）同源引用 */
export const SCHEDULE_WAKE_TAG = '<schedule-wake>';

/** 恢复唤醒轮通知标签（2026-11-15 sunx P2 Task 5,R9）：attach 收尾自动重估的通知定性前缀——
 *  构建端（buildSessionRestoredNotification）与过滤端（entry.ts isQuietNotice 安静清单）同源引用。
 *  三员同族：机制通知对显示面零信息量（notice 本体不上屏,恢复轮显示走普通 run 行） */
export const SESSION_RESTORED_TAG = '<session-restored>';

/** 定时唤醒轮 runTask 的 goal：与通知文收尾指令同义（WAKE_GOAL 同构——goal 只是观测标签不进提示词链） */
export const SCHEDULE_WAKE_GOAL = 'Continue toward your outstanding goals; if nothing remains, reply briefly.';

/** 恢复唤醒轮 runTask 的 goal（R9）：与通知文收尾重估指令同义（同上——观测标签不进提示词链） */
export const RESTORED_WAKE_GOAL = 'Re-read the board and ledger, decide what to re-dispatch, and report to the user what was lost.';

/** 迟到注明宽限（准点定时器抖动容差）：lateMs 超过它才在通知文注「fired late by」——
 *  busy 排队/停机跨越的迟到远超此值，准点 fire 的毫秒级抖动不注 */
export const SCHEDULE_LATE_GRACE_MS = 1_000;

/** 迟到时长人读串（R7 通知文「fired late by X」数据源）：秒内=Xs、时内=Xm Ys、其余=Xh Ym */
export function formatDelayMs(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 定时唤醒通知文（P2 Task 3 裁定模板）：定性说明+note 正文+迟到注明（可选）+收尾指令。
 *  无任务回执段（不混 WakeRef 词汇——schedule_task 的派发结论走其自身终态的既有任务唤醒轮） */
export function buildScheduleWakeNotification(note: string, lateMs?: number): string {
  const late = lateMs !== undefined && lateMs > SCHEDULE_LATE_GRACE_MS
    ? `\nThis wake fired late by ${formatDelayMs(lateMs)}; handle accordingly.`
    : '';
  return `${SCHEDULE_WAKE_TAG}\nScheduled wake (not a user message): ${note}${late}\nContinue toward your outstanding goals; if nothing remains, reply briefly.`;
}

/** 定时唤醒轮判定（P2 Task 3）：run 条直接前驱为携 schedule 标记的 notice → true（写入顺序固定
 *  notice→run 同 wakeOfRun，配对零歧义）。与 wakeOfRun 并立两函数——两词汇零交集；显示前缀
 *  「定时唤醒」的文案与拼接归显示层（GUI chat-reducer/EntryViews，fix round 2——纯件零 i18n 导入钉） */
export function scheduledWakeOfRun(entries: readonly KernelEntry[], runIdx: number): boolean {
  const prev = entries[runIdx - 1];
  return prev !== undefined && prev.kind === 'notice' && prev.schedule === true;
}

// ===== 恢复唤醒轮通知文（2026-11-15 sunx P2 Task 5,R9 自动重估）=====

/** 恢复轮打断任务行（attach 序推导的「自愈清单」条目——板上 recoverOnLoad 自愈 cancelled/台账
 *  孤儿重放标 stopped 两源归一）：name=人读名（板 title/台账 title??label）、id=寻址键、status=自愈终态 */
export interface RestoredInterrupted {
  name: string;
  id: string;
  status: string;
}

/** 恢复轮素材行（PendingMaterial 的呈现投影——裁定 5 只取 title/askedBy：问题原文全文已在行里
 *  可由模型按 pid 审计,素材行保持简短;结构化定义避免本模块反向依赖 seglog） */
export interface RestoredMaterial {
  title: string;
  askedBy?: { label: string; taskId?: string };
}

/** 恢复唤醒通知文（R9 裁定模板）：定性说明+打断清单（title/id+自愈终态）+未决素材列（title+askedBy
 *  归因）+重估指令。两清单节各自空则整节省略（触发条件保证至少一节在场——全无素材静默不起轮）。
 *  无任务回执段（不混 WakeRef 词汇——清单行是人读投影,run 配对走 restored 标记） */
export function buildSessionRestoredNotification(interrupted: ReadonlyArray<RestoredInterrupted>, materials: ReadonlyArray<RestoredMaterial>): string {
  const lines: string[] = [
    SESSION_RESTORED_TAG,
    'Session restored after a daemon restart (not a user message).',
  ];
  if (interrupted.length > 0) {
    lines.push('Dispatched tasks interrupted by the restart:');
    for (const t of interrupted) lines.push(`- ${t.name} (${t.id}): ${t.status}`);
  }
  if (materials.length > 0) {
    lines.push('Unanswered questions left pending:');
    for (const m of materials) {
      const by = m.askedBy !== undefined ? ` (asked by ${m.askedBy.label}${m.askedBy.taskId !== undefined ? `, task ${m.askedBy.taskId}` : ''})` : '';
      lines.push(`- ${m.title}${by}`);
    }
  }
  lines.push('Re-read the board and ledger, decide what to re-dispatch, and report to the user what was lost.');
  return lines.join('\n');
}

/** 恢复唤醒轮判定（R9）：run 条直接前驱为携 restored 标记的 notice → true（写入顺序固定 notice→run
 *  同 wakeOfRun/scheduledWakeOfRun,配对零歧义）。三配对函数并立——三词汇零交集,显示面互不串号 */
export function sessionRestoredOfRun(entries: readonly KernelEntry[], runIdx: number): boolean {
  const prev = entries[runIdx - 1];
  return prev !== undefined && prev.kind === 'notice' && prev.restored === true;
}

/** 模型面通知文（spec §5.2）：定性说明在正文内、回执由 receiptOf 注入（=task_wait receiptBody 同构）、系统提示零改动 */
export function buildWakeNotification(refs: readonly WakeRef[], receiptOf: (id: string) => string): string {
  return [
    WAKE_NOTICE_TAG,
    'Automated notice, not a user message: background work you started earlier has finished.',
    ...refs.map((r) => receiptOf(r.id)),
    'Continue any work that was waiting on this result; if nothing remains, reply briefly.',
    WAKE_NOTICE_TAG_END,
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

/** 缺省单点（2026-11-16 技术债补审 I2：三处 `?? 10`/`?? 1500` 字面量重复收编） */
export const WAKE_MAX_CHAIN_DEFAULT = 10;
export const WAKE_BATCH_MS_DEFAULT = 1500;

/** 唤醒控制器（session 层单点，daemon/TUI 各一实例）：登记/合批/用户优先/复检/防循环。
 *  零 IO（timer 除外）；宿主 teardown 调 reset() 清 timer（防句柄泄漏） */
export class WakeController {
  private pending: WakeTaskInput[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain = 0;
  /** 在途唤醒闩：fire 受理置位；onTurnEnded 入口一次性读清（含 interrupted——中断即无跟进，不留陈旧 true） */
  private waking = false;
  /** 会话换新屏蔽集（宿主 reset(ids) 注入）：旧会话在跑任务的 id——其**日后**终态（finish 照样找到跨
   *  /new 存活的台账对象）不得唤醒新会话；单清 pending 挡不住后续终态，故在登记入口最前拦截 */
  private ignored = new Set<string>();

  constructor(private readonly opts: WakeControllerOpts) {}

  /** 用户消息提交点调用（宿主 submit 用户路径）：连续唤醒计数归零 */
  markUserActivity(): void {
    this.chain = 0;
  }

  /** 非任务唤醒（定时唤醒，P2 Task 3）计入连续上限的登记口：触顶=onLimit 已发+返回 false
   *  （调用方放弃本次起轮——定时唤醒受同一防循环上限约束）；未触顶计一并返回 true。
   *  与任务唤醒同账本（chain 单一）——用户消息 markUserActivity / reset 归零语义共用 */
  consumeChain(): boolean {
    if (this.chain >= (this.opts.maxChain ?? WAKE_MAX_CHAIN_DEFAULT)) {
      this.opts.onLimit?.();
      return false;
    }
    this.chain += 1;
    return true;
  }

  /** 任务终态入口（宿主接 harness opts.wake.onFinished）：屏蔽集命中（会话换新前的旧任务）最前拦截；
   *  非终态/非主链非板/重复登记一律忽略 */
  onTaskFinished(task: WakeTaskInput): void {
    if (this.ignored.has(task.id)) return; // 会话换新屏蔽：旧会话任务不唤醒新会话（bg-wake §3 跨会话隔离）
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
    }, this.opts.batchMs ?? WAKE_BATCH_MS_DEFAULT);
  }

  private tryFire(prevWaking: boolean): boolean {
    if (this.opts.busy()) return false; // 计时器与用户提交竞态：busy 即本轮收束再取
    const batch = this.pending.filter((t) => !this.opts.receipted(t.id));
    this.pending = [];
    if (batch.length === 0) return prevWaking; // 空批（timer 已先受理/全部已 receipted）：回报入口读得的在途态，不新起轮
    if (this.chain >= (this.opts.maxChain ?? WAKE_MAX_CHAIN_DEFAULT)) {
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

  /** 收口（宿主 teardown）/会话换新（宿主软重置）双用：清 timer/pending/chain/waking；
   *  ignoreIds 在场=会话换新屏蔽集（旧会话在跑任务 id，其日后终态不唤醒新会话）；无参=清空屏蔽集
   *  （daemon disposeRuntime 既有无参调用零变化） */
  reset(ignoreIds?: Iterable<string>): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.chain = 0;
    this.waking = false;
    this.ignored = new Set(ignoreIds ?? []);
  }
}
