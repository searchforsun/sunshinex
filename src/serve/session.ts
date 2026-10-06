import { createRuntime } from '../tui/runtime';
import type { TuiRuntime } from '../tui/runtime';
import type { ModelAdapter } from '../model/adapter';
import type { SessionEvent } from '../types';
import { applyBoardEvent, emptyBoard } from '../taskboard/model';
import type { TaskBoardState } from '../taskboard/model';
import { applyDelegation } from '../delegation/projection';
import type { Delegation } from '../delegation/projection';
import { boardEventFrom } from '../tui/session';
import { TranscriptCollector } from './transcript';
import type { TranscriptEntry } from './transcript';

/**
 * 会话运行时（G3 会话中心 T1）：从 daemon 单会话态整体平移的每会话单元——按会话 root 独立装配
 * `createRuntime`（独立泵/影子投影/转录/run 票据），daemon 只持注册表与全局面（seq 计数/WS 连接）。
 * 装配零旁路：与 TUI 同一 `createRuntime` 单点（mode 恒 dontAsk：GUI v1 无终端交互面）。
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

/** GET /session/:id/snapshot 载荷（G2 Ruling 1 两轨分工的归档面快照） */
export interface SessionSnapshot {
  messages: TranscriptEntry[];
  board: TaskBoardState;
  delegations: Delegation[];
  status: 'idle' | 'running';
  lastSeq: number;
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
  /** 泵广播面：帧经 daemon WS 层序列化后发全部连接（连接层按 sessionId 分发/过滤，T3） */
  broadcast: (frame: EventFrame) => void;
}

export class SessionRuntime {
  readonly id: string;
  readonly root: string;
  private readonly opts: SessionRuntimeOpts;
  /** 会话运行时本体（reset 时整体换新——软重置等价 /new：换 Harness 即换上下文链/沉淀管线/steering） */
  private runtimeImpl: TuiRuntime;
  private current?: CurrentRun;
  /** 事件环形缓冲（补发窗口）：pump 单点写入，连接建立即逐会话补发；帧自带 seq+sessionId */
  private readonly frames: EventFrame[] = [];
  /** 本会话已泵最大 seq（snapshot.lastSeq 同源；全局计数器分配故单调） */
  private lastSeqNum = 0;
  /** 影子投影（G2 snapshot 套件）：board/delegation 与 TUI session 同源纯件从同一事件流推导 */
  private board: TaskBoardState = emptyBoard();
  private delegations: Delegation[] = [];
  /** 粗粒度转录（spec G2 Ruling 1）：pump 同源喂入，snapshot 的 messages 字段（reset 换新实例清空） */
  private transcriptImpl = new TranscriptCollector();

  constructor(opts: SessionRuntimeOpts) {
    this.opts = opts;
    this.id = opts.id;
    this.root = opts.root;
    this.runtimeImpl = this.assemble();
  }

  /** 装配单点：与 TUI 同一 createRuntime（mode 恒 dontAsk），onEvent 接本会话泵——reset 复用同点换新 */
  private assemble(): TuiRuntime {
    return createRuntime({
      root: this.opts.root,
      model: this.opts.model,
      mode: 'dontAsk',
      onEvent: (e) => this.pump(e),
    });
  }

  /** 运行时本体外窥（T2 attach 播种/T5 扩展消费；harness 公开面只在 teardown 消费） */
  get runtime(): TuiRuntime {
    return this.runtimeImpl;
  }

  /** 转录收集器外窥（T2 attach 的 msg 行播种位） */
  get transcript(): TranscriptCollector {
    return this.transcriptImpl;
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
    if (e.type.startsWith('task-') || e.type.startsWith('gate-')) this.board = applyBoardEvent(this.board, boardEventFrom(e));
    if (e.type.startsWith('delegation-')) this.delegations = applyDelegation(this.delegations, e);
    this.transcriptImpl.push(e);
    this.opts.broadcast(frame);
  }

  /** 运行态外窥：current 在场即 running */
  status(): 'idle' | 'running' {
    return this.current ? 'running' : 'idle';
  }

  /** 提交任务（每会话 run 串行，spec §7）：单 run 锁在先（409 拒二次提交），受理后 202 即回——run
   *  异步走主链入口 runTask（同 TUI /goal 路径），失败吞错转 stderr 日志行（daemon 不因单 run 失败
   *  倒面），finally 清锁。user 条入转录在锁检查之后——409 拒绝的提交不留痕 */
  submit(goal: string): SessionSubmitResult {
    if (this.current) return { ok: false, status: 409, error: 'run in progress' };
    const abort = new AbortController();
    this.transcriptImpl.submit(goal);
    const p: Promise<void> = this.runtimeImpl
      .runTask(goal, { signal: abort.signal })
      .catch((err) => {
        console.error('[serve] run failed:', err);
      })
      .then(() => undefined)
      .finally(() => {
        this.current = undefined;
      });
    this.current = { abort, done: p };
    return { ok: true };
  }

  /** 中止当前 run：步边界/在途模型调用经 signal 即刻中止（reactor 既有语义），runTask 以
   *  stopReason=interrupted 收束后 finally 清锁 */
  interrupt(): SessionInterruptResult {
    if (!this.current) return { ok: false, error: 'no run in progress' };
    this.current.abort.abort();
    return { ok: true };
  }

  /** 运行中穿插（G3 steer 平移）：SteeringChannel 纯内存 FIFO——enqueue 不做运行态检查，运行中步边界
   *  drain 消费、空闲入队下一轮生效（排队语义即承诺，恒 200 由 HTTP 面承担） */
  steer(text: string): void {
    this.runtimeImpl.harness.steering.enqueue(text);
  }

  /**
   * 软重置（旧 /session/new 语义迁入 /session/:id/reset，spec §4.1）：等价 /new 但保留 sessionId——
   * 在跑 run 先中止（有界等待 settle，防僵尸 run 写入清空后的投影）→ 换新运行时（换 Harness 即换
   * 上下文链/沉淀管线/steering 队列，真 /new 等价）→ 旧运行时内脏收口（stopAll→drain→mcpClose）→
   * 影子/转录/补发缓冲清空。seq 不回拨（全局单调语义：重连客户端后续帧 seq 续接不重号）；journal
   * seal 不在此面（会话存活，续写同 journal——T2 attach 后语义）
   */
  async reset(): Promise<void> {
    await this.abortAndSettle();
    const old = this.runtimeImpl;
    this.runtimeImpl = this.assemble();
    await this.disposeRuntime(old);
    this.board = emptyBoard();
    this.delegations = [];
    this.transcriptImpl = new TranscriptCollector();
    this.frames.length = 0;
  }

  /** 会话快照（G2 /snapshot 载荷单点平移；G3 增 lastSeq）：粗粒度转录 + board/delegations 影子投影 +
   *  运行态 + 事件序列水位——GUI 冷启动/刷新经一次拉取恢复全景，细粒度实时面仍走 WS 事件流（两轨
   *  分工，spec G2 Ruling 1）；lastSeq=本会话已泵最大 seq（与影子态同 tick 读取，pump 序内先影子后
   *  广播）——客户端以「重连后本会话首帧 seq > lastSeq ⇒ 无缺口」判重连补发完备（G4 消费） */
  snapshotResponse(): SessionSnapshot {
    return {
      messages: this.transcriptImpl.entries(),
      board: this.board,
      delegations: this.delegations,
      status: this.status(),
      lastSeq: this.lastSeqNum,
    };
  }

  /**
   * 会话收口（spec §7 收尾序，平移自 daemon 单会话 teardown）：abort 在跑 run → 有界等待其 settle
   *  收口（2s 上限）→ stopAll → drain → mcpClose（序同 CLI teardownCliRun 现场）。daemon close 序
   *  以分相形态（abortAndSettle/dispose）并入网络面先行关序，本方法为独立完整序。journal seal
   *  T2 接入（attach 落档后续写收口）
   */
  async teardown(): Promise<void> {
    await this.abortAndSettle();
    await this.dispose();
  }

  /** 收口步骤 0：在跑 run 即刻中止（T1 评审裁定：悬挂 run 的 promise 会拖住事件循环/测试收口；路径同
   *  /interrupt）→ 被中止 run 的 settle 钩子（沉淀入队）需收口后才进 drain——2000ms 有界防 signal
   *  无视的工具悬挂 teardown（终审裁定）；done 先胜即清残留 timer，不给事件循环留 2s 尾巴 */
  async abortAndSettle(): Promise<void> {
    this.current?.abort.abort();
    if (!this.current) return;
    const current = this.current;
    let settleTimer: NodeJS.Timeout | undefined;
    const bail = new Promise<void>((resolve) => {
      settleTimer = setTimeout(resolve, ABORTED_RUN_SETTLE_MS);
    });
    await Promise.race([current.done, bail]);
    clearTimeout(settleTimer);
  }

  /** 收口步骤 3-5（当前运行时）：停全部后台任务（同 CLI D24：任务执行体先停、通道后关，stopAll 同步
   *  纯本地记账不抛）→ 排空后台沉淀管线（此时无新入队源，drain 即终态）→ MCP 连接收口（stdio 子进程
   *  防悬挂事件循环）。daemon close 的网络面先行序在此相与 abort 相之间切入 */
  async dispose(): Promise<void> {
    await this.disposeRuntime(this.runtimeImpl);
  }

  /** 内脏收口单点（reset 的旧运行时换新后同序收口） */
  private async disposeRuntime(rt: TuiRuntime): Promise<void> {
    rt.harness.tasks.stopAll();
    await rt.harness.pipeline.drain();
    await rt.harness.mcpClose();
  }
}
