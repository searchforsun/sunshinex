import * as path from 'node:path';
import { spillImages } from './images-cache';
import { createKernelRuntime } from '../session/runtime';
import { resolveDataDir } from '../config/data-dir';
import { parseTier } from '../runtime';
import { parseEffort } from '../model/effort';
import type { ModelTier, ReasoningEffort, SessionKind } from '../types';
import { ModelSwitcher } from '../model/catalog';
import type { KernelRuntime } from '../session/runtime';
import type { ScheduleCreateSeam } from '../harness/tools/schedule-create-tool';
import type { SunxPeersSeam } from '../harness/tools/sunx-peer-tools';
import type { ModelAdapter } from '../model/adapter';
import type { ApprovalDecision, ApprovalRequest, AskUserAnswer, AskUserRequest, SessionEvent, SunxPeerRef, TodoItem } from '../types';
import { applyBoardEvent, emptyBoard } from '../taskboard/model';
import { t } from '../i18n';
import type { TaskBoardState } from '../taskboard/model';
import type { AgentTeam } from '../taskboard/team-registry';
import { applyDelegation } from '../delegation/projection';
import type { Delegation } from '../delegation/projection';
import { boardEventFrom } from '../tui/session';
import type { SessionJournal, JournalEvent } from '../session/journal';
import * as fs from 'fs';
import type { SnapshotEntry } from '../session/journal';
import { SessionKernel, isShadowEvent, type KernelEvent, type SteerItem } from '../session/kernel';
import { kernelEventRows, reduceWakeScheduleRows, reducePendingRows } from '../session/seglog';
import type { SegRowLike, WakeScheduleRecord, PendingMaterial } from '../session/seglog';
import type { KernelEntry } from '../session/entry';
import { sanitizeTurn } from '../session/entry';
import { WakeController, WAKE_GOAL, toWakeRefs, buildScheduleWakeNotification, buildSessionRestoredNotification, SCHEDULE_WAKE_GOAL, RESTORED_WAKE_GOAL } from '../session/wake';
import { boardTaskTitleOf, buildWakeNotice } from '../session/wake-host';
import type { WakeTaskInput, RestoredInterrupted, RestoredMaterial } from '../session/wake';
import { TimerController } from '../session/timer';
import { forkDispatch } from '../harness/subagent';
import { readSessionMeta, writeSessionMeta, sessionsDir, parseJournalFile, journalDisplayTitle } from '../session/journal';
import { resolveRunWindow, reactorMaxStepsEnv, subagentTokenCapEnv } from '../config/termination-config';
import { derivePlanName, parseNumberedSteps, PLAN_MODE_NOTE } from '../harness/plan-flow';
import type { PlanDecision, PlanLandMode } from '../harness/plan-flow';
import { writePlanDoc } from '../session/journal';
import { listChanges, diffChangeSets } from './session-changes';
import { lineDiffCounts } from '../harness/tools/write-diffstat';
import type { Artifact, ChangeFile, TurnFileChange } from '../types';
import { mergeRunArtifacts, scanArtifactsJsonl, mergeAggregated, type AggregatedArtifact } from './artifacts-handlers';
import type { ApprovalFrame, AskFrame, DaemonFrame, PlanApprovalFrame } from './daemon-wire';
/** RunMeta 本体上收内核条目模型(src/session/entry,内核单点)——此处 type re-export 供既有消费方 */
export type { RunMeta } from '../session/entry';

/** 影子事件判定单点在内核层(src/session/kernel,内核落档透传与本面回放改道共用)——此处原路径
 *  转口供 daemon 回放面与测试消费。WS 回放面据此把这类帧从 512 环窗改道 journal 全量重发
 *  (环窗对长会话子智能体流必溢出,刷新后投影恢复不可依赖环窗;journal 落档先于广播,行集恒为全量真源) */
export { isShadowEvent } from '../session/kernel';

/**
 * 会话运行时（G3 会话中心 T1）：从 daemon 单会话态整体平移的每会话单元——按会话 root 独立装配
 * `createRuntime`（独立泵/影子投影/转录/run 票据），daemon 只持注册表与全局面（seq 计数/WS 连接）。
 * 装配零旁路：与 TUI 同一 `createKernelRuntime` 单点（mode 缺省 full-access；P6 §4 挂起接缝无条件注入——
 * 审批/问询挂起表在会话,daemon 只注入 mintPid/broadcast 网络寻址两接缝）。
 */

/** WS 下行事件帧（会话中心 + G3 seq 协议）：`{kind:'event', sessionId, seq, e}`——sessionId 为帧所属
 *  会话（三型帧均挂；approval/ask 挂起面帧 G4 起另形同挂 sessionId，不入单调序列）；seq 为 daemon 级
 *  全局单调序号（T1 裁定：全局而非每会话——跨会话不重号，客户端按 sessionId 过滤后仍是严格递增流）。
 *  补发与实时共用同一帧形 */
export interface EventFrame {
  kind: 'event';
  sessionId: string;
  seq: number;
  e: SessionEvent;
}

/** GET /session/:id/snapshot 载荷（G2 Ruling 1 两轨分工的归档面快照）；G5 增 team 段（teammate
 *  投影——harness.team 同源），pending 段由 daemon 侧合并（挂起表 daemon 级资产，session 不持——
 *  见 daemon.handleSnapshot） */
/** 分页形态(2026-10-26 三期):缺省尾窗 200;before/limit 向前翻页。tail 与 before 互斥 */
export interface SessionSnapshotPage {
  tail?: number;
  before?: number;
  limit?: number;
}

/** 会话 todo 批次行(快照载荷面):daemon 权威投影,GUI「待办」页签直显(不再仅靠转录派生)。
 *  2026-11-25「给待办一个标题参数」:title=模型自拟清单名,同标题跨轮更新归并为**同一待办**
 *  (key/ts=首写落定,updatedTs=最近更新);goal/userKey(用户气泡回链)退役 */
interface SessionTodoBatch {
  key: string;
  ts: number;
  /** 最近一次更新时刻(跨轮归并后就地推进;旧行缺省=ts) */
  updatedTs?: number;
  /** 模型给清单起的标题(todo_write.title;缺省=按条目签名归并,旧载荷兼容) */
  title?: string;
  items: Array<{ text: string; status: 'completed' | 'in_progress' | 'pending' }>;
}

interface SessionSnapshot {
  messages: KernelEntry[];
  /** 内核流式游标(G14.51 归位):快照时刻的 openRun/openSeg——客户端装载直用,不再从条目反推 */
  openRun: number;
  openSeg: number;
  /** 分页元数据(2026-10-26 三期,恒在):total=内核条目全量数;oldestSeq=本页最旧 seq
   *  (客户端向前翻页游标);hasMore=本页之前仍有更早条目 */
  total: number;
  oldestSeq?: number;
  hasMore: boolean;
  board: TaskBoardState;
  delegations: Delegation[];
  status: 'idle' | 'running';
  lastSeq: number;
  team: Array<{ name: string; busy: boolean; teamId?: string; createdAt?: number }>;
  /** 工作区 AgentTeam 注册表投影（teamId/name/createdAt） */
  teams: AgentTeam[];
  /** G10-C1b 切换回显段:model=当前选择 id(undefined=缺省主模型/单模型);mode=会话权限态 */
  model?: string;
  mode: SessionMode;
  /** G10-C2b 档位/思考强度覆盖(undefined=缺省) */
  tier?: SessionTier;
  effort?: ReasoningEffort;
  /** G10-C1d 排队插话段(steering FIFO 快照;seq=队列下标,cancel 寻址键);images=随行图片附件 */
  queued: Array<{ seq: number; text: string; images?: string[] }>;
  /** 队列暂停态（2026-11-23 用户裁定「中断同时暂停队列」）：真=轮收束不自动发出,待发条目留存,
   *  GUI 队列面板显示暂停横幅;解除仅经队列恢复端点 */
  queuePaused: boolean;
  /** 归档态(2026-10-21):旁车 meta archived 回读——GUI 顶栏归档钮/徽标三态播种;未附 journal 恒 false */
  archived: boolean;
  /** todo 批次权威投影(2026-10-31 用户裁定):journal 全量派生+live 增量——GUI 直显,无旧档兼容面 */
  todoBatches: SessionTodoBatch[];
  /** fork 血缘(2026-11-04 用户裁定「分叉于会话」横幅面):journal header forkedFrom 读数(kind='fork'
   *  主链分档;side=辅助档不显)。title=父档显示题(journalDisplayTitle 单点)。原生会话缺省缺席 */
  forkedFrom?: { sessionId: string; title: string };
}

/** snapshot 挂起段行（G5）：kind 判别与 daemon 挂起表同源（approval/ask/plan-approval——阶段三
 *  plan-arm 新增计划裁决卡）;pid 为 daemon 级铸造票据——跨会话卡恢复（GUI 重启/刷新后重放挂起面）
 *  的寻址键；G7 增 req=挂起表 entry.req 直序列化（ApprovalRequest/AskUserRequest/计划卡 {doc,items}
 *  字面）——GUI reseed 重建卡的内容面（连接层 pid 去重拦了重发帧，snapshot 是刷新后卡内容的唯一来源） */
export interface SnapshotPendingRow {
  pid: string;
  kind: 'approval' | 'ask' | 'plan-approval';
  req: unknown;
}

/** submit 结果：ok=true 受理（HTTP 202 面）；ok=false 拒（运行中 409——不排队，GUI 侧无队列语义，
 *  排队会静默吞掉用户意图） */
type SessionSubmitResult = { ok: true } | { ok: false; status: 409; error: string };

/** interrupt 结果：ok=true 已发中止信号；ok=false 无在跑 run（409 面） */
type SessionInterruptResult = { ok: true } | { ok: false; error: string };

/** 一轮收尾信息（定时任务执行记录回填）：stopReason=done/interrupted/其它；一次性观察者。
 *  endedAt=收尾时刻（epoch ms）；seconds=轮计算秒数（与 runmeta 同源）；tokens=本轮 tokensUsed（在场才给） */
export interface RunEndInfo {
  stopReason?: string;
  endedAt: number;
  seconds: number;
  tokens?: number;
}

/** 单 run 锁的在场票据：abort 句柄持有即「运行中」，run 收束（含中断/失败）即清位；done 为 run promise
 *  本体——teardown/reset 的有界等待锚点（被中止 run 的 settle 收口等待经它观测） */
interface CurrentRun {
  abort: AbortController;
  done: Promise<void>;
}

/** 事件环形缓冲容量（重连补发窗口）：满即丢最老——daemon 长跑不无界涨内存 */
const EVENT_BUFFER_CAP = 512;

/** teardown/reset 步骤 0 有界等待上限（终审裁定）：被中止 run 的 settle 钩子（沉淀入队）收口窗口，2s 防
 *  signal 无视的工具悬挂 teardown；超时即放行进后续步骤 */
const ABORTED_RUN_SETTLE_MS = 2_000;

/** 通道元信息 → 会话冻结层文本（2026-11-23 用户裁定「平台/聊天 id/应用名进系统上下文」）：
 *  全静态字段——同一聊天所有轮次逐字节一致（前缀缓存零损失）；发言用户是动态的（群聊每人
 *  不同）**不进此层**，由消息级 [来自 x]: 前缀承载（router ⑫）。appName 可改（设置页改名），
 *  改名后新轮次缓存重铸一次为可接受代价（用户裁定确认）。
 *  身份来源（2026-11-25 裁定「和 sunx 是隔离的,应该注入的是应用名称」）：通道会话的身份字段
 *  只取此处的应用名称——身份由数据来源决定,不靠措辞约束模型 */
function channelMetaCharter(m: { platform: string; chatId: string; appName?: string; userName?: string; userId?: string }): string {
  const lines = [
    `当前通道平台: ${m.platform}`,
    `当前聊天 id: ${m.chatId}`,
  ];
  if (m.appName !== undefined && m.appName !== '') lines.push(`当前应用名称: ${m.appName}`);
  // 单聊用户身份（2026-11-25 用户裁定「上下文中应该知道当前用户 userid 和用户名」）:群聊发送者
  // 随消息变（消息级 [来自 名字（id）] 前缀承载）,单聊对象固定=聊天人——出生定版进冻结层
  if (m.userName !== undefined || m.userId !== undefined) {
    const name = m.userName !== undefined && m.userName !== '' ? m.userName : m.userId ?? '';
    const id = m.userId !== undefined && m.userId !== '' && m.userId !== name ? `（${m.userId}）` : '';
    if (name !== '') lines.push(`当前聊天用户: ${name}${id}`);
  }
  return lines.join('\n');
}

export interface SessionRuntimeOpts {
  id: string;
  /** 会话工作目录（绝对路径——daemon.createSession 解析后注入；buildHarness 按它装配数据底座） */
  root: string;
  /** 模型适配器（daemon 级注入，与 CLI buildModel/TUI 三面同一 ModelAdapter 契约） */
  model: ModelAdapter;
  /** seq 分配器：daemon 级全局单调计数（T1 裁定——跨会话不重号，帧过滤按全局单调语义不破） */
  nextSeq: () => number;
  /** 泵广播面：帧经 daemon WS 层序列化后发全部连接（连接层按 sessionId 分发/过滤，T3）。
   *  P6 放宽至 DaemonFrame 全并集——事件帧与挂起帧同路（挂起帧由会话自己组帧广播） */
  broadcast: (frame: DaemonFrame) => void;
  /** 权限模式（G4 manual 接线）：缺省 full-access（GUI v1 无终端交互面,沿原 dontAsk 地位正名）；acceptEdits 时
   *  guard asker 走本会话挂起表（suspendApproval 内判定——P6 §4 下沉后装配接缝在 assemble() 无条件注入） */
  mode?: SessionMode;
  /** 挂起 id 铸造接缝（P6 §4）：daemon 级单调 `p<n>`（跨会话全局唯一——回执端点寻址键），
   *  会话注册挂起时调用；铸造权留 daemon（网络寻址面职责，spec §4 裁定） */
  mintPid: () => string;
  /** 模型切换器（G10-C1b）：daemon 装配为 ModelSwitcher 时注入（全会话共享同一实例——切换 daemon 级生效） */
  modelSwitcher?: ModelSwitcher;
  /** 会话形态（2026-11-15 sunx P1 Task 4）：'sunx' 时 assemble() 透传 createKernelRuntime——稳定段身份槽/
   *  编排章程、SUNX_FACE_TOOLS 白名单、fork 子代 kind 继承全链激活；缺席=standard 装配逐字节不变 */
  kind?: SessionKind;
  /** 自定义会话名（2026-11-15 sunx P1 Task 4）：出生 meta 落 title——只进 G14.16 既有显示链
   *  （侧栏/悬浮卡/列表题），不进提示词（出生身份行不变） */
  name?: string;
  /** 实例品性原文（charter，2026-11-15 sunx §17.1 用户面=品性/代码面=charter）：assemble() 透传
   *  ContextManager 会话冻结层（全局 → 项目 → 品性）；后续编辑走 /session/:id/charter 尾追替代行 */
  charter?: string;
  /** Sunx 所属群（2026-11-26 群组规格 §3.2）：出生 meta 落 groupId；缺席=不写键（读取兜底默认群） */
  groupId?: string;
  /** 通道元信息（2026-11-23 用户裁定「平台/聊天 id/应用名进系统上下文」）：assemble() 透传
   *  ContextManager 会话冻结层——出生定版一次不重写（前缀缓存纪律：同一聊天逐字节一致；
   *  动态发言用户走消息级 [来自 x]: 前缀不入此层）；缺席=普通会话装配字节不变 */
  channelMeta?: { platform: string; chatId: string; appName?: string; userName?: string; userId?: string };
  /** 定时分派清单接缝（2026-11-25 用户裁定④,session-lifecycle io 透传）：task_status 工具回执附段 */
  schedulesFor?: (root: string) => Array<{ name: string; nextRunAt: number | null }>;
  /** 持久化域目录（2026-11-15 sunx P3 Task 2 域绑定）：sunx 出生即铸档时由 createSessionIn 注入
   *  `~/.sunshinex/sunx/<journalId>/data`——assemble() 透传 buildHarness（持久化数据面全落域），
   *  `dataDir` 外窥供 handler 寻址；缺席（standard/TUI/CLI）=resolveDataDir(root) 既有推导逐字节不变 */
  dataDir?: string;
  /** 定时任务创建接缝（2026-11-20）：daemon 注入 ScheduleEngine 出口，assemble() 透传
   *  createKernelRuntime——create_scheduled_task 工具由它落档/布防；缺席=工具不注册（TUI/CLI） */
  scheduleCreate?: ScheduleCreateSeam;
  /** send_channel_message 接缝（spec §6;2026-11-23 用户裁定「补上 send_channel_message」）：
   *  daemon lifecycleIo channelSendFor 按 sessionId 注入，assemble() 透传 harness——
   *  send_channel_message 工具由它投递到绑定聊天；缺席=工具不注册（TUI/CLI） */
  channelSend?: { send(text: string): Promise<boolean> };
  /** 跨 Sunx 对等消息接缝（2026-11-26 用户裁定「两个工具实现 sunx 之间的聊天」）：
   *  daemon lifecycleIo sunxPeersFor 按 sessionId 注入，assemble() 透传 harness——
   *  list_sunx_peers/send_sunx_messages 由它枚举活实例/投递；缺席=工具不注册（TUI/CLI/子面） */
  sunxPeers?: SunxPeersSeam;
}

/** 挂起表条目（P6 §4 下沉,原 daemon-wire 资产）：kind 判别联合；resolve 即回执值（interrupt/reset
 *  以 deny/dismissed/放弃回填,TUI approval.ts 先例——plan 卡中断=confirmPlan(false) 语义）。
 *  sessionId 出模型——条目恒在所属会话表内,同会话寻址自明;wire 帧（ApprovalFrame/AskFrame/
 *  PlanApprovalFrame）由会话组帧时携带自身 id */
type PendingEntry =
  | { kind: 'approval'; req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }
  | { kind: 'ask'; req: AskUserRequest; resolve: (a: AskUserAnswer) => void }
  | { kind: 'plan-approval'; req: { name?: string; path?: string; doc: string; items: string[] }; resolve: (d: PlanDecision) => void };

/** snapshot 挂起段行（G5/P6 后由会话自产）：kind 判别与挂起表同源（approval/ask/plan-approval）；
 *  pid 为 daemon 级铸造票据——跨会话卡恢复（GUI 重启/刷新后重放挂起面）的寻址键；req=挂起表
 *  entry.req 直序列化（ApprovalRequest/AskUserRequest/计划卡 {doc,items} 字面）——GUI reseed 重建卡
 *  的内容面（连接层 pid 去重拦了重发帧, snapshot 是刷新后卡内容的唯一来源） */
export interface SnapshotPendingRow {
  pid: string;
  kind: 'approval' | 'ask' | 'plan-approval';
  req: unknown;
}

/** 会话模式（G10-C1b，spec §3.2）：read-only/acceptEdits/full-access 为权限档（=PermissionMode）；
 *  plan 为**流程标记**（阶段三 plan-arm——armed 态提交经 planFlow 走规划流程,权限面恒三档,
 *  装配映射 plan→acceptEdits,内核闲置于 acceptEdits） */
export type SessionMode = 'read-only' | 'acceptEdits' | 'full-access' | 'plan';

/** 运行中切换面(G10-C1b/C2b):tier/effort per-run 注入 runTask opts(与 TUI ctrl.state 同语义,下一轮生效) */
type SessionTier = ModelTier;

export class SessionRuntime {
  readonly id: string;
  /** 会话工作区根(树会话=工作树路径;可变仅经 rehomeRoot——attach 按档归位,2026-11-11 树会话
   *  重启回主分支根修:GUI 恢复链只有组根,journal 旁车 meta.root 才是真根) */
  root: string;
  /** 会话形态（2026-11-15 sunx P1 Task 4；2026-11-15 final review fix wave 起可变——唯一写点
   *  reCast）：出生装配定死，存实例字段——reset/rehomeRoot/reCast 换铸经同一 assemble() 每次透传
   *  不丢（setMode 真档直切不换铸更是零风险）；sunx 判定外窥供 charter 编辑端点 409 面消费 */
  sessionKind: SessionKind | undefined;
  /** 自定义会话名（2026-11-15）：仅出生 meta.title 消费（显示链），不进提示词；reCast 唯一写点 */
  private sessionName: string | undefined;
  /** 创建名外窥(sunx P2 2026-11-15 用户实测「打开就是新会话」修):title GET 未铸档窗口回显
   *  创建名——打开即显姓名,窗口期到首条消息落 birth 为止;sessionKind 同款公开面 */
  get sunxName(): string | undefined {
    return this.sessionName;
  }
  /** 通道绑定外窥（2026-11-25 用户裁定「每个会话的名称和普通会话一样」）：channelMeta 在场=
   *  通道聊天会话——title GET 的出生名回落对其关闭（顶栏随首条消息总结/重命名走,不再钉
   *  应用名;手建 Sunx 回落保持「打开即显姓名」既有语义） */
  get channelMeta(): { platform: string; chatId: string; appName?: string } | undefined {
    return this.opts.channelMeta;
  }
  /** 持久化域目录外窥（2026-11-15 sunx P3 Task 2 寻址面单点）：注入（sunx 出生即铸档）=域目录；
   *  缺席=resolveDataDir(root) 既有推导——handler/attach 链/会话内落盘面统一改走本外窥后，
   *  standard 字节不变、sunx 全部持久化面（journal/meta/台账/板/记忆/计划书/快照）自动随域 */
  get dataDir(): string {
    return this.opts.dataDir ?? resolveDataDir(this.root);
  }
  /** 实例品性原文（2026-11-15 sunx §17.1）：assemble() 每次换铸透传 ContextManager 品性冻结层；
   *  reCast 唯一写点 */
  private sessionCharter: string | undefined;
  /** 品性当前态（2026-11-15 sunx P2 Task 7 GET 读面事实源）：出生 charter 起步，编辑端点
   *  noteCharterEdit 单点推进——charterLayer 构造即冻结不随编辑动（前缀缓存纪律+append-only
   *  替代行语义），读面若直读冻结层，编辑后 GET 会落出生旧文（合同测试 ⑨b 红检实证） */
  private charterCurrent: string | null;
  private opts: SessionRuntimeOpts;
  /** 会话运行时本体（reset 时整体换新——软重置等价 /new：换 Harness 即换上下文链/沉淀管线/steering） */
  private runtimeImpl: KernelRuntime;
  private current?: CurrentRun;
  /** 轮收尾观察者（一次性；run finally 清空——定时任务执行记录）。finally 内 current 清位后同步回调 */
  private readonly runEndListeners = new Set<(info: RunEndInfo) => void>();
  /** 唤醒控制器（bg-wake spec §3）：登记/合批/续发单点；receipted 查 harness live 面（换铸后新实例同账本对象） */
  private readonly wake = new WakeController({
    busy: () => this.current !== undefined,
    receipted: (id) => this.runtimeImpl.harness.tasks.isReceipted(id),
    fire: (tasks) => this.submitWake(tasks),
    onLimit: () => this.pump({ type: 'notice', text: 'auto-wake limit reached (no user message in between)', ts: Date.now() }),
  });

  /** 定时调度控制器（2026-11-15 sunx P2 Task 3）：会话级单活跃调度位——到点=fireScheduled 宿主接缝
   *  （组 notice+起轮/schedule_task 先派发，同一回调内完成）；busy 排队沿 WakeController 空闲判定模式。
   *  reset/reCast 换铸随 disposeRuntime reset()（句柄收口，WakeController 同纪律） */
  private readonly timer = new TimerController({
    busy: () => this.current !== undefined,
    fire: (rec, lateMs) => this.fireScheduled(rec, lateMs),
  });
  /** 定时调度 id 计数器（sched-<n>，会话内单调——机制行/回执寻址键；重启后 attach 重布防沿用档上 id 不重铸） */
  private scheduleSeq = 0;

  /** 工具 arm 接缝（harness opts.schedule 注入，仅 sunx 装配）：id 铸造+未触发态机制行落档+
   *  被替换者终态行（回放面跳过的闸门——替换语义跨重启不复活旧调度） */
  private armSchedule(input: { fireAt: number; note: string; taskSpec?: string }): { id: string; replacedId?: string } {
    const id = `sched-${(this.scheduleSeq += 1)}`;
    const prev = this.timer.scheduled;
    this.armScheduleRecord({ ...input, id });
    this.logScheduleRow({ ...input, id });
    return { id, ...(prev !== undefined ? { replacedId: prev.id } : {}) };
  }

  /** 调度位装配单点（工具 arm 与 attach 重布防共用）：先落被替换者终态行再换位——顺序保证
   *  journal 扫描（按 id 末行）永远看到替换者已终结 */
  private armScheduleRecord(rec: WakeScheduleRecord): void {
    const prev = this.timer.scheduled;
    if (prev !== undefined && prev.id !== rec.id) this.logScheduleRow({ ...prev, firedAt: Date.now() });
    this.timer.arm(rec);
  }

  /** wake-schedule 机制行落档单点（runmeta 直写先例——arm 非内核转录事件，不经 kernelEventRows）：
   *  尽力落档，写失败不影响运行面 */
  private logScheduleRow(rec: WakeScheduleRecord): void {
    try {
      this.journal?.log({
        t: 'wake-schedule',
        id: rec.id,
        fireAt: rec.fireAt,
        note: rec.note,
        ...(rec.taskSpec !== undefined ? { taskSpec: rec.taskSpec } : {}),
        ...(rec.firedAt !== undefined ? { firedAt: rec.firedAt } : {}),
      });
    } catch {
      // 尽力落档：机制行写失败不阻断调度运行面
    }
  }

  /** pending 机制行落档单点（2026-11-15 sunx P2 Task 4,wake-schedule 同先例——挂起非内核转录事件，
   *  不经 kernelEventRows）：suspend 入口落 pending-open、resolve/deny 出口落 pending-resolve。
   *  尽力而为落档纪律：写失败不影响挂起运行面（帧广播照常）。journal 未挂载（测试直构）即丢弃 */
  private logPendingRow(row: { t: 'pending-open'; pid: string; kind: 'ask' | 'approval' | 'plan-approval'; req: unknown } | { t: 'pending-resolve'; pid: string; outcome: string }): void {
    try {
      this.ensureMintedWithBirth(); // 挂起行也是实质事件（审计①）——档未铸先铸（幂等,首行已铸则 no-op）
      this.journal?.log(row);
    } catch {
      // 尽力落档：挂起行写失败不阻断挂起/回执运行面
    }
  }

  /** 到点回调（TimerController fire 接缝）：plan 武装态不受理（留位待下次轮收束——submitWake 同判定）
   *  → 连续唤醒上限计入（触顶=调度终结[落终态行防重放重发]、放弃起轮——定时唤醒受同一防循环约束）
   *  → schedule_task 先 fork 派发（dispatch fork 通道同款路径 forkDispatch 单点）→ 起定时唤醒轮
   *  （submitWake 同管线：notice 携 schedule 标记+run 固定序）。受理才落终态行——回队/停机跨越
   *  （R7）保持未触发态，重启重布防补发至多一次 */
  private fireScheduled(rec: WakeScheduleRecord, lateMs: number): boolean {
    if (this.planArmed()) return false;
    if (!this.wake.consumeChain()) {
      this.logScheduleRow({ ...rec, firedAt: Date.now() });
      return true;
    }
    if (rec.taskSpec !== undefined) {
      // schedule_task：先派发再起轮——同一回调内完成；派发失败不阻断唤醒轮（简报随 notice 正文可见）。
      // 到点派发在 run 外（控制器空闲判定保证；防御式复读）：runner 预算源随 reactor run 起止挂/摘
      // （reactor.ts attachParent），空闲期无源=INVALID_STATE——挂缺省预算（maxSteps 同 reactor 缺省
      // 口径 reactorMaxStepsEnv ?? 400；tokenCap 同 SUNSHINEX_SUBAGENT_TOKEN_CAP 单点）后即摘：
      // spawnBackground 同步捕获预算，子代随后自跑不依赖父源；在途 run 在场则不触碰其预算源
      const runner = this.runtimeImpl.harness.runner;
      const idle = this.current === undefined;
      if (idle) {
        const tokenCap = subagentTokenCapEnv();
        runner.attachParent(() => ({ maxSteps: reactorMaxStepsEnv() ?? 400, ...(tokenCap !== undefined ? { tokenCap } : {}) }));
      }
      try {
        forkDispatch(runner, { spec: rec.taskSpec, ...(rec.note !== '' ? { label: rec.note } : {}) });
      } catch (e) {
        console.error('[serve] scheduled dispatch failed:', e);
      } finally {
        if (idle) runner.detachParent();
      }
    }
    const accepted = this.submit(SCHEDULE_WAKE_GOAL, undefined, { schedule: { note: rec.note, lateMs } }).ok;
    if (accepted) this.logScheduleRow({ ...rec, firedAt: Date.now() });
    return accepted;
  }

  /** attach 重布防（P2 Task 3，session-lifecycle.attachSessionIn 在 attachJournal 之后调用）：
   *  journal wake-schedule 机制行回放——已触发（firedAt 终态行在场）跳过，未触发项 re-arm；
   *  fireAt 已过（daemon 停机跨越）=R7 错过：到点即补发一次并在通知文注明延迟时长
   *  （TimerController.arm 对过期 fireAt 延迟 0 异步即发，迟到时长现算）。多枚未触发档行按行序
   *  逐枚入位（单活跃位替换语义，末行为准）。id 计数器随回放播种存档最大位（fix round 1）——
   *  每实例 scheduleSeq 归零，不播种则重启后首铸 sched-1 必撞存档 id（by-id 末行映射遮蔽存档
   *  审计史；撞存活调度时替换终态行守卫 prev.id!==rec.id 还会漏落终态行） */
  rearmSchedules(rows: ReadonlyArray<SegRowLike>): void {
    for (const rec of reduceWakeScheduleRows(rows)) {
      const m = /^sched-(\d+)$/.exec(rec.id);
      if (m !== null) this.scheduleSeq = Math.max(this.scheduleSeq, Number(m[1]));
      if (rec.firedAt !== undefined) continue;
      this.armScheduleRecord(rec);
    }
  }

  /** 恢复轮素材清单（2026-11-15 sunx P2 Task 4）：attach 回放产出——journal pending 机制行中**未决**
   *  （open 无 resolve 对位=daemon 重启蒸发的挂起）转成素材（问题原文+选项+askedBy 归因），由恢复后
   *  的 Sunx 在新 run 重新处理（Task 5 接线消费）。裁定 ②：**不复活 promise**——不重建挂起表、不重发
   *  挂起帧（executor 已死,复活无消费者;GUI 卡不复活）,本字段是唯一产出物。裁定 ④：standard/sunx
   *  同产（行面/回放面普适）,素材消费（恢复轮 notice）限 sunx（Task 5 范围）。生命周期（裁定 3）：
   *  attach 时产出 → Task 5 恢复轮消费后 clearPendingMaterial 清空;幂等——素材由行推导非累加态,
   *  下一次 attach 前再重启则重产（seedPendingMaterials 整列替换） */
  private pendingMaterials: PendingMaterial[] = [];

  /** 素材清单外窥（Task 5 恢复轮 notice 消费接口；Task 4 移交义务清偿——返回类型收口
   *  ReadonlyArray,消费侧不可变） */
  pendingMaterial(): ReadonlyArray<PendingMaterial> {
    return this.pendingMaterials;
  }

  /** 素材清单清空（Task 5 恢复轮消费后调用——素材单次消费语义） */
  clearPendingMaterial(): void {
    this.pendingMaterials = [];
  }

  /** attach 回放单点（session-lifecycle.attachSessionIn 在 rearmSchedules 之后调用,同区并列）：
   *  journal 全量行 → reducePendingRows → 未决素材整列替换（旧档无行=空列,行为不变;已决行仅审计
   *  不入素材）。纯内存赋值零副作用——不 pump 不广播不落档 */
  seedPendingMaterials(rows: ReadonlyArray<SegRowLike>): void {
    this.pendingMaterials = reducePendingRows(rows).open;
  }

  /** 板任务名解析（daemon 侧板投影）：wake-host 单点委托，板投影来源（this.board.tasks）为宿主差异面 */
  private boardTaskTitle(ledgerId: string): string | undefined {
    return boardTaskTitleOf(ledgerId, this.board.tasks);
  }

  /** 唤醒 notice 落链单点（G2 收敛,2026-11-16）：宿主泵（帧缓冲+WS 广播+kernel.pump 全链——直调
   *  kernel.pump 只落档不发帧,GUI live 收不到）+ 链尾 note。任务/定时/恢复三种唤醒轮共用 */
  private pumpWakeNotice(md: string, payload: { wake?: unknown; schedule?: boolean; restored?: boolean }): void {
    this.pump({ type: 'notice', text: md, payload, ts: Date.now() });
    this.runtimeImpl.harness.context.appendChain([{ action: 'note', observation: md }]);
  }

  /** 唤醒轮入口（fire 接缝）：plan 武装态不受理（批次回队）；真 submit 双态收口，快照/统计/续发全共用 */
  private submitWake(tasks: WakeTaskInput[]): boolean {
    if (this.planArmed()) return false;
    return this.submit(WAKE_GOAL, undefined, { tasks }).ok;
  }


  /**
   * 恢复唤醒轮入口（R9,2026-11-15 sunx P2 Task 5）：session-lifecycle.attachSessionIn 全序收尾后
   * 一次性 fire-and-forget 调用——专用 submitWake 变体第三员（notice→run 固定序同管线）。触发判定
   * 在调用方（attach 序已有信息推导：板 init 自愈读面+台账孤儿 stopped 读面+挂起素材清单——零新增
   * 生产状态）；本入口只管起轮纪律：
   * - standard 会话零触发（裁定 4）——kind 守卫最前；
   * - 计入连续唤醒上限（consumeChain——与任务/定时唤醒同账本,触顶 onLimit 由控制器发,本口静默弃）；
   * - 消费口（裁定 3）：起跑成功即 clearPendingMaterial（素材单次消费——本实例语义;409 丢弃不清,
   *   行推导幂等下次 attach 重产）;
   * - busy 竞争用户优先（裁定 2）：恢复轮走 submit 单 run 锁,409（run 在途）即丢弃并落 skip notice
   *   「recovery round skipped: session busy」——素材已入链可被下一轮自然消费,不做复杂排队。
   */
  submitRestoredRound(interrupted: ReadonlyArray<RestoredInterrupted>, materials: ReadonlyArray<PendingMaterial>): boolean {
    if (this.sessionKind !== 'sunx') return false;
    if (this.planArmed()) return false;
    if (!this.wake.consumeChain()) return false;
    const accepted = this.submit(RESTORED_WAKE_GOAL, undefined, { restored: { interrupted, materials } }).ok;
    if (accepted) this.clearPendingMaterial();
    else this.pump({ type: 'notice', text: 'recovery round skipped: session busy', ts: Date.now() });
    return accepted;
  }
  /** 事件环形缓冲（补发窗口）：pump 单点写入，连接建立即逐会话补发；帧自带 seq+sessionId */
  private readonly frames: EventFrame[] = [];
  /** 本会话已泵最大 seq（snapshot.lastSeq 同源；全局计数器分配故单调） */
  private lastSeqNum = 0;
  /** 影子投影（G2 snapshot 套件）：board/delegation 与 TUI session 同源纯件从同一事件流推导 */
  private board: TaskBoardState = emptyBoard();
  private delegations: Delegation[] = [];
  /** 会话内核转录（session-kernel spec §3,P2 接入）：pump 同源喂入,snapshot 的 messages 字段
   *  （reset 换新实例清空）。持久化 = v3 单档唯一写者：内核段级事件经 persistKernelEvent 落
   *  journal 行（seg/seg-update/run-open/truncate;chain/compact/runmeta 行为既有路径）——
   *  collector 与 G14.213b 第二 jsonl 退役,装载走 attach 位 reduceSegRows */
  private kernel: SessionKernel;
  /** 挂起表（P6 §4 下沉,spec 裁定「挂起是会话事件,不随连接生灭」）：approval/ask 未决条目,
   *  pid=daemon 铸造票据（opts.mintPid）;resolve 后即删（重复回执 404 判据）。daemon 保留网络
   *  寻址（pid 铸造/回执路由/帧传输）与本表只读外窥（快照合并/WS 重发） */
  private readonly pending = new Map<string, PendingEntry>();
  /** G14.17 run 内 usage/ctx 末值（pump 旁路捕获，run 收尾落旁车 meta 后随下次 submit 清零） */
  private runUsage?: { total: number; cache: number; prompt: number };
  private runCtxUsed?: number;
  /** 会话 todo 批次权威投影(2026-10-31 用户裁定「任务历史持久化可见」):attach 自 journal 全量行
   *  派生(seedTodoBatches)+live 随段级事件增量维护(trackTodoEvent)——内核环形窗 CAP 2000 之外的
   *  老批次只有档上有,GUI 转录派生面覆盖不到;快照载荷以此为准(不留旧 daemon 兼容面) */
  private todoBatches: SessionTodoBatch[] = [];
  /** fork 血缘读数缓存( lineage 随档不变,按 journalId 键控失效——换挂/轮转后重读) */
  private forkedFromCache: { jid: string; info: SessionSnapshot['forkedFrom'] } | null = null;
  /** attach/出生挂载的会话日志（T2）：在场即链行续落（context.onContextChange 订阅）与 teardown seal；
   *  daemon 侧新会话出生即挂（惰性建档——首 run 首条 append 才落盘，空会话零文件）；resume 转录由
   *  事件转录面承担，msg 行非 TUI ChatItem（daemon 档只落 chain） */
  private journal?: SessionJournal;

  /** 当前权限模式（G10-C1b 可变面）：setMode 重建 runtime（reset 同路径,转录/影子投影独立不受损） */
  private currentMode: SessionMode;

  // ---- plan 模式（2026-11-03 无感化,ask_question 同构）：无宿主编排状态机——armed 提交=会话作用域
  // run（read-only 覆盖在座）,exit_plan executor 弹卡阻塞等裁决,裁决落档后同 run 无感继续。----
  // （旧 planFlow 六件/合成链行/replan 静默位全部随状态机消解退役,挂起复用 approval/ask 挂起表形态）

  /** 会话 todo 清单（todo_write 接缝收写,装配单点 onTodos 注入）：交稿批准时宿主按计划书 Steps 播种,
   *  执行期模型 todo_write 自管维护 */
  private todos: TodoItem[] = [];
  /** 当前 run 的任务目标（armed 提交时记录）：exit_plan 漏 name 时 derivePlanName 兜底派生源 */
  private activeGoal = '';

  /** arm 判定单点：mode==='plan' 即 armed——下条提交走 read-only 覆盖+计划提示 note（纪律档强制先规划） */
  private planArmed(): boolean {
    return this.currentMode === 'plan';
  }

  /** 武装外窥（/plan 三态,命令通道分流消费） */
  isPlanArmed(): boolean {
    return this.planArmed();
  }

  /** 交稿挂起卡在途外窥（/plan <目标> 挂卡期分流:弃卡+重新提交） */
  hasPlanPending(): boolean {
    for (const entry of this.pending.values()) if (entry.kind === 'plan-approval') return true;
    return false;
  }

  /** exit_plan 出牌接缝（2026-11-03 无感化;2026-11-04 泛化）：落盘计划文件+挂起行（卡/帧）+
   *  阻塞等裁决;批准落档由 resolvePendingPlanApproval 在 executor 恢复前完成。run 不收口——
   *  界面保持运行中（与 ask_question「等待回答」同观感）。任何档可调（通用提案工具） */
  private async planAwaitDecision(name: string, doc: string): Promise<PlanDecision> {
    this.ensureMintedWithBirth();
    const items = parseNumberedSteps(doc);
    const dName = name !== '' ? name : derivePlanName(this.activeGoal);
    let path: string | undefined;
    const jid = this.journal?.currentId;
    if (jid !== undefined) path = writePlanDoc(this.dataDir, jid, dName, doc);
    return await this.awaitPlanApproval({ name: dName, path, doc, items });
  }

  /** 转录条目数外窥(装载互斥判据与测试面) */
  transcriptCount(): number {
    return this.kernel.count();
  }

  /** 运行档外窥（G14.90）：daemon 挂起闭包按当前档判定——pill 切 acceptEdits 后新建会话无需重建注入面 */
  isAcceptEdits(): boolean {
    return this.currentMode === 'acceptEdits';
  }

  constructor(opts: SessionRuntimeOpts) {
    this.opts = opts;
    this.id = opts.id;
    this.root = opts.root;
    this.sessionKind = opts.kind; // 构造入参落实例字段（2026-11-15 sunx P1 Task 4）——换铸透传不丢
    this.sessionName = opts.name;
    this.sessionCharter = opts.charter;
    this.charterCurrent = opts.charter ?? null;
    this.currentMode = opts.mode ?? 'full-access';
    this.kernel = new SessionKernel({ onKernelEvent: (ev) => this.persistKernelEvent(ev) });
    this.runtimeImpl = this.assemble();
    this.bindStopAudit(this.runtimeImpl);
  }

  /** 任务停止审计线（2026-11-21 用户需求）：后台任务终态 stopped 时——该任务名下若有待答提问
   *  （子智能体路由版 ask，req.askedBy 归因），取消并落 pending-resolve、在主对话留一行说明。
   *  此前静默清卡：用户事后只看到子转录里停在「正在等待回答」+轮带已停止，无从判断「问了没等到」
   *  还是「压根没问」。换铸（reset/rehomeRoot/setMode）后须对新运行时重绑 */
  private bindStopAudit(rt: KernelRuntime): void {
    rt.harness.tasks.setStopNotifier((t) => {
      for (const [pid, entry] of [...this.pending.entries()]) {
        if (entry.kind !== 'ask') continue;
        const by = entry.req.askedBy;
        if (by === undefined) continue;
        if (by.taskId !== t.id && by.label !== t.label) continue;
        this.pending.delete(pid);
        this.logPendingRow({ t: 'pending-resolve', pid, outcome: 'cancelled: task stopped' });
        entry.resolve({ type: 'dismissed' });
        this.pump({
          type: 'notice',
          text: `[${by.label}] 提问已随任务停止取消（task ${t.id}）`,
          ts: Date.now(),
        });
      }
    });
  }

  /** attach 重挂根(2026-11-11):档记 meta.root 在盘且异于壳根时由 attachSessionIn 调——**整链换根**
   *  不止字段:装配面(沙箱 cwd/安全链信任根/快照 sink root/感知)都按 opts.root 铸造,须换新运行时
   *  (reset/setMode 同路径)。attach 时壳为出生态(无实质事件),换铸零损;旧运行时后台收割 */
  rehomeRoot(root: string): void {
    const old = this.runtimeImpl;
    this.opts = { ...this.opts, root };
    this.root = root;
    this.runtimeImpl = this.assemble();
    this.bindStopAudit(this.runtimeImpl);
    if (this.journal !== undefined) {
      this.syncSessionStores();
      this.hookJournalSink();
    }
    void this.disposeRuntime(old).catch(() => undefined);
  }

  /**
   * 会话形态重铸（2026-11-15 final review fix wave，spec §13 P1 场景「用户关掉 GUI 重开恢复」根修）：
   * GUI 重开链 = 壳 newSession（无 kind=standard 出生态）→ attach 附 journal——旁车 meta.kind='sunx'
   * 而在座壳非 sunx 时由 attachSessionIn 调本方法把壳重铸为 sunx 形态（kind/charter/name 三字段与
   * 构造入参同面，assemble 单点透传不丢）。rehomeRoot 同路径先例：attach 时壳为出生态（零实质事件
   * 未播种），换铸零损——调用序铁律：重铸必须先于 restoreSession/kernelSeed/seedShadow/快照回种
   * （换铸清运行时态，先播种再换铸=全丢）。charter: null=无品性层（与 ContextManager 缺席门一致，
   * undefined 键同形）；幂等由调用方守（在座已是 sunx 不再铸——收编复用路径天然不达本方法）。
   */
  reCast(opts: { kind: 'sunx'; name?: string; charter?: string | null }): void {
    const old = this.runtimeImpl;
    this.sessionKind = opts.kind;
    this.sessionName = opts.name;
    this.sessionCharter = opts.charter ?? undefined; // null=无品性层（装配 charter 键缺席同形）
    this.charterCurrent = opts.charter ?? null; // 读面=调用方传文（fix round 1：attach 侧 meta.charterText 编辑文优先/缺席回落快照出生文——与链回放替代行同文,读面/模型面两窗不漂移;null=无品性层同缺席门。reset 路径另归 birth 文,见 reset() 注释）
    this.runtimeImpl = this.assemble();
    this.bindStopAudit(this.runtimeImpl);
    if (this.journal !== undefined) {
      this.syncSessionStores();
      this.hookJournalSink();
    }
    void this.disposeRuntime(old).catch(() => undefined);
  }

  /** v3 落档单点(P2 起,spec §3.2):内核段级事件 → journal 行(kernelEventRows 共享映射,P3 起
   *  daemon/TUI 同一写形)。journal 未挂载即丢弃;惰性建档对齐 chain 订阅(首条段级行落 header)。
   *  chain/compact 行走 onContextChange 既有订阅、runmeta 行走 submit() 收尾既有路径——三条写路
   *  同档不重叠。P5:steer 事件双消费——旁路广播 queue 帧(不经 pump,防主链投影误闭合)+整列落档 */
  private persistKernelEvent(ev: KernelEvent): void {
    if (ev.t === 'steer') this.emitQueueFrame(ev.items);
    const j = this.journal;
    if (j === undefined) return;
    try {
      this.ensureMintedWithBirth(); // 惰性建档(chain 订阅同构)+出生行伴随(幽灵会话根因修:两写路同单点)
      for (const row of kernelEventRows(ev)) j.log(row);
    } catch {
      // 尽力落档:写失败不影响运行面
    }
    this.trackTodoEvent(ev);
  }

  /** todo 批次 live 增量(权威投影维护面):todo_write 工具段=按**标题**归并(2026-11-25:
   *  同标题跨轮更新=同一待办,首写 key/ts 不漂,updatedTs 推进;无标题退签名归并,旧行为) */
  private trackTodoEvent(ev: KernelEvent): void {
    if (ev.t !== 'seg-open') return;
    const en = ev.entry;
    if (en.kind !== 'tool' || en.name !== 'todo_write') return;
    const rawInput = en.input as { todos?: unknown; title?: unknown } | undefined;
    const arr = rawInput !== undefined && Array.isArray(rawInput.todos) ? rawInput.todos : [];
    const title = typeof rawInput?.title === 'string' ? rawInput.title.trim() : '';
    const items = arr
      .map((o) => {
        const x = (o ?? {}) as { text?: unknown; status?: unknown };
        const text = typeof x.text === 'string' ? x.text : '';
        const status: SessionTodoBatch['items'][number]['status'] = x.status === 'completed' ? 'completed' : x.status === 'in_progress' ? 'in_progress' : 'pending';
        return { text, status };
      })
      .filter((x) => x.text !== '');
    if (items.length === 0) return;
    // 归并键:标题优先(模型改写条目措辞也收敛同一待办);无标题退条目签名(旧行为)
    const groupOf = (b: SessionTodoBatch): string => (b.title !== undefined ? `t:${b.title}` : `s:${b.items.map((i) => i.text).join('|')}`);
    const mine = title !== '' ? `t:${title}` : `s:${items.map((i) => i.text).join('|')}`;
    const idx = this.todoBatches.findIndex((b) => groupOf(b) === mine);
    if (idx >= 0) this.todoBatches[idx] = { ...this.todoBatches[idx], updatedTs: en.ts, items };
    else this.todoBatches.push({ key: `t${en.seq}`, ts: en.ts, updatedTs: en.ts, ...(title !== '' ? { title } : {}), items });
  }

  /** journal 全量行 → todo 批次(attach 播种单点,2026-10-31 用户裁定「任务历史持久化可见」):
   *  todo_write tool 行按**标题**归并(2026-11-25:同标题跨轮=同一待办,首写 key/ts/updatedTs 落定;
   *  无标题退条目签名,旧行为),ts 正序。坏行字段缺省回落逐行跳过 */
  seedTodoBatches(rows: ReadonlyArray<SegRowLike>): void {
    for (const row of rows) {
      if (row.t !== 'seg') continue;
      const kind = typeof row.kind === 'string' ? row.kind : undefined;
      if (kind !== 'tool') continue;
      const name = typeof row.name === 'string' ? row.name : undefined;
      const seq = typeof row.seq === 'number' ? row.seq : undefined;
      if (name !== 'todo_write' || seq === undefined) continue;
      const input = row.input !== undefined && typeof row.input === 'object' && row.input !== null ? (row.input as { todos?: unknown; title?: unknown }) : undefined;
      const arr = input !== undefined && Array.isArray(input.todos) ? input.todos : [];
      const title = typeof input?.title === 'string' ? input.title.trim() : '';
      const items = arr
        .map((o) => {
          const x = (o ?? {}) as { text?: unknown; status?: unknown };
          const text = typeof x.text === 'string' ? x.text : '';
          const status: SessionTodoBatch['items'][number]['status'] = x.status === 'completed' ? 'completed' : x.status === 'in_progress' ? 'in_progress' : 'pending';
          return { text, status };
        })
        .filter((x) => x.text !== '');
      if (items.length === 0) continue;
      const batch: SessionTodoBatch = { key: `t${seq}`, ts: typeof row.ts === 'number' ? row.ts : 0, updatedTs: typeof row.ts === 'number' ? row.ts : 0, ...(title !== '' ? { title } : {}), items };
      const idx = this.todoBatches.findIndex((b) => b.key === batch.key);
      if (idx >= 0) this.todoBatches[idx] = batch;
      else this.todoBatches.push(batch);
    }
    // 2026-11-25:同标题(同一份待办)合并保留**首写** key/ts(唯一 id 稳定,创建时间=首写
    // 时刻),条目与 updatedTs 取最新——与 live 路径同口径;无标题退签名归并(旧行为)
    const groupOf = (b: SessionTodoBatch): string => (b.title !== undefined ? `t:${b.title}` : `s:${b.items.map((i) => i.text).join('|')}`);
    const byGroup = new Map<string, SessionTodoBatch>();
    for (const b of [...this.todoBatches].sort((a, b) => (a.updatedTs ?? a.ts) - (b.updatedTs ?? b.ts))) {
      const g = groupOf(b);
      const prev = byGroup.get(g);
      byGroup.set(g, prev !== undefined ? { ...prev, updatedTs: b.updatedTs ?? b.ts, items: b.items } : b);
    }
    this.todoBatches = [...byGroup.values()].sort((a, b) => a.ts - b.ts);
  }

  /** attach 回种(G14.2xx 内核层落库):journal 影子行折叠回影子投影——board/delegation 行经翻译
   *  折叠(快照即恢复,重启/重连/换渲染层不再空板空委派);subagent 行以**帧重放**交还渲染层
   *  (agent 页签的聚合面从帧重建,与实时流同一消费通道)。daemon.attach 序在 kernelSeed 后调用 */
  seedShadow(events: ReadonlyArray<JournalEvent>): void {
    for (const row of events) {
      if (row.t === 'board') {
        // 旧写面(serve 级短暂窗口)ev 键兼容:同义原始事件二取一;缺一跳过(坏行不得炸 attach)
        const raw = (row as { e?: SessionEvent }).e ?? (row as { ev?: SessionEvent }).ev;
        if (raw === undefined) continue;
        const bev = boardEventFrom(raw);
        if (bev !== undefined) this.board = applyBoardEvent(this.board, bev);
      } else if (row.t === 'delegation') {
        this.delegations = applyDelegation(this.delegations, row.e);
      } else if (row.t === 'subagent') {
        this.emitShadowFrame(row.e);
      }
    }
  }

  /**
   * attachJournal 收养 TeamStore 后:GUI 影子板改以物理板快照为权威——journal 影子回放缺
   * artifact.durationMs(旧 emit 未带)且与盘面 createdAt 偶发不一致;物理板 event sourcing
   * 含完整 createdAt/耗时,重启后任务/编排时间面同源。盘空则保留 seedShadow 板(旧档兜底)。
   */
  pullBoardFromHarness(): void {
    const physical = this.runtimeImpl.harness.taskboard.snapshot();
    if (Object.keys(physical.tasks).length === 0) return;
    this.board = physical;
  }

  /**
   * attach 后板投影对齐:Harness TaskBoard.init 已把打开态自愈为 cancelled,但 seedShadow 会从
   * journal 回放旧 running/pending 盖回影子板——GUI 出现不可停孤儿(物理板已终态、stop 幂等无事件)。
   * 物理板为生命周期权威:影子打开态跟 harness 对齐,差异经 pump 落档+广播。
   */
  reconcileBoardWithHarness(): void {
    const physical = this.runtimeImpl.harness.taskboard;
    const auth = physical.snapshot().tasks;
    for (const task of Object.values(this.board.tasks)) {
      if (task.status !== 'pending' && task.status !== 'running') continue;
      const live = auth[task.id];
      // harness 仍打开 → stopTask 发事件经 onEvent→pump 同步影子
      if (live !== undefined && (live.status === 'pending' || live.status === 'running')) {
        physical.stopTask(task.id);
        continue;
      }
      // harness 已终态(或缺失):影子单独补 cancelled,落档防下次 attach 再孤儿
      const from = task.status;
      const note = from === 'running'
        ? 'interrupted by restart (execution lost — recreate the task if needed)'
        : 'no live executors after restart — recreate the task if needed';
      this.pump({
        type: 'task-status-changed',
        ts: Date.now(),
        payload: { taskId: task.id, from, status: 'cancelled', note },
      });
    }
  }

  /** 板停后影子同步:物理板已终态时 stopBoardTask 不发事件——影子若仍打开则补 pump cancelled */
  syncBoardStopToShadow(taskId: string): void {
    const task = this.board.tasks[taskId];
    if (task === undefined) return;
    if (task.status !== 'pending' && task.status !== 'running') return;
    this.pump({
      type: 'task-status-changed',
      ts: Date.now(),
      payload: { taskId, from: task.status, status: 'cancelled', note: 'stopped' },
    });
  }

  /** 旁路帧发射单点（D88 收敛，原四写——emitShadowFrame/emitQueueFrame/broadcastUserEcho/
   *  emitJournalMinted 各持同一「nextSeq→lastSeqNum→建 EventFrame→frames.push→EVENT_BUFFER_CAP
   *  shift→broadcast」协议不变量）：seq 分配+环形缓冲+广播一处承载，旁路面只构造 SessionEvent
   *  后委托；改缓冲策略/seq 语义单点改 */
  private emitBypassFrame(e: SessionEvent): void {
    const seq = this.opts.nextSeq();
    this.lastSeqNum = seq;
    const frame: EventFrame = { kind: 'event', sessionId: this.id, seq, e };
    this.frames.push(frame);
    if (this.frames.length > EVENT_BUFFER_CAP) this.frames.shift();
    this.opts.broadcast(frame);
  }

  /** 子智能体影子帧重放:journal 里的子智能体事件按新 seq 回灌帧缓冲+广播,
   *  GUI agent 页签的聚合面从帧重建(实时流同一消费通道) */
  private emitShadowFrame(e: SessionEvent): void {
    this.emitBypassFrame(e);
  }

  /** queue 事件旁路广播(P5,spec §12):队列变更不发 SessionEvent 主链(pump 会喂转录内核与影子
   *  投影,default 分支把 queue 当边界误闭合开启段)——单走 seq 分配+环形缓冲+广播;重连补发经
   *  frames 环窗天然覆盖(新连接回放最后一条 queue 帧=最新队列) */
  private emitQueueFrame(items: SteerItem[]): void {
    this.emitBypassFrame({ type: 'queue', payload: { items }, ts: Date.now() });
  }

  /** v3 档装载入核(attach 序调用,daemon.ts 持 journalId 位):reduceSegRows 重放条目 seed——
   *  seq 原样沿用(truncate 对位),不触发落档事件(防装载双写) */
  kernelSeed(entries: ReadonlyArray<KernelEntry>): void {
    this.kernel.seed(entries);
  }

  /** 等待队列装载(P5,spec §12):attach 序调 reduceSteerRows 重放末条 steer 行 → 内核回种
   *  (不发事件防双写;快照 queued 即刻可见) */
  steerSeed(items: ReadonlyArray<SteerItem>): void {
    this.kernel.steerRestore(items);
  }

  /** 装配单点：与 TUI 同一 createKernelRuntime（mode 缺省 full-access）——onEvent 接本会话泵,reset 复用
   *  同点换新。P6 §4 挂起接缝无条件注入（守卫在 suspend* 内）：acceptEdits 审批走本会话挂起表
   *  （isAcceptEdits 判定),ask_question 任意档挂起（G14.93 裁定）,ghost 窗（isAborted）直接回落不入表 */
  private assemble(): KernelRuntime {
    const rt = createKernelRuntime({
      root: this.opts.root,
      model: this.opts.model,
      // plan-arm 态内核闲置于 acceptEdits——替换旧 plan→dontAsk 假映射,内核档位恒三档（spec §3.2）
      mode: this.currentMode === 'plan' ? 'acceptEdits' : this.currentMode,
      // sunx 装配透传（2026-11-15 sunx P1 Task 4）：kind→稳定段身份槽/编排章程+工具白名单+fork kind
      // 继承（buildHarness/loopDeps 两路）,charter→ContextManager 品性冻结层——reset/rehomeRoot/reCast
      // 换铸走本单点,实例字段恒透传不丢;缺席=standard 字节不变
      ...(this.sessionKind !== undefined ? { kind: this.sessionKind } : {}),
      // 出生名身份行（2026-11-15 用户问询裁定「让 agent 知道姓名」）：姓名与品性同拍入会话冻结层——
      // 定版一次不重写（前缀缓存纪律：出生定版+改名尾追为预留机制）；缺席不加行。
      // 通道会话独立分支（2026-11-25 用户裁定「和 sunx 是隔离的,应该注入的是应用名称,不是第一个
      // 会话'数字1'」）：通道聊天会话的身份来源=通道配置应用名称（channelMeta.appName），与 sunx
      // 会话名通道隔离——身份由数据来源决定（sessionName 对通道会话只是显示兜底,不进身份层）；
      // 品性（cfg.charter）在场仍随附
      ...(this.opts.channelMeta !== undefined
        ? {
            charter: [
              channelMetaCharter(this.opts.channelMeta),
              ...(this.sessionCharter !== undefined && this.sessionCharter !== '' ? [this.sessionCharter] : []),
            ].join('\n\n'),
          }
        : this.sessionKind === 'sunx' && this.sessionName !== undefined && this.sessionName !== ''
          ? { charter: `Your name: ${this.sessionName}.

${this.sessionCharter ?? ''}` }
          : this.sessionCharter !== undefined ? { charter: this.sessionCharter } : {}),
      // 持久化域透传（2026-11-15 sunx P3 Task 2 域绑定）：缺席=既有推导零变化
      ...(this.opts.dataDir !== undefined ? { dataDir: this.opts.dataDir } : {}),
      // 学习沉淀关闸（P2 遗留义务清偿,P3 Task 2 裁定）：sunx 装配 learnSkills:false——编排轮不沉淀
      // 伪技能（域目录零 learned/ 基座）;standard 不传=既有推导逐字节不变
      ...(this.sessionKind === 'sunx' ? { learnSkills: false } : {}),
      onEvent: (e) => this.pump(e),
      onApproval: (req) => this.suspendApproval(req),
      onAskUser: (req) => this.suspendAsk(req),
      // exit_plan 出牌接缝（2026-11-03 无感化;2026-11-04 泛化）：弹卡阻塞等裁决（run 不收口）,
      // 批准落档（landPlanDecision）在 reply 路径 executor 恢复前完成
      plan: {
        awaitDecision: (name, doc) => this.planAwaitDecision(name, doc),
      },
      // 定时调度接缝（2026-11-15 sunx P2 Task 3）：schedule_wakeup/schedule_task 的 arm 出口——
      // 宿主 TimerController 承载（id 铸造+机制行落档+被替换终态行都在会话）；仅 sunx 装配注入
      // （standard 字节不变——工具不注册+缝缺席双保险）
      ...(this.sessionKind === 'sunx' ? { schedule: { arm: (rec: { fireAt: number; note: string; taskSpec?: string }) => this.armSchedule(rec) } } : {}),
      // 定时任务创建工具接缝（2026-11-20）：宿主 daemon 的 ScheduleEngine 出口——接缝在场即注册
      // create_scheduled_task（标准/sunx 会话同源；CLI/TUI 不注入=工具缺席）
      ...(this.opts.scheduleCreate !== undefined ? { scheduleCreate: this.opts.scheduleCreate } : {}),
      ...(this.opts.scheduleCreate !== undefined ? { scheduleCreateDefaults: () => this.scheduleCreateDefaults() } : {}),
      // send_channel_message 工具接缝（spec §6;2026-11-23 用户裁定「补上 send_channel_message」）：
      // daemon lifecycleIo channelSendFor 按 sessionId 注入——接缝在场即注册（CLI/TUI 不注入=缺席）
      ...(this.opts.channelSend !== undefined ? { channelSend: this.opts.channelSend } : {}),
      // 跨 Sunx 对等消息接缝（2026-11-26）：daemon 注入活实例枚举/投递口——在场即注册两件工具
      ...(this.opts.sunxPeers !== undefined ? { sunxPeers: this.opts.sunxPeers } : {}),
      // todo_write 接缝（todos 字段单点收写）：批准时宿主按 Steps 播种,执行期模型 todo_write 自管维护
      onTodos: (items) => {
        this.todos = items;
      },
      // bg-wake 接缝（spec §3.1）：终态分流汇（done/failed 登记进 WakeController,过滤归控制器）
      // + 分派回执唤醒提示宿主闸①（hint）——daemon 装配恒注入（CLI buildDeps 不注入＝无唤醒）
      wake: { onFinished: (t) => this.wake.onTaskFinished(t), hint: true },
    });
    // 插入发送（front 置首条目）步边界消费口：取走即回显——user 帧（live 气泡）+ kernel user 条
    // （journal/快照,重连后不缺席）。此前 front 注入只落 steps 链,GUI 全程无气泡（2026-10-25 用户报障）
    // 内置浏览器按会话隔离(2026-11-03):插件 MCP 连接取本会话浏览器键(=journalId)与侧栏座位(运行时 id)
    rt.harness.browserSession = () => ({ key: this.ensureBrowserKey(), seat: this.id });
    rt.harness.steerSource = () => {
      const lines = this.kernel.steerDrain();
      for (const line of lines) {
        this.kernel.submit(line.text, line.images, line.fromSunx); // journal user 条（kernel 事件只走落档面,不广播——帧在下）
        this.broadcastUserEcho(line.text, line.images, line.fromSunx); // 出队注入即回显气泡(2026-11-23 用户裁定:出队=入对话;入队期只在队列 chips)
      }
      return lines;
    };
    return rt;
  }

  /** user 回显纯帧广播（不经 kernel.pump——泵路回显曾致转录双气泡+journal
   *  双行,G14.2xx 实测;条目本体由 kernel.submit 写面承载,本帧只管 live 视图） */
  private broadcastUserEcho(text: string, images?: string[], fromSunx?: SunxPeerRef): void {
    this.emitBypassFrame({
      type: 'user',
      text,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      ...(fromSunx !== undefined ? { payload: { fromSunx } } : {}),
      ts: Date.now(),
    });
  }

  // ---- 挂起表（P6 §4 下沉）：注册/回执/回填/外窥,daemon 只做寻址与传输 ----

  /** acceptEdits 审批挂起（guard asker 注入位）：full-access 自动放行语义由 guard 前置（不到这里）,到这里的
   *  非 acceptEdits 视为拒绝兜底;ghost（run 已中止——interrupt/reset/delete 的 denyPending 回填发生在
   *  abort 时点,其后的迟到 asker 调用即幽灵）直接 deny 不入表不广播（G14.10） */
  private suspendApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    // 档位门退役(2026-11-01 用户裁定):能到这里的审批只有两类——acceptEdits 交互面与插件 act 类
    // 强制问线(full-access 常规 ask 在 guard 层已自动放行,不会到这);acceptEdits 门曾把 act 类的
    // 审批帧整只吞成 deny(完全访问下 bottom 确认框不弹的根因)。ghost 窗守卫保留
    if (this.isAborted()) return Promise.resolve('deny');
    return new Promise((resolve) => {
      const pid = this.opts.mintPid();
      this.pending.set(pid, { kind: 'approval', req, resolve });
      this.logPendingRow({ t: 'pending-open', pid, kind: 'approval', req }); // 挂起持久化（Task 4）：落档先于广播（行集恒为全量真源）
      const frame: ApprovalFrame = { kind: 'approval', sessionId: this.id, pid, req };
      this.opts.broadcast(frame);
    });
  }

  /** 问询挂起（G14.93 用户裁定：ask_question 是模型主动问用户,任何权限档都必须等真实回答,不可静默
   *  跳过）;ghost 窗直接 dismissed 不入表（同上） */
  private suspendAsk(req: AskUserRequest): Promise<AskUserAnswer> {
    if (this.isAborted()) return Promise.resolve({ type: 'dismissed' });
    return new Promise((resolve) => {
      const pid = this.opts.mintPid();
      this.pending.set(pid, { kind: 'ask', req, resolve });
      this.logPendingRow({ t: 'pending-open', pid, kind: 'ask', req }); // 挂起持久化（Task 4）：question/options/askedBy 原件随行（恢复轮素材源）
      const frame: AskFrame = { kind: 'ask', sessionId: this.id, pid, req };
      this.opts.broadcast(frame);
    });
  }

  /** plan 审批挂起（阶段三 spec §5.1,planFlow awaitApproval 接缝的宿主实现）：挂起表注册 plan 卡→
   *  WS 广播 plan-approval 帧（payload {doc,items} 计划书全文+步骤清单）→ **卡登记+广播后**才放行
   *  submit 半径（onParked）——「表面可见」先于「idle 放行」,防放行窗口内的回执 404 竞窗;
   *  中止已置位的 ghost 窗直接放弃回填不入表（suspendApproval 先例）。决策由 resolvePendingPlanApproval
   *  经回执路由回填驱动流程续跑（TUI planDecide 回填单点的表驱动同构——寻址键 pid 入挂起表,不再设
   *  planDecide 字段） */
  private awaitPlanApproval(card: { name: string; path?: string; doc: string; items: string[] }): Promise<PlanDecision> {
    return new Promise((resolve) => {
      const pid = this.opts.mintPid();
      this.pending.set(pid, { kind: 'plan-approval', req: card, resolve });
      this.logPendingRow({ t: 'pending-open', pid, kind: 'plan-approval', req: card }); // 挂起持久化（Task 4）：同 approval/ask 落档先于广播
      const frame: PlanApprovalFrame = { kind: 'plan-approval', sessionId: this.id, pid, req: card };
      this.opts.broadcast(frame);
    });
  }

  /** plan 审批回执（kind 判别——plan 回执打到 approval/ask 挂起 = false→HTTP 404 面,反之亦然）：
   *  删表→resolve——裁决不 pump 系统提示（2026-11-04 用户裁定「用户不关心,从底层去掉」:卡面即结果,
   *  转录零诊断行;approval/ask 回执诊断行保留不受影响） */
  resolvePendingPlanApproval(pid: string, decision: PlanDecision): boolean {
    const entry = this.pending.get(pid);
    if (entry === undefined || entry.kind !== 'plan-approval') return false;
    this.pending.delete(pid);
    // 挂起持久化（Task 4）：resolve 行落档先于回填——裁决审计行先于 executor 恢复产生的任何续跑行
    const feedback = (decision.feedback ?? '').trim();
    this.logPendingRow({ t: 'pending-resolve', pid, outcome: decision.approved ? 'approved' : feedback !== '' ? `rejected: ${feedback}` : 'dismissed' });
    // 落档钩（2026-11-03 无感化;2026-11-04 泛化）:**批准在 executor 恢复前落档**——exit override+
    // 真档 setBaseMode+arm 解除+todos 按 Steps 播种;此后 executor 恢复,模型以已放权的档位同 run
    // 无感继续实施。mode 缺省=当前档（可写域两键卡语义:批准=维持当前档实施;只读域缺省回落
    // acceptEdits——防御路径,正常流程卡面必带显式落档）。重新计划:带反馈=修订环回喂(只读域维持);
    // 空反馈=放弃本轮→中断 run 回输入态(executor 凭信号中止)
    if (decision.approved) {
      // 缺省回落:可写域=当前档;只读域/armed=acceptEdits(防御路径——正常流程卡面必带显式落档)
      const fallback: PlanLandMode = this.currentMode === 'full-access' ? 'full-access' : 'acceptEdits';
      this.landPlanDecision(decision.mode ?? fallback, entry.req.items);
    } else if ((decision.feedback ?? '').trim() === '') {
      this.interrupt(); // 空反馈=放弃本轮:中断 run 回输入态(2026-11-04 用户裁定:裁决系统提示不入转录——卡面即结果,用户不关心诊断行)
    }
    entry.resolve(decision);
    return true;
  }

  /** 批准落档单点（2026-11-03 无感化,executor 恢复前调用）：exit read-only 覆盖+真档 setBaseMode
   *  （guard 活改,下一未决调用即放权）+arm 解除+todos 按 Steps 播种（执行期模型 todo_write 自管） */
  private landPlanDecision(mode: PlanLandMode, items: string[]): void {
    this.runtimeImpl.harness.security.exitModeOverride();
    this.currentMode = mode;
    this.runtimeImpl.harness.security.setBaseMode(mode);
    this.persistSelection({ mode });
    this.setTodos(items.map((t): TodoItem => ({ text: t, status: 'pending' })));
  }

  /** plan 挂起卡放弃回填单点（中断/reset/teardown 路径;TUI approval.ts interrupt→confirmPlan(false)
   *  语义对齐）：删表→resolve({approved:false})——decide 回填后流程凭已置位的中止信号走
   *  aborted-interrupted 收尾,产物不注入、执行不启动（rider:awaitApproval 期间中止+approved 竞态边界） */
  private denyPlanPendings(): void {
    for (const [pid, entry] of this.pending) {
      if (entry.kind !== 'plan-approval') continue;
      this.pending.delete(pid);
      this.logPendingRow({ t: 'pending-resolve', pid, outcome: 'dismissed' }); // 挂起持久化（Task 4）：放弃回填同落审计行
      entry.resolve({ approved: false });
    }
  }

  /** 审批回执（kind 判别——approval 回执打到 ask 挂起 = false→HTTP 404）：删表→resolve→notice 入
   *  转录三面（G4 裁定 1 尾项：粗归档可见,不发明新事件型） */
  resolvePendingApproval(pid: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(pid);
    if (entry === undefined || entry.kind !== 'approval') return false;
    this.pending.delete(pid);
    this.logPendingRow({ t: 'pending-resolve', pid, outcome: decision }); // 挂起持久化（Task 4）：裁决字面即结果摘要
    entry.resolve(decision);
    // payload.pid 随帧(2026-11-23 用户裁定「回答ask后没有关闭ask弹窗」):GUI 挂起卡据此清卡——
    // IM 侧回执(approval/ask 经通道文本消费)不经过 GUI settle,无 pid 卡永不关
    this.pump({ type: 'notice', text: `approval ${pid} resolved: ${decision}`, ts: Date.now(), payload: { pid } });
    return true;
  }

  /** 问询回执（同上,ask 判别） */
  resolvePendingAsk(pid: string, answer: AskUserAnswer): boolean {
    const entry = this.pending.get(pid);
    if (entry === undefined || entry.kind !== 'ask') return false;
    this.pending.delete(pid);
    // 挂起持久化（Task 4）：回答三态摘要（selected 列/custom 文本/dismissed）
    const outcome = answer.type === 'selected' ? `selected: ${answer.labels.join(', ')}` : answer.type === 'custom' ? `custom: ${answer.text}` : 'dismissed';
    this.logPendingRow({ t: 'pending-resolve', pid, outcome });
    entry.resolve(answer);
    this.pump({ type: 'notice', text: `ask ${pid} answered`, ts: Date.now(), payload: { pid } });
    return true;
  }

  /** 全部未决回填（G4 裁定 3：interrupt/reset=deny 回填——TUI approval.ts 先例）：approval→deny、
   *  ask→dismissed、plan-approval→放弃回填（流程凭中止信号走 aborted,产物不注入）并清表;
   *  不发 notice（中止路径的观察行由 run 自身事件面承载）。挂起持久化（Task 4）：deny 回填同落
   *  resolve 行（outcome=denied/dismissed——与用户显式回执 deny 区分,审计完整）;行先于回填落,
   *  审计序在 executor 恢复产生的续跑行之前 */
  denyPending(): void {
    for (const [pid, entry] of this.pending) {
      if (entry.kind === 'approval') {
        this.logPendingRow({ t: 'pending-resolve', pid, outcome: 'denied' });
        entry.resolve('deny');
      } else if (entry.kind === 'ask') {
        this.logPendingRow({ t: 'pending-resolve', pid, outcome: 'dismissed' });
        entry.resolve({ type: 'dismissed' });
      } else {
        this.logPendingRow({ t: 'pending-resolve', pid, outcome: 'dismissed' });
        entry.resolve({ approved: false });
      }
    }
    this.pending.clear();
  }

  /** 快照挂起段（G5）：`{pid,kind,req}` 行列,daemon handleSnapshot 直并入 snapshot 载荷 */
  pendingSnapshot(): SnapshotPendingRow[] {
    return [...this.pending.entries()].map(([pid, entry]) => ({ pid, kind: entry.kind, req: entry.req }));
  }

  /** WS 重连重发面（G4 裁定 4）：挂起帧与首播同形同构（daemon 建连序逐会话收集直发） */
  pendingFrames(): Array<ApprovalFrame | AskFrame | PlanApprovalFrame> {
    return [...this.pending.entries()].map(([pid, entry]) =>
      entry.kind === 'approval'
        ? { kind: 'approval' as const, sessionId: this.id, pid, req: entry.req }
        : entry.kind === 'ask'
          ? { kind: 'ask' as const, sessionId: this.id, pid, req: entry.req }
          : { kind: 'plan-approval' as const, sessionId: this.id, pid, req: entry.req },
    );
  }

  /** 运行时本体外窥（T2 attach 播种/T5 扩展消费；harness 公开面只在 teardown 消费） */
  get runtime(): KernelRuntime {
    return this.runtimeImpl;
  }

  /** 会话内核外窥(测试/attach 消费;replay 只读) */
  get sessionKernel(): SessionKernel {
    return this.kernel;
  }

  /** attach 挂载的 journal id 外窥（daemon attach 双挂守卫与测试面） */
  get attachedJournalId(): string | undefined {
    return this.journal?.currentId;
  }

  /**
   * 挂载既有 journal（T2 attach 恢复收尾）：播种（链 restoreSession + 转录 seed）由 daemon attach 序
   *  前置完成（runtime/transcript 外窥），本点做两件事——journal 实例挂载 + context.onContextChange
   *  同构订阅（TUI SessionController session.ts:199 同形：append→chain 行、compact→compact 行；msg
   *  行不续写——daemon 的 msg 面是事件转录，非 TUI ChatItem）。此后 run 的链变更经订阅即时续落
   *  同一 journal 文件；teardown/close 经 dispose seal 收口。
   */
  /** G14 diff 回退面：callId 不可寻（重放会话帧缓冲无此调用）时按相对路径找 journal snapshots
   *  行的末次 pre-image（写快照 blob 内容寻址落盘，journal 行内 path→hash 即可重建）。
   *  判界：路径必须落会话 root 内。 */
  diffPreImageFor(relPath: string): { abs: string; entry: SnapshotEntry } | undefined {
    const id = this.journal?.currentId;
    if (id === undefined) return undefined;
    const abs = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const relPosix = rel.split(path.sep).join('/');
    const file = path.join(this.dataDir, 'sessions', `${id}.jsonl`);
    let last: SnapshotEntry | undefined;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"snapshots"')) continue;
        try {
          const e = JSON.parse(line) as { t?: string; files?: SnapshotEntry[] };
          if (e.t !== 'snapshots' || !Array.isArray(e.files)) continue;
          for (const f of e.files) if (f.path === relPosix) last = f;
        } catch {
          // 坏行跳过（快照行撕裂不阻断扫描）
        }
      }
    } catch {
      return undefined;
    }
    if (last === undefined) return undefined;
    return { abs, entry: last };
  }

  /** 按 callId 直取捕获（2026-11-11 每刀独立快照,/diff 面消费）：先内存清单（在座会话零 IO）,
   *  未命中扫 journal snapshots 行（重启后清单空=唯一可达面;落盘条目自带 callId 回标字段）。
   *  每刀快照互不覆盖——同路径第 N 刀取回的就是第 N 刀自己的前后像 */
  snapshotByCall(callId: string): { abs: string; entry: SnapshotEntry } | undefined {
    const inMemory = this.runtimeImpl.harness.writeSnapshot.byCall(callId);
    if (inMemory !== undefined) return { abs: path.resolve(this.root, inMemory.path), entry: inMemory };
    const id = this.journal?.currentId;
    if (id === undefined) return undefined;
    const file = path.join(this.dataDir, 'sessions', `${id}.jsonl`);
    let hit: SnapshotEntry | undefined;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"snapshots"') || !line.includes(JSON.stringify(callId))) continue;
        try {
          const e = JSON.parse(line) as { t?: string; files?: SnapshotEntry[] };
          if (e.t !== 'snapshots' || !Array.isArray(e.files)) continue;
          for (const f of e.files) if (f.callId === callId) hit = f;
        } catch {
          // 坏行跳过（快照行撕裂不阻断扫描）
        }
      }
    } catch {
      return undefined;
    }
    if (hit === undefined) return undefined;
    return { abs: path.resolve(this.root, hit.path), entry: hit };
  }

  /** 轮次 checkpoint 内存索引(2026-11-10):runSeq → 本轮路径级前像/后像——轮收尾时填充;
   *  daemon 重启即空,读面 turnChangeFor 落 journal 扫描回退(重放会话同可用) */
  private readonly turnChanges = new Map<number, TurnFileChange[]>();
  private readonly runArtifacts = new Map<number, Artifact[]>(); // 轮次产物(2026-11-12 spec §6.2 端点当轮面)
  /** 快照回标用 callId→路径暂存（2026-11-11 每刀独立快照）：write/edit tool-call 记入,tool-result
   *  回执消费即删（泵内单点,见 pump 注释） */
  private readonly callPaths = new Map<string, string>();

  /** 轮次 checkpoint 查询面(turn-diff/turn-restore 端点消费):先内存索引(在座会话零 IO),
   *  未命中扫 journal runmeta 行——对位口径与 reduceSegRows 同构(行绑「末个 run-open seq」),
   *  面字段不予信任(sanitizeTurn 净化)。缺场 undefined */
  turnChangeFor(run: number, relPath: string): TurnFileChange | undefined {
    const relPosix = relPath.replaceAll('\\', '/');
    const inMemory = this.turnChanges.get(run)?.find((t) => t.path === relPosix);
    if (inMemory !== undefined) return inMemory;
    const id = this.journal?.currentId;
    if (id === undefined) return undefined;
    const file = path.join(this.dataDir, 'sessions', `${id}.jsonl`);
    let openSeq = -1;
    let hit: TurnFileChange | undefined;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"run-open"') && !line.includes('"runmeta"')) continue;
        try {
          const e = JSON.parse(line) as { t?: string; seq?: unknown; turn?: unknown };
          if (e.t === 'run-open') {
            openSeq = typeof e.seq === 'number' ? e.seq : openSeq;
            continue;
          }
          if (e.t !== 'runmeta' || e.seq !== undefined || openSeq !== run) continue;
          const turn = sanitizeTurn(e.turn);
          if (turn !== undefined) {
            const found = turn.find((t) => t.path === relPosix);
            if (found !== undefined) hit = found;
          }
        } catch {
          // 坏行跳过（撕裂不阻断扫描）
        }
      }
    } catch {
      return undefined;
    }
    return hit;
  }

  /** 产物库聚合（2026-11-12 spec §6.2;2026-11-14 kind 化:key=artifactKey）：内存当轮面 + journal 落档面合并，跨 run
   *  去重保留最新 run（库语义），runSeq 倒序；含子 run（journal 全量扫） */
  artifactsAggregated(): { items: AggregatedArtifact[] } {
    const rows: AggregatedArtifact[] = [];
    for (const [runSeq, list] of this.runArtifacts) {
      for (const a of list) rows.push({ ...a, runSeq });
    }
    const id = this.journal?.currentId;
    if (id !== undefined) {
      try {
        const file = path.join(this.dataDir, 'sessions', `${id}.jsonl`);
        rows.push(...scanArtifactsJsonl(fs.readFileSync(file, 'utf8')));
      } catch {
        // 无档/读失败=仅内存面
      }
    }
    return { items: mergeAggregated(rows) };
  }

  attachJournal(journal: SessionJournal): void {
    this.journal = journal;
    this.syncSessionStores();
    this.hookJournalSink();
  }

  /** 会话维落盘收养：后台任务账本 + 团队/板/inbox（journalId 稳定身份；铸造后与 attach 同拍）。
   *  reset 换 Harness 后重收养。幂等。 */
  private syncSessionStores(): void {
    const journalId = this.journal?.currentId;
    if (journalId === undefined) return;
    const dataDir = this.dataDir;
    const ledgerFile = path.join(dataDir, 'tasks', `ledger-${journalId}.jsonl`);
    // 账本只认自己的 journal（2026-11-25 用户裁定「只复制任务记录,不复制任务板和智能体团队」）:
    // 每个会话读写 ledger-<journalId>;**唯一跨会话记录来源=daemon /new 的显式并入单点**
    // （终态记录,boardDispatch 行过滤）。旧实现此处「通道会话首铸缺档吸收聊天域最新他席账本」
    // 的隐式路径已删——任意新会话都会整本继承旧任务,绕过「只有 /new 复制一次」裁定
    this.runtimeImpl.harness.tasks.adoptLedger(ledgerFile);
    this.runtimeImpl.harness.adoptSessionTeams(journalId);
  }

  /** journal 落盘订阅单点（单槽，后注册覆盖——attachJournal 重挂天然幂等不双写）：attach 与 reset 换新
   *  运行时后重挂共用；出生写语义（2026-10-31 spec §2）——会话铸造即建档落 header+ctx-snap 首拍,
   *  订阅内快照翻新走 persistSnapshotRow（末行为准） */
  private hookJournalSink(): void {
    this.runtimeImpl.harness.context.onContextChange((c) => {
      if (c.kind === 'append') {
        this.ensureMintedWithBirth(); // 首条实质事件建档即落 ctx-snap 出生行(header→ctx-snap→chain)——占座壳零事件零档(幽灵会话根因修),真会话冻结起点不变
        this.journal?.log({ t: 'chain', steps: c.steps });
      } else if (c.kind === 'snap') {
        this.persistSnapshotRow(); // 快照翻新（压缩/显式刷新,/init）：新行落档,末行为准（2026-10-31 spec §2）
      } else if (c.kind === 'compact') {
        this.journal?.log({ t: 'compact', chainFrom: c.chainFrom, compacted: c.compacted });
      }
    });
  }

  /** 快照落档单点（2026-10-31 spec §2）：出生写与翻新写共用——journal 未建档则先建档（惰性建档
   *  口径在此退役：出生写后每次 newSession 即铸造 header+ctx-snap 档,「空会话零文件」不变式由
   *  spec §2 显式废除,空会话档案增长是出生写语义的既定成本）;无 journal（理论不可达,守卫）no-op */
  /** 内置浏览器会话键(2026-11-03 浏览器状态按会话隔离):= journalId——稳定身份,重启不变;侧栏
   *  webview 持久分区 persist:sx-<键> 与浏览器插件 MCP 连接同键。未建档即建档:取键只发生在打开浏览器
   *  页签/浏览器插件首次装配,均为实质交互,不产幽灵会话;无 journal(测试桩)回落运行时 id */
  ensureBrowserKey(): string {
    this.ensureMintedWithBirth();
    return this.journal?.currentId ?? this.id;
  }

  /** 建档单点(出生写伴随):首条实质事件(链行/段级行任一路先到)触发建档——header 后立即落
   *  ctx-snap 出生行,两写路(链订阅/段级落档)共用,防「seg 行先铸档漏出生行」分叉 */
  private ensureMintedWithBirth(): void {
    const j = this.journal;
    if (j === undefined || j.currentId !== undefined) return;
    j.start(3); // v3 档:daemon 会话 header v=3(段级行词汇,P11-T2 零兼容)
    this.syncSessionStores(); // journalId 此刻才有——团队/账本按会话根收养，须在首笔工具前完成
    this.persistSnapshotRow();
    this.persistBirthMeta(); // sunx 出生 meta（2026-11-15 P1 Task 4）：kind/title(name)/charterRev:1——跟 birth 链路走,禁提前建档
    this.emitJournalMinted();
  }

  /** sunx 出生 meta 落档单点（2026-11-15 sunx P1 Task 4；P3 Task 2 起可达面=惰性建档
   *  ensureMintedWithBirth 与出生即铸档 ensureSunxBirth 两路）。kind==='sunx' 才落键;standard 不落
   *  任何新键(既有路径字节不变)。title=自定义名(仅进 G14.16 既有显示链,不进提示词);charterRev:1=
   *  出生品性即初版——charter 编辑端点读旧值 ?? 0 后 +1;root=工作区根（P3 Task 2 域旁车——attachSunx
   *  重开壳根唯一定位源,出生未跑也有）。落盘位置随 dataDir 外窥（域绑定后=域内旁车） */
  private persistBirthMeta(): void {
    if (this.sessionKind !== 'sunx') return;
    const journalId = this.journal?.currentId;
    if (journalId === undefined) return;
    writeSessionMeta(this.dataDir, journalId, {
      kind: 'sunx',
      // title（2026-11-25 用户裁定「每个会话的名称和普通会话一样显示成第一句消息的总结」）：
      // **通道聊天会话不题名**——journalDisplayTitle 落到首条用户消息总结（重命名经 ⋯ 菜单落
      // meta.title 同普通会话）;手建 Sunx 保持 name 题名（名称即身份,创建名即显示名）
      ...(this.sessionName !== undefined && this.opts.channelMeta === undefined ? { title: this.sessionName } : {}),
      ...(this.opts.groupId !== undefined && this.opts.groupId !== '' ? { groupId: this.opts.groupId } : {}),
      charterRev: 1,
      root: this.root, // 域旁车带 root（P3 Task 2）：attachSunx 重开壳根的唯一定位源——出生未跑也有
    });
  }

  /** 惰性建档外窥（2026-11-15 charter 编辑端点消费）：sunx 会话未铸档时先落 birth（含 meta
   *  charterRev:1）再算替代序次——替代链行 append 紧随其后,零幽灵窗;已铸档幂等 no-op */
  ensureJournalMinted(): void {
    this.ensureMintedWithBirth();
  }

  /** sunx 出生即铸档收尾（2026-11-15 sunx P3 Task 2）：createSessionIn 已在域目录内建档（journalId
   *  先铸——sunxDomainDir 域路径依赖它；header 经 SessionJournal.startWithId 落盘）并 attachJournal
   *  （syncSessionStores 收养域内台账/团队）——本点补出生三面：ctx-snap 快照冻结起点（persistSnapshotRow）
   *  + 出生 meta（persistBirthMeta——kind/title/charterRev:1/root 落域旁车）+ journal-minted 铸造帧
   *  （GUI 即刻回填稳定身份）。持久化实体语义：出生即存在（无实质事件也建档）；standard 惰性建档
   *  （ensureMintedWithBirth）零变化。非 sunx/档未铸（直构防御）静默 no-op */
  ensureSunxBirth(): void {
    if (this.sessionKind !== 'sunx') return;
    if (this.journal?.currentId === undefined) return;
    this.persistSnapshotRow();
    this.persistBirthMeta();
    this.emitJournalMinted();
  }

  /** 品性读面（2026-11-15 sunx P2 Task 7 GET /session/:id/charter 消费）：当前品性原文，
   *  null=无品性层。事实源=charterCurrent（出生 charter 起步、编辑端点回写推进）——非
   *  charterLayer（构造即冻结，编辑走链上替代行不回写冻结层，直读会落出生旧文） */
  charterText(): string | null {
    return this.charterCurrent;
  }

  /** 品性编辑回写单点（2026-11-15 sunx P2 Task 7）：charter 编辑端点落替代链行后调——
   *  读面与链尾替代行一致（GET 预填=当前全文，非出生旧文） */
  noteCharterEdit(text: string): void {
    this.charterCurrent = text;
  }

  /** journal 铸造推送(2026-11-07 用户裁定「主动推送是基本能力」):旁路帧(不经 pump 主链)
   *  ——GUI 即刻回填升级链稳定身份,免 recents 对账窗口 */
  private emitJournalMinted(): void {
    const journalId = this.journal?.currentId;
    if (journalId === undefined) return;
    this.emitBypassFrame({ type: 'journal-minted', payload: { journalId }, ts: Date.now() });
  }

  persistSnapshotRow(): void {
    if (this.journal === undefined) return;
    if (this.journal.currentId === undefined) {
      this.journal.start(3);
      this.syncSessionStores();
      this.emitJournalMinted();
    }
    this.journal.log({ t: 'ctx-snap', ...this.runtimeImpl.harness.context.snapshotExport() } as unknown as Parameters<SessionJournal['log']>[0]);
  }

  /** 影子投影只读外窥（测试面） */
  get shadowBoard(): TaskBoardState {
    return this.board;
  }

  get shadowDelegations(): Delegation[] {
    return this.delegations;
  }

  /** 补发窗口只读外窥：daemon 连接建立时逐会话全量补发（会话序 s1..sN，各内缓冲序） */
  bufferedFrames(): readonly EventFrame[] {
    return this.frames;
  }

  /** G14.2xx b 影子事件全量读面（HTTP 水合端点用）：journal shadow 行（board/delegation/subagent）
   *  原始事件按序返回,cut=读档时刻的泵水位。环窗（EVENT_BUFFER_CAP=512）对长会话子智能体流必溢出,
   *  且 GUI 刷新时 WS 连接建立先于会话 attach——「连接时刻回放」对影子投影天生够不着;journal 是
   *  唯一全量源(落档先于广播)。客户端契约:水合在途的实时 shadow 帧按 seq 缓冲,落定后清零重放
   *  本列、再重放缓冲中 seq > cut 的帧——cut 前的帧已含于行集(读档先于其广播),cut 后的帧只在
   *  缓冲,零丢帧零重复。无档/读档失败回空列(尽力恢复,不炸调用面)。 */
  shadowJournalEvents(): { events: SessionEvent[]; cut: number } {
    const jid = this.attachedJournalId;
    if (jid === undefined) return { events: [], cut: this.lastSeqNum };
    try {
      const file = path.join(sessionsDir(this.dataDir), `${jid}.jsonl`);
      if (!fs.existsSync(file)) return { events: [], cut: this.lastSeqNum };
      const events: SessionEvent[] = [];
      for (const row of parseJournalFile(file).events) {
        // 旧写面兼容(seedShadow 同款):board 行 ev/e 二取一,缺一跳过(坏行不得炸水合)
        const e =
          row.t === 'board'
            ? ((row as { e?: SessionEvent }).e ?? (row as { ev?: SessionEvent }).ev)
            : row.t === 'delegation' || row.t === 'subagent'
              ? row.e
              : undefined;
        if (e !== undefined && isShadowEvent(e)) events.push(e);
      }
      return { events, cut: this.lastSeqNum };
    } catch {
      return { events: [], cut: this.lastSeqNum };
    }
  }

  /** 事件泵（每会话一个，spec §7）：seq 分配（daemon 级全局单调，在先）→ 环形缓冲写入（满 512 丢最老）
   *  → 影子投影同步喂入 → 广播（daemon 序列化一次发全部连接）。序内裁定（G3 平移）：计数先于影子先于
   *  广播——同 tick 读 /snapshot 时 lastSeq 恒 ≥ 任何已广播帧的 seq（影子态与 seq 无交错半态）。
   *  投影与广播同源同序：snapshot 取到的影子态恒等于已广播事件的累积（无连接时投影照走——影子不依赖
   *  消费面在场） */
  pump(rawEvent: SessionEvent): void {
    // 工具结果图片同赴 images-cache(2026-10-31 用户裁定扩展:工具下拉回显图也零 base64 入档)——
    // 截屏/读图类工具的 payload.images dataURL 在泵口单点落盘换路径引用,journal/帧/快照全链路径串;
    // 模型视觉面在 harness wire 内已消费 dataURL,不受影响
    let e = rawEvent;
    if (e.type === 'tool-result' && Array.isArray(e.payload?.images) && (e.payload!.images as unknown[]).length > 0) {
      e = { ...e, payload: { ...e.payload, images: spillImages(this.root, e.payload!.images as string[]) } };
    }
    // 每刀独立快照回标（2026-11-11）：write/edit 的 tool-call 先记 callId→路径，同 callId 的
    // tool-result 成功回执时把 sink 里该路径末尾未标条目挂上 callId——/diff 面按 callId 直取,
    // 退役「数同路径调用位次」寻址（失败调用不计捕获=位次错位,前后像对不上号的真根因）
    if (e.type === 'tool-call' || e.type === 'tool-result') {
      const p = e.payload as { callId?: unknown; tool?: unknown; input?: unknown; ok?: unknown } | undefined;
      const callId = typeof p?.callId === 'string' ? p.callId : '';
      if (callId !== '') {
        if (e.type === 'tool-call') {
          // 仅快照族(write/edit)入表:read 等带 path 的调用不得回标他人捕获
          const inPath = p?.input !== null && typeof p?.input === 'object' ? (p.input as { path?: unknown }).path : undefined;
          if ((e.text === 'write' || e.text === 'edit') && typeof inPath === 'string' && inPath.length > 0) this.callPaths.set(callId, inPath);
        } else {
          const rel = this.callPaths.get(callId);
          this.callPaths.delete(callId);
          if (rel !== undefined && p?.ok === true) {
            this.runtimeImpl.harness.writeSnapshot.tagCall(rel, callId);
          }
        }
      }
    }
    const seq = this.opts.nextSeq();
    this.lastSeqNum = seq;
    const frame: EventFrame = { kind: 'event', sessionId: this.id, seq, e };
    this.frames.push(frame);
    if (this.frames.length > EVENT_BUFFER_CAP) this.frames.shift();
    // G14.17 meta 素材旁路：run 内末次 usage（turnTotal/cacheHitTotal/promptTotal 累计覆盖语义，
    // 取尾值即本轮全量）与末次 ctx exact 占用——run 收尾一并落旁车 meta
    if (e.type === 'usage') {
      const p = e.payload ?? {};
      this.runUsage = {
        total: typeof p.turnTotal === 'number' ? p.turnTotal : 0,
        cache: typeof p.cacheHitTotal === 'number' ? p.cacheHitTotal : 0,
        prompt: typeof p.promptTotal === 'number' ? p.promptTotal : 0,
      };
    } else if (e.type === 'ctx' && typeof e.payload?.used === 'number') {
      this.runCtxUsed = e.payload.used;
    }
    if (e.type.startsWith('task-')) {
      // G14.2xx 板面/委派/子智能体流落档已收归内核泵(shadow 事件,seglog 映射 journal 行)——
      // 本面只留影子投影更新,daemon/TUI 两写面自动继承
      const bev = boardEventFrom(e);
      if (bev !== undefined) this.board = applyBoardEvent(this.board, bev);
    }
    if (e.type.startsWith('delegation-')) this.delegations = applyDelegation(this.delegations, e);
    this.kernel.pump(e);
    this.opts.broadcast(frame);
  }

  /** 运行态外窥：current 在场即 running */
  status(): 'idle' | 'running' {
    return this.current ? 'running' : 'idle';
  }

  /** 轮收尾观察者（一次性）：下一次 run 收尾时回调并清空观察者集合；返回注销函数。
   *  定时任务执行记录回填用——回调错误吞掉（观察者失败不影响收尾） */
  onRunEnd(cb: (info: RunEndInfo) => void): () => void {
    this.runEndListeners.add(cb);
    return () => {
      this.runEndListeners.delete(cb);
    };
  }

  /** 提交任务（每会话 run 串行，spec §7）：单 run 锁在先（409 拒二次提交），受理后 202 即回——run
   *  异步走主链入口 runTask（同 TUI /goal 路径），失败吞错转 stderr 日志行（daemon 不因单 run 失败
   *  倒面），finally 清锁。user 条入转录在锁检查之后——409 拒绝的提交不留痕。任务文本经链尾指令行
   *  进模型上下文（appendInstructionLine——TUI /goal 同构，tui/session.ts 先例：goal 自身只是观测
   *  标签，不进提示词）；该行同落出生 journal（chain 派生转录的 `> <goal>` user 条来源）。
   *  双态（bg-wake spec §5.3）：wake 缺省=用户路径（markUserActivity+user 条+指令行）；wake 在场=
   *  唤醒轮（无 markUserActivity、notice 通知条+链尾 note 替代——快照/统计/续发全共用）。唤醒轮三员
   *  （P2 Task 3/5）：tasks 在场=任务终态唤醒（wake 引用配对）；schedule 在场=定时唤醒（notice 携
   *  schedule 标记——scheduledWakeOfRun 独立配对，不混 WakeRef 词汇）；restored 在场=恢复唤醒轮
   *  （R9——notice 携 restored 标记,sessionRestoredOfRun 独立配对,无 wake 引用） */
  submit(
    goal: string,
    images?: string[],
    wake?: {
      tasks?: WakeTaskInput[];
      schedule?: { note: string; lateMs?: number };
      restored?: { interrupted: ReadonlyArray<RestoredInterrupted>; materials: ReadonlyArray<RestoredMaterial> };
    },
    /** 跨 Sunx 投递来源（2026-11-26）：进内核 user 条归因（seg 行/replay 全链贯通） */
    fromSunx?: SunxPeerRef,
  ): SessionSubmitResult {
    if (this.current) return { ok: false, status: 409, error: 'run in progress' };
    if (wake === undefined) {
      this.wake.markUserActivity(); // 用户路径：连续唤醒计数归零（唤醒路径不重置）
      // 模型切换说明补显（2026-11-23 用户裁定「发出消息后才显示」+2026-11-24 二轮「提示应该在
      // 上面/模型不感知」）：挂起说明在本条消息发出时只落转录面（payload modelSwitch 标记——GUI
      // 回显 user 条先入核、说明帧后到，内核按标记插到回显之前=提示在消息上方）；不落链面——
      // 链尾 note 已撤，模型对切换零感知（用户裁定「agent 为什么知道模型被切换了」）
      if (this.pendingModelNotice !== null) {
        const { from, to } = this.pendingModelNotice;
        this.pendingModelNotice = null;
        this.pump({
          type: 'notice',
          text: t(`Model switched from ${from} to ${to}`, `模型从 ${from} 切换至 ${to}`),
          payload: { modelSwitch: true },
          ts: Date.now(),
        });
      }
    }
    // 图片落盘点(2026-10-31 用户裁定):dataURL → images-cache 文件路径引用——base64 不再进
    // 上下文/档/wire(见 images-cache.ts 头注);此入口覆盖普通提交与计划模式提交全部提交面
    // （唤醒路径零图片:不 spill 不入面）
    images = wake === undefined ? spillImages(this.root, images) : undefined;
    // 计划模式（2026-11-03 无感化,ask_question 同构）：armed 提交=read-only 覆盖在座+计划提示 note,
    // 走**普通会话作用域 run**——不再 fork/不再宿主编排;模型调研后 exit_plan 弹卡阻塞等裁决
    // （run 不收口）,裁决落档后同 run 无感继续。计划名兜底派生源记录（唤醒轮非用户提交,不武装）
    const armed = wake === undefined && this.planArmed();
    if (armed) this.activeGoal = goal;
    const abort = new AbortController();
    // G14.2xx 立即停止:run 信号装入沙箱——interrupt 时在途 exec 子进程即刻收割(不再等步边界)
    this.runtimeImpl.harness.sandbox.setRunSignal(abort.signal);
    const startedAt = Date.now();
    // G14.100 本轮改动基线(run 前 git 变动集):收尾差集=本轮 bash 面增量(runmeta.changes 供 GUI 汇总
    // 条;2026-11-11 快照族路径已改冻结快照面,git 面只补 bash 改动)。基线 promise 收尾 await——
    // 旧 void 竞态:轮很短时基线可能在轮末才落,差集吞掉本轮改动
    let runBaseChanges: ChangeFile[] = [];
    let runBaseKnown = false; // 基线不可得时收尾不报 bash 面——空基线差集会把存量文件全算本轮增量(误报)
    const basePromise = listChanges(this.root)
      .then((r) => {
        if (r.ok) { runBaseChanges = r.value.files; runBaseKnown = true; }
      })
      .catch(() => {}); // 旁路:基线探测失败不阻断 run 启动,收尾按 runBaseKnown 收窄
    this.runUsage = undefined;
    this.runCtxUsed = undefined;
    const hasImages = images !== undefined && images.length > 0;
    if (armed) {
      // 计划模式:read-only 覆盖在座(调研期强制只读;批准落档时退出)+提示 note(退出/批准结果都回喂模型)
      this.runtimeImpl.harness.security.enterModeOverride('read-only');
      this.runtimeImpl.harness.context.appendChain([{ action: 'note', observation: PLAN_MODE_NOTE }]);
    }
    // 轮次 checkpoint 寻址键(2026-11-10):run-open 条目 seq——GUI run 条 key(`k<seq>`)同源,
    // 跨重启稳定(journal seq 原样随档),turn-diff/turn-restore 端点按 run+path 寻址
    const runSeq = this.kernel.openRun();
    if (wake !== undefined && wake.tasks !== undefined) {
      // 任务终态唤醒轮（spec §5.3）：通知 notice 条 + 链尾 note——无 user 条、无指令行；模型输入与恢复面同构
      const refs = toWakeRefs(wake.tasks, (ledgerId) => this.boardTaskTitle(ledgerId));
      const md = buildWakeNotice(refs, this.runtimeImpl.harness.tasks);
      // 唤醒 notice 走宿主泵(帧缓冲+WS 广播+kernel.pump 全链)——直调 kernel.pump 只落档不发帧,
      // GUI live 收不到事件帧,前缀只在切会话(快照 seed)后出现(用户实测 2026-11-14)
      this.pumpWakeNotice(md, { wake: refs });
    } else if (wake !== undefined && wake.schedule !== undefined) {
      // 定时唤醒轮（P2 Task 3）：submitWake 同管线双态第二员——notice 携 schedule 标记
      // （scheduledWakeOfRun 独立配对，不混 WakeRef 词汇）+ 链尾 note；错过注明延迟（R7/busy 排队）
      this.pumpWakeNotice(buildScheduleWakeNotification(wake.schedule.note, wake.schedule.lateMs), { schedule: true });
    } else if (wake !== undefined && wake.restored !== undefined) {
      // 恢复唤醒轮（R9,P2 Task 5）：submitWake 同管线第三员——notice 携 restored 标记
      // （sessionRestoredOfRun 独立配对,与 wake/schedule 词汇零交集）+ 链尾 note;无 wake 引用——
      // 打断清单/素材列在通知文正文（人读投影）,显示走普通 run 行（<session-restored> 安静清单不显示）
      this.pumpWakeNotice(buildSessionRestoredNotification(wake.restored.interrupted, wake.restored.materials), { restored: true });
    } else {
      this.kernel.submit(goal, images, fromSunx);
      this.runtimeImpl.harness.context.appendInstructionLine(goal, hasImages ? images : undefined);
    }
    let runOutcome: import('../types').RunOutcome | undefined; // G14.89 finally 续发判停
    // 轮收尾观察面本地记账（2026-11-20 定时任务 Task 4）：收尾在 then 计算、finally 回调；
    // 异常路径（runTask 拒绝）then 可能没算出——finally 回退到 startedAt 兜底有限值
    let runEndedAt = 0;
    let runSeconds = 0;
    const p: Promise<void> = this.runtimeImpl
      .runTask(goal, {
        signal: abort.signal,
        ...(this.tier ? { tier: this.tier } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
      })
      .catch((err) => {
        console.error('[serve] run failed:', err);
      })
      .then(async (outcome) => {
        runOutcome = outcome ?? undefined;
        // 本轮写改动逐轮落档:只在 dispose 封存则整段会话的改动挤在档尾,回退文件无从按轮定位
        const turnSealed = this.runtimeImpl.harness.writeSnapshot.takeUnsealed();
        this.journal?.seal(turnSealed);
        // 本轮改动面(2026-11-11 用户裁定「每轮修改产生快照写死,轮与轮互不影响」):快照族(write/edit)
        // 路径的行数=本轮首刀前像 vs 轮末后像的 blob 差(冻结落档)——与 git 状态完全解耦:轮内提交
        // 不吞行数、后续轮次再改不回头改写本轮数字。git 差集只补充快照族之外的路径(bash 改动等,
        // 无前像=不可本轮撤销)。净零改动(前后像同 hash)不入改动卡
        const sink = this.runtimeImpl.harness.writeSnapshot;
        const firstPre = new Map<string, SnapshotEntry>();
        for (const e of turnSealed) {
          const key = e.path.replaceAll('\\', '/');
          if (!firstPre.has(key)) firstPre.set(key, e);
        }
        const snapRows: Array<{ path: string; status: ChangeFile['status']; added: number | null; deleted: number | null; turn: TurnFileChange }> = [];
        for (const [relPosix, pre] of firstPre) {
          const before = pre.deleted !== true && pre.hash.length > 0 ? sink.readBlob(pre.hash) : null;
          let afterBuf: Buffer | null = null;
          try {
            afterBuf = fs.readFileSync(path.resolve(this.root, relPosix));
          } catch {
            afterBuf = null; // 轮末已删(本轮删除面)
          }
          const afterHash = afterBuf !== null ? sink.store(afterBuf) : '';
          // 净零:本轮改了又改回(前后像逐字节相等)/新建又删——不入卡(每刀快照仍可经工具行查看)
          if (pre.deleted === true ? afterBuf === null : afterBuf !== null && pre.hash === afterHash) continue;
          const turn: TurnFileChange = {
            path: relPosix,
            ...(pre.deleted !== true && pre.hash.length > 0 ? { before: pre.hash } : {}),
            ...(pre.deleted === true ? { beforeDeleted: true as const } : {}),
            after: afterHash,
            ...(afterBuf === null ? { afterDeleted: true as const } : {}),
          };
          // 行数统计(LCS 护栏 16M 格,超限 null=不示数):before 缺场=新建(+全行),after 缺场=删除(-全行)
          const counts = lineDiffCounts(before?.toString('utf8'), afterBuf !== null ? afterBuf.toString('utf8') : undefined);
          const status: ChangeFile['status'] = afterBuf === null ? 'deleted' : pre.deleted === true ? 'untracked' : 'modified';
          snapRows.push({ path: relPosix, status, added: counts?.added ?? null, deleted: counts?.deleted ?? null, turn });
        }
        // git 补充面:基线差集里快照族之外的路径(bash 改动);快照族路径一律以上方冻结行为准
        const snapPaths = new Set(firstPre.keys());
        let gitExtra: ChangeFile[] = [];
        try {
          await basePromise;
          if (runBaseKnown) {
            const now = await listChanges(this.root);
            if (now.ok) gitExtra = diffChangeSets(runBaseChanges, now.value.files).filter((c) => !snapPaths.has(c.path.replaceAll('\\', '/')));
          }
        } catch {
          // 差集失败不挡收尾(汇总条缺 bash 面数据可接受)
        }
        // 轮次 checkpoint(2026-11-10 用户裁定「每轮精确看到自己的改动、能撤销」):前像=blob hash
        // (快照族才有,bash 改动无前像=不可本轮撤销),后像=轮末磁盘内容 hash(staleness 闸门基准)
        const runChanges: ChangeFile[] = snapRows.map(({ turn: _t, ...rest }) => rest);
        const turn: TurnFileChange[] = snapRows.map((r) => r.turn);
        for (const c of gitExtra) {
          const relPosix = c.path.replaceAll('\\', '/');
          let after = '';
          let afterDeleted: true | undefined;
          try {
            after = sink.store(fs.readFileSync(path.resolve(this.root, c.path)));
          } catch {
            afterDeleted = true;
          }
          runChanges.push(c);
          turn.push({ path: relPosix, after, ...(afterDeleted !== undefined ? { afterDeleted } : {}) });
        }
        if (runSeq >= 0 && turn.length > 0) this.turnChanges.set(runSeq, turn);
        // 产物=模型声明唯一网（2026-11-20 用户裁定「完全去掉自己去解析,交给 agent 自己判断哪些是
        // 产物」）：三条自动网（写盘钩/git 差集/mtime 扫描）退役，只剩 report_artifacts 声明；
        // mergeRunArtifacts 保留作声明去重+64 帽单点（自动网入参空）
        const declared = this.runtimeImpl.harness.artifacts.drain();
        const artifacts = mergeRunArtifacts(declared);
        if (runSeq >= 0 && artifacts.length > 0) this.runArtifacts.set(runSeq, artifacts);
        // G14.15 run 收尾元数据落 journal:GUI 回放恢复 Worked 行时长与步数/tokens 统计
        const endedTs = Date.now();
        runEndedAt = endedTs; // 轮收尾观察面（Task 4）：与 runmeta endedTs 同源
        const seconds = Math.max(1, Math.round((endedTs - startedAt) / 1000));
        runSeconds = seconds; // 轮收尾观察面（Task 4）：与 runmeta seconds 同源
        this.journal?.log({
          t: 'runmeta',
          // G14.210 停止态入档:中断/失败收口(非 done)→GUI 回放运行条显「已停止」
          ...(outcome?.stopReason !== undefined && outcome.stopReason !== 'done' ? { stopped: true } : {}),
          seconds,
          // G14.20 口径改宗(2026-10-31「1 轮 1 动作显示 5 步」根修):步数权威=内核 stats.sessionSteps
          // (模型动作轮;reactor 链全宽步号含指令注入/notice/工具回执行,虚高且与 live 面板/reload 重建不一致)
          ...(this.kernel.stats().sessionSteps > 0 ? { steps: this.kernel.stats().sessionSteps } : {}),
          ...(this.kernel.turnSteps() > 0 ? { runSteps: this.kernel.turnSteps() } : {}),
          tokens: outcome?.tokensUsed,
          ...(this.runUsage !== undefined ? { cacheTokens: this.runUsage.cache } : {}),
          endedTs,
          ...(runChanges.length > 0 ? { changes: runChanges } : {}),
          ...(turn.length > 0 ? { turn } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
        });
        // G14.100 runmeta 帧(实时轮汇总条数据源):journal 落档后广播,journal 不广播 GUI 无从感知
        this.pump({
          type: 'runmeta',
          ts: endedTs,
          payload: {
            seconds,
            ...(this.kernel.stats().sessionSteps > 0 ? { steps: this.kernel.stats().sessionSteps } : {}),
            ...(this.kernel.turnSteps() > 0 ? { runSteps: this.kernel.turnSteps() } : {}),
            tokens: outcome?.tokensUsed,
            ...(this.runUsage !== undefined ? { cacheTokens: this.runUsage.cache } : {}),
            endedTs,
            ...(runChanges.length > 0 ? { changes: runChanges } : {}),
            ...(turn.length > 0 ? { turn } : {}),
            ...(artifacts.length > 0 ? { artifacts } : {}),
          },
        });
        // G14.17 会话级旁车 meta 累积：runs/steps/tokens/秒数/缓存与 prompt 累计/末次上文占用/
        // 模型档位——列表与回溯面零重放直读（读旧值算累计,单 run 锁下无并发写面）
        const journalId = this.journal?.currentId;
        if (journalId !== undefined && outcome !== undefined) {
          const prev = readSessionMeta(this.dataDir, journalId);
          const u = this.runUsage;
          const model = this.runtimeImpl.harness.model;
          writeSessionMeta(this.dataDir, journalId, {
            updatedAt: endedTs,
            root: this.root,
            runs: (prev.runs ?? 0) + 1,
            ...(this.kernel.stats().sessionSteps > 0 ? { steps: this.kernel.stats().sessionSteps } : {}), // 累计口径覆盖写(stats 权威)
            tokens: (prev.tokens ?? 0) + (outcome.tokensUsed ?? 0),
            seconds: (prev.seconds ?? 0) + seconds,
            ...(u !== undefined ? { cacheTokens: (prev.cacheTokens ?? 0) + u.cache, promptTokens: (prev.promptTokens ?? 0) + u.prompt } : {}),
            ...(this.runCtxUsed !== undefined ? { ctxUsed: this.runCtxUsed } : {}),
            ctxWindow: resolveRunWindow(model),
            ...(model.label !== undefined ? { model: model.label } : { model: model.provider }),
            ...(this.effort !== undefined ? { effort: this.effort } : {}),
          });
        }
      })
      .finally(() => {
        this.current = undefined;
        // 轮收尾观察面（2026-11-20 定时任务 Task 4，spec §12）：current 清位后一次性回调并清空观察者
        // 集合——执行记录回填看见的收尾态与 status()=idle 同拍。then 未算出的异常路径回退 startedAt
        // 兜底，保证 endedAt/seconds 恒为有限值；回调失败吞掉，不影响收尾后续（续发/唤醒/定时）
        const endedAt = runEndedAt > 0 ? runEndedAt : Date.now();
        const info: RunEndInfo = {
          stopReason: runOutcome?.stopReason,
          endedAt,
          seconds: runSeconds > 0 ? runSeconds : Math.max(0, Math.round((endedAt - startedAt) / 1000)),
          ...(runOutcome?.tokensUsed !== undefined ? { tokens: runOutcome.tokensUsed } : {}),
        };
        const listeners = [...this.runEndListeners];
        this.runEndListeners.clear();
        for (const cb of listeners) {
          try {
            cb(info);
          } catch {
            /* 观察者失败不影响收尾 */
          }
        }
        // 计划模式收尾(2026-11-03 无感化):run 结束时 read-only 覆盖仍在座(未批准即结束——放弃放弃/
        // 中断/异常)→退出覆盖(批准路径已在落档钩退出,此处幂等);退出计划工具武装随 currentMode
        if (this.runtimeImpl.harness.security.overrideActive) this.runtimeImpl.harness.security.exitModeOverride();
        // G14.2xx 立即停止:轮收束即摘 run 信号(在途 exec 收割只属本轮;下轮 submit 重装)
        this.runtimeImpl.harness.sandbox.setRunSignal(undefined);
        // G14.89 轮收束自动发下一轮:队列非空即取队首续跑(排队语义=等当前轮完成自动发);
        // interrupted(用户主动停)不续——停止即停,队列留存由用户决定;余下条目保序回队
        // (P5:取走/回队均走内核——steer 行落档+queue 帧广播随发)
        if (runOutcome?.stopReason !== 'interrupted') {
          // 队列暂停态（2026-11-23 用户裁定）：不取队即不发出——待发条目留存,解除仅经队列恢复端点;
          // wake 续发/定时补跑不受队列暂停牵连（背景任务接力与用户队列分立）
          const pending = this.queuePausedFlag ? [] : this.kernel.steerTakePending();
          if (pending.length > 0) {
            for (const it of pending.slice(1)) this.kernel.steerEnqueue(it.text, it.images, it.fromSunx);
            // G14.89 user 回显帧:GUI 运行中入队不本地回显,气泡靠此帧。回显必须走纯帧广播
            // (不经 kernel.pump)——内部续发的 kernel.submit 自身会写 user 段,
            // 泵路回显曾致转录双气泡+journal 双行(G14.2xx 实测)
            this.broadcastUserEcho(pending[0]!.text, pending[0]!.images, pending[0]!.fromSunx);
            this.submit(pending[0]!.text, pending[0]!.images, undefined, pending[0]!.fromSunx);
          } else {
            // bg-wake 续发（spec §6）：steer 空时问唤醒——有终态登记且空闲即起唤醒轮（合批窗内到点的
            // 在途批也在此收口）；interrupted 不问（上方守卫，保留 pending §10-1）。返回值弃置：
            // 在途闩已由 onTurnEnded 入口一次性读清，宿主无需跟进标记
            this.wake.onTurnEnded(runOutcome?.stopReason);
            // 定时调度轮收束补跑（P2 Task 3）：busy 期间到点的调度（或受理失败留位）在 wake 之后再取
            // ——wake 受理起轮即占锁，本口 busy 判定自然留位到下轮收束（空闲判定模式与 wake 同构）
            this.timer.onTurnEnded();
          }
        }
      });
    // run 链终态收口：链上无 catch（收尾落档的 journal/meta 写失败——e2e teardown rm 后的迟到写窗、
    // 或 runTask 本身异常）会成 unhandled rejection；此处倒 error 帧可见化（teardown 后 pump 仅入
    // 影子缓冲，broadcast 无客户端为 no-op，安全）
    p.catch((err: unknown) => {
      this.pump({ type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() });
    });
    this.current = { abort, done: p };
    return { ok: true };
  }

  /** 外部（IM 通道）提交：语义同 submit + **user 回显帧广播**（2026-11-23 用户裁定「还是没有
   *  显示用户的气泡」根修——IM 提交无 GUI 乐观回显，submit 只落档不产帧，GUI 观看该会话时
   *  用户气泡要等重播才现身；本方法提交成功即广播 user 纯帧，GUI live 即显。GUI 自身提交走
   *  submit+本地乐观回显，不得走此方法防双气泡，G14.89 口径）。router IM 入站专用 */
  submitExternal(goal: string, images?: string[], fromSunx?: SunxPeerRef): SessionSubmitResult {
    const r = this.submit(goal, images, undefined, fromSunx);
    if (r.ok) this.broadcastUserEcho(goal, images, fromSunx);
    return r;
  }

  /** 在飞轮次锚（kernel run 条目 seq；空闲=-1。2026-11-26 跨 Sunx 定位：发送方发送时刻的轮次，
   *  随 fromSunx 归因下行——接收方点击归因行打开发送方会话并滚到该轮） */
  openRunSeq(): number {
    return this.kernel.openRun();
  }

  /** 中止当前 run：步边界/在途模型调用经 signal 即刻中止（reactor 既有语义），runTask 以
   *  stopReason=interrupted 收束后 finally 清锁。阻塞中的 exit_plan 挂起 executor 同为中断面：
   *  denyPlanPendings 回填（放弃/拒绝）+中止信号,executor 恢复后 run 以 interrupted 收束 */
  /** 命令执行中止句柄(2026-10-31 用户裁定「命令运行态可中断,中断后显示命令中断提示」):runCommand
   *  在途期挂载,interrupt 无 run 在途时转中止命令;收尾清空 */
  commandAbort?: AbortController;

  interrupt(): SessionInterruptResult {
    if (!this.current) {
      if (this.commandAbort !== undefined && !this.commandAbort.signal.aborted) {
        this.commandAbort.abort();
        return { ok: true };
      }
      return { ok: false, error: 'no run in progress' };
    }
    this.current.abort.abort();
    // 挂起型交稿卡（2026-11-03 无感化）:阻塞中的 exit_plan executor 凭 deny 回填+中止信号收尾
    // （放弃本轮/中断语义,arm 保持由 currentMode 决定）
    this.denyPlanPendings();
    return { ok: true };
  }

  /** todo 清单唯一写点（装配 onTodos 收写与批准续段勾选共用;会话级字段,reset 换新清空） */
  private setTodos(items: TodoItem[]): void {
    this.todos = items;
  }

  /** 运行中穿插（G3 steer 平移）：队列态在内核(P5)——enqueue 不做运行态检查，运行中步边界
   *  drain 消费、空闲入队下一轮生效（排队语义即承诺，恒 200 由 HTTP 面承担）;steer 行落档与
   *  queue 帧广播经 onKernelEvent 单槽随发。排队期展示=输入框上侧队列 chips（2026-11-23 用户
   *  裁定「在队列中就仍在队列中,队列显示在输入框上侧」）;出队注入(drain)才回显气泡——agent
   *  思考/工具回复已出队即入对话,G14.89 入队不回显口径维持 */
  steer(text: string, images?: string[], fromSunx?: SunxPeerRef): void {
    this.kernel.steerEnqueue(text, spillImages(this.root, images), fromSunx); // 图片落盘点(同 submit 裁定)
  }

  /**
   * 软重置（旧 /session/new 语义迁入 /session/:id/reset，spec §4.1）：等价 /new 但保留 sessionId——
   * 在跑 run 先中止（有界等待 settle，防僵尸 run 写入清空后的投影）→ 换新运行时（换 Harness 即换
   * 上下文链/沉淀管线/steering 队列，真 /new 等价）→ 旧运行时内脏收口（stopAll→drain→mcpClose）→
   * 影子/转录/补发缓冲清空。seq 不回拨（全局单调语义：重连客户端后续帧 seq 续接不重号）；attach 挂载
   * 的 journal 不 seal 不解挂（会话存活，续写同 journal——T2 语义）——落盘订阅随新运行时重挂。
   */
  async reset(): Promise<void> {
    this.denyPlanPendings(); // plan 挂起卡放弃回填（阻塞 executor 凭信号收尾）
    this.current = undefined; // 有界 settle 超时后仍清锁，避免 status 假 running
    // 品性读面随换新归位（P2 Task 7 fix round 1）：reset 换新运行时=链清空+新上下文挂出生品性层
    // （sessionCharter 经 assemble 透传）——charterCurrent 若保留 reset 前编辑文，GET 会返回模型
    // 已不跟的文（反向漂移）。归 birth 文（与 reCast 同拍语义；meta.charterText 不动——重启重开
    // 时链回放含替代行,模型又跟编辑文,读面再由 attach 按 meta 归位）
    this.charterCurrent = this.sessionCharter ?? null;
    const old = this.runtimeImpl;
    this.runtimeImpl = this.assemble();
    this.bindStopAudit(this.runtimeImpl);
    // reset 终结已落档调度（终审修复波 Fix 1）：下方 disposeRuntime 的 timer.reset() 只清内存位不落盘
    // ——盘上未触发 wake-schedule 行存活，daemon 重启 attach rearmSchedules 会把用户 /reset 丢弃的
    // 闹钟对已清空上下文重布防起一轮定时唤醒（「软重置后调度不复活」此前只在同进程内为真）。对当前
    // 挂起位落 firedAt 终态行（镜像 fireScheduled 链上限路径写法；与挂起面 denyPlanPendings 落
    // resolve 行同对称处理），回放面（rearmSchedules 的 firedAt 在场跳过闸门）即不再重布防
    const discarded = this.timer.scheduled;
    if (discarded !== undefined) this.logScheduleRow({ ...discarded, firedAt: Date.now() });
    if (this.journal !== undefined) {
      this.hookJournalSink();
      this.syncSessionStores();
      this.persistSnapshotRow(); // 快照翻新：reset 换新运行时重读磁盘,末行落新拍（续写同档,末条为准）
    }
    await this.disposeRuntime(old);
    // 软重置续写同 journal：板投影跟 harness/盘面（syncSessionStores 已收养），不强制空板
    this.board = this.runtimeImpl.harness.taskboard.snapshot();
    this.delegations = [];
    this.todos = []; // 真 /new 等价：待办清单随换新清空（TUI 软重置同语义）
    this.todoBatches = []; // 真 /new 等价：todo 批次权威投影随换新清空（2026-10-31 同上口径）
    // 转录清空(v3):truncate 行落档(upToSeq=0 全清——重放视界与 live 清空对齐)+ 内核换新
    // (同一 onKernelEvent 挂点,后续段落新行;truncate 前落行——换新后旧条目不再可达)
    this.kernel.truncate(0);
    this.kernel = new SessionKernel({ onKernelEvent: (ev) => this.persistKernelEvent(ev) });
    this.frames.length = 0;
  }

  /** 会话快照（G2 /snapshot 载荷单点平移；G3 增 lastSeq；G5 增 team 段）：粗粒度转录 + board/delegations
   *  影子投影 + teammate 名/busy（TeamRegistry.aliveNames/get/isBusy 同源——GUI Board/Team 面消费）+
   *  运行态 + 事件序列水位——GUI 冷启动/刷新经一次拉取恢复全景，细粒度实时面仍走 WS 事件流（两轨
   *  分工，spec G2 Ruling 1）；lastSeq=本会话已泵最大 seq（与影子态同 tick 读取，pump 序内先影子后
   *  广播）——客户端以「重连后本会话首帧 seq > lastSeq ⇒ 无缺口」判重连补发完备（G4 消费） */
  /** 当前模型选择 id（undefined = 缺省主模型;无切换器恒 undefined） */
  private currentModelId(): string | undefined {
    return this.modelSwitcher?.currentId();
  }

  /** 档位/思考强度（G10-C2b 可变面）：per-run 注入 runTask opts,下一轮生效 */
  private tier?: SessionTier;
  private effort?: ReasoningEffort;

  /** create_scheduled_task 缺省配置（2026-11-20 用户裁定「各种配置复用当前输入框的」）：
   *  取本会话此刻的强度/权限档——工具在模型省参数时落这两个值；plan 映射 acceptEdits
   *  （无人值守任务不能挂计划确认）。工作区由工具默认根兜底，模型全局共享不固定。 */
  private scheduleCreateDefaults(): { model?: string; effort?: ReasoningEffort; mode: 'read-only' | 'acceptEdits' | 'full-access' } {
    return {
      ...(this.currentModelId() !== undefined ? { model: this.currentModelId() } : {}),
      ...(this.effort !== undefined ? { effort: this.effort } : {}),
      mode: this.currentMode === 'plan' ? 'acceptEdits' : this.currentMode,
    };
  }

  setTier(tier: string): boolean {
    const v = parseTier(tier);
    if (v === undefined) return false;
    this.tier = v;
    return true;
  }

  clearTier(): void {
    this.tier = undefined;
  }

  setEffort(effort: string): boolean {
    const v = parseEffort(effort);
    if (v === undefined) return false;
    this.effort = v;
    this.persistSelection({ effort: v }); // G14.2xx 选择即刻落 meta(attach 回放,重启不回落缺省)
    return true;
  }

  clearEffort(): void {
    this.effort = undefined;
    this.persistSelection({ effort: undefined });
  }

  /** 模型切换器外窥（G10-C1b;undefined = daemon 装配为单模型,不可切） */
  get modelSwitcher(): ModelSwitcher | null {
    return this.opts.modelSwitcher ?? null;
  }

  /** 运行中模型切换（G10-C1b）：switchTo 单点;unknown id 幂等 false 不动现状。切换 daemon 级生效。
   *  系统提示延后显示（2026-11-23 用户二轮裁定「切换模型时不产生提示,切换模型发出消息后才显示」）：
   *  实际变化（prev≠next）只记挂起说明（from 取首个未显示切换的起点,to 取最新目标——连续试选合并成
   *  一条;切回起点即作废,来回试选零噪音）;下一条用户消息发出时（submit 用户路径）才落双面——
   *  notice 事件（用户面,t() 双语）+ 链尾 note 行（模型面,英文单语 §15）。同 id 重选/装配期
   *  switchTo(choices[0])/reload 配置漂移不记挂起（只响应用户显式切换） */
  setModel(id: string | undefined): boolean {
    const sw = this.modelSwitcher;
    if (sw === null) return false;
    const prev = sw.currentId();
    if (!sw.switchTo(id)) return false;
    const next = sw.currentId();
    if (next === prev) return true;
    if (id !== undefined) this.persistSelection({ model: id });
    this.pendingModelNotice = {
      from: this.pendingModelNotice?.from ?? (prev ?? 'default model'),
      to: next ?? 'default model',
    };
    return true;
  }

  /** 权限模式切换（G10-C1b;2026-11-03 重建退役）：真档轻量直切——档位在装配期只进 guard 构造参数
   *  （session.ts assemble 映射）,全消费点（guard/chain）按每次工具调用活读,`security.setBaseMode`
   *  纯字段写即全链生效:**运行中切真档不再 busy,下一未决调用按新档判决;在飞调用/子进程不回溯**。
   *  换铸（assemble 重建+快照直传回种）是 v1 复用 reset 路径的惯性,非 mode 依赖——随本修订退役,连同
   *  其修补机械（快照直传/hookJournalSink 重挂/链 restore）。两个有意差异登记:①sessionAllows/
   *  sessionDirAllows 跨档保留（加法语义,旧换铸清空）;②readGuard 不换铸（降档免重读,旧换铸「强制
   *  重读」语义退役）。边界（2026-11-03 无感化）:挂卡期切真档=弃卡+中断收口（不再 busy——卡挂起
   *  的 run 由 interrupt 收口,guard 活读承载真档即时生效）;切离 plan 保留 disarm 收口（中止在途,语义不变）。
   *  plan 流程标记（阶段三 plan-arm;/plan 三态）：setMode('plan') 即武装——武装快路径,任何状态可用、
   *  幂等、永不 busy：arm 只是 currentMode 标记位（装配映射恒 acceptEdits）,不重建运行时;运行中武装
   *  对下一次提交生效;规划轮权限面走 read-only 覆盖,与基档无关。本方法即「手动切档解除」路径（切离
   *  plan 档=disarm）。回放语义（spec §5.2,跨重启不恢复 arm）：persistSelection 照写 mode:'plan' 落
   *  meta 旁车,attach 回放只认现值三档（'plan' 照写不照回）——armed 不跨重启;已批准的计划书随链回放。
   *  disarm 收口（2026-11-03 无感化）：切离 plan 且 run 在途（调研/挂卡阻塞中）即 interrupt——挂起卡
   *  放弃回填+run 收口回输入态;批准续段=同 run 直切（setBaseMode,无流程可中止——planFlow 状态机已退役）。 */
  async setMode(mode: SessionMode): Promise<'ok' | 'busy'> {
    // 武装快路径（2026-11-03）：置标记+落 meta 即回,零重建零 busy
    if (mode === 'plan') {
      if (this.currentMode === 'plan') return 'ok'; // 同档幂等
      this.currentMode = 'plan';
      this.persistSelection({ mode });
      return 'ok';
    }
    // 边界:disarm——切离 plan 且 run 在途（调研/挂卡阻塞中）,中断 run（挂起卡放弃回填）并退出 override;
    // 真档直切后新基档即时生效（运行中不再 busy——guard 活读,在飞不回溯）
    if (this.planArmed() && this.current !== undefined) this.interrupt();
    this.runtimeImpl.harness.security.exitModeOverride();
    if (mode === this.currentMode) return 'ok';
    this.currentMode = mode;
    this.runtimeImpl.harness.security.setBaseMode(mode); // guard 纯字段写,下一未决调用即按新档判决
    this.persistSelection({ mode }); // G14.2xx 模式切换即刻落 meta(attach 回放)
    return 'ok';
  }

  /** G14.2xx 会话选择面持久化单点(model/effort/mode):即改即写 meta 旁车——公共持久化口径
   *  (CLAUDE.md §13),重启/重开 attach 时回放,不再回落装配缺省;journal 未附(无 id)跳过 */
  private persistSelection(patch: { model?: string; effort?: string; mode?: SessionMode }): void {
    const journalId = this.journal?.currentId;
    if (journalId === undefined) return;
    writeSessionMeta(this.dataDir, journalId, patch);
  }

  /** G14.83 队列重排:from → to(拖拽排序);置首=插入发送(下一轮立即注入)——P5 走内核态 */
  steerMove(seq: number, to: number): boolean {
    return this.kernel.steerMove(seq, to);
  }

  steerFront(seq: number): boolean {
    return this.kernel.steerMoveToFront(seq);
  }

  /** P5 队列编辑(spec §12.2):第 seq 条文本改写;越界/空白 false */
  steerEdit(seq: number, text: string): boolean {
    return this.kernel.steerEditAt(seq, text);
  }

  /** 排队插话(G10-C1d):内核队列快照(P5),seq=位置下标(每次变更重排,cancel 寻址键) */
  /** 队列暂停态（2026-11-23 用户裁定「用户点击输入框暂停按钮,同时要暂停队列,不要自动发出」）：
   *  真=轮收束不自动发出（待发条目留存,面板显示暂停横幅）;输入框停止钮中断时同置;解除仅经队列恢复。
   *  内存态随运行时生命周期（队列本体同源,不落盘） */
  private queuePausedFlag = false;
  /** 挂起的模型切换说明（2026-11-23 用户裁定「发出消息后才显示」）：setModel 实际变化时记录
   *  {from,to}（from=首个未显示切换起点,连续试选合并为一条,切回起点作废）;下一条用户消息
   *  submit 时落双面后清空。内存态随运行时生命周期 */
  private pendingModelNotice: { from: string; to: string } | null = null;

  /** 队列暂停:置暂停态并广播快照面（GUI 队列面板横幅切换） */
  queuePause(): void {
    this.queuePausedFlag = true;
  }

  /** 队列恢复:解除暂停;idle 且队列非空即按序自动发送（排队语义即刻续跑;running 由轮收束 gate 接力） */
  queueResume(): void {
    this.queuePausedFlag = false;
    if (this.status() !== 'idle') return;
    const pending = this.kernel.steerTakePending();
    if (pending.length > 0) {
      for (const it of pending.slice(1)) this.kernel.steerEnqueue(it.text, it.images);
      this.broadcastUserEcho(pending[0]!.text, pending[0]!.images);
      this.submit(pending[0]!.text, pending[0]!.images);
    }
  }

  private queuedSteer(): Array<{ seq: number; text: string; images?: string[]; fromSunx?: SunxPeerRef }> {
    return this.kernel.steerPendingItems().map(({ seq, text, images, fromSunx }) => ({ seq, text, ...(images !== undefined ? { images } : {}), ...(fromSunx !== undefined ? { fromSunx } : {}) }));
  }

  /** 撤回排队插话(G10-C1d):按下标撤;越界 false */
  cancelSteer(seq: number): boolean {
    return this.kernel.steerRemoveAt(seq);
  }

  /** fork 血缘读数(header 单行读+按 journalId 缓存):kind='fork' 主链分档才显(side=辅助档不显,
   *  原生档无字段=undefined)。title=父档显示题(journalDisplayTitle 单点;父同 root,fallback=root 名) */
  private forkedFromInfo(): SessionSnapshot['forkedFrom'] {
    const jid = this.attachedJournalId;
    if (jid === undefined) return undefined;
    if (this.forkedFromCache?.jid === jid) return this.forkedFromCache.info;
    let info: SessionSnapshot['forkedFrom'];
    try {
      const first = fs.readFileSync(path.join(sessionsDir(this.dataDir), `${jid}.jsonl`), 'utf8').split('\n')[0] ?? '';
      const header = JSON.parse(first) as JournalEvent;
      const ff = header.t === 'header' ? header.forkedFrom : undefined;
      info = ff !== undefined && ff.kind === 'fork'
        ? { sessionId: ff.sourceSessionId, title: journalDisplayTitle(this.dataDir, ff.sourceSessionId, path.basename(this.root)) }
        : undefined;
    } catch {
      info = undefined;
    }
    this.forkedFromCache = { jid, info };
    return info;
  }

  snapshotResponse(page?: SessionSnapshotPage): SessionSnapshot {
    void this.todos; // 会话 todo 投影读面（批准播种/模型 todo_write 收写;GUI 面走 todo-batches）——TS6133 豁免读
    const full = this.kernel.replay();
    // 2026-10-26 三期:缺省尾窗 200(首屏);before/limit 向前翻页(补全页,缺省 600 上限 2000)。
    // 2026-11-19:GUI reseed 改传 tail=2000 一次取全(分页补历史使刻度/正文两段加载)——内核
    // 档面本就以 CAP 2000 封顶(src/session/entry.ts),tail 同口径钳上限,其它客户端缺省 200 不变。
    // result.full 恒剥(载荷瘦身,全量观测走 entry/observation 按需端点);journal 落盘不动
    const tail = Math.min(page?.tail ?? 200, 2000);
    const before = page?.before;
    const limit = Math.min(Math.max(page?.limit ?? 600, 1), 2000);
    let messages: readonly KernelEntry[];
    let hasMore: boolean;
    if (before !== undefined) {
      const headEnd = full.findIndex((m) => m.seq >= before);
      const head = headEnd < 0 ? full : full.slice(0, headEnd);
      const start = Math.max(0, head.length - limit);
      messages = head.slice(start);
      hasMore = start > 0;
    } else {
      const start = Math.max(0, full.length - tail);
      messages = full.slice(start);
      hasMore = start > 0;
    }
    return {
      messages: messages.map((m) => (m.result?.full === undefined ? m : { ...m, result: { text: m.result.text, ok: m.result.ok } })),
      total: full.length,
      ...(messages.length > 0 ? { oldestSeq: messages[0]!.seq } : {}),
      hasMore,
      openRun: this.kernel.openRun(),
      openSeg: this.kernel.openSeg(),
      board: this.board,
      delegations: this.delegations,
      status: this.status(),
      lastSeq: this.lastSeqNum,
      model: this.currentModelId(),
      mode: this.currentMode,
      ...(this.tier ? { tier: this.tier } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      queued: this.queuedSteer(),
      queuePaused: this.queuePausedFlag,
      todoBatches: this.todoBatches,
      archived: this.attachedJournalId !== undefined
        ? readSessionMeta(this.dataDir, this.attachedJournalId).archived === true
        : false,
      ...(this.forkedFromInfo() !== undefined ? { forkedFrom: this.forkedFromInfo() } : {}),
      team: this.runtimeImpl.harness.team.aliveNames().map((name) => {
        const tm = this.runtimeImpl.harness.team.get(name);
        return {
          name,
          busy: tm?.isBusy() ?? false,
          ...(this.runtimeImpl.harness.team.teamIdOf(name) !== undefined
            ? { teamId: this.runtimeImpl.harness.team.teamIdOf(name)! }
            : {}),
          ...(tm !== undefined && tm.createdAt > 0 ? { createdAt: tm.createdAt } : {}),
        };
      }),
      teams: this.runtimeImpl.harness.agentTeams.list(),
    };
  }

  /** 按需全量观测(2026-10-26 三期 §4.5):快照分页剥 result.full 后,工具行展开按 seq 单条拉取——
   *  kernel 内存直取零盘读;未命中(undefined)=seq 越界/已截断,客户端回落 result.text */
  entryObservation(seq: number): { seq: number; text?: string; full?: string } | undefined {
    const e = this.kernel.replay().find((m) => m.seq === seq);
    if (e === undefined) return undefined;
    return { seq, text: e.result?.text, full: e.result?.full };
  }

  /** run 中止态外窥（G5 ghost 硬化）：current 在场且 abort 信号已发——daemon 侧 acceptEdits asker 闭包
   *  在注册挂起前查此位（interrupt/reset 已回填过旧表，abort 之后到达的 ask 是 ghost：无人再回填，
   *  直接 deny/dismissed 不入表不广播） */
  isAborted(): boolean {
    return this.current?.abort.signal.aborted === true;
  }

  /**
   * 会话收口（spec §7 收尾序，平移自 daemon 单会话 teardown）：abort 在跑 run → 有界等待其 settle
   * 收口（2s 上限）→ stopAll → drain → mcpClose（序同 CLI teardownCliRun 现场）→ journal seal。
   * daemon close 序以分相形态（abortAndSettle/dispose）并入网络面先行关序，本方法为独立完整序。
   */
  async teardown(): Promise<void> {
    await this.abortAndSettle();
    await this.dispose();
  }

  /** 收口步骤 0：在跑 run 即刻中止（T1 评审裁定：悬挂 run 的 promise 会拖住事件循环/测试收口；路径同
   *  /interrupt）→ 被中止 run 的 settle 钩子（沉淀入队）需收口后才进 drain——2000ms 有界防 signal
   *  无视的工具悬挂 teardown（终审裁定）；done 先胜即清残留 timer，不给事件循环留 2s 尾巴。
   *  阻塞中的 exit_plan 挂起 executor 同为中断面：denyPlanPendings 回填（放弃/拒绝）→ executor 恢复
   *  凭中止信号收尾 */
  async abortAndSettle(): Promise<void> {
    this.current?.abort.abort();
    this.denyPlanPendings();
    if (!this.current) return;
    const current = this.current;
    let settleTimer: NodeJS.Timeout | undefined;
    const bail = new Promise<void>((resolve) => {
      settleTimer = setTimeout(resolve, ABORTED_RUN_SETTLE_MS);
    });
    // race 面吞拒：done 的拒绝（中止收尾落档的写失败等）已经 p.catch 倒 error 帧可见化——
    // settle 等待的语义是「等其落定」而非「随其失败」，拒绝不得拖垮 teardown/close 序
    await Promise.race([current.done.catch(() => undefined), bail]);
    clearTimeout(settleTimer);
  }


  /** 收口步骤 3-5（当前运行时）：停全部后台任务（同 CLI D24：任务执行体先停、通道后关，stopAll 同步
   *  纯本地记账不抛）→ 排空后台沉淀管线（此时无新入队源，drain 即终态）→ MCP 连接收口（stdio 子进程
   *  防悬挂事件循环）→ journal seal（T2：write 影子快照清单以 snapshots 事件尾追，同 TUI sealJournal
   *  形态；空清单零事件——drain 后续 seal 幂等）。daemon close 的网络面先行序在此相与 abort 相之间切入 */
  async dispose(): Promise<void> {
    await this.disposeRuntime(this.runtimeImpl);
    this.journal?.seal(this.runtimeImpl.harness.writeSnapshot.takeUnsealed());
  }

  /** 内脏收口单点（reset 的旧运行时换新后同序收口） */
  private async disposeRuntime(rt: KernelRuntime): Promise<void> {
    rt.harness.team?.stopAll();
    rt.harness.tasks.stopAll();
    this.wake.reset(); // bg-wake 收口：清合批 timer/pending/链计数（防句柄泄漏,换铸/关闭后旧批次零残留）
    this.timer.reset(); // 定时调度收口（P2 Task 3）：清句柄/调度位（WakeController 同纪律）。盘面分流（终审
    // Fix 1）：reset 路径已先行落 firedAt 终态行——档上无未触发行,重启 attach 重布防零复活；teardown/close
    // 路径不终结（调度是会话资产随档存活——daemon 停机跨越重启补发,手册「定时随档保存重启生效」口径）
    await rt.harness.pipeline.drain();
    await rt.harness.mcpClose();
  }
}
