import * as path from 'node:path';
import { createKernelRuntime } from '../session/runtime';
import { resolveDataDir } from '../config/data-dir';
import { parseTier } from '../runtime';
import { parseEffort } from '../model/effort';
import type { ModelTier, ReasoningEffort } from '../types';
import { ModelSwitcher } from '../model/catalog';
import type { KernelRuntime } from '../session/runtime';
import type { ModelAdapter } from '../model/adapter';
import type { ApprovalDecision, ApprovalRequest, AskUserAnswer, AskUserRequest, RunOutcome, SessionEvent, TodoItem } from '../types';
import { applyBoardEvent, emptyBoard } from '../taskboard/model';
import type { TaskBoardState } from '../taskboard/model';
import { applyDelegation } from '../delegation/projection';
import type { Delegation } from '../delegation/projection';
import { boardEventFrom } from '../tui/session';
import type { SessionJournal, JournalEvent } from '../tui/session-journal';
import * as fs from 'fs';
import type { SnapshotEntry } from '../tui/session-journal';
import { SessionKernel, isShadowEvent, type KernelEvent, type SteerItem } from '../session/kernel';
import { kernelEventRows } from '../session/seglog';
import type { KernelEntry } from '../session/entry';
import { readSessionMeta, writeSessionMeta, sessionsDir, parseJournalFile } from '../tui/session-journal';
import { resolveRunWindow } from '../config/termination-config';
import { runPlanFlow, PLAN_TASK_LABEL, PLAN_MAX_ROUNDS } from '../harness/plan-flow';
import type { PlanDecision } from '../harness/plan-flow';
import { SLASH_COMMANDS } from '../tui/slash-commands';
import { listChanges, diffChangeSets } from './session-changes';
import type { ChangeFile } from '../types';
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
export interface SessionSnapshot {
  messages: KernelEntry[];
  /** 内核流式游标(G14.51 归位):快照时刻的 openRun/openSeg——客户端装载直用,不再从条目反推 */
  openRun: number;
  openSeg: number;
  board: TaskBoardState;
  delegations: Delegation[];
  status: 'idle' | 'running';
  lastSeq: number;
  team: Array<{ name: string; busy: boolean }>;
  /** G10-C1b 切换回显段:model=当前选择 id(undefined=缺省主模型/单模型);mode=会话权限态 */
  model?: string;
  mode: SessionMode;
  /** G10-C2b 档位/思考强度覆盖(undefined=缺省) */
  tier?: SessionTier;
  effort?: ReasoningEffort;
  /** G10-C1d 排队插话段(steering FIFO 快照;seq=队列下标,cancel 寻址键) */
  queued: Array<{ seq: number; text: string }>;
  /** 归档态(2026-10-21):旁车 meta archived 回读——GUI 顶栏归档钮/徽标三态播种;未附 journal 恒 false */
  archived: boolean;
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
export type SessionSubmitResult = { ok: true } | { ok: false; status: 409; error: string };

/** interrupt 结果：ok=true 已发中止信号；ok=false 无在跑 run（409 面） */
export type SessionInterruptResult = { ok: true } | { ok: false; error: string };

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
}

/** 挂起表条目（P6 §4 下沉,原 daemon-wire 资产）：kind 判别联合；resolve 即回执值（interrupt/reset
 *  以 deny/dismissed/拒绝回填,TUI approval.ts 先例——plan 卡中断=confirmPlan(false) 语义）。
 *  sessionId 出模型——条目恒在所属会话表内,同会话寻址自明;wire 帧（ApprovalFrame/AskFrame/
 *  PlanApprovalFrame）由会话组帧时携带自身 id */
export type PendingEntry =
  | { kind: 'approval'; req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }
  | { kind: 'ask'; req: AskUserRequest; resolve: (a: AskUserAnswer) => void }
  | { kind: 'plan-approval'; req: { doc: string; items: string[] }; resolve: (d: PlanDecision) => void };

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
export type SessionTier = ModelTier;

export class SessionRuntime {
  readonly id: string;
  readonly root: string;
  private readonly opts: SessionRuntimeOpts;
  /** 会话运行时本体（reset 时整体换新——软重置等价 /new：换 Harness 即换上下文链/沉淀管线/steering） */
  private runtimeImpl: KernelRuntime;
  private current?: CurrentRun;
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
  /** G14.20 done 载荷会话累计步数（steps 语义单一源,runmeta/旁车覆盖写） */
  private runDoneSteps?: number;
  /** G14.56 本轮自身步数(done 载荷 runSteps;runmeta 落档,GUI 回放 run 尾部「本轮」口径) */
  private runRunSteps?: number;
  /** attach/出生挂载的会话日志（T2）：在场即链行续落（context.onContextChange 订阅）与 teardown seal；
   *  daemon 侧新会话出生即挂（惰性建档——首 run 首条 append 才落盘，空会话零文件）；resume 转录由
   *  事件转录面承担，msg 行非 TUI ChatItem（daemon 档只落 chain） */
  private journal?: SessionJournal;

  /** 当前权限模式（G10-C1b 可变面）：setMode 重建 runtime（reset 同路径,转录/影子投影独立不受损） */
  private currentMode: SessionMode;

  // ---- plan-arm（阶段三 spec §5.1）：mode==='plan' 即 armed 的流程在途态三件 ----

  /** planFlow 消费壳在途标记（TUI 同名同语义）：armed 空闲提交拦截为 planFlow 后置位,流程终态
   *  （批准执行收尾/中断/超限/无产物）复位;裁决点挂卡期保持 true——armed+idle+在途的提交 409
   *  （单流程在途,裁决走挂起表回执端点,不排队）。公开判定仅类内消费（interrupt/submit/abortAndSettle） */
  private planFlowRunning = false;
  /** plan 流程中断源（TUI taskAbort 同构）：规划轮 fork run/执行段逐项 run/挂卡期中止判定共用同一
   *  信号——interrupt()/abortAndSettle() 直达;流程不在途 undefined */
  private planAbort?: AbortController;
  /** plan 流程整体收束 promise（abortAndSettle 有界等待锚）：reset/teardown 等它落定（≤2s）防换新
   *  运行时与续跑段竞写 */
  private planFlowSettled?: Promise<void>;
  /** 会话 todo 清单（todo_write 接缝收写,装配单点 onTodos 注入）：planFlow todosSnapshot 权威源
   *  （规划轮模型 todo_write 快照即步骤权威,TUI state.todos 同构）+批准续段逐项勾选承载 */
  private todos: TodoItem[] = [];

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
    this.currentMode = opts.mode ?? 'full-access';
    this.kernel = new SessionKernel({ onKernelEvent: (ev) => this.persistKernelEvent(ev) });
    this.runtimeImpl = this.assemble();
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
      if (j.currentId === undefined) j.start(3); // 惰性建档(chain 订阅同构):首条段级行落 header——首 run 的 user/run-open 行不再丢档
      for (const row of kernelEventRows(ev)) j.log(row);
    } catch {
      // 尽力落档:写失败不影响运行面
    }
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

  /** 子智能体影子帧重放(emitQueueFrame 同形):journal 里的子智能体事件按新 seq 回灌帧缓冲+广播,
   *  GUI agent 页签的聚合面从帧重建(实时流同一消费通道) */
  private emitShadowFrame(e: SessionEvent): void {
    const seq = this.opts.nextSeq();
    this.lastSeqNum = seq;
    const frame: EventFrame = { kind: 'event', sessionId: this.id, seq, e };
    this.frames.push(frame);
    if (this.frames.length > EVENT_BUFFER_CAP) this.frames.shift();
    this.opts.broadcast(frame);
  }

  /** queue 事件旁路广播(P5,spec §12):队列变更不发 SessionEvent 主链(pump 会喂转录内核与影子
   *  投影,default 分支把 queue 当边界误闭合开启段)——单走 seq 分配+环形缓冲+广播;重连补发经
   *  frames 环窗天然覆盖(新连接回放最后一条 queue 帧=最新队列) */  private emitQueueFrame(items: SteerItem[]): void {
    const seq = this.opts.nextSeq();
    this.lastSeqNum = seq;
    const frame: EventFrame = { kind: 'event', sessionId: this.id, seq, e: { type: 'queue', payload: { items }, ts: Date.now() } };
    this.frames.push(frame);
    if (this.frames.length > EVENT_BUFFER_CAP) this.frames.shift();
    this.opts.broadcast(frame);
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
      onEvent: (e) => this.pump(e),
      onApproval: (req) => this.suspendApproval(req),
      onAskUser: (req) => this.suspendAsk(req),
      // todo_write 接缝（planFlow todosSnapshot 权威源,spec §4.1）：会话级 todos 字段单点收写——
      // 规划轮模型 todo_write 的快照即计划步骤权威（TUI state.todos 同构）,批准续段逐项勾选同字段承载
      onTodos: (items) => {
        this.todos = items;
      },
    });
    // 插入发送（front 置首条目）步边界消费口：取走即回显——user 帧（live 气泡）+ kernel user 条
    // （journal/快照,重连后不缺席）。此前 front 注入只落 steps 链,GUI 全程无气泡（2026-10-25 用户报障）
    rt.harness.steerSource = () => {
      const lines = this.kernel.steerDrain();
      for (const text of lines) {
        this.kernel.submit(text); // journal user 条（kernel 事件只走落档面,不广播——帧在下）
        this.broadcastUserEcho(text);
      }
      return lines;
    };
    return rt;
  }

  /** user 回显纯帧广播（emitQueueFrame 同形,不经 kernel.pump——泵路回显曾致转录双气泡+journal
   *  双行,G14.2xx 实测;条目本体由 kernel.submit 写面承载,本帧只管 live 视图） */
  private broadcastUserEcho(text: string): void {
    const seq = this.opts.nextSeq();
    this.lastSeqNum = seq;
    const frame: EventFrame = {
      kind: 'event',
      sessionId: this.id,
      seq,
      e: { type: 'user', text, ts: Date.now() },
    };
    this.frames.push(frame);
    if (this.frames.length > EVENT_BUFFER_CAP) this.frames.shift();
    this.opts.broadcast(frame);
  }

  // ---- 挂起表（P6 §4 下沉）：注册/回执/回填/外窥,daemon 只做寻址与传输 ----

  /** acceptEdits 审批挂起（guard asker 注入位）：full-access 自动放行语义由 guard 前置（不到这里）,到这里的
   *  非 acceptEdits 视为拒绝兜底;ghost（run 已中止——interrupt/reset/delete 的 denyPending 回填发生在
   *  abort 时点,其后的迟到 asker 调用即幽灵）直接 deny 不入表不广播（G14.10） */
  private suspendApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.isAborted() || !this.isAcceptEdits()) return Promise.resolve('deny');
    return new Promise((resolve) => {
      const pid = this.opts.mintPid();
      this.pending.set(pid, { kind: 'approval', req, resolve });
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
      const frame: AskFrame = { kind: 'ask', sessionId: this.id, pid, req };
      this.opts.broadcast(frame);
    });
  }

  /** plan 审批挂起（阶段三 spec §5.1,planFlow awaitApproval 接缝的宿主实现）：挂起表注册 plan 卡→
   *  WS 广播 plan-approval 帧（payload {doc,items} 计划书全文+步骤清单）→ **卡登记+广播后**才放行
   *  submit 半径（onParked）——「表面可见」先于「idle 放行」,防放行窗口内的回执 404 竞窗;
   *  中止已置位的 ghost 窗直接拒绝回填不入表（suspendApproval 先例）。决策由 resolvePendingPlanApproval
   *  经回执路由回填驱动流程续跑（TUI planDecide 回填单点的表驱动同构——寻址键 pid 入挂起表,不再设
   *  planDecide 字段） */
  private awaitPlanApproval(doc: string, items: string[], onParked: () => void): Promise<PlanDecision> {
    return new Promise((resolve) => {
      if (this.planAbort?.signal.aborted) {
        resolve({ approved: false });
        onParked();
        return;
      }
      const pid = this.opts.mintPid();
      this.pending.set(pid, { kind: 'plan-approval', req: { doc, items }, resolve });
      const frame: PlanApprovalFrame = { kind: 'plan-approval', sessionId: this.id, pid, req: { doc, items } };
      this.opts.broadcast(frame);
      onParked(); // 裁决点放行 submit 半径：锁交还（idle 时刻合法是批准续段 setMode 的前置）
    });
  }

  /** plan 审批回执（kind 判别——plan 回执打到 approval/ask 挂起 = false→HTTP 404 面,反之亦然）：
   *  删表→resolve→notice 入转录三面（回执留痕,沿 approval/ask 既有形态） */
  resolvePendingPlanApproval(pid: string, decision: PlanDecision): boolean {
    const entry = this.pending.get(pid);
    if (entry === undefined || entry.kind !== 'plan-approval') return false;
    this.pending.delete(pid);
    entry.resolve(decision);
    this.pump({ type: 'notice', text: `plan-approval ${pid} resolved: ${decision.approved ? 'approved' : 'rejected'}`, ts: Date.now() });
    return true;
  }

  /** plan 挂起卡拒绝回填单点（中断/reset/teardown 路径;TUI approval.ts interrupt→confirmPlan(false)
   *  语义对齐）：删表→resolve({approved:false})——decide 回填后流程凭已置位的中止信号走
   *  aborted-interrupted 收尾,产物不注入、执行不启动（rider:awaitApproval 期间中止+approved 竞态边界） */
  private denyPlanPendings(): void {
    for (const [pid, entry] of this.pending) {
      if (entry.kind !== 'plan-approval') continue;
      this.pending.delete(pid);
      entry.resolve({ approved: false });
    }
  }

  /** 审批回执（kind 判别——approval 回执打到 ask 挂起 = false→HTTP 404）：删表→resolve→notice 入
   *  转录三面（G4 裁定 1 尾项：粗归档可见,不发明新事件型） */
  resolvePendingApproval(pid: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(pid);
    if (entry === undefined || entry.kind !== 'approval') return false;
    this.pending.delete(pid);
    entry.resolve(decision);
    this.pump({ type: 'notice', text: `approval ${pid} resolved: ${decision}`, ts: Date.now() });
    return true;
  }

  /** 问询回执（同上,ask 判别） */
  resolvePendingAsk(pid: string, answer: AskUserAnswer): boolean {
    const entry = this.pending.get(pid);
    if (entry === undefined || entry.kind !== 'ask') return false;
    this.pending.delete(pid);
    entry.resolve(answer);
    this.pump({ type: 'notice', text: `ask ${pid} answered`, ts: Date.now() });
    return true;
  }

  /** 全部未决回填（G4 裁定 3：interrupt/reset=deny 回填——TUI approval.ts 先例）：approval→deny、
   *  ask→dismissed、plan-approval→拒绝回填（流程凭中止信号走 aborted,产物不注入）并清表;
   *  不发 notice（中止路径的观察行由 run 自身事件面承载） */
  denyPending(): void {
    for (const entry of this.pending.values()) {
      if (entry.kind === 'approval') entry.resolve('deny');
      else if (entry.kind === 'ask') entry.resolve({ type: 'dismissed' });
      else entry.resolve({ approved: false });
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
    const file = path.join(resolveDataDir(this.root), 'sessions', `${id}.jsonl`);
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

  attachJournal(journal: SessionJournal): void {
    this.journal = journal;
    this.syncTasksLedger();
    this.hookJournalSink();
  }

  /** 后台任务账本收养（2026-10-24 回溯裁定+严重 bug 修复）：daemon 会话 sun-id 每次 newSession
   *  都新铸（journalId 才是稳定身份——GUI 打开会话=newSession+attach 两连）——账本路径不得在
   *  装配期按 sun-id 定死,须在 journal 挂上时按 journalId 收养（装载回放+后续追加切到该文件）。
   *  reset 换 Harness 后重收养（journal 仍在 SessionRuntime 身上）。幂等:重放对已在账条目零副作用 */
  private syncTasksLedger(): void {
    const journalId = this.journal?.currentId;
    if (journalId === undefined) return;
    this.runtimeImpl.harness.tasks.adoptLedger(
      path.join(resolveDataDir(this.opts.root), 'tasks', `ledger-${journalId}.jsonl`),
    );
  }

  /** journal 落盘订阅单点（单槽，后注册覆盖——attachJournal 重挂天然幂等不双写）：attach 与 reset 换新
   *  运行时后重挂共用；T2 出生 journal 惰性建档——首条 append 时 start() 落 header（空会话零文件，
   *  TUI SessionJournal 惰性先例同构） */
  private hookJournalSink(): void {
    this.runtimeImpl.harness.context.onContextChange((c) => {
      if (c.kind === 'append') {
        if (this.journal !== undefined && this.journal.currentId === undefined) this.journal.start(3); // v3 档:daemon 会话 header v=3(段级行词汇,P11-T2 零兼容)
        this.journal?.log({ t: 'chain', steps: c.steps });
      } else {
        this.journal?.log({ t: 'compact', chainFrom: c.chainFrom, compacted: c.compacted });
      }
    });
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
      const file = path.join(sessionsDir(resolveDataDir(this.root)), `${jid}.jsonl`);
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
  pump(e: SessionEvent): void {
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
    } else if (e.type === 'done' && typeof e.payload?.steps === 'number') {
      // G14.20 steps 语义统一:done 载荷 steps=reactor 会话累计步数(steps.length 含种子链)——
      // runmeta/旁车照抄该值(覆盖语义),与圆环/侧栏 meta 同一口径;链行增量口径废弃(少计)
      this.runDoneSteps = e.payload.steps;
      // G14.56:runSteps=本轮自身步数(reactor seedLen 后去重计)——GUI run 尾部「本轮」口径
      this.runRunSteps = typeof e.payload.runSteps === 'number' ? e.payload.runSteps : undefined;
    }
    if (e.type.startsWith('task-') || e.type.startsWith('gate-')) {
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

  /** 提交任务（每会话 run 串行，spec §7）：单 run 锁在先（409 拒二次提交），受理后 202 即回——run
   * 异步走主链入口 runTask（同 TUI /goal 路径），失败吞错转 stderr 日志行（daemon 不因单 run 失败
   * 倒面），finally 清锁。user 条入转录在锁检查之后——409 拒绝的提交不留痕。任务文本经链尾指令行
   * 进模型上下文（appendInstructionLine——TUI /goal 同构，tui/session.ts 先例：goal 自身只是观测
   * 标签，不进提示词）；该行同落出生 journal（chain 派生转录的 `> <goal>` user 条来源） */
  submit(goal: string): SessionSubmitResult {
    if (this.current) return { ok: false, status: 409, error: 'run in progress' };
    // plan flow 在途一律 409（终审修复 a：不论 armed——disarm 收口窗口/中断后 settle 前的提交也拒,
    // 沿既有文案口径。主路径防并发:planFlow 无内部串行化,放行即与续跑段竞写）
    if (this.planFlowRunning) return { ok: false, status: 409, error: 'plan flow in progress' };
    // plan-arm 提交通道（spec §5.1）：mode==='plan' 即 armed——armed 空闲提交经 planFlow 规划流程
    // （TUI /plan 同构:规划→确认卡→批准落档→逐项执行）;流程在途（含裁决点挂卡——idle+planFlowRunning）
    // 一律 409 不排队,裁决走挂起表回执端点。批准自动解除（续段 setMode 切走）/手动切档解除/拒绝保持。
    if (this.planArmed()) {
      this.runPlanArm(goal);
      return { ok: true };
    }
    const abort = new AbortController();
    // G14.2xx 立即停止:run 信号装入沙箱——interrupt 时在途 exec 子进程即刻收割(不再等步边界)
    this.runtimeImpl.harness.sandbox.setRunSignal(abort.signal);
    const startedAt = Date.now();
    // G14.100 本轮改动基线(run 前 git 变动集):收尾差集=本轮增量(runmeta.changes 供 GUI 汇总条)
    let runBaseChanges: ChangeFile[] = [];
    let runBaseKnown = false; // 基线不可得时收尾不报改动面——空基线差集会把存量文件全算本轮增量(误报)
    void listChanges(this.root).then((r) => {
      if (r.ok) { runBaseChanges = r.value.files; runBaseKnown = true; }
    }).catch(() => {}); // 旁路:基线探测失败不阻断 run 启动,收尾按 runBaseKnown 收窄
    this.runUsage = undefined;
    this.runCtxUsed = undefined;
    this.runDoneSteps = undefined;
    this.runRunSteps = undefined;
    this.kernel.submit(goal);
    this.runtimeImpl.harness.context.appendInstructionLine(goal);
    let runOutcome: import('../types').RunOutcome | undefined; // G14.89 finally 续发判停
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
        // G14.100 本轮改动差集(基线→现状):文件级增量进 runmeta(GUI 轮尾汇总条)
        let runChanges: ChangeFile[] = [];
        try {
          const now = await listChanges(this.root);
          if (now.ok && runBaseKnown) runChanges = diffChangeSets(runBaseChanges, now.value.files);
        } catch {
          // 差集失败不挡收尾(汇总条缺本轮数据可接受)
        }
        // G14.15 run 收尾元数据落 journal:GUI 回放恢复 Worked 行时长与步数/tokens 统计
        const endedTs = Date.now();
        const seconds = Math.max(1, Math.round((endedTs - startedAt) / 1000));
        this.journal?.log({
          t: 'runmeta',
          // G14.210 停止态入档:中断/失败收口(非 done)→GUI 回放运行条显「已停止」
          ...(outcome?.stopReason !== undefined && outcome.stopReason !== 'done' ? { stopped: true } : {}),
          seconds,
          ...(this.runDoneSteps !== undefined ? { steps: this.runDoneSteps } : {}),
          ...(this.runRunSteps !== undefined ? { runSteps: this.runRunSteps } : {}),
          tokens: outcome?.tokensUsed,
          ...(this.runUsage !== undefined ? { cacheTokens: this.runUsage.cache } : {}),
          endedTs,
          ...(runChanges.length > 0 ? { changes: runChanges } : {}),
        });
        // G14.100 runmeta 帧(实时轮汇总条数据源):journal 落档后广播,journal 不广播 GUI 无从感知
        this.pump({
          type: 'runmeta',
          ts: endedTs,
          payload: {
            seconds,
            ...(this.runDoneSteps !== undefined ? { steps: this.runDoneSteps } : {}),
            ...(this.runRunSteps !== undefined ? { runSteps: this.runRunSteps } : {}),
            tokens: outcome?.tokensUsed,
            ...(this.runUsage !== undefined ? { cacheTokens: this.runUsage.cache } : {}),
            endedTs,
            ...(runChanges.length > 0 ? { changes: runChanges } : {}),
          },
        });
        // G14.17 会话级旁车 meta 累积：runs/steps/tokens/秒数/缓存与 prompt 累计/末次上文占用/
        // 模型档位——列表与回溯面零重放直读（读旧值算累计,单 run 锁下无并发写面）
        const journalId = this.journal?.currentId;
        if (journalId !== undefined && outcome !== undefined) {
          const prev = readSessionMeta(resolveDataDir(this.root), journalId);
          const u = this.runUsage;
          const model = this.runtimeImpl.harness.model;
          writeSessionMeta(resolveDataDir(this.root), journalId, {
            updatedAt: endedTs,
            runs: (prev.runs ?? 0) + 1,
            ...(this.runDoneSteps !== undefined ? { steps: this.runDoneSteps } : {}), // 累计口径覆盖写
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
        // G14.2xx 立即停止:轮收束即摘 run 信号(在途 exec 收割只属本轮;下轮 submit 重装)
        this.runtimeImpl.harness.sandbox.setRunSignal(undefined);
        // G14.89 轮收束自动发下一轮:队列非空即取队首续跑(排队语义=等当前轮完成自动发);
        // interrupted(用户主动停)不续——停止即停,队列留存由用户决定;余下条目保序回队
        // (P5:取走/回队均走内核——steer 行落档+queue 帧广播随发)
        if (runOutcome?.stopReason !== 'interrupted') {
          const pending = this.kernel.steerTakePending();
          if (pending.length > 0) {
            for (const it of pending.slice(1)) this.kernel.steerEnqueue(it.text);
            // G14.89 user 回显帧:GUI 运行中入队不本地回显,气泡靠此帧。回显必须走纯帧广播
            // (不经 kernel.pump)——内部续发的 kernel.submit 自身会写 user 段,
            // 泵路回显曾致转录双气泡+journal 双行(G14.2xx 实测)
            this.broadcastUserEcho(pending[0]!.text);
            this.submit(pending[0]!.text);
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

  /** 中止当前 run：步边界/在途模型调用经 signal 即刻中止（reactor 既有语义），runTask 以
   *  stopReason=interrupted 收束后 finally 清锁。plan 流程在途（规划轮/裁决点挂卡/执行段）同为
   *  中断面：共用 abortPlanFlowAndSettle 单点（信号中止+挂卡拒绝回填+有界等收束,fire-and-forget——
   *  收尾可观测面由流程自身的 aborted 回执承载;settle 等待的强制的只在 reset/teardown/disarm） */
  interrupt(): SessionInterruptResult {
    if (!this.current && !this.planFlowRunning) return { ok: false, error: 'no run in progress' };
    this.current?.abort.abort();
    void this.abortPlanFlowAndSettle();
    return { ok: true };
  }

  // ---- plan-arm（阶段三 spec §5.1）：armed 提交的 planFlow 消费壳,接缝同构 TUI startPlanFlow ----

  /** arm 判定单点（spec §5.1）：mode==='plan' 即 armed——下条空闲 submit 经 planFlow。批准落
   *  acceptEdits 自动解除（setMode 切走）/手动切档解除/拒绝保持 armed;装配映射恒 acceptEdits
   *  （Task 3）,此处只管流程。 */
  private planArmed(): boolean {
    return this.currentMode === 'plan';
  }

  /** /plan 规划流程壳（spec §5.1;TUI startPlanFlow 同构,serve 侧裁决经挂起表回执路由驱动）：
   *  runPlanFlow 纯流程编排的宿主消费,IO 全走接缝。submit 半径只到用户裁决点：首轮规划在阶段一锁内
   *  跑到 awaiting-approval（或中断/超限/无产物终态）——卡登记+广播后放行锁（idle 时刻合法是批准续段
   *  setMode 的前置）;裁决后续段（批准=落 acceptEdits+逐项执行;拒绝=修订重入/超限收尾）脱离 submit
   *  半径,由 resolvePendingPlanApproval 的回执驱动后台续跑——「提交后停在确认卡」的公开语义不变。 */
  private runPlanArm(goal: string): void {
    this.planFlowRunning = true;
    const abort = new AbortController();
    this.planAbort = abort;
    // 用户目标回显（kernel.submit 单点：user 段入转录+WS 广播+journal 行;TUI /plan 输入回显同构）——
    // 目标自身不进链（TUI 同裁定：goal 只是观测标签,规划提示词经 fork seedHistory 承载）
    this.kernel.submit(goal);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let gated = false;
    const releaseGateOnce = (): void => {
      if (gated) return;
      gated = true;
      if (this.current?.abort === abort) this.current = undefined; // 裁决点/终态放行：idle 时刻合法（setMode 前置）
      this.runtimeImpl.harness.sandbox.setRunSignal(undefined);
      openGate();
    };
    // 阶段一锁（submit 半径）：受理即持锁（409 拒二次提交）+ run 信号装入沙箱（interrupt 在途 exec 即刻收割）
    this.runtimeImpl.harness.sandbox.setRunSignal(abort.signal);
    this.current = { abort, done: gate };
    let openFlow!: () => void;
    const flowSettled = new Promise<void>((resolve) => {
      openFlow = resolve;
    });
    this.planFlowSettled = flowSettled;
    // 前轮计划书宿主侧留存（TUI 同构 rider：驳回环重入,revising 轮拼进规划提示词前部——plan-flow 模块不动）
    let lastPlanDoc: string | undefined;
    let revising = false;
    void (async () => {
      try {
        const r = await runPlanFlow(goal, {
          // 中断信号沿规划任务透传（TUI runInternalTask 同构,第三参对齐接缝签名）
          runPlanningTask: (prompt, signal) => {
            const full = revising && lastPlanDoc
              ? `Previous plan document (rejected — revise it per the feedback below):\n${lastPlanDoc}\n\n${prompt}`
              : prompt;
            return this.runPlanningTask(full, signal);
          },
          enterReadOnly: () => this.runtimeImpl.harness.security.enterModeOverride('read-only'),
          exitReadOnly: () => this.runtimeImpl.harness.security.exitModeOverride(),
          todosSnapshot: () => this.todos.map((td) => ({ text: td.text, status: td.status })),
          chainAppendPlan: (doc) => {
            // 计划书入链（ChainAction 'plan',批准后一次）。'plan' 行**不进**推理轮半径——Task 8 移交
            // 裁定（TUI 已留注释：messages lastTaskIdx 只锚 'task'）,serve 侧同裁定同注释：执行段
            // 首步 runTask 经同链读到计划书,推理轮半径无需纳入。
            this.runtimeImpl.harness.context.appendChain([{ action: 'plan', observation: doc }]);
          },
          emit: (e) => {
            if (e.type === 'planning') return; // 运行态已由阶段一锁承载（status running）,无独立状态行
            if (e.type === 'awaiting-approval') {
              lastPlanDoc = e.doc; // 前轮计划书留存（revising 轮拼提示词用）
              revising = false;
              return; // 卡面=plan-approval 帧+挂起表快照（awaitApproval 接缝登记）,无独立状态行
            }
            if (e.type === 'revising') {
              revising = true;
              this.pump({ type: 'notice', text: `Revising plan with your feedback (round ${e.round}/${PLAN_MAX_ROUNDS})`, ts: Date.now() });
              return;
            }
            if (e.type === 'aborted') {
              // failed 臂如实措辞（终审修复,spec §7：规划失败不再谎报 interrupted,stopReason 透传入文）
              const why = e.reason === 'interrupted'
                ? 'Planning interrupted'
                : e.reason === 'exhausted'
                  ? 'Plan rejected 3 times — stopped, nothing executed'
                  : e.reason === 'empty'
                    ? 'Planning produced no steps — cancelled'
                    : `Planning failed: ${e.stopReason ?? 'unknown'}`;
              this.pump({ type: 'notice', text: why, ts: Date.now() });
              releaseGateOnce(); // 无裁决点路径（中断/超限/无产物）也放行 submit 半径
              return;
            }
            // approved：产物经返回值 r 承载,续段在下方 r 分支
            this.pump({ type: 'notice', text: `Plan approved — executing ${e.items.length} step(s)`, ts: Date.now() });
          },
          awaitApproval: (doc, items) => this.awaitPlanApproval(doc, items, releaseGateOnce),
          signal: abort.signal,
        });
        if (r) {
          // 批准续段（单点,TUI 同构：漂移探测 → 落 acceptEdits → 逐项执行）。链序保证：planFlow 已先
          // chainAppendPlan 再返回——计划书行严格先于本段的执行指令行入链
          const notices = this.runtimeImpl.harness.context.checkConstantsDrift();
          for (const n of notices) this.runtimeImpl.harness.context.appendChain([{ action: 'notice', observation: n }]);
          for (const n of notices) this.pump({ type: 'notice', text: n, ts: Date.now() });
          // 落 acceptEdits（spec §4.4/§5.1 绑定：真切换,arm 解除）。idle 时刻合法（锁已在裁决点放行;
          // busy 面 unreachable——planFlowRunning 挡新提交,流程外无并发 run 源）。重建 runtime 后新
          // guard 基档即 acceptEdits、asker 接线经装配单点自动就位（isAcceptEdits 判定）——serve 相对
          // TUI 的优势：TUI 需 setBaseMode 手动通道,serve 装配映射单点承接。
          // planFlowInternal 旁路：流程内切换不得自触 disarm 收口（abortPlanFlowAndSettle 会中止自己）;
          // busy 即中止流程（终审修复 c：防御纵深——旧形态忽略返回值,busy 也照跑执行段;即便 a/b 已封
          // 主路径,此处不再带病续跑）
          const ctx = this.runtimeImpl.harness.context;
          const carry = { chain: ctx.chainView(), chainFrom: ctx.chainFromView(), compacted: ctx.compactedView() };
          if ((await this.setMode('acceptEdits', { planFlowInternal: true })) === 'busy') {
            this.pump({ type: 'notice', text: 'Plan approved — execution cancelled (mode switch failed)', ts: Date.now() });
            return;
          }
          // setMode 换新运行时=换上下文链（reset 同路径）——批准续段必须站在含计划书的原链上执行：
          // 快照-换新-restoreSession 回种（daemon attach 同构;直注入不触发订阅,零双写）
          this.runtimeImpl.harness.context.restoreSession(carry);
          this.pump({ type: 'notice', text: 'Switched to workspace edit mode', ts: Date.now() });
          // 阶段二锁（执行段）：批准续段整段持锁（409 拒并发提交）+沙箱信号重装（换新后落新 runtime）
          this.runtimeImpl.harness.sandbox.setRunSignal(abort.signal);
          let openExec!: () => void;
          const execDone = new Promise<void>((resolve) => {
            openExec = resolve;
          });
          this.current = { abort, done: execDone };
          try {
            await this.runPlanItems(r.items);
          } finally {
            if (this.current?.abort === abort) this.current = undefined;
            this.runtimeImpl.harness.sandbox.setRunSignal(undefined);
            openExec();
          }
        }
        // aborted：三分支回执已在 emit 臂如实落地,此处零事务（防双份文案）
      } catch (e) {
        this.pump({ type: 'error', text: 'Planning failed: ' + (e instanceof Error ? e.message : String(e)), ts: Date.now() });
        releaseGateOnce(); // 防御：壳异常也放行 submit 半径
      } finally {
        this.planFlowRunning = false;
        this.planAbort = undefined;
        this.planFlowSettled = undefined;
        if (this.current?.abort === abort) this.current = undefined;
        releaseGateOnce(); // 防御：任何出口都放行 submit 半径
        openFlow();
      }
    })();
  }

  /** 规划轮任务（TUI runInternalTask 同构）：fork 隔离执行——提示词不进会话链（§11 边界登记）,终态零
   *  主链回写。第二参 signal：planFlow 接缝显式传递（与流程中断源同源,签名对齐 PlanFlowSeams） */
  private runPlanningTask(prompt: string, signal?: AbortSignal): Promise<RunOutcome> {
    const ctx = this.runtimeImpl.harness.context;
    const base = ctx.chainView();
    return this.runtimeImpl.runTask(PLAN_TASK_LABEL, {
      scope: 'fork',
      seedHistory: [...base, { step: (base.length > 0 ? base[base.length - 1].step : 0) + 1, action: 'task', observation: prompt }],
      ...(this.tier ? { tier: this.tier } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /** 逐项执行计划（批准续段;TUI runPlanItems 同构）：每步一个主链 run,完成即勾选 todo（宁停不误——
   *  单项失败/中断即停,剩余保持未完成）;进度经既有事件面（notice）广播。 */
  private async runPlanItems(items: string[]): Promise<void> {
    const abort = this.planAbort;
    const ctx = this.runtimeImpl.harness.context;
    this.setTodos(items.map((t): TodoItem => ({ text: t, status: 'pending' })));
    // 计划纪律走链（只增不改;§15 写链面英文单语,TUI 同一行文案）
    ctx.appendChain([{ action: 'note', observation: 'Plan discipline: each round completes only the last "Current instruction"; do not execute, anticipate, or reorder other tasks.' }]);
    for (let i = 0; i < items.length; i++) {
      // 中断检查在循环体首行（终审修复,与 TUI 同构）：「上一步完成后信号才落地」的竞窗下,被跳过
      // 步骤的指令行不再入链、待办不再误标 in_progress（旧形态先 append/标 in_progress 再查）
      if (abort?.signal.aborted) break; // 上一步被中断：不进下一 plan 步
      this.pump({ type: 'notice', text: `Step ${i + 1}/${items.length} — ${items[i]}`, ts: Date.now() });
      this.setTodos(this.todos.map((td) => (td.text === items[i] && td.status === 'pending' ? { ...td, status: 'in_progress' } : td)));
      ctx.appendInstructionLine(`Current instruction: ${items[i]}`);
      try {
        const r: RunOutcome = await this.runtimeImpl.runTask(items[i], {
          ...(this.tier ? { tier: this.tier } : {}),
          ...(this.effort ? { effort: this.effort } : {}),
          ...(abort ? { signal: abort.signal } : {}),
        });
        if (r.stopReason === 'interrupted') {
          this.pump({ type: 'notice', text: 'Task interrupted — completed steps kept on the chain', ts: Date.now() });
          break;
        }
        if (!r.done) {
          this.pump({ type: 'notice', text: `Step incomplete: ${items[i]}; remaining steps paused`, ts: Date.now() });
          break;
        }
        this.setTodos(this.todos.map((td) => (td.text === items[i] ? { ...td, status: 'completed' } : td)));
      } catch (e) {
        this.pump({ type: 'notice', text: `Step failed: ${items[i]} (${e instanceof Error ? e.message : String(e)}); remaining steps paused`, ts: Date.now() });
        break;
      }
    }
  }

  /** todo 清单唯一写点（装配 onTodos 收写与批准续段勾选共用;会话级字段,reset 换新清空） */
  private setTodos(items: TodoItem[]): void {
    this.todos = items;
  }

  /** 运行中穿插（G3 steer 平移）：队列态在内核(P5)——enqueue 不做运行态检查，运行中步边界
   *  drain 消费、空闲入队下一轮生效（排队语义即承诺，恒 200 由 HTTP 面承担）;steer 行落档与
   *  queue 帧广播经 onKernelEvent 单槽随发 */
  steer(text: string): void {
    this.kernel.steerEnqueue(text);
  }

  /**
   * 软重置（旧 /session/new 语义迁入 /session/:id/reset，spec §4.1）：等价 /new 但保留 sessionId——
   * 在跑 run 先中止（有界等待 settle，防僵尸 run 写入清空后的投影）→ 换新运行时（换 Harness 即换
   * 上下文链/沉淀管线/steering 队列，真 /new 等价）→ 旧运行时内脏收口（stopAll→drain→mcpClose）→
   * 影子/转录/补发缓冲清空。seq 不回拨（全局单调语义：重连客户端后续帧 seq 续接不重号）；attach 挂载
   * 的 journal 不 seal 不解挂（会话存活，续写同 journal——T2 语义）——落盘订阅随新运行时重挂。
   */
  async reset(): Promise<void> {
    await this.abortAndSettle(); // plan 流程在途同断面收口（信号中止+挂卡拒绝回填,见 abortAndSettle）
    const old = this.runtimeImpl;
    this.runtimeImpl = this.assemble();
    if (this.journal !== undefined) {
      this.hookJournalSink();
      this.syncTasksLedger();
    }
    await this.disposeRuntime(old);
    this.board = emptyBoard();
    this.delegations = [];
    this.todos = []; // 真 /new 等价：待办清单随换新清空（TUI 软重置同语义）
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

  /** 运行中模型切换（G10-C1b）：switchTo 单点;unknown id 幂等 false 不动现状。切换 daemon 级生效 */
  setModel(id: string | undefined): boolean {
    const sw = this.modelSwitcher;
    const okSwitch = sw === null ? false : sw.switchTo(id);
    if (okSwitch && id !== undefined) this.persistSelection({ model: id });
    return okSwitch;
  }

  /** 权限模式切换（G10-C1b）：idle-only（运行中 409 面归 daemon handler）;重建 runtime 与 reset 同路径,
   *  转录/影子投影独立字段不受损;换新 runtime 后重挂 journal 落盘订阅（hookJournalSink 单槽幂等）。
   *  plan 流程标记（阶段三 plan-arm）：setMode('plan') 即 armed——本方法即「手动切档解除」路径
   *  （切离 plan 档=disarm）;setMode('plan')/『/plan 命令』为武装位。回放语义（spec §5.2,跨重启不恢复
   *  arm）：本路径经 persistSelection 照写 mode:'plan' 落 meta 旁车,但 attach 回放只认现值三档
   *  （daemon.ts 装载序,'plan' 照写不照回）——armed 天然不跨重启,无需新增持久化;已批准的计划书随链
   *  （'plan' 行）回放。
   *  disarm 收口（终审修复 b）：plan 流程在途时切离 plan,卡挂起期锁已放行（idle）——旧形态只查 idle
   *  即实切,在途 planFlow 被孤儿化（用户点旧卡驱动续段与新任务并发跑;拒绝路径 revising 的 read-only
   *  覆盖还会拒掉用户任务的写操作）。现切离前先经 abortPlanFlowAndSettle 单点中止流程（信号+挂卡
   *  拒绝回填+有界等收束）再换新运行时;批准续段自身的落档切换走 planFlowInternal 旁路（流程内切换
   *  不得自中止）。异步化即为此等待;setMode('plan') 同档幂等早退,不触收口。 */
  async setMode(mode: SessionMode, opts?: { planFlowInternal?: boolean }): Promise<'ok' | 'busy'> {
    if (this.status() !== 'idle') return 'busy';
    if (mode === this.currentMode) return 'ok';
    if (this.planFlowRunning && !opts?.planFlowInternal) {
      await this.abortPlanFlowAndSettle();
      if (this.status() !== 'idle') return 'busy'; // 防御:收束窗口内有新 run 起跑则拒切（不换新运行时压 run）
    }
    this.currentMode = mode;
    this.runtimeImpl = this.assemble();
    if (this.journal !== undefined) this.hookJournalSink();
    this.persistSelection({ mode }); // G14.2xx 模式切换即刻落 meta(attach 回放)
    return 'ok';
  }

  /** G14.2xx 会话选择面持久化单点(model/effort/mode):即改即写 meta 旁车——公共持久化口径
   *  (CLAUDE.md §13),重启/重开 attach 时回放,不再回落装配缺省;journal 未附(无 id)跳过 */
  private persistSelection(patch: { model?: string; effort?: string; mode?: SessionMode }): void {
    const journalId = this.journal?.currentId;
    if (journalId === undefined) return;
    writeSessionMeta(resolveDataDir(this.root), journalId, patch);
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

  /** G14.95 技能命令清单(会话维,/session/:id/skill-commands 数据面):字符集合法+撞名内置词排除
   *  (TUI skillCommandIds 同口径),GUI 命令面板混入技能项 */
  skillCommands(): Array<{ id: string; description: string }> {
    const builtin = new Set(SLASH_COMMANDS.map((c) => c.slice(1)));
    return this.runtimeImpl.harness.skills
      .list()
      .filter((m) => /^[a-z0-9][a-z0-9_-]*$/.test(m.id) && !builtin.has(m.id))
      .map((m) => ({ id: m.id, description: m.description }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 排队插话(G10-C1d):内核队列快照(P5),seq=位置下标(每次变更重排,cancel 寻址键) */
  private queuedSteer(): Array<{ seq: number; text: string }> {
    return this.kernel.steerPendingItems().map(({ seq, text }) => ({ seq, text }));
  }

  /** 撤回排队插话(G10-C1d):按下标撤;越界 false */
  cancelSteer(seq: number): boolean {
    return this.kernel.steerRemoveAt(seq);
  }

  snapshotResponse(): SessionSnapshot {
    return {
      messages: this.kernel.replay(),
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
      archived: this.attachedJournalId !== undefined
        ? readSessionMeta(resolveDataDir(this.root), this.attachedJournalId).archived === true
        : false,
      team: this.runtimeImpl.harness.team.aliveNames().map((name) => ({
        name,
        busy: this.runtimeImpl.harness.team.get(name)?.isBusy() ?? false,
      })),
    };
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
   *  plan 流程在途同断面：abortPlanFlowAndSettle 单点先行（流程整体收束后再等 run settle——防
   *  reset 换新运行时与续跑段竞写） */
  async abortAndSettle(): Promise<void> {
    this.current?.abort.abort();
    await this.abortPlanFlowAndSettle();
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

  /** plan 流程在途中止单点（终审修复 b：镜像 abortAndSettle 形态收敛为一个内部操作）——
   *  planAbort.abort()（流程信号:规划轮在途调用/执行段逐项 run/挂卡期中止判定共用）+
   *  denyPlanPendings()（挂卡拒绝回填——decide 回填后流程凭已置位的中止信号走 aborted 收尾,
   *  产物不注入执行不启动）+ 有界等 planFlowSettled（≤2s;挂卡期 current 已放行,流程收束 promise
   *  是唯一等待锚——防调用方换新运行时与续跑段竞写）。interrupt（fire-and-forget）/abortAndSettle
   *  （reset/teardown 前置）/setMode 切离 plan（disarm）各路共用;流程不在途零事务幂等 */
  private async abortPlanFlowAndSettle(): Promise<void> {
    if (!this.planFlowRunning) return;
    this.planAbort?.abort();
    this.denyPlanPendings();
    const flowSettled = this.planFlowSettled;
    if (flowSettled === undefined) return;
    let settleTimer: NodeJS.Timeout | undefined;
    const bail = new Promise<void>((resolve) => {
      settleTimer = setTimeout(resolve, ABORTED_RUN_SETTLE_MS);
    });
    // race 面吞拒同 abortAndSettle：等「落定」不随其失败
    await Promise.race([flowSettled.catch(() => undefined), bail]);
    clearTimeout(settleTimer);
  }

  /** 收口步骤 3-5（当前运行时）：停全部后台任务（同 CLI D24：任务执行体先停、通道后关，stopAll 同步
   *  纯本地记账不抛）→ 排空后台沉淀管线（此时无新入队源，drain 即终态）→ MCP 连接收口（stdio 子进程
   *  防悬挂事件循环）→ journal seal（T2：write 影子快照清单以 snapshots 事件尾追，同 TUI sealJournal
   *  形态；空清单零事件——drain 后续 seal 幂等）。daemon close 的网络面先行序在此相与 abort 相之间切入 */
  async dispose(): Promise<void> {
    await this.disposeRuntime(this.runtimeImpl);
    this.journal?.seal(this.runtimeImpl.harness.writeSnapshot.drain());
  }

  /** 内脏收口单点（reset 的旧运行时换新后同序收口） */
  private async disposeRuntime(rt: KernelRuntime): Promise<void> {
    rt.harness.team?.stopAll();
    rt.harness.tasks.stopAll();
    await rt.harness.pipeline.drain();
    await rt.harness.mcpClose();
  }
}
