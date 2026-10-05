import type { AskUserAnswer, AskUserRequest, AskUserSeam } from '../types';
import { ApprovalDecision, ApprovalRequest, SessionEvent } from '../types';
import { t } from '../i18n';
import { formatContextBreakdown } from './format';
import { RunOutcome, TuiRuntime, createRuntime } from './runtime';
import type { ModelSwitcher } from '../model/catalog';
import { renderMd } from './md-ansi';
import { MdStream, appendLiveText, closeLiveBlock, sealLiveReply } from './md-stream';
import { onChildEvent, archiveChild, stopChild as stopChildPanel } from './child-panel';
import {
  suspendAskerFor,
  resolveApproval as resolveApprovalOn,
  askUser as askUserOn,
  resolveAskAnswer as resolveAskAnswerOn,
  requestPause as requestPauseOn,
  cancelPause as cancelPauseOn,
  hangPauseCard as hangPauseCardOn,
  interrupt as interruptNow,
  pushInterruptedNotice,
} from './approval';
import { toolCallLine } from './tool-verbs';
import { describeIncomplete } from './stop-reason';
import { ContextManager, chainToHistoryItems, runCompaction, contextBreakdown } from '../harness/context';
import { resolveRunWindow } from '../config/termination-config';
import { sunshineInitGoal } from '../harness/sunshine-init';
import { skillHeader } from '../harness/skills';
import * as fs from 'fs';
import * as path from 'path';
import { SessionJournal, newSessionId } from './session-journal';
import { resolveDataDir } from '../config/data-dir';
import { SLASH_COMMANDS } from './slash-commands';
import { resolveMemoryConfig, setMemorySessionOverride } from '../config/memory-config';
import { LiveTaskState, applyTaskState, initialTaskState } from './task-state';
import { readSkillUsage, recordSkillUsage } from './skill-usage';
import { configureWindowsTerminal, wtSettingsCandidates } from './terminal-setup';
import { memoryList, memoryAdd, memoryRm, memoryGc, kbIndex } from './commands-memory';
import { modelSwitch, modelTierSwitch, modelEffortSwitch } from './commands-model';
import { resumeFlow, branchFlow, resumeLatest as resumeLatestFrom } from './commands-session';
import { applyDelegation } from '../delegation/projection';
import { applyBoardEvent, emptyBoard } from '../taskboard/model';
import type { BoardEvent, TaskStatus } from '../taskboard/model';

// D17 拆分件（docs/TECH-DEBT-SURVEY.md H1 五步边界）：纯模型层迁 chat-model.ts、流式 md 通道迁 md-stream.ts、
// 命令族迁 commands-*.ts、子代理面板迁 child-panel.ts、挂起协调迁 approval.ts；session.ts 转发导出
// 保持既有导入面（组件与既有测试零改动是硬约束）
export {
  pairChildResults,
  formatTaskStatsLine,
  applyCtxWatermark,
  shouldPumpOnIdleBeat,
  PLAN_TASK_LABEL,
} from './chat-model';
export type {
  ChatRole,
  ChatItem,
  TodoItem,
  TodoStatus,
  SessionStatus,
  StatusMetrics,
  LiveBlock,
  ChildLine,
  ChildLiveState,
  TuiState,
  SessionOpts,
} from './chat-model';
import { PLAN_TASK_LABEL, applyCtxWatermark, formatTaskStatsLine, slashHelp, spawnBaseLabel, shouldPumpOnIdleBeat } from './chat-model';
import type { ChatItem, ChatRole, LiveBlock, TodoItem, TuiState } from './chat-model';
import type { SessionOpts } from './chat-model';

/** SessionEvent(task- 前缀与 gate- 前缀事件) → BoardEvent 翻译单点:与 TaskBoard.emit 载荷口径互为镜像(P1 子集:
 *  created/status/unlocked/blocked/gate 两态;conclusion 等富字段不进 UI 事件,投影无需) */
function boardEventFrom(e: SessionEvent): BoardEvent {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const taskId = String(p.taskId ?? '');
  const ts = e.ts;
  switch (e.type) {
    case 'task-created':
      return { t: 'task-created', taskId, title: String(p.title ?? ''), spec: String(p.spec ?? ''), dependsOn: Array.isArray(p.dependsOn) ? (p.dependsOn as string[]) : [], ts };
    case 'task-status-changed':
      return { t: 'status-changed', taskId, from: (p.from as TaskStatus) ?? 'pending', to: (p.status as TaskStatus) ?? 'pending', ts };
    case 'gate-waiting':
      return { t: 'gate-set', taskId, ts, ...(typeof p.note === 'string' ? { note: p.note } : {}) };
    case 'gate-resolved':
      return { t: 'gate-resolved', taskId, approved: p.approved === true, ts };
    default:
      return { t: 'status-changed', taskId, from: 'pending', to: 'pending', ts }; // task-unlocked/task-blocked:投影无状态变化,reducer 原引用返回
  }
}

/** 会话控制器：事件进 → 状态变更（渲染层订阅）；斜杠命令解析、FIFO 排队、审批挂起/回填；纯逻辑可独立单测 */
export class SessionController {
  readonly runtime: TuiRuntime;
  /** 项目根（公开 = 命令族/子代理拆分件消费：memory/kb-index 的库基准、归档统计等；与 runtime 装配同源） */
  readonly root: string;
  /** 流式 md 通道（D17 拆分件 md-stream，持有者 trait）：块缓冲/围栏/已推源/水位/规划轮归档抑制
   *  全部随通道实例走，控制器经协调函数（appendLive/closeLive/sealReply）与 this.md.* 消费；
   *  公开 = LiveCoordHost 结构化接缝（md-stream 消费，公开面新增不改语义） */
  readonly md: MdStream = new MdStream({
    mirrorTailStart: (tailStart) => {
      if (this.state.live?.kind === 'reply') this.state = { ...this.state, live: { ...this.state.live, tailStart } };
    },
    archiveAnsiFragment: (norm) => {
      this.pushMsg('assistant', norm, { ansi: true });
    },
    mdWidth: () => this.mdWidth(),
  });
  /** usage 整场基线：每个模型轮开始前同步为当前累计，事件按「基线 + 本轮 per-run 值」聚合（/plan 步骤间不重置窗口） */
  private usageBase = { tokens: 0, cache: 0, prompt: 0 };
  /** 会话状态单点（公开 = 拆分件 commands 族、child-panel、approval 经 ctrl 协调读写——公开面新增不改语义；
   *  渲染层维持 getState()/onState 只读消费） */
  state: TuiState = {
    messages: [],
    todos: [],
    status: 'idle',
    metrics: { turnStartedAt: 0, turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, sessionCacheTokens: 0, sessionPromptTokens: 0, sessionTurns: 0, sessionSteps: 0, runs: 0, ctxUsed: 0, turnChildTokens: 0, sessionChildTokens: 0, sessionTotalTokens: 0 },
    children: [],
    delegations: [],
    board: emptyBoard(),
    task: initialTaskState(),
  };
  private listeners = new Set<(s: TuiState) => void>();
  /** 消息全局单调序号（Static 区 key 唯一性来源）；/new 清空消息但不回绕——公开 = commands-session 恢复重放回填 nextSeq */
  msgSeq = 0;
  /** 会话事件日志（规格 2026-09-17-session-persistence D4 + 2026-09-22 事件级即时落盘）：持久化事件随产生落盘（惰性建档，空会话零文件）；
   *  公开 = commands-session 谱系命令读 currentId/attach 续挂，建档写点仍收敛在 ensureJournal/rotate */
  journal?: SessionJournal;
  /** 恢复携带的 UI 现场（--continue / /resume 重放产物；entry 经 takeRestoredUi 播种 retain，一次性取走）；
   *  公开 = commands-session 恢复三面注入点 */
  restoredUi?: { history: string[]; expandAll: boolean; latestFull: boolean };
  /** 子代理半行缓冲（label → 未成行）：token/reasoning 增量拼接、遇换行成行入 transcript；
   *  公开 = child-panel 拆分件消费（Map 实例不重绑，仅方法变更） */
  readonly childBufs = new Map<string, string>();
  /** 子代理委派提示词暂存（spawn tool-call 捕获 → 面板态创建时挂载 → 归档清理；规格 §4.2）；
   *  公开 = child-panel 拆分件消费 */
  readonly childPrompts = new Map<string, string>();
  /** spawn 调用关联栈（FIFO）：主链 spawn tool-call 压栈（行 seq + 关联基名）、tool-result 弹出归档（规格 §4.4 配对语义）；
   *  后台两段式结果先行 → wait 标记延迟归档（子代理 done 触发），wait 条目不阻塞后续前台配对；
   *  公开 = child-panel 拆分件消费（/new 整栈清空在本体重置） */
  spawnCalls: { seq: number; base: string; wait?: boolean; delegatedAt: number }[] = [];
  /** 运行中挂起的调用行（CC 模式延迟入档）：tool-call 挂起不进历史区（底部活动行唯一承载运行态），
   *  tool-result 回程时调用行+结果行成对定格入档；收尾未回程者补档不蒸发 */
  private pendingCalls: { callId?: string; text: string; input?: unknown; verb: string }[] = [];
  /** 挂起的审批裁决（manual 模式 suspendAsker 挂起）；公开 = 拆分件 approval 消费（挂起/回填/中断拒绝单点） */
  pendingApproval?: { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void };
  /** 空闲兜底节拍（规格 §3.5）：仅 idle 且后台队列非空时消费；unref 不阻塞进程退出 */
  private kickTimer?: ReturnType<typeof setInterval>;
  /** 挂起的计划确认卡（/plan 流程）；confirmPlan 裁决后清除——公开 = 拆分件 approval 中断放弃路径消费 */
  pendingPlan?: { items: string[] };
  /** 最近一次压缩事件时的 ctx 水位（自动压缩留痕 before → after 用；/compact 路径不消费） */
  private compactWatermark = 0;
  /** compact 事件序号（1-based）：一次压缩 = applyCompaction + trimChainFront 恰两条，留痕按序配对消歧 */
  private compactEventSeq = 0;
  /** 任务轮首 miss 提示判定（规格 D 观测小件）：每任务轮首重置；提示一次后不再重复 */
  private turnMissHinted = false;
  /** 裁决权注入（SessionOpts.asker）：挂起语义不变，回填后咨询并以其为最终裁决；公开 = 拆分件 approval 消费 */
  autoAsker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 会话内持久记忆开关（/memory on|off；undefined=随控制面）：写 setMemorySessionOverride 单点，仅本会话生效、不改盘，/new 清除；
   *  公开 = commands-memory 状态行读取 */
  memoryOverride?: boolean;
  /** 多源多模型切换器（/model 数据面）：不在场 = 未配置 providers，/model 给配置指引；
   *  公开 = commands-model/commands-session 消费（选择卡数据面与恢复重放复位） */
  readonly modelSwitcher?: ModelSwitcher;
  /** 当前任务中断源（Esc/Ctrl+C）：任务起点建、closeTask 清；interrupt() 置 aborted 贯通模型/loop/reactor——
   *  公开 = 拆分件 approval 中止消费（任务流起点建立仍在控制器） */
  taskAbort?: AbortController;

  /** 任务统计基线（规格 §3.2）：任务流起点建（与 turnTokens 归零同点）、closeTask done 路径算差值产出统计行 */
  private taskStats?: { startedAt: number; startSteps: number; startTokens: number; startChildTokens: number };
  /** 中断抑制位：pushInterruptedNotice 单点置位——中断路径不产出收尾统计行；公开 = 拆分件 approval 置位消费 */
  taskStatsSuppressed = false;

  /** 任务统计基线建立单点：任务流起点调用（同点 turnTokens 已归零，startTokens 即 0 起算主链增量） */
  private beginTaskStats(): void {
    this.taskStats = { startedAt: Date.now(), startSteps: this.state.metrics.sessionSteps, startTokens: this.state.metrics.turnTokens, startChildTokens: this.state.metrics.sessionChildTokens };
    this.taskStatsSuppressed = false;
  }

  /** AskQuestion 挂起态：问询管线挂起点与裁决回填口（AskQuestion 线 D5）；公开 = 拆分件 approval 消费 */
  pendingQuestion?: { req: AskUserRequest; resolve: (a: AskUserAnswer) => void };

  constructor(opts: SessionOpts) {
    this.root = opts.root;
    this.modelSwitcher = opts.models;
    this.mdColumns = opts.mdColumns; // J6 双源收敛：流式 md 宽度源注入（缺省回退 process.stdout.columns，既有口径）
    // 主模型装配单点：切换器在场即以其为主模型（/model 换内芯即时贯通 reactor/子代理/压缩）；
    // 否则回落单模型适配器（无 providers 配置的既有形态）
    const mainModel = opts.models ?? opts.model;
    this.runtime = opts.runtime ?? createRuntime({
      root: opts.root,
      ...(mainModel ? { model: mainModel } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.tier ? { tier: opts.tier } : {}),
      ...(opts.addDirs ? { addDirs: opts.addDirs } : {}),
      onEvent: (e) => this.onEvent(e),
      onAskUser: opts.onAskUser ?? ((req) => this.askUser(req)),
      onTodos: (items) => this.setTodos(items),
    });
    this.autoAsker = opts.asker;
    // 终端化审批闭包迁拆分件 approval（挂起语义不变：guard ask → 挂起 → 裁决回填 → 继续）
    if (opts.mode === 'manual') this.runtime.harness.security.setAsker(suspendAskerFor(this));
    this.state = { ...this.state, metrics: { ...this.state.metrics, runs: this.runtime.harness.ledger.summary().runs } };
    if (opts.tier) this.state = { ...this.state, tier: opts.tier };
    if (opts.effort) this.state = { ...this.state, effort: opts.effort };
    // 装配期已选模型（providers 配置且主模型未显式配置时缺省取首个）：状态栏段同步初值
    if (opts.models && opts.models.currentId() !== undefined) this.state = { ...this.state, modelId: opts.models.currentId(), modelLabel: opts.models.label, ...(opts.models.contextWindow !== undefined ? { modelWindow: opts.models.contextWindow } : {}) };
    // 空闲兜底节拍（规格 §3.5）：仅 idle 且后台队列非空时消费（无待办零调用零配额）；
    // 主触发是 closeTask 的 kick，本定时器只是兜底；unref 保证不阻塞进程退出
    this.kickTimer = setInterval(() => {
      const p = this.runtime.harness.pipeline;
      if (shouldPumpOnIdleBeat(this.state.status, this.pendingApproval !== undefined, p.pending(), this.pendingQuestion !== undefined)) void p.drain();
    }, resolveMemoryConfig().memoryIdleKickMs);
    this.kickTimer.unref?.();
    // 会话日志订阅（规格 §5 单一事实源）：链/压缩变更 → 事件缓冲；任务必经 submit 建档，此后事件动态路由到当前 journal 实例。
    // 未建档时事件丢弃（订阅常驻、可选链路由）；restoreSession 直注入不触发订阅（重放零击穿）。
    this.runtime.harness.context.onContextChange((c) => {
      if (c.kind === 'append') this.journal?.log({ t: 'chain', steps: c.steps });
      else {
        this.journal?.log({ t: 'compact', chainFrom: c.chainFrom, compacted: c.compacted });
        // 自动压缩消息流留痕（CC auto-compact 口径）：一次压缩 = applyCompaction + trimChainFront 两条 compact 事件，
        // 以事件序号配对（重放按序覆盖同款语义）——成对第一/第二条都不上屏，第三条起（新一轮压缩首个事件）上屏；
        // 消歧靠任务态：/compact 自带回执（handleSlash 分支），此处仅任务运行中（自动路径）补水位留痕
        this.compactEventSeq++;
        const isPairSecond = this.compactEventSeq % 2 === 0; // 一次压缩 = 恰两条事件；第二条=折链收口
        if (isPairSecond && this.state.status === 'running') {
          const before = this.compactWatermark;
          const after = this.state.metrics.ctxUsed;
          this.pushMsg('system', t(`Context compacted (ctx ${before} → ${after} tokens)`, `上下文已压缩（水位 ${before} → ${after} tokens）`));
          this.compactWatermark = after;
        }
      }
    });
    if (opts.resumePicker) void resumeFlow(this);
    if (opts.continueLast) this.resumeLatest();
  }

  getState(): TuiState {
    return this.state;
  }

  /** 会话链账本（测试与高级用法读取；常规写入经 runTaskFlow / runInternalTask） */
  get context(): ContextManager {
    return this.runtime.harness.context;
  }

  /** 订阅状态变更（渲染层入口）；返回退订函数 */
  onState(cb: (s: TuiState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** live 块读写单点（公开 = md-stream LiveCoordHost 接缝：流式协调函数经此读写 state.live，公开面新增不改语义） */
  get liveBlock(): LiveBlock | undefined {
    return this.state.live;
  }
  set liveBlock(live: LiveBlock | undefined) {
    this.state = { ...this.state, live };
  }

  /** 提交输入：斜杠命令即时处理；自然语言任务运行中提交进 FIFO 队列 */
  async submit(input: string): Promise<void> {
    const text = input.trim();
    if (!text) return;
    // 会话日志（规格 D4/D6）：user 事件=输入历史还原源，先于回显入志
    const j = this.ensureJournal();
    j.start();
    j.log({ t: 'user', text });
    // 用户输入回显上屏（含斜杠命令）：消息流完整呈现对话轮次（/plan <目标> 此前整行蒸发）；内部 goal 提示词仍不上屏
    this.pushMsg('user', text);
    if (text.startsWith('/')) {
      await this.handleSlash(text);
      return;
    }
    this.md.clear();
    if (this.state.status === 'running' || this.state.status === 'awaiting-approval' || this.state.status === 'awaiting-question') {
      // 运行中穿插（对标 CC queued messages，用户→运行时方向、非模型工具面）：入 steering 通道，
      // reactor 步边界 drain 同轮消费；未被消费的行由收口兜底 drainQueue 补跑
      this.runtime.harness.steering.enqueue(text);
      this.pushMsg('system', t(`Queued: ${text}`, `已排队：${text}`));
      return;
    }
    await this.runTaskFlow(text);
    await this.drainQueue();
  }

  /** 回填当前挂起审批（薄委托拆分件 approval）；无挂起时静默忽略 */
  async resolveApproval(d: ApprovalDecision): Promise<void> {
    await resolveApprovalOn(this, d);
  }

  /** AskQuestion 挂起管线（薄委托拆分件 approval；形态对标 suspendAsker——挂起前态记录、选择器接管、回填恢复） */
  askUser(req: AskUserRequest): Promise<AskUserAnswer> {
    return askUserOn(this, req);
  }

  /** 渲染层/测试裁决回填口（薄委托拆分件 approval）：无挂起时静默忽略（幂等） */
  resolveAskAnswer(a: AskUserAnswer): void {
    resolveAskAnswerOn(this, a);
  }

  /** 第一次 Ctrl+C（运行中）：挂起暂停确认卡（薄委托拆分件 approval）——status 保持 running、abort 不触发；
   *  已挂卡或非运行态返回 false（App 层据此回落既有分流） */
  requestPause(): boolean {
    return requestPauseOn(this);
  }

  /** 撤回暂停确认卡（Esc/n/继续项；薄委托拆分件 approval）：回运行现场，任务零影响 */
  cancelPause(): void {
    cancelPauseOn(this);
  }

  /** 子代理全屏视图挂卡（UI 面；薄委托拆分件 approval）：无 running 门槛——后台子代理跨回合存续，
   *  与 requestPause 同一张卡两种入口（App 分发层按按键所在视图分流） */
  hangPauseCard(): void {
    hangPauseCardOn(this);
  }

  /** 停单个子代理（UI 面；薄委托拆分件 child-panel，保持公开 API 不变——单停不连带中断主链，细节见拆分件） */
  stopChild(label: string): boolean {
    return stopChildPanel(this, label);
  }

  /** 用户中断（Esc/Ctrl+C，对标 Claude Code；薄委托拆分件 approval）：中止在途模型调用与后续步、
   *  待审批按拒绝、待确认计划放弃、排队任务一并丢弃。运行外状态 no-op（App 层据此分流退出/清输入）；
   *  返回是否实际发生中断 */
  interrupt(): boolean {
    return interruptNow(this);
  }

  /** 中断回执单点（迁拆分件 approval）：interrupted 终态由各任务流调用；warn 级（用户主动操作，非故障） */

  /** 等待会话回到 idle（队列清空且无挂起审批） */
  async waitIdle(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.state.status !== 'idle' || this.pendingApproval) {
      if (Date.now() > deadline) throw new Error(t('waitIdle timeout', 'waitIdle 超时'));
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** 计划确认卡裁决：true 逐项执行（待办同步勾选），false 放弃回 idle */
  async confirmPlan(yes: boolean): Promise<void> {
    const pending = this.pendingPlan;
    if (!pending) return;
    this.pendingPlan = undefined;
    if (!yes) {
      this.state = { ...this.state, status: 'idle', pauseConfirm: undefined }; // 同 closeTask 状态出口清卡（规划轮挂的卡可走到这）
      this.pushMsg('system', t('Plan discarded, back to input', '已放弃执行计划，回到输入态'));
      return;
    }
    // 确认项过期/冲突检测（规范 N1 动态改动尾追，对标 CC）：计划起草到确认之间磁盘会话常量可能已变化——
    // 执行前主动探测并把差异尾追进链（模型面）+ 回执（用户面），以最新为准；基线随探测前进，后续任务起点不重复告知
    const notices = this.runtime.harness.context.checkConstantsDrift();
    for (const n of notices) this.runtime.harness.context.appendChain([{ action: 'notice', observation: n }]);
    if (notices.length > 0) {
      this.pushMsg('system', t(
        `Session constants changed since the plan was drafted; the latest version applies:\n${notices.join('\n')}`,
        `计划起草后会话常量已变化，执行以最新为准：\n${notices.join('\n')}`,
      ), { level: 'warn' });
    }
    await this.runPlanItems(pending.items);
  }

  private async startPlanFlow(goal: string): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, turnChildTokens: 0, sessionTurns: this.state.metrics.sessionTurns + 1 },
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.beginTaskStats();
    this.turnMissHinted = false; // 新任务轮：轮首 miss 判定重置（观测小件）
    this.taskAbort = new AbortController();
    this.notify();
    let planText = '';
    this.md.planReplyNoArchive = true;
    try {
      // 规划段与执行段同链（H1）：经主链的 Loop 长任务模板。
      // 原实现是裸调 graph 角色节点——手工构造的 termination 无人读取（装饰性），
      // 且 loop → graph 会形成反向依赖；角色框定改为提示词级（依赖方向保持 graph → loop → harness）。
      // 规划段 fork 隔离：verbose 规划提示词与规划结论不进会话链（§11 边界登记——链只承载任务与执行轨迹），
      // 执行段（runPlanItems）才逐条指令行入链；角色框定保持提示词级（依赖方向 graph → loop → harness）
      const verbosePlanningPrompt = `${PLAN_TASK_LABEL} for the goal below, one step per line formatted "1. step"; output only step lines, no explanations, no code fences.\nGoal: ${goal}`;
      const r = await this.runInternalTask(verbosePlanningPrompt, PLAN_TASK_LABEL);
      if (!r.done) {
        // 用户中断（Esc/Ctrl+C）打断规划段：与主链任务同语义——中断回执+回 idle，不落 error 粘滞；
        // planReplyNoArchive 必须复位，否则中断后新任务的正文会被归档抑制位吞掉
        if (r.stopReason === 'interrupted') {
          this.md.planReplyNoArchive = false;
          pushInterruptedNotice(this);
          this.closeTask();
          return;
        }
        throw new Error(describeIncomplete(r.stopReason) || t('Planning incomplete', '规划未完成'));
      }
      planText = r.reply ?? '';
    } catch (e) {
      this.pushMsg('system', t('Planning failed: ', '规划失败：') + (e instanceof Error ? e.message : String(e)), { level: 'error' });
      this.closeTask();
      return;
    } finally {
      this.md.planReplyNoArchive = false;
    }
    const items = planText
      .split('\n')
      .map((l) => l.trim())
      .map((l) => l.replace(/^\d+[.、]\s*/, '').trim())
      .filter((l) => l.length > 0);
    if (items.length === 0) {
      this.pushMsg('system', t('No numbered steps produced (each line must be "1. xxx"), cancelled', '规划未产出编号步骤（每行需形如「1. xxx」），已取消'), { level: 'warn' });
      this.taskStats = undefined; // 失败路径不产出收尾统计行（规格 §3.2 边界）
      this.closeTask();
      return;
    }
    this.pendingPlan = { items };
    const card = [
      t('Plan confirmation (/plan)', '计划确认卡（/plan）'),
      ...items.map((item, i) => i + 1 + '. ' + item),
      t(items.length + ' items; confirm to execute step by step', '共 ' + items.length + ' 项，确认后逐项执行'),
    ].join('\n');
    this.pushMsg('system', card);
    this.state = { ...this.state, status: 'awaiting-plan' };
    this.notify();
  }

  /** 逐项执行计划：每项一个 run，完成即勾选待办（宁停不误：单项失败即暂停，剩余保持未完成） */
  private async runPlanItems(items: string[]): Promise<void> {
    this.taskAbort = new AbortController(); // plan 执行段整段一个中断源（Esc/Ctrl+C 中止当前步及后续步）
    this.state = { ...this.state, status: 'running' };
    this.setTodos(items.map((t) => ({ text: t, status: 'pending' as const })));
    this.notify();
    const ctx = this.runtime.harness.context;
    // 计划纪律走链（只增不改）：每轮只完成最后一条当前指令，不执行/预判/重排后续任务
    ctx.appendChain([{ action: 'note', observation: 'Plan discipline: each round completes only the last "Current instruction"; do not execute, anticipate, or reorder other tasks.' }]);
    for (let i = 0; i < items.length; i++) {
      this.pushMsg('step', `Step ${i + 1}/${items.length} — ${items[i]}`);
      this.state = {
        ...this.state,
        metrics: { ...this.state.metrics, turnStartedAt: Date.now() },
      };
      this.usageBase = { tokens: this.state.metrics.turnTokens, cache: this.state.metrics.turnCacheTokens, prompt: this.state.metrics.turnPromptTokens };
      this.notify();
      this.setTodos(this.state.todos.map((td) => (td.text === items[i] && td.status === 'pending' ? { ...td, status: 'in_progress' } : td)));
      ctx.appendInstructionLine(`Current instruction: ${items[i]}`);
      try {
        if (this.taskAbort?.signal.aborted) break; // 上一步被中断：不进下一 plan 步
        const r: RunOutcome = await this.runtime.runTask(items[i], {
          ...(this.state.tier ? { tier: this.state.tier } : {}),
          ...(this.state.effort ? { effort: this.state.effort } : {}),
          ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
        });
        if (r.stopReason === 'interrupted') { pushInterruptedNotice(this); break; }
        if (!r.done) {
          this.reportIncomplete(r, 'warn');
          this.pushMsg('system', t(`Step incomplete: ${items[i]}; remaining steps paused`, `步骤未完成：${items[i]}；剩余步骤暂停`), { level: 'warn' });
          break;
        }
        this.setTodos(this.state.todos.map((td) => (td.text === items[i] ? { ...td, status: 'completed' } : td)));
        // 步骤全量轨迹与结论行已由 reactor 会话作用域自动入链（fork 模型：不再只留结论行）
        // 步骤正文已随流式管线入档（markdansi 行级 ansi 条目 + finish 收口），此处不再重复上屏（Step 切换时上一阶段正文重复的根因）
      } catch (e) {
        this.pushMsg('system', t('Step failed: ' + items[i] + ' (' + (e instanceof Error ? e.message : String(e)) + '); remaining steps paused', '步骤失败：' + items[i] + '（' + (e instanceof Error ? e.message : String(e)) + '）；剩余步骤暂停'), { level: 'error' });
        break;
      }
    }
    this.closeTask();
  }

  /** 任务收束：回 idle 并停表（turnStartedAt=0，idle 态不再显示耗时）。本轮 tokens/缓存命中保留为上一轮统计（下次提交进 running 时重置）；error 态保留现场便于回看出错时刻 */
  // ===== 会话持久化（规格 docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md）=====

  /** 会话日志单点获取：首个持久化事件建档；未建档直接返回实例（start 前事件丢弃=空会话零文件）；
   *  公开 = commands-session 恢复三面续挂目标档消费 */
  ensureJournal(): SessionJournal {
    if (!this.journal) this.journal = new SessionJournal(resolveDataDir(this.root));
    return this.journal;
  }

  /** 快照型事件接线（规格 2026-09-22 D5）：变更点即时 log 的单点构造器，防四处拼装漂移；
   *  公开 = commands-model 三命令切换回执消费 */
  logModel(): void {
    this.journal?.log({ t: 'model', ...(this.state.tier ? { tier: this.state.tier } : {}), ...(this.state.effort ? { effort: this.state.effort } : {}), ...(this.state.modelId !== undefined ? { modelId: this.state.modelId } : {}) });
  }

  /** todo 清单唯一写点（规格 D6）：state 更新 + journal 即时落盘 + notify；模型工具/plan 引擎两条运行期路径共用。journal 重放为恢复路径，直接赋值不走此点（防重放自我回写） */
  private setTodos(items: TodoItem[]): void {
    this.state = { ...this.state, todos: items };
    this.logTodos();
    this.notify();
  }

  private logTodos(): void {
    this.journal?.log({ t: 'todos', items: this.state.todos });
  }

  /** 任务收口（规格 2026-09-22 D2/D8）：仅补拍本轮 write 影子快照清单（snapshots 事件）；其余事件已随产生落盘 */
  private sealJournal(): void {
    this.journal?.seal(this.runtime.harness.writeSnapshot.drain());
  }

  /** 视图两态变更记录（App 切换 Tab/Ctrl+O 调用；缓冲随收口落盘） */
  recordView(expandAll: boolean, latestFull: boolean): void {
    this.journal?.log({ t: 'view', expandAll, latestFull });
  }

  /** 恢复 UI 现场取用（entry 播种 retain 用；一次性） */
  takeRestoredUi(): { history: string[]; expandAll: boolean; latestFull: boolean } | undefined {
    const ui = this.restoredUi;
    this.restoredUi = undefined;
    return ui;
  }

  /** 输入框回填（/rewind //fork，规格 §7）：一次性取走，App 层 effect 消费；无回填时 no-op */
  takeBackfill(): string | undefined {
    const b = this.state.backfill;
    if (b !== undefined) {
      this.state = { ...this.state, backfill: undefined };
      this.notify();
    }
    return b;
  }

  /** --continue（规格 D1/D3）：续接最近会话（薄委托拆分件 commands-session；保持控制器公开 API 不变） */
  resumeLatest(): void {
    resumeLatestFrom(this);
  }

  /** 退出清理（规格 §3.5）：清空闲兜底节拍定时器——防长驻进程重挂/多实例测试下定时器累积（评审 Important-1）；幂等 */
  dispose(): void {
    if (this.kickTimer !== undefined) clearInterval(this.kickTimer);
    this.kickTimer = undefined;
    // MCP 连接收口：关闭 stdio 子进程防悬挂（fire-and-forget，退出路径零阻塞）
    void this.runtime.harness.mcpClose();
  }

  /** 未回程调用补入档单点（CC 模式延迟入档的兜底）：任务收尾/中断时挂起调用降级定格——
   *  调用行单独入档退出 pending（无结果行），产出不蒸发；正常回程路径不经此点 */
  private flushPendingCalls(): void {
    if (this.pendingCalls.length === 0) return;
    const flushed: ChatItem[] = this.pendingCalls.map((p) => ({
      role: 'tool', text: p.text, ts: Date.now(), seq: ++this.msgSeq,
      kind: 'call', pending: false, callId: p.callId,
    }));
    this.pendingCalls = [];
    this.appendMessages(flushed);
  }

  private closeTask(): void {
    if (this.state.status !== 'running' && this.state.status !== 'awaiting-plan') return;
    this.flushPendingCalls();
    this.taskAbort = undefined;
    // 任务收尾统计行（规格 2026-09-26-stats-enhancement §3.2）：done 正常完成路径产出（基线差值，含子代理合并口径）；中断经抑制位跳过；error 态不走 closeTask
    if (this.taskStats && !this.taskStatsSuppressed) {
      const ts = this.taskStats;
      const m = this.state.metrics;
      const mainTokens = Math.max(0, m.turnTokens - ts.startTokens);
      const childTokens = Math.max(0, m.sessionChildTokens - ts.startChildTokens);
      this.pushMsg('system', formatTaskStatsLine(Math.round((Date.now() - ts.startedAt) / 1000), m.sessionSteps - ts.startSteps, mainTokens + childTokens, childTokens));
    }
    this.taskStats = undefined;
    this.state = {
      ...this.state,
      status: 'idle',
      metrics: { ...this.state.metrics, turnStartedAt: 0 },
      // 暂停确认卡随状态出口清除（2026-10-02 状态卫生）：挂卡期任务自然收尾不清即残留——空闲态
      // Ctrl+C 被 App「第二次确认」分支吞掉成死键（interrupt() 非 active 不清卡即 return）
      pauseConfirm: undefined,
      // 生命周期清理（规格 §4.4）：已归档者本已离场；运行中子代理（后台两段式）跨回合保留，done 归档收口
      children: this.state.children.filter((c) => !c.done),
    };
    this.childBufs.clear();
    // 待归档锚点全保留（archiveChild 统一回队：栈中条目要么已配对消费、要么等 done 收口，无第三态）
    this.sealJournal(); // 快照清单补拍（事件级：其余事件已随产生落盘，规格 2026-09-22 D2/D8）
    this.runtime.harness.pipeline.kick(); // 回 idle 即踢一次后台消化（规格 §3.5）：队列非空才消费、无待办零调用
    this.notify();
  }

  /** 内部 verbose 任务（/init）：fork 隔离执行——提示词不进会话链（§11 边界登记），终态零主链回写 */
  private async runInternalTask(prompt: string, label: string): Promise<RunOutcome> {
    const ctx = this.runtime.harness.context;
    const base = ctx.chainView();
    return this.runtime.runTask(label, {
      scope: 'fork',
      seedHistory: [...base, { step: (base.length > 0 ? base[base.length - 1].step : 0) + 1, action: 'task', observation: prompt }],
      ...(this.state.tier ? { tier: this.state.tier } : {}),
      ...(this.state.effort ? { effort: this.state.effort } : {}),
      ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
    });
  }

  /** 未完成终止提示上屏（D10 收敛）：describeIncomplete 非空即以 system 消息推送；done/model-error 为空串天然跳过 */
  private reportIncomplete(r: RunOutcome, level?: 'warn'): void {
    const note = describeIncomplete(r.stopReason);
    if (note.length > 0) this.pushMsg('system', note, level ? { level } : undefined);
  }

  private async runTaskFlow(goal: string, opts?: { forkInstruction?: string }): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, turnChildTokens: 0, sessionTurns: this.state.metrics.sessionTurns + 1 },
      live: undefined,
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.beginTaskStats();
    this.turnMissHinted = false; // 新任务轮：轮首 miss 判定重置（观测小件）
    this.taskAbort = new AbortController();
    this.notify();
    // MCP 降级警告上屏（warn 级系统消息）：服务器失败只损失该服务器工具，任务不阻断
    for (const w of this.runtime.harness.mcpWarnings()) {
      this.pushMsg('system', t(`MCP warning: ${w}`, `MCP 警告：${w}`), { level: 'warn' });
    }
    try {
      const ctx = this.runtime.harness.context;
      if (opts?.forkInstruction) {
        // 内部 verbose 任务（/init 等）：fork 隔离——提示词经 fork 尾追承载、不进会话链（防污染对话流）
        const base = ctx.chainView();
        const r = await this.runtime.runTask(goal, {
          scope: 'fork',
          seedHistory: [...base, { step: (base.length > 0 ? base[base.length - 1].step : 0) + 1, action: 'task', observation: opts.forkInstruction }],
          ...(this.state.tier ? { tier: this.state.tier } : {}),
          ...(this.state.effort ? { effort: this.state.effort } : {}),
          ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
        });
        if (r.stopReason === 'interrupted') pushInterruptedNotice(this);
        this.reportIncomplete(r, 'warn');
        this.closeTask();
        return;
      }
      // 主链任务（§11 只增不改）：当前指令行尾追进链，reactor 会话作用域收束自动回写全量步骤与结论/补丁行
      ctx.appendInstructionLine(`Current instruction: ${goal}`);
      const r = await this.runtime.runTask(goal, {
        ...(this.state.tier ? { tier: this.state.tier } : {}),
        ...(this.state.effort ? { effort: this.state.effort } : {}),
        ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
      });
      if (r.stopReason === 'interrupted') pushInterruptedNotice(this);
      this.reportIncomplete(r, 'warn');
      this.closeTask();
    } catch (e) {
      this.pushMsg('system', t(`Error: ${e instanceof Error ? e.message : String(e)}`, `发生错误：${e instanceof Error ? e.message : String(e)}`), { level: 'error' });
      this.state = { ...this.state, status: 'error', pauseConfirm: undefined }; // 同 closeTask 状态出口清卡
      this.notify();
      return; // error 态保留计时现场（sticky），下次提交进 running 时重置
    }
  }

  /** /goal 完整修正环（规格 2026-09-15-tui-goal D2/D3 + 2026-09-16-goal-template D2/D5）：模板为内部装配机制，用户面零暴露；
   *  任务行入链带 /goal 标注 → runLoop（缺省标准环）→ 终态回执（status/iterations/criteria/tokens）→ closeTask。
   *  异常路径同 runTaskFlow 切 error 粘滞（保留现场）；已入链任务行不回滚（append-only，失败以链上轨迹为准） */
  private async runGoalFlow(goal: string): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, turnChildTokens: 0, sessionTurns: this.state.metrics.sessionTurns + 1 },
      live: undefined,
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.beginTaskStats();
    this.turnMissHinted = false; // 新任务轮：轮首 miss 判定重置（观测小件）
    this.taskAbort = new AbortController();
    this.notify();
    try {
      this.runtime.harness.context.appendInstructionLine(`Current instruction: ${goal} (/goal)`);
      this.pushMsg('system', t(`✻ /goal: ${goal}`, `✻ /goal：${goal}`));
      const r = await this.runtime.runLoop(goal, {
        ...(this.state.tier ? { tier: this.state.tier } : {}),
        ...(this.state.effort ? { effort: this.state.effort } : {}),
        ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
      });
      // interrupted 的用户回执由下方 incomplete 分支承载（引擎 error 已含中断文案），不重复发
      const lines = (r.criteria ?? []).map((c) => `  ${c.passed ? '✓' : '✗'} ${c.id} ${c.desc}`);
      if (r.status === 'done') {
        this.pushMsg('system', [
          t(
            `✻ /goal done: ${r.iterations} iteration(s) · ${r.tokensUsed} tokens`,
            `✻ /goal 完成：${r.iterations} 轮 · ${r.tokensUsed} tokens`,
          ),
          ...lines,
        ].join('\n'));
      } else {
        this.pushMsg('system', [
          t(
            `✻ /goal incomplete: ${r.status}${r.error ? ` — ${r.error}` : ''}`,
            `✻ /goal 未完成：${r.status}${r.error ? ` — ${r.error}` : ''}`,
          ),
          ...(r.status === 'paused'
            ? [t('Run /goal again to continue (the session chain keeps the context)', '重跑 /goal 可续走（会话链保留上下文）')]
            : []),
          ...lines,
          describeIncomplete(r.stopReason),
        ].filter((l) => l.length > 0).join('\n'));
      }
      this.closeTask();
    } catch (e) {
      this.pushMsg('system', t(`Error: ${e instanceof Error ? e.message : String(e)}`, `发生错误：${e instanceof Error ? e.message : String(e)}`), { level: 'error' });
      this.state = { ...this.state, status: 'error', pauseConfirm: undefined }; // 同 closeTask 状态出口清卡
      this.notify();
      return;
    }
  }

  /** 待投递穿插行数（TUI 队列展示/撤回判定用） */
  steeringPending(): number {
    return this.runtime.harness.steering.pending();
  }

  /** 撤回取回（对标 CC Up 键取回队列）：取走全部未投递穿插行（按入队序）；App 层回填输入框逐行编辑或清空丢弃 */
  takeBackQueued(): string[] {
    return this.runtime.harness.steering.takePending();
  }

  /** 运行中穿插收口兜底（对标 CC「turn 结束仍有排队→最旧者作下一轮」）：未被步边界消费的行按入队序补跑为新任务 */
  private async drainQueue(): Promise<void> {
    for (const line of this.runtime.harness.steering.takePending()) {
      await this.runTaskFlow(line);
    }
  }

  /** 斜杠命令分发面：命令只认裸形式（规格 D2），选择卡经 askUser 挂起回填 */
  private async handleSlash(text: string): Promise<void> {
    const cmd = text.split(/\s+/)[0] ?? text;
    // 命令只认裸形式（规格 D2）：一切带参枚举形态与不在清单的命令词统一无法识别；
    // 自由文本参数命令（目标/关注点/记忆内容/目录路径）不在枚举范围，带参放行
    const FREE_TEXT_ARGS = new Set(['/compact', '/plan', '/goal', '/memory-add', '/add-dir', '/kb-index']);
    // 技能命令（规格 2026-09-22-skill-as-command D4）：意图尾参为自由文本，与 FREE_TEXT_ARGS 同豁免；命中与否由尾部技能分发面裁决
    const isSkillCommand = this.skillCommandIds().includes(cmd.slice(1));
    if (!FREE_TEXT_ARGS.has(cmd) && !isSkillCommand && text !== cmd) {
      this.pushMsg('system', t('Unrecognized command. Use /help to see available commands', '无法识别命令，使用 /help 查看使用方法'), { level: 'warn' });
      return;
    }
    if (cmd === '/help') {
      this.pushMsg('system', slashHelp().join('\n'));
      return;
    }
    if (cmd === '/init') {
      // Claude Code /init 同款模型驱动：发起真实分析任务，模型自行 read/ls/grep 感知代码库并 write 生成/完善 SUNSHINE.md；
      // 写盘经安全链（manual 模式经 asker 审批），装载走 ContextLoader 每轮 assemble 从磁盘读取，写盘即对后续轮次生效
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /init unavailable now', '当前有任务进行中，暂不能执行 /init'), { level: 'warn' });
        return;
      }
      const p = path.join(this.root, 'SUNSHINE.md');
      const existed = fs.existsSync(p);
      // 提示词属内部实现不上屏，仅一行启动提示；分析过程经工具实时流可见；fork 隔离——verbose 提示词不进会话链
      this.pushMsg('system', existed ? t('/init: analyzing project, updating SUNSHINE.md…', '/init：分析项目，完善 SUNSHINE.md…') : t('/init: analyzing project, generating SUNSHINE.md…', '/init：分析项目，生成 SUNSHINE.md…'));
      await this.runTaskFlow(t('/init: analyze project and write SUNSHINE.md', '/init：分析项目并写入 SUNSHINE.md'), { forkInstruction: sunshineInitGoal(this.root, existed) });
      // 回执只按落盘事实（模型经安全链 write；任务中断时不虚报成功）
      const written = fs.existsSync(p);
      if (written) {
        // G 项刷新点：/init 是显式写盘者——重载快照使新内容立即可见（其余中途改盘仍冻结）
        this.runtime.harness.context.reloadContext();
        this.pushMsg('system', existed ? t('SUNSHINE.md written (updated); reloaded into session context', '已写入 SUNSHINE.md（完善）：已重载入会话上下文') : t('SUNSHINE.md written (created); loaded into session context', '已写入 SUNSHINE.md（新建）：已载入会话上下文'));
      } else {
        this.pushMsg('system', t('SUNSHINE.md not written: task incomplete, rerun /init', 'SUNSHINE.md 未生成：任务未完成，可重新执行 /init'), { level: 'warn' });
      }
      return;
    }
    if (cmd === '/status') {
      const s = this.runtime.harness.ledger.summary();
      this.pushMsg('system', t(`Ledger: ${s.runs} runs / ${s.tokens} tokens; messages: ${this.state.messages.length}; todos: ${this.state.todos.length}`, `账本：${s.runs} runs / ${s.tokens} tokens；消息 ${this.state.messages.length} 条；待办 ${this.state.todos.length} 项`));
      return;
    }
    if (cmd === '/terminal-setup') {
      // Shift+Enter 换行键的终端侧一次性配置（CC /terminal-setup 同款自动化）：终端缺省 Shift+Enter
      // 与 Enter 同发 \r 不可区分，运行时只认 \x1b\r——此处把 WT 键位写好（绑定 + Alt+Enter 解绑）
      const existing = wtSettingsCandidates().filter((p) => fs.existsSync(p));
      if (existing.length === 0) {
        this.pushMsg('system', t(
          'Windows Terminal settings.json not found. VSCode: keybindings.json add {"key":"shift+enter","command":"workbench.action.terminal.sendSequence","when":"terminalFocus","args":{"text":"\\u001b\\r"}}',
          '未找到 Windows Terminal settings.json。VSCode：keybindings.json 加 {"key":"shift+enter","command":"workbench.action.terminal.sendSequence","when":"terminalFocus","args":{"text":"\\u001b\\r"}}',
        ), { level: 'warn' });
        return;
      }
      const lines: string[] = [t('Terminal setup (Shift+Enter newline):', '终端设置（Shift+Enter 换行）：')];
      for (const p of existing) {
        const r = configureWindowsTerminal(p);
        if (!r.ok) lines.push(t(`✗ ${p}: ${r.message}`, `✗ ${p}：${r.message}`));
        else if (r.changed) lines.push(t(`✓ ${p}\n  backup: ${r.backup}\n  restart Windows Terminal to take effect`, `✓ ${p}\n  备份：${r.backup}\n  重启 Windows Terminal 后生效`));
        else lines.push(t(`✓ ${p}: already configured`, `✓ ${p}：已配置，无需改动`));
      }
      this.pushMsg('system', lines.join('\n'));
      return;
    }
    if (cmd === '/add-dir') {
      const arg = text.slice(cmd.length).trim();
      if (arg === '') {
        this.pushMsg('system', t('/add-dir requires a directory path', '/add-dir 需要目录路径'), { level: 'error' });
        return;
      }
      const r = this.runtime.harness.addAdditionalDir(arg);
      this.pushMsg('system', r.ok
        ? t(`trusted directory added: ${r.message}`, `信任目录已添加：${r.message}`)
        : t(`failed to add directory: ${r.message}`, `信任目录添加失败：${r.message}`), r.ok ? undefined : { level: 'error' });
      return;
    }
    if (cmd === '/tasks') {
      // 后台任务表（规格 D7，对标 CC /tasks）：id/kind/status/label + 输出路径；模型可 read 查看输出、task_wait 等待到终态、task_stop 停止
      const list = this.runtime.harness.tasks.list();
      if (list.length === 0) {
        this.pushMsg('system', t('No background tasks.', '暂无后台任务。'));
        return;
      }
      const rows = list.map((x) => `${x.id}\t${x.kind}\t${x.status}\t${x.label}\t(output: ${x.outputFilePath})`);
      this.pushMsg('system', t(
        `Background tasks:\n${rows.join('\n')}\nInspect output with read; wait for completion with the task_wait tool; stop with the task_stop tool.`,
        `后台任务：\n${rows.join('\n')}\n输出可用 read 查看；可用 task_wait 工具等待到终态；可用 task_stop 工具停止。`,
      ));
      return;
    }
    if (cmd === '/skill') {
      // 技能选择卡（规格 D1/D5）：裸形式、单选选定即链尾追加载；带参形态由裸形式守卫统一无法识别
      await this.skillFlow();
      return;
    }
    if (cmd === '/new') {
      // /new 轮转化（规格 D2）：旧会话收口归档 → 换新 sessionId（header 立即落盘、指针随即改指新会话）→ 软重置；旧档 /resume 可找回
      this.journal?.rotate(newSessionId());
      this.runtime.harness.security.clearSessionAllows();
      this.memoryOverride = undefined;
      setMemorySessionOverride(undefined); // /new = 新会话起点：会话内覆盖清除（快照重读随刷新点对齐磁盘与控制面）
      this.taskStats = undefined; // 新会话起点：任务统计基线一并清除
      this.md.clear();
      this.state = {
        messages: [],
        todos: [],
        status: 'idle',
        metrics: {
          turnStartedAt: 0,
          turnTokens: 0,
          turnCacheTokens: 0,
          turnPromptTokens: 0,
          ctxUsed: 0,
          runs: this.state.metrics.runs,
          sessionCacheTokens: 0,
          sessionPromptTokens: 0,
          sessionTurns: 0,
          sessionSteps: 0,
          turnChildTokens: 0,
          sessionChildTokens: 0,
          sessionTotalTokens: 0,
        },
        children: [],
        delegations: [],
        board: emptyBoard(),
        task: initialTaskState(),
        ...(this.state.tier ? { tier: this.state.tier } : {}),
        ...(this.state.modelId !== undefined ? { modelId: this.state.modelId, modelLabel: this.state.modelLabel, modelWindow: this.state.modelWindow } : {}),
        live: undefined,
      };
      this.childBufs.clear();
      this.childPrompts.clear();
      this.spawnCalls = [];
      this.pendingCalls = [];
      this.runtime.harness.context.resetSession();
      this.pushMsg('system', t('Soft reset: messages, todos, session chain and compacted summary cleared; session approvals cleared (memory & ledger kept)', '软重置：消息、待办、会话链与压缩摘要已清空，会话级审批登记已清除（记忆与账本保留）'));
      return;
    }
    if (cmd === '/model') {
      // 多源多模型切换（settings providers 键）：选择卡即选即切，对后续任务生效（整场恒定，CLAUDE.md §11 重算事件口径）
      // ——函数体迁拆分件 commands-model，骨架只留分发
      await modelSwitch(this);
      return;
    }
    if (cmd === '/model-tier') {
      // 用户级档位切换（small/medium/large 选择卡），对后续任务生效——细节见拆分件 commands-model
      await modelTierSwitch(this);
      return;
    }
    if (cmd === '/model-effort') {
      // 思考强度切换（含 default 清除回适配器缺省；回执回显探测降级后实际生效档——细节见拆分件）
      await modelEffortSwitch(this);
      return;
    }
    if (cmd === '/resume') {
      // 恢复入口（规格 §6/D6）：无参选择卡（mtime 降序 + 首条输入摘要）；>8 条 filterable 全量卡（筛选在渲染层）；翻页统一渲染层滑窗（2026-09-30 口径）
      // 带参形态已由裸形式守卫统一无法识别——此处只认无参；流程体迁拆分件 commands-session
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /resume unavailable now', '当前有任务进行中，暂不能执行 /resume'), { level: 'warn' });
        return;
      }
      await resumeFlow(this);
      return;
    }
    if (cmd === '/rewind' || cmd === '/fork') {
      // 会话回退/分叉（rewind/fork 规格 §7）：idle 守卫沿 /resume 先例，运行中拒绝——流程体迁拆分件 commands-session
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; ' + cmd + ' unavailable now', '当前有任务进行中，暂不能执行 ' + cmd), { level: 'warn' });
        return;
      }
      await branchFlow(this, cmd === '/rewind' ? 'rewind' : 'fork');
      return;
    }
    if (cmd === '/compact') {
      // 压缩协调单点（与 Reactor 自动压缩同链路，规格 D5）：补链参与（chainView 转 history 条目）→ 压缩 → 摘要（会话模型，失败回退）→ 折链
      const ctx = this.runtime.harness.context;
      const chainItems = chainToHistoryItems(ctx.chainView());
      const items = ctx.assemble(chainItems);
      const before = ctx.window.estimate(items).used;
      const focus = text.trim().split(/\s+/).slice(1).join(' ').trim();
      const r = await runCompaction(ctx, items, {
        summaryTokenBudget: 2000,
        rereadTokenBudget: 2000,
        chainFoldedCount: chainItems.length,
        summaryModel: this.runtime.harness.model,
        ...(focus.length > 0 ? { focus } : {}),
      });
      const after = ctx.window.estimate(ctx.assemble()).used;
      this.state = { ...this.state, metrics: { ...this.state.metrics, ctxUsed: after } };
      this.pushMsg('system', t(`Compressed: ${r.chunks.length} summary chunks re-injected (ctx ${before} → ${after} tokens)`, `已压缩：${r.chunks.length} 个摘要块重注入（水位 ${before} → ${after} tokens）`));
      return;
    }
    if (cmd === '/context') {
      // 上下文构成观测（只读零副作用）：分段与 buildMessages 消息面同构（稳定段+快照三段+压缩块+链+技能块），
      // 窗口分母与 Reactor 压缩判定同源；技能块走 peek 不消费、不经 assemble、不写链——观测不改变被观测面
      const ctx = this.runtime.harness.context;
      const parts = ctx.snapshotPartsView();
      const b = contextBreakdown({
        stableSegment: this.runtime.harness.reactor.stableSegment(),
        instructions: parts.instructions,
        skills: parts.skills,
        memory: parts.memory,
        compacted: ctx.compactedView(),
        chain: ctx.chainView(),
        skill: ctx.peekSkill(),
        window: resolveRunWindow(this.runtime.harness.model),
        chainFrom: ctx.chainFromView(),
      });
      this.pushMsg('system', formatContextBreakdown(b));
      return;
    }
    if (cmd === '/plan') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; planning unavailable now', '当前有任务进行中，暂不能开始规划'), { level: 'warn' });
        return;
      }
      const goal = text.slice(cmd.length).trim();
      if (!goal) {
        this.pushMsg('system', t('Usage: /plan <goal> — plan numbered steps first, confirm, then execute step by step', '用法：/plan <目标>——先规划产出编号步骤，确认后逐项执行'), { level: 'warn' });
        return;
      }
      await this.startPlanFlow(goal);
      return;
    }
    if (cmd === '/goal') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /goal unavailable now', '当前有任务进行中，暂不能执行 /goal'), { level: 'warn' });
        return;
      }
      // 模板为内部装配机制（规格 2026-09-16-goal-template D1/D5）：/goal 后一切即目标文本，恒走缺省标准环
      const goal = text.slice(cmd.length).trim();
      if (!goal) {
        this.pushMsg('system', t(
          'Usage: /goal <goal> — runs the verify-fix loop until your condition is met; state the goal as one measurable end state (e.g. /goal all tests in src/auth pass), or embed multiple criteria inline (验收标准：t1=…)',
          '用法：/goal <目标>——运行验收修正环，直至目标条件满足；目标用一句可度量的终态描述（如 /goal src/auth 测试全绿），复杂目标可内嵌多判据（验收标准：t1=…）',
        ), { level: 'warn' });
        return;
      }
      await this.runGoalFlow(goal);
      return;
    }
    if (cmd === '/memory') return memoryList(this);
    if (cmd === '/memory-add') return memoryAdd(this, text.slice(cmd.length).trim());
    if (cmd === '/memory-rm') return memoryRm(this);
    if (cmd === '/memory-gc') return memoryGc(this);
    if (cmd === '/kb-index') return kbIndex(this, text.slice(cmd.length).trim());
    if (cmd === '/memory-on' || cmd === '/memory-off') {
      const on = cmd === '/memory-on';
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t(`A task is running; ${cmd} unavailable now`, `当前有任务进行中，暂不能执行 ${cmd}`), { level: 'warn' });
        return;
      }
      this.memoryOverride = on;
      setMemorySessionOverride(on); // 会话内覆盖单点：提取/注入/写闸门逐次判门读取（§7 控制面）
      this.pushMsg('system', t(`Persistent memory ${on ? 'on' : 'off'} for this session (persist with the SUNSHINEX_AUTO_MEMORY env var)`, `本会话持久记忆已${on ? '开启' : '关闭'}（持久化请设环境变量 SUNSHINEX_AUTO_MEMORY）`));
      return;
    }
    // 技能命令分发（规格 2026-09-22-skill-as-command D2–D5）：内置命令全部落空后查注册表（内置优先 D1——撞名技能不注册，此处天然不可达）
    if (this.skillCommandIds().includes(cmd.slice(1))) {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t(`A task is running; ${cmd} unavailable now`, `当前有任务进行中，暂不能执行 ${cmd}`), { level: 'warn' });
        return;
      }
      const loaded = this.loadSkill(cmd.slice(1));
      const intent = text.slice(cmd.length).trim();
      // D4：确定性加载成功后意图原样派发标准环（与 /goal 同款解析）；裸形式无意图止于加载（D3）；failed 不派发
      if (loaded !== 'failed' && intent) await this.runTaskFlow(intent);
      return;
    }
    this.pushMsg('system', t('Unrecognized command. Use /help to see available commands', '无法识别命令，使用 /help 查看使用方法'), { level: 'warn' });
  }

  /** 技能命令注册表（规格 2026-09-22-skill-as-command D6 单点）：list() 现读磁盘（学习沉淀即时可见）；
   *  按 D2 字符集过滤、D1 内置词排除（内置优先——撞名技能不注册，仅可经 /skill 卡加载），id 字典序 */
  skillCommandIds(): string[] {
    return this.skillManifestsForCommands().map((m) => m.id).sort();
  }

  /** 命令面技能清单共用过滤（D1/D2 单点）：字符集合法 + 撞名内置词排除；skillCommandIds 与
   *  skillMenuEntries 同源消费，防两清单漂移 */
  private skillManifestsForCommands() {
    const builtin = new Set(SLASH_COMMANDS.map((c) => c.slice(1)));
    return this.runtime.harness.skills.list().filter((m) => /^[a-z0-9][a-z0-9_-]*$/.test(m.id) && !builtin.has(m.id));
  }

  /** 纵向命令面板技能源（2026-09-30 对标 CC）：清单口径与 skillCommandIds 同源，附 name/description
   *  与最近使用时间——最近使用在前（用户裁决「skills 默认显示最近常用的」）、平局回落数字典序；
   *  调用方（App）挂载 + 回合边界刷新，不逐键读盘 */
  skillMenuEntries(): { id: string; name: string; description: string; lastUsedAt?: number }[] {
    const usage = readSkillUsage(this.root);
    return this.skillManifestsForCommands()
      .map((m) => ({ id: m.id, name: m.name, description: m.description, lastUsedAt: usage[m.id] }))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 技能加载单点（规格 D3，自 skillFlow 尾段提取）：链上去重 → resolve → 链尾追持久注入 → 回执；
   *  /skill 选择卡与 /<技能id> 命令同源消费；failed 不派发后续任务（D4）；
   *  成功/去重两径记录最近使用（2026-09-30 纵向命令面板排序源），failed 不记 */
  private loadSkill(id: string): 'loaded' | 'already' | 'failed' {
    if (this.runtime.harness.context.chainView().some((s) => s.action === 'skill' && s.observation.includes(`(id=${id} v=`))) {
      this.pushMsg('system', t(`Skill ${id} already loaded in this session`, `技能 ${id} 本会话已加载`));
      recordSkillUsage(this.root, id);
      return 'already';
    }
    const r = this.runtime.harness.skills.resolve(id);
    if (!r.ok) {
      this.pushMsg('system', t(`Skill load failed: ${r.error.message}`, `技能加载失败：${r.error.message}`), { level: 'warn' });
      return 'failed';
    }
    const m = r.value.manifest;
    // 链尾追持久注入（先例 D2）：头行对齐 loop skillRef 既有格式，正文随后续每帧经链携带
    this.runtime.harness.context.appendChain([{ action: 'skill', observation: `${skillHeader(m)}\n\n${r.value.body}` }]);
    this.pushMsg('system', t(`Skill loaded: ${m.name} (id=${m.id}) — included in context for subsequent tasks`, `技能已加载：${m.name}（id=${m.id}）——随后续任务进上下文`));
    recordSkillUsage(this.root, id);
    return 'loaded';
  }

  /** /skill 技能选择卡（规格 D1–D5）：单选选定即加载；正文经链尾追持久注入（与模型 skill 工具观察同语义），
   *  链上同 id 去重；>8 项 filterable（筛选在渲染层，会话层全量直出） */
  private async skillFlow(): Promise<void> {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /skill unavailable now', '当前有任务进行中，暂不能执行 /skill'), { level: 'warn' });
      return;
    }
    const manifests = [...this.runtime.harness.skills.list()].sort((a, b) =>
      a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1,
    );
    if (manifests.length === 0) {
      this.pushMsg('system', t('No skills available — add .sunshinex/skills/<id>/SKILL.md', '暂无可用技能——放置 SKILL.md 到 .sunshinex/skills/<id>/ 目录'), { level: 'warn' });
      return;
    }
    const labelToId = new Map<string, string>();
    const options = manifests.map((m) => {
      const label = labelToId.has(m.name) ? `${m.name} (${m.id})` : m.name;
      labelToId.set(label, m.id);
      return { label, description: m.description.length > 128 ? `${m.description.slice(0, 128)}…` : m.description };
    });
    const answer = await this.askUser({
      question: t('Load which skill? (type to filter)', '加载哪个技能？（输入即筛选）'),
      options,
      ...(options.length > 8 ? { filterable: true } : {}),
    });
    if (answer.type !== 'selected') return; // dismissed 静默（规格 D4，沿既有卡取消语义）
    const id = labelToId.get(answer.labels[0] ?? '');
    if (id === undefined) return;
    const loaded = this.runtime.harness.context.chainView().some((s) => s.action === 'skill' && s.observation.includes(`(id=${id} v=`));
    if (loaded) {
      this.pushMsg('system', t(`Skill ${id} already loaded in this session`, `技能 ${id} 本会话已加载`));
      return;
    }
    const r = this.runtime.harness.skills.resolve(id);
    if (!r.ok) {
      this.pushMsg('system', t(`Skill load failed: ${r.error.message}`, `技能加载失败：${r.error.message}`), { level: 'warn' });
      return;
    }
    this.loadSkill(id);
  }

  private onEvent(e: SessionEvent): void {
    // 委派/板事件分流(P1 收敛,spec §11):类型前缀判定前置——即便上游误打 subagent 标签也不误吞(终审裁定);
    // delegation-* 进委派投影,task-*/gate-* 进板投影,两者都不触达主链消息分支
    if (e.type.startsWith('delegation-')) {
      this.state = { ...this.state, delegations: applyDelegation(this.state.delegations, e) };
      this.notifyThrottled();
      return;
    }
    if (e.type.startsWith('task-') || e.type.startsWith('gate-')) {
      const board = applyBoardEvent(this.state.board, boardEventFrom(e));
      if (board !== this.state.board) {
        this.state = { ...this.state, board };
        this.notifyThrottled();
      }
      return;
    }
    // 子代理事件分流(规格 §4.1):带 payload.subagent 标签的事件路由至面板态,不触达主链任何分支
    const sub = e.payload?.subagent;
    if (typeof sub === 'string' && sub.length > 0) {
      onChildEvent(this, e, sub);
      return;
    }
    this.state = { ...this.state, task: applyTaskState(this.state.task, e) };
    switch (e.type) {
      case 'notice':
        // 收口说明行用户面（规格 §10）：记忆/技能沉淀以一行增量告知（内容为英文链行原文，照原样不译）
        this.pushMsg('system', String(e.payload?.text ?? e.text ?? ''));
        return;
      case 'token':
        // chat 主通道正文增量直连（token 承载纯正文，无协议骨架过滤层）：live 累积 + markdansi 行级喂入（片段即时入档）
        this.appendLive('reply', e.text ?? '');
        return;
      case 'reasoning':
        this.appendLive('thinking', e.text ?? '');
        return;
      case 'ctx': {
        // reactor 旁路水位：exact=true 为端点真实 usage.prompt_tokens（直接采信，允许回落）；
        // exact=false 为装配面估算（只向上预告）。死代码分支「promptTokens 优先」自此真正接通
        const m = this.state.metrics;
        const incoming = typeof e.payload?.used === 'number' ? e.payload.used : 0;
        const used = applyCtxWatermark(m.ctxUsed, incoming, e.payload?.exact === true);
        if (used === m.ctxUsed) return;
        this.state = { ...this.state, metrics: { ...m, ctxUsed: used } };
        this.notify();
        return;
      }
      case 'usage': {
        if (typeof e.payload?.turnTotal !== 'number') return; // 无数值载荷不更新
        // 轮首 miss 提示（观测小件）：本轮首个 usage 事件且 cache=0 且 prompt≥50k → 提示一次（只提示不归因展开）
        if (!this.turnMissHinted) {
          this.turnMissHinted = true;
          const firstCache = typeof e.payload?.cacheHitTotal === 'number' ? e.payload.cacheHitTotal : 0;
          const firstPrompt = typeof e.payload?.promptTotal === 'number' ? e.payload.promptTotal : 0;
          if (firstCache === 0 && firstPrompt >= 50_000) {
            this.pushMsg('system', t('Round-first prompt cache miss (0 cached): the endpoint cache may have expired (TTL); correctness is not affected', '轮首缓存未命中（cached=0）：端点缓存可能已过期（TTL），不影响正确性'), { level: 'warn' });
          }
        }
        // per-run 值叠加任务级基线：/plan 逐步执行本轮持续累计（步骤切换不重置）
        const turnTokensTotal = this.usageBase.tokens + e.payload.turnTotal;
        const c = this.usageBase.cache + (typeof e.payload.cacheHitTotal === 'number' ? e.payload.cacheHitTotal : 0);
        const p = this.usageBase.prompt + (typeof e.payload.promptTotal === 'number' ? e.payload.promptTotal : 0);
        const m = this.state.metrics;
        if (turnTokensTotal === m.turnTokens && c === m.turnCacheTokens && p === m.turnPromptTokens) return; // 数值未变的重复 usage 不触发重渲染
        // 会话累计按本轮增量并入（Σcached/Σprompt：跨任务不清零、/new 归零）——轮首 miss 只稀释会话均值，不再把状态栏砸成 0%
        this.state = {
          ...this.state,
          metrics: {
            ...m,
            turnTokens: turnTokensTotal,
            turnCacheTokens: c,
            turnPromptTokens: p,
            sessionCacheTokens: m.sessionCacheTokens + Math.max(0, c - m.turnCacheTokens),
            sessionPromptTokens: m.sessionPromptTokens + Math.max(0, p - m.turnPromptTokens),
            sessionTotalTokens: m.sessionTotalTokens + Math.max(0, turnTokensTotal - m.turnTokens),
          },
        };
        this.notify();
        return;
      }
      case 'tool-call': {
        this.sealReply();
        const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : undefined;
        // 调用行延迟入档（CC 模式）：运行中调用行由动态区活动行唯一承载，历史区零 pending 行；
        // 回程时调用行+结果行成对定格（动态区紧贴转录末尾，定格视觉即原地完成）
        const entry = {
          callId,
          text: toolCallLine(e.text ?? '', e.payload?.input),
          input: e.payload?.input,
          verb: e.text ?? '',
        };
        this.pendingCalls = [...this.pendingCalls.filter((p) => p.callId === undefined || p.callId !== callId), entry];
        // 委派提示词捕获（规格 §4.2）：spawn 的 input.prompt 按基名暂存，子面板态创建时挂载、归档清理
        if (e.text === 'spawn') {
          const pin = e.payload?.input as Record<string, unknown> | undefined;
          const prompt = typeof pin?.prompt === 'string' && pin.prompt.length > 0 ? pin.prompt : undefined;
          if (prompt !== undefined) this.childPrompts.set(spawnBaseLabel(pin), prompt);
        }
        // 即时通知（b705855 延迟入档重构时随 pushMsg 一起丢失）：挂起清单变更与底部活动行出现都依赖本通知，
        // 缺失即委派期动态区零变化、观感像卡住
        this.notify();
        return;
      }
      case 'tool-result': {
        const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : undefined;
        // 取回挂起调用行（callId 命中优先，undefined FIFO 兜底——与旧乱序插回同口径）
        const idx = this.pendingCalls.findIndex((p) => (callId !== undefined ? p.callId === callId : p.callId === undefined));
        const pending = this.pendingCalls.splice(idx >= 0 ? idx : 0, 1)[0];
        const callItem: ChatItem = {
          role: 'tool', text: pending?.text ?? '', ts: Date.now(), seq: ++this.msgSeq,
          kind: 'call', pending: false, callId,
        };
        const item: ChatItem = {
          role: 'tool', text: e.text ?? '', ts: Date.now(), seq: ++this.msgSeq,
          kind: 'result', ok: e.payload?.ok === true,
          // callId 随行入档（2026-09-28 真机残留修复）：历史区 SPAWN 行整对剔除以 result.callId → call 行 seq
          // 配对，结果行缺 callId 即永不命中、spawn 结果行整对泄漏进主时间线
          callId,
          detail: typeof e.payload?.full === 'string' ? e.payload.full : undefined,
        };
        this.appendMessages([callItem, item]);
        if (e.payload?.tool === 'spawn' && pending !== undefined) {
          // spawn 调用关联栈：调用行此刻才入档，压栈其真实 seq 与委派时刻（浏览列表委派时间序数据源），成对语义下紧随其后弹出归档
          this.spawnCalls.push({ seq: callItem.seq, base: spawnBaseLabel(pending?.input), delegatedAt: callItem.ts });
          archiveChild(this);
        }
        return;
      }
      case 'step': {
        // 步数计账：模型动作步（done 收尾帧不计、子代理事件已分流不达此处），会话累计、/new 归零（状态栏 turns/steps 段数据源）
        // phase 叙述通道已退役（2026-09-30 用户裁决，单一权威源）：叙述只走 token→正文一条通道
        //（流式 delta / 非流式单帧补发，reactor 发射点保证），本事件只承载步号计账不上屏
        if (e.text !== 'done') {
          this.state = { ...this.state, metrics: { ...this.state.metrics, sessionSteps: this.state.metrics.sessionSteps + 1 } };
        }
        return;
      }
      case 'done': {
        const draft = this.state.live?.kind === 'reply' ? this.state.live.text : '';
        const source = this.md.pushedSource; // 已推源在冲刷前取样（seal 随通道归零）
        this.closeLive();
        this.flushPendingCalls();
        if (this.md.planReplyNoArchive) {
          // 规划轮终稿不重复入档：计划正文仅以确认卡形态上屏一次
          this.md.clear();
          this.refreshMetrics();
          return;
        }
        if (e.payload?.stopReason === 'model-error') {
          // D6：模型失败已由 error 通道上屏，done 收尾帧携带的同一错误文案不再以 assistant 终答身份重复入档
          this.md.clear();
          this.refreshMetrics();
          return;
        }
        const finalText = e.text && e.text.length > 0 ? e.text : source.length > 0 ? source : draft;
        // 冲刷收口：行尾残段成行喂入 + 缓冲块整体渲染入档（未闭合表格/围栏整块收口），
        // 随后通道置空；流式已入档部分终稿 dedup 天然成立（已入档条目不重发，差量走前缀对齐）
        this.md.seal();
        if (finalText.length > 0) {
          // 终稿与已推源的前缀对齐（已推源跨 reply/thinking 交错块连续，非末 live 块）：前缀命配 →
          // 差量（非流式整帧/终稿多出尾段）单点渲染补齐；前缀失配（协议异常防御）→ 公共前缀差量
          // 降级渲染，不重复已流式呈现的内容
          let common = source.length;
          if (!finalText.startsWith(source)) {
            common = 0;
            const n = Math.min(finalText.length, source.length);
            while (common < n && finalText[common] === source[common]) common += 1;
          }
          const rest = finalText.slice(common);
          if (rest.length > 0) this.md.pushFragment(renderMd(rest, this.mdWidth()));
        }
        this.refreshMetrics();
        return;
      }
      case 'error':
        this.closeLive();
        this.md.clear();
        this.flushPendingCalls();
        this.pushMsg('system', t(`Error: ${e.text ?? '(no detail)'}`, `错误：${e.text ?? '（无说明）'}`), { level: 'error' });
        this.refreshMetrics();
        return;
      default:
        return; // route / approval-* 不落消息区
    }
  }

  /** 消息区单条入档（公开 = md-stream/child-panel/approval 等拆分件经窄接口消费，公开面新增不改语义） */
  pushMsg(role: ChatRole, text: string, extra?: Partial<Pick<ChatItem, 'kind' | 'ok' | 'pending' | 'callId' | 'detail' | 'level' | 'ansi'>>): void {
    this.appendMessages([{ role, text, ts: Date.now(), seq: ++this.msgSeq, ...(extra ?? {}) }]);
  }

  /** 消息区唯一追加写点（单一挂钩点）：改 state + 逐条落 journal + 通知三件套单点——pushMsg（单条）、
   *  tool-result 成对入档、flushPendingCalls 批量兜底共用；任何绕过此点手拼 messages 的路径都会让
   *  未来加在写点上的不变量静默失效（b705855 丢 notify 真机前科）。恢复注入不经此处（零重复入志，文档化特例） */
  private appendMessages(items: ChatItem[]): void {
    if (items.length === 0) return;
    this.state = { ...this.state, messages: [...this.state.messages, ...items] };
    for (const item of items) this.journal?.log({ t: 'msg', item });
    this.notify();
  }

  /** 已入档消息的唯一覆盖写点：同 seq 原位替换 + 'msg-update' 回写（归档富化唯一消费方）；
   *  公开 = child-panel 归档富化回写消费 */
  updateMessage(item: ChatItem): void {
    this.state = { ...this.state, messages: this.state.messages.map((m) => (m.seq === item.seq ? item : m)) };
    this.journal?.log({ t: 'msg-update', item });
    this.notify();
  }

  /** 测试注入口：直喂 SessionEvent 走完整分流路径（等价 runtime onEvent 回调），生产路径零改动 */
  onEventForTest(e: SessionEvent): void {
    this.onEvent(e);
  }

  /** 活任务三态只读视图（渲染层与测试消费；交互面只读不重推导） */
  taskState(): LiveTaskState {
    return this.state.task;
  }

  /** 追加实时区内容（委托 md-stream.appendLiveText：同类续接；异类先收束旧块——交错收束语义细节见拆分件） */
  private appendLive(kind: LiveBlock['kind'], delta: string): void {
    appendLiveText(this, kind, delta);
  }

  /** 流式 md 渲染宽度注入源（J6 双源收敛）：装配层/测试经 SessionOpts.mdColumns 注入；缺省回退 process.stdout.columns */
  private readonly mdColumns: (() => number) | undefined;

  /** markdansi 流式通道宽度（块渲染与终稿兜底渲染共用基准）；公开 = MdStreamHost 接缝（md-stream 消费） */
  mdWidth(): number {
    return this.mdColumns?.() ?? process.stdout.columns ?? 80;
  }

  /** 收束实时区（委托 md-stream.closeLiveBlock：thinking 折叠为一行摘要；reply 不落消息——终稿由 done 接管） */
  private closeLive(): void {
    closeLiveBlock(this);
  }

  /** 工具边界旁白封口（委托 md-stream.sealLiveReply：live reply 冲刷收口 + 通道置空，细节见拆分件） */
  private sealReply(): void {
    sealLiveReply(this);
  }

  /** done/error 后刷新账本 runs（缓存命中率已升格会话累计口径，随 usage 事件增量更新） */
  private refreshMetrics(): void {
    this.state = {
      ...this.state,
      metrics: { ...this.state.metrics, runs: this.runtime.harness.ledger.summary().runs },
    };
    this.notify();
  }

  /** 高频增量（token/reasoning 逐 delta）合帧节流窗口：约 80ms 通知一次，终态与结构事件仍即时放行 */
  private static readonly NOTIFY_THROTTLE_MS = 80; // 流式合帧窗口（2026-09-30 流畅度裁决）：ink 无逐行 diff，动态区任一行变化即全帧重写——帧率与擦写面积耦合：正文流式改 markdansi 通道逐行入档后动态区行数有界，80ms（~12 帧/s）擦写肉眼不可感、流式爬行观感显著更顺；旧 120ms 是 20+ 行大预览区时代的防闪灼取舍，区域收敛后钝感即卡顿感
  private notifyTimer?: NodeJS.Timeout;

  /** 状态通知（公开 = md-stream/child-panel 等拆分件经窄接口消费，公开面新增不改语义） */
  notify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    for (const cb of this.listeners) cb(this.state);
  }

  /** 增量合帧：窗口内多次状态变更只通知一次（监听方取到的总是最新状态）；定时器不持有进程引用；
   *  公开 = 拆分件接缝（同 notify） */
  notifyThrottled(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.notify();
    }, SessionController.NOTIFY_THROTTLE_MS);
    this.notifyTimer.unref();
  }
}

