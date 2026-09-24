import type { AskUserAnswer, AskUserRequest, AskUserSeam } from '../types';
import type { TodoItem, TodoStatus } from '../types';
import { ApprovalDecision, ApprovalRequest, ContextItem, HistoryStep, ModelTier, ReasoningEffort, SessionEvent } from '../types';
import { EFFORT_ORDER, parseEffort } from '../model/adapter';
import { t } from '../i18n';
import { RunOutcome, TuiRuntime, TuiRuntimeOpts, createRuntime } from './runtime';
import { parseTier } from '../runtime';
import { estimateTokens } from '../harness/context/window';
import { stableReplySegment } from './reply-flusher';
import { toolCallLine } from './tool-verbs';
import { describeIncomplete } from './stop-reason';
import { ContextManager, chainToHistoryItems, runCompaction } from '../harness/context';
import { sunshineInitGoal } from '../harness/sunshine-init';
import * as fs from 'fs';
import * as path from 'path';
import { SessionJournal, listSessions, newSessionId, sessionsDir, parseJournalFile, reduceJournal, listAnchors, branchFrom, type SessionMeta } from './session-journal';
import { collectRestorePlan, applyRestorePlan } from './session-snapshots';
import { resolveDataDir } from '../config/data-dir';
import { SLASH_COMMANDS } from './slash-commands';
import { MemoryStore } from '../harness/memory/store';
import { resolveMemoryConfig, setMemorySessionOverride } from '../config/memory-config';
import { scanMemoryText } from '../harness/memory/guards';
import { consolidateMemory } from '../harness/memory/consolidate';
import { isModelSummarizer } from '../harness/context/summarizer';
import { LiveTaskState, applyTaskState, initialTaskState } from './task-state';

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system' | 'thinking' | 'step';

export interface ChatItem {
  role: ChatRole;
  text: string;
  ts: number;
  /** 全局单调序号：TUI Static 区 key 的唯一性来源，跨 /new 递增不回绕 */
  seq: number;
  /** tool 行细分：call（● 调用行）/ result（⎿ 结果行） */
  kind?: 'call' | 'result';
  /** tool 结果行成功标记 */
  ok?: boolean;
  /** system 消息级别：info 状态回执（缺省）/ warn 警示 / error 失败——渲染层据此选色 */
  level?: 'info' | 'warn' | 'error';
  /** 可展开原文：thinking 折叠行的思考全文 / tool 结果行的完整 observation（入档后折叠打印，供后续 transcript 视图） */
  detail?: string;
  /** 子代理归档摘要（SPAWN call 行专属）：steps=子代理步数、durationMs=归档时刻-startedAt；零子事件即败时缺省 */
  subagentMeta?: { steps: number; durationMs: number };
}

export type { TodoItem, TodoStatus } from '../types';

export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'awaiting-plan' | 'awaiting-question' | 'error';

export interface StatusMetrics {
  turnStartedAt: number;
  turnTokens: number;
  /** 本轮 prompt 缓存命中 tokens（usage 事件 cacheHitTotal 聚合；中间量，不再直接驱动状态栏 cache 段） */
  turnCacheTokens: number;
  /** 本轮 prompt tokens（usage 事件 promptTotal 聚合；与 turnCacheTokens 同量纲） */
  turnPromptTokens: number;
  /** 会话累计缓存命中 tokens（Σcached：同会话跨任务不清零、仅 /new 归零；状态栏 cache 段分子） */
  sessionCacheTokens: number;
  /** 会话累计 prompt tokens（Σprompt：cache 段分母，与 sessionCacheTokens 同量纲） */
  sessionPromptTokens: number;
  /** 会话累计任务轮次（任务起点 +1：跨任务累加、仅 /new 归零；状态栏 turns 段） */
  sessionTurns: number;
  /** 会话累计模型动作步数（step 事件计步、done 收尾帧不计；状态栏 steps 段） */
  sessionSteps: number;
  runs: number;
  /** 当前上下文占用水位估算 tokens（最新模型轮装配面估算；分母为 SUNSHINEX_CONTEXT_WINDOW 配置窗口） */
  ctxUsed: number;
}

export interface LiveBlock {
  kind: 'reply' | 'thinking';
  text: string;
  startedAt: number;
  /** 流式正文已入档水位：预览只渲染 slice(committedLen) 的未入档尾段，避免与滚动缓冲重复 */
  committedLen?: number;
}

/** 子代理运行中面板态（规格 §4.2）：带 payload.subagent 标签的事件路由至此，主链零污染 */
export interface ChildLiveState {
  label: string;
  startedAt: number;
  steps: number;
  tokens: number;
  /** 全量行（归档用）：工具行/流式文本统一行化 */
  transcript: string[];
  /** 面板尾流：transcript 末 ≤3 行（含未成行） */
  tail: string[];
  /** 完成态：done/error 事件置位——并行批中早完成者即时显终标而非一直转圈（归档锚点在主链 tool-result，晚于兄弟完成） */
  done?: boolean;
}

/** 面板尾流视图：transcript 末 ≤3 行（含未成行 buf）——存储单一来源的派生（规格 §4.2） */
function childTail(transcript: string[], buf: string): string[] {
  return [...transcript, ...(buf ? [buf] : [])].slice(-3);
}

/** spawn 调用关联基名（规格 §4.4）：label ?? agent_id ?? 'subagent'（与 Runner 解析同源；消歧后缀不含入内） */
function spawnBaseLabel(input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  return str(obj.label) ?? str(obj.agent_id) ?? 'subagent';
}

export interface TuiState {
  messages: ChatItem[];
  approval?: ApprovalRequest;
  todos: TodoItem[];
  status: SessionStatus;
  metrics: StatusMetrics;
  live?: LiveBlock;
  /** 运行中子代理面板态（规格 §4）：首事件创建、spawn 结果归档移除、回合边界清空 */
  children: ChildLiveState[];
  /** 活任务三态（规格 §4）：事件流经 applyTaskState 纯函数推导，瞬态不进 journal */
  task: LiveTaskState;
  /** 用户级模型档位（/model 会话内切换；undefined = 缺省主模型，run 级常量不随步重估） */
  model?: ModelTier;
  /** 缺省思考强度（/model-effort 会话内切换；undefined = 适配器 cfg/env 缺省，run 级常量） */
  effort?: ReasoningEffort;
  /** AskQuestion 挂起卡（ask_question 工具或本地问询期间非空；渲染层选择器接管键盘） */
  question?: AskUserRequest;
  /** 输入框回填文本（/rewind //fork 锚点轮输入；瞬态不进 journal，App 取走即消费） */
  backfill?: string;
}

export interface SessionOpts extends TuiRuntimeOpts {
  /** 启动即续接最近会话（CLI --continue；规格 D1/D5）。无档位时提示并以新会话继续，不静默吞 */
  continueLast?: boolean;
  /** 启动即弹会话选择卡（--resume） */
  resumePicker?: boolean;
  /** manual 模式审批回调（终端化审批装配点；渲染层注入交互实现） */
  asker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 问询接缝覆盖（headless/脚本注入；缺省会话装配把 seam 接到本控制器问询管线） */
  onAskUser?: AskUserSeam;
  /** 运行时注入位：缺省自建 createRuntime(opts)；测试可注入假实现以隔离长任务 */
  runtime?: TuiRuntime;
}

/** ctx 水位消费策略：真实 usage 口径（exact）直接采信——压缩回落 / plan 新步骤最小化回落都是真实语义；
 *  估算口径只作向上预告，不得覆盖更准的真实水位（消除同轮内估算↔真实的往复抖动） */
export function applyCtxWatermark(current: number, incoming: number, exact: boolean): number {
  if (!(incoming > 0)) return current;
  return exact ? incoming : Math.max(current, incoming);
}

/** 斜杠命令帮助（运行期求值：语言随 --language 装配后设定，禁止模块级 t() 冻结） */
/** 选择卡分页（规格 D6）：>8 项时卡尾追加 More…（下一页）/Back…（上一页）导航项，page 从 0 起；单页内零导航项 */
export function paginateOptions(
  items: Array<{ label: string; description?: string }>,
  page = 0,
  pageSize = 8,
): { options: Array<{ label: string; description?: string }>; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const options = [...items.slice(page * pageSize, (page + 1) * pageSize)];
  if (page + 1 < totalPages) options.push({ label: t('More…', '更多…'), description: t('next page', '下一页') });
  if (page > 0) options.push({ label: t('Back…', '上一页…'), description: t('previous page', '上一页') });
  return { options, page, totalPages };
}

function slashHelp(): string[] {
  const lines = [
    t('Commands:', '命令：'),
    t('  /init          analyze & write SUNSHINE.md', '  /init          分析生成/完善 SUNSHINE.md'),
    t('  /goal          run the verify-fix loop: /goal <goal>', '  /goal          运行完整验收修正环：/goal <目标>'),
    t('  /plan          plan first, execute on approval: /plan <goal>', '  /plan          先规划后执行：/plan <目标>'),
    t('  /new           new session (soft reset)', '  /new           新会话（软重置）'),
    t('  /resume        resume a saved session (selector with paging)', '  /resume        恢复已保存会话（选择卡，支持翻页）'),
    t('  /rewind        rewind current session to an earlier turn', '  /rewind        回退当前会话到更早的任务轮'),
    t('  /fork          fork a parallel session from any past turn', '  /fork          从任意历史轮分叉出平行会话'),
    t('  /compact       compress context: /compact [focus]', '  /compact       压缩上下文：/compact [关注点]'),
    t('  /model         switch model tier (selector)', '  /model         切换模型档位（选择卡）'),
    t('  /model-effort  switch reasoning effort (selector)', '  /model-effort  切换思考强度（选择卡）'),
    t('  /memory        list persistent memories', '  /memory        列出持久记忆'),
    t('  /memory-add    add a memory: /memory-add <text>', '  /memory-add    添加记忆：/memory-add <内容>'),
    t('  /memory-rm     delete memories (multi-select)', '  /memory-rm     删除记忆（多选卡）'),
    t('  /memory-gc     consolidate memories now', '  /memory-gc     立即整理记忆'),
    t('  /memory-on     enable memory for this session', '  /memory-on     本会话开启持久记忆'),
    t('  /memory-off    disable memory for this session', '  /memory-off    本会话关闭持久记忆'),
    t('  /tasks         list background tasks (id/kind/status/label, output path)', '  /tasks         列出后台任务（id/类型/状态/标签，输出路径）'),
    t('  /skill         load a skill into context (selector, type to filter)', '  /skill         加载技能进上下文（选择卡，输入筛选）'),
    t('  /status        session & ledger summary', '  /status        会话与账本摘要'),
    t('  /help          show this list', '  /help          本清单'),
  ];
  // 技能命令一行引导：完整列表经 /skill 选择卡筛选（type-to-filter），/<技能id> 直调形态同源分发
  lines.push(t('  Skills: invoke /<skill-id> directly; browse with /skill', '  技能命令：直接 /<技能id> 调用；完整列表经 /skill 筛选'));
  return lines;
}

/** 会话控制器：事件进 → 状态变更（渲染层订阅）；斜杠命令解析、FIFO 排队、审批挂起/回填；纯逻辑可独立单测 */
/** 空闲兜底节拍判据（规格 §3.5）：仅 idle（且无挂起审批）且后台队列非空才消费——无待办零调用零配额。
 *  抽为导出纯函数以钉死「运行中不消费」的负向证伪力（评审 Important-2）。 */
export function shouldPumpOnIdleBeat(status: string, hasPendingApproval: boolean, pending: number, hasPendingQuestion = false): boolean {
  return status === 'idle' && !hasPendingApproval && !hasPendingQuestion && pending > 0;
}

/** /plan 规划轮内部任务标签：规划提示词与 runInternalTask label 共用（D10：防两处漂移） */
export const PLAN_TASK_LABEL = 'Produce a numbered step plan';

export class SessionController {
  readonly runtime: TuiRuntime;
  /** 项目根：/init 生成 SUNSHINE.md 的基准目录（与 runtime 装配同源） */
  private readonly root: string;
  /** 流式正文已入档水位（done 终稿前缀长度）：安全点切块入档用，新回合/收尾归零 */
  private committedLen = 0;
  /** /plan 规划轮：计划正文只以确认卡上屏一次，流式切块与 done 终稿均不再重复入档（重复显示根因） */
  private planReplyNoArchive = false;
  /** usage 整场基线：每个模型轮开始前同步为当前累计，事件按「基线 + 本轮 per-run 值」聚合（/plan 步骤间不重置窗口） */
  private usageBase = { tokens: 0, cache: 0, prompt: 0 };
  private state: TuiState = {
    messages: [],
    todos: [],
    status: 'idle',
    metrics: { turnStartedAt: 0, turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, sessionCacheTokens: 0, sessionPromptTokens: 0, sessionTurns: 0, sessionSteps: 0, runs: 0, ctxUsed: 0 },
    children: [],
    task: initialTaskState(),
  };
  private listeners = new Set<(s: TuiState) => void>();
  /** 消息全局单调序号（Static 区 key 唯一性来源）；/new 清空消息但不回绕 */
  private msgSeq = 0;
  /** 会话事件日志（规格 2026-09-17-session-persistence D4 + 2026-09-22 事件级即时落盘）：持久化事件随产生落盘（惰性建档，空会话零文件） */
  private journal?: SessionJournal;
  /** 恢复携带的 UI 现场（--continue / /resume 重放产物；entry 经 takeRestoredUi 播种 retain，一次性取走） */
  private restoredUi?: { history: string[]; expandAll: boolean; latestFull: boolean };
  /** 子代理半行缓冲（label → 未成行）：token/reasoning 增量拼接、遇换行成行入 transcript */
  private childBufs = new Map<string, string>();
  /** spawn 调用关联栈（FIFO）：主链 spawn tool-call 压栈（行 seq + 关联基名）、spawn tool-result 弹出归档（规格 §4.4 配对语义） */
  private spawnCalls: { seq: number; base: string }[] = [];
  private pendingApproval?: { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void };
  /** 空闲兜底节拍（规格 §3.5）：仅 idle 且后台队列非空时消费；unref 不阻塞进程退出 */
  private kickTimer?: ReturnType<typeof setInterval>;
  /** 挂起的计划确认卡（/plan 流程）；confirmPlan 裁决后清除 */
  private pendingPlan?: { items: string[] };
  /** 最近一次压缩事件时的 ctx 水位（自动压缩留痕 before → after 用；/compact 路径不消费） */
  private compactWatermark = 0;
  /** compact 事件序号（1-based）：一次压缩 = applyCompaction + trimChainFront 恰两条，留痕按序配对消歧 */
  private compactEventSeq = 0;
  /** 任务轮首 miss 提示判定（规格 D 观测小件）：每任务轮首重置；提示一次后不再重复 */
  private turnMissHinted = false;
  /** 裁决权注入（SessionOpts.asker）：挂起语义不变，回填后咨询并以其为最终裁决 */
  private autoAsker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 会话内持久记忆开关（/memory on|off；undefined=随控制面）：写 setMemorySessionOverride 单点，仅本会话生效、不改盘，/new 清除 */
  private memoryOverride?: boolean;
  /** 当前任务中断源（Esc/Ctrl+C）：任务起点建、closeTask 清；interrupt() 置 aborted 贯通模型/loop/reactor */
  private taskAbort?: AbortController;

  /** AskQuestion 挂起态：问询管线挂起点与裁决回填口（AskQuestion 线 D5） */
  private pendingQuestion?: { req: AskUserRequest; resolve: (a: AskUserAnswer) => void };

  constructor(opts: SessionOpts) {
    this.root = opts.root;
    this.runtime = opts.runtime ?? createRuntime({
      root: opts.root,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.tier ? { tier: opts.tier } : {}),
      onEvent: (e) => this.onEvent(e),
      onAskUser: opts.onAskUser ?? ((req) => this.askUser(req)),
      onTodos: (items) => this.setTodos(items),
    });
    const suspendAsker = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      // 终端化审批：guard ask → 挂起（awaiting-approval + 审批卡）→ 裁决回填 → 继续；
      // 有外部 asker（headless/脚本）时委托之，状态转换保持一致便于观测与渲染
      this.state = { ...this.state, status: 'awaiting-approval', approval: req, task: this.state.task.phase === 'tool-pending' ? { ...this.state.task, phase: 'tool-awaiting' } : this.state.task };
      this.notify();
      // 挂起等回填（App 模态/测试直调）；opts.asker 为裁决权注入，回填后咨询并以其为最终裁决
      let d = await new Promise<ApprovalDecision>((resolve) => {
        this.pendingApproval = { req, resolve };
      });
      if (this.autoAsker) d = await this.autoAsker(req);
      this.state = { ...this.state, approval: undefined, status: 'running', task: this.state.task.phase === 'tool-awaiting' ? { ...this.state.task, phase: 'tool-pending' } : this.state.task };
      this.notify();
      return d;
    };
    this.autoAsker = opts.asker;
    if (opts.mode === 'manual') this.runtime.harness.security.setAsker(suspendAsker);
    this.state = { ...this.state, metrics: { ...this.state.metrics, runs: this.runtime.harness.ledger.summary().runs } };
    if (opts.tier) this.state = { ...this.state, model: opts.tier };
    if (opts.effort) this.state = { ...this.state, effort: opts.effort };
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
    if (opts.resumePicker) void this.resumeFlow();
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
        this.committedLen = 0;
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

  /** 回填当前挂起审批；无挂起时静默忽略 */
  async resolveApproval(d: ApprovalDecision): Promise<void> {
    const pending = this.pendingApproval;
    if (!pending) return;
    this.pendingApproval = undefined;
    this.state = { ...this.state, approval: undefined };
    this.notify();
    pending.resolve(d);
  }

  /** 用户中断（Esc/Ctrl+C，对标 Claude Code）：中止在途模型调用与后续步、待审批按拒绝、待确认计划放弃、排队任务一并丢弃。
   *  运行外状态 no-op（App 层据此分流退出/清输入）；返回是否实际发生中断 */
  /** AskQuestion 挂起管线（AskQuestion 线 D5，形态对标 suspendAsker）：prevStatus 记录挂起前态（running=任务中途问询、
   *  idle=/resume 选择器等本地问询），awaiting-question + 问题卡上屏 → 渲染层选择器接管键盘 → resolveAskAnswer 回填 → 恢复现场态 */
  askUser(req: AskUserRequest): Promise<AskUserAnswer> {
    const prevStatus = this.state.status;
    this.state = { ...this.state, status: 'awaiting-question', question: req };
    this.notify();
    return new Promise<AskUserAnswer>((resolve) => {
      this.pendingQuestion = {
        req,
        resolve: (a) => {
          this.pendingQuestion = undefined;
          this.state = { ...this.state, question: undefined, status: prevStatus };
          this.notify();
          resolve(a);
        },
      };
    });
  }

  /** 渲染层/测试裁决回填口：无挂起时静默忽略（幂等） */
  resolveAskAnswer(a: AskUserAnswer): void {
    this.pendingQuestion?.resolve(a);
  }

  interrupt(): boolean {
    const active = this.state.status === 'running' || this.state.status === 'awaiting-approval' || this.state.status === 'awaiting-plan' || this.state.status === 'awaiting-question';
    if (!active) return false;
    this.taskAbort?.abort();
    this.taskAbort = undefined;
    // 待审批卡：中断即拒绝（deny 不落会话放行），任务经安全链 deny 语义自然停下
    const pending = this.pendingApproval;
    if (pending) {
      this.pendingApproval = undefined;
      this.state = { ...this.state, approval: undefined };
      pending.resolve('deny');
    }
    // 问询挂起：中断先以 dismissed 回填（管线自然恢复现场态），任务随 abort 信号停下；不遗留悬空 Promise
    if (this.pendingQuestion) {
      const pendingQ = this.pendingQuestion;
      this.pendingQuestion = undefined;
      this.state = { ...this.state, question: undefined };
      pendingQ.resolve({ type: 'dismissed' });
    }
    // 待确认计划：中断即放弃（与 confirmPlan(false) 同语义）
    if (this.pendingPlan) {
      this.pendingPlan = undefined;
      this.state = { ...this.state, status: 'idle' };
      this.pushMsg('system', t('Plan discarded, back to input', '已放弃执行计划，回到输入态'));
      this.notify();
      return true;
    }
    // 待投递穿插行随中断一并丢弃（用户意图是停，不是继续跑）；已消费穿插行已随步入链，不受影响
    if (this.runtime.harness.steering.pending() > 0) {
      const dropped = this.runtime.harness.steering.takePending().length;
      this.pushMsg('system', t(`Queued tasks dropped: ${dropped}`, `已丢弃排队任务：${dropped} 条`), { level: 'warn' });
    }
    this.notify();
    return true;
  }

  /** 中断回执单点：interrupted 终态由各任务流调用；warn 级（用户主动操作，非故障） */
  private pushInterruptedNotice(): void {
    this.pushMsg('system', t('Task interrupted (Esc/Ctrl+C) — completed steps kept on the chain', '已中断当前任务（Esc/Ctrl+C）——已完成步骤保留在会话链'), { level: 'warn' });
  }

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
      this.state = { ...this.state, status: 'idle' };
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
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, sessionTurns: this.state.metrics.sessionTurns + 1 },
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.turnMissHinted = false; // 新任务轮：轮首 miss 判定重置（观测小件）
    this.taskAbort = new AbortController();
    this.notify();
    let planText = '';
    this.planReplyNoArchive = true;
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
          this.planReplyNoArchive = false;
          this.pushInterruptedNotice();
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
      this.planReplyNoArchive = false;
    }
    const items = planText
      .split('\n')
      .map((l) => l.trim())
      .map((l) => l.replace(/^\d+[.、]\s*/, '').trim())
      .filter((l) => l.length > 0);
    if (items.length === 0) {
      this.pushMsg('system', t('No numbered steps produced (each line must be "1. xxx"), cancelled', '规划未产出编号步骤（每行需形如「1. xxx」），已取消'), { level: 'warn' });
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
          ...(this.state.model ? { tier: this.state.model } : {}),
          ...(this.state.effort ? { effort: this.state.effort } : {}),
          ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
        });
        if (r.stopReason === 'interrupted') { this.pushInterruptedNotice(); break; }
        if (!r.done) {
          this.reportIncomplete(r, 'warn');
          this.pushMsg('system', t(`Step incomplete: ${items[i]}; remaining steps paused`, `步骤未完成：${items[i]}；剩余步骤暂停`), { level: 'warn' });
          break;
        }
        this.setTodos(this.state.todos.map((td) => (td.text === items[i] ? { ...td, status: 'completed' } : td)));
        // 步骤全量轨迹与结论行已由 reactor 会话作用域自动入链（fork 模型：不再只留结论行）
        // 步骤正文已随流式管线入档（flushReply 切块 + done 补尾），此处不再重复上屏（Step 切换时上一阶段正文重复的根因）
      } catch (e) {
        this.pushMsg('system', t('Step failed: ' + items[i] + ' (' + (e instanceof Error ? e.message : String(e)) + '); remaining steps paused', '步骤失败：' + items[i] + '（' + (e instanceof Error ? e.message : String(e)) + '）；剩余步骤暂停'), { level: 'error' });
        break;
      }
    }
    this.closeTask();
  }

  /** 任务收束：回 idle 并停表（turnStartedAt=0，idle 态不再显示耗时）。本轮 tokens/缓存命中保留为上一轮统计（下次提交进 running 时重置）；error 态保留现场便于回看出错时刻 */
  // ===== 会话持久化（规格 docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md）=====

  /** 会话日志单点获取：首个持久化事件建档；未建档直接返回实例（start 前事件丢弃=空会话零文件） */
  private ensureJournal(): SessionJournal {
    if (!this.journal) this.journal = new SessionJournal(resolveDataDir(this.root));
    return this.journal;
  }

  /** 快照型事件接线（规格 2026-09-22 D5）：变更点即时 log 的单点构造器，防四处拼装漂移 */
  private logModel(): void {
    this.journal?.log({ t: 'model', ...(this.state.model ? { tier: this.state.model } : {}), ...(this.state.effort ? { effort: this.state.effort } : {}) });
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

  /** 会话恢复选择卡（/resume 与 --resume 启动共用单点）：mtime 降序候选（排除当前在飞会话）→ askUser 挂起 → restoreFromSession */
  private async resumeFlow(): Promise<void> {
    const dataDir = resolveDataDir(this.root);
    // /resume 候选排除当前在飞会话（事件级落盘：命令输入自身即时建档，不排除会把本次命令的自建档选为最新恢复目标）
    const currentId = this.journal?.currentId;
    const sessions = listSessions(dataDir).filter((s) => s.id !== currentId);
    if (sessions.length === 0) {
      this.pushMsg('system', t('No saved sessions yet', '暂无已保存会话'), { level: 'warn' });
      return;
    }
    // >8 项切 filterable 卡（规格 D6/D8）：全量直出、渲染层筛选，一次问询直达；≤8 项维持既有循环形态不变
    if (sessions.length > 8) {
      const items = sessions.map((s) => ({ label: s.id, description: s.firstUser ? s.firstUser.slice(0, 60) : t('(no user input)', '（无用户输入）') }));
      const answer = await this.askUser({
        question: t('Resume which session? (type to filter)', '恢复哪个会话？（输入即筛选）'),
        options: items,
        filterable: true,
      });
      if (answer.type !== 'selected') {
        this.pushMsg('system', t('Resume cancelled', '已取消恢复'));
        return;
      }
      const pick = sessions.find((s) => s.id === answer.labels[0]);
      if (!pick) {
        this.pushMsg('system', t('No such session: ' + (answer.labels[0] ?? ''), '没有这个会话：' + (answer.labels[0] ?? '')), { level: 'warn' });
        return;
      }
      this.restoreFromSession(pick);
      return;
    }
    const moreLabel = t('More…', '更多…');
    const backLabel = t('Back…', '上一页…');
    let page = 0;
    for (;;) {
      const shown = paginateOptions(
        sessions.map((s) => ({ label: s.id, description: s.firstUser ? s.firstUser.slice(0, 60) : t('(no user input)', '（无用户输入）') })),
        page,
      );
      const answer = await this.askUser({
        question: t('Resume which session?', '恢复哪个会话？'),
        options: shown.options,
      });
      if (answer.type === 'dismissed') {
        this.pushMsg('system', t('Resume cancelled', '已取消恢复'));
        return;
      }
      const pickedId = answer.type === 'custom' ? answer.text.trim() : (answer.labels[0] ?? '');
      if (pickedId === moreLabel) { page += 1; continue; }
      if (pickedId === backLabel) { page -= 1; continue; }
      const pick = sessions.find((s) => s.id === pickedId);
      if (!pick) {
        this.pushMsg('system', t('No such session: ' + pickedId, '没有这个会话：' + pickedId), { level: 'warn' });
        return;
      }
      this.restoreFromSession(pick);
      return;
    }
  }

  /** --continue（规格 D1/D3）：续接最近会话（listSessions mtime 降序首项，对标 CC -c）；无档提示后按新会话继续（不静默吞） */
  resumeLatest(): void {
    const dataDir = resolveDataDir(this.root);
    const meta = listSessions(dataDir)[0];
    if (!meta) {
      this.pushMsg('system', t('No saved session to continue; started a fresh one', '没有可续接的已保存会话，已开启新会话'), { level: 'warn' });
      return;
    }
    this.restoreFromSession(meta);
  }

  /** 恢复会话（规格 §6 恢复三面）：flush 当前 → 解析目标日志 → 版本守卫 → 三面直注入 → journal 续挂目标档 */
  private restoreFromSession(meta: SessionMeta): void {
    const parsed = parseJournalFile(meta.file);
    const replay = reduceJournal(parsed.events);
    if (replay.version !== 1) {
      this.pushMsg('system', t('Cannot restore this session: unsupported journal version', '无法恢复该会话：日志版本不受支持'), { level: 'error' });
      return;
    }
    // 三面还原（直注入不经 pushMsg/订阅——零重复入志、零前缀击穿）：链/压缩归 ContextManager；消息/待办/档位归控制器；UI 现场暂存供 entry 播种
    this.runtime.harness.context.restoreSession({ chain: replay.chain, chainFrom: replay.chainFrom, compacted: replay.compacted });
    this.msgSeq = replay.nextSeq;
    this.state = {
      ...this.state,
      messages: replay.messages,
      todos: replay.todos,
      status: 'idle',
      ...(replay.model !== undefined ? { model: replay.model } : {}),
      ...(replay.effort !== undefined ? { effort: replay.effort } : {}),
      approval: undefined,
      live: undefined,
      children: [],
    };
    this.restoredUi = { history: replay.history, expandAll: replay.view.expandAll, latestFull: replay.view.latestFull };
    this.ensureJournal().attach(meta.id);
    // 横幅在状态注入后上屏（注入前 push 会被 messages 覆盖吞掉）；撕裂场景合并提示，保持「消息 + 单条提示行」
    if (parsed.truncated) {
      this.pushMsg('system', t('Session restored: ' + meta.id + ' — journal tail was truncated (previous crash?); restored up to the last complete event', '已恢复会话：' + meta.id + '（日志尾部截断，此前可能异常退出；已恢复到最后一条完整事件）'), { level: 'warn' });
    } else {
      this.pushMsg('system', t('Session restored: ' + meta.id, '已恢复会话：' + meta.id));
    }
  }

  /** /rewind //fork 共用分支流程（rewind/fork 规格 §7）：锚点选择 → 分档 → 装载 → 代码回退（可选）→ 回执 + 输入回填 */
  private async branchFlow(kind: 'rewind' | 'fork'): Promise<void> {
    const dataDir = resolveDataDir(this.root);
    const srcId = this.journal?.currentId;
    const srcFile = srcId ? path.join(sessionsDir(dataDir), srcId + '.jsonl') : undefined;
    if (!srcId || !srcFile || !fs.existsSync(srcFile)) {
      this.pushMsg('system', t(kind === 'rewind' ? 'No journaled session to rewind' : 'No journaled session to fork', kind === 'rewind' ? '当前会话没有可回退的日志' : '当前会话没有可分叉的日志'), { level: 'warn' });
      return;
    }
    const parsed = parseJournalFile(srcFile);
    const anchors = listAnchors(parsed);
    if (anchors.length === 0) {
      this.pushMsg('system', t(kind === 'rewind' ? 'No turns to rewind yet' : 'No turns to fork yet', kind === 'rewind' ? '暂无可回退的任务轮' : '暂无可分叉的任务轮'), { level: 'warn' });
      return;
    }
    const a = await this.askUser({
      question: t(kind === 'rewind' ? 'Rewind to which turn?' : 'Fork from which turn?', kind === 'rewind' ? '回退到哪一轮？' : '从哪一轮分叉？'),
      options: anchors.map((x, i) => ({
        label: String(i + 1),
        description: x.text.length > 48 ? x.text.slice(0, 48) + '…' : x.text,
      })),
    });
    if (a.type === 'dismissed') {
      this.pushMsg('system', t(kind === 'rewind' ? 'Rewind cancelled' : 'Fork cancelled', kind === 'rewind' ? '已取消回退' : '已取消分叉'));
      return;
    }
    const idx = Number.parseInt(a.type === 'custom' ? a.text.trim() : (a.labels[0] ?? ''), 10) - 1;
    const anchor = Number.isInteger(idx) && idx >= 0 && idx < anchors.length ? anchors[idx] : undefined;
    if (!anchor) {
      this.pushMsg('system', t('No such turn', '没有这一轮'), { level: 'warn' });
      return;
    }
    let codeAction = false;
    if (kind === 'rewind') {
      const hasFiles = collectRestorePlan(srcFile, anchor.line).length > 0;
      const opts = hasFiles ? ['code and conversation', 'conversation only', 'code only'] : ['conversation only'];
      const b = await this.askUser({
        question: t('What to restore?', '恢复哪些内容？'),
        options: opts.map((label) => ({ label })),
      });
      if (b.type === 'dismissed') {
        this.pushMsg('system', t('Rewind cancelled', '已取消回退'));
        return;
      }
      const picked = b.type === 'custom' ? b.text.trim() : (b.labels[0] ?? '');
      if (picked === 'code and conversation' || picked === 'code only') codeAction = true;
    } else {
      const c = await this.askUser({
        question: t('Fork a parallel session from this turn?', '从这一轮分叉出平行会话？'),
        options: [{ label: 'fork' }],
      });
      if (c.type === 'dismissed') {
        this.pushMsg('system', t('Fork cancelled', '已取消分叉'));
        return;
      }
    }
    let newId: string;
    try {
      newId = branchFrom(dataDir, srcId, anchor.line - 1, kind); // 锚点行不进新档（规格 §5.2）
    } catch (err) {
      this.pushMsg('system', t('Branch failed: ' + String((err as Error).message), '分档失败：' + String((err as Error).message)), { level: 'warn' });
      return;
    }
    // 续挂新档并切指针（不可变分档：源档零改动；事件级落盘下 restore 无收口写回面）
    this.journal?.attach(newId);
    this.restoreFromSession({ id: newId, file: path.join(sessionsDir(dataDir), newId + '.jsonl'), updatedAt: Date.now() });
    if (kind === 'rewind' && codeAction) {
      const plan = collectRestorePlan(srcFile, anchor.line); // 以分支前源档收集（规格 §6.2）
      const r = applyRestorePlan(this.root, plan, path.join(dataDir, 'sessions', '_blobs'));
      const parts = [
        r.restored.length > 0 ? `${r.restored.length} restored` : '',
        r.removed.length > 0 ? `${r.removed.length} removed` : '',
        r.skipped.length > 0 ? `${r.skipped.length} skipped` : '',
      ].filter(Boolean).join(', ');
      this.pushMsg('system', t('Code restored to turn start (' + parts + ')', '代码已回退到该轮起点（' + parts + '）'), r.skipped.length > 0 ? { level: 'warn' } : undefined);
    }
    const anchorIdx = anchors.indexOf(anchor) + 1;
    if (kind === 'rewind') {
      this.pushMsg('system', t(`Rewound to turn ${anchorIdx} — previous timeline kept, /resume to return`, `已回退到第 ${anchorIdx} 轮——原时间线保留，/resume 可回`));
    } else {
      this.pushMsg('system', t(`Forked new session from turn ${anchorIdx} — source session kept`, `已从第 ${anchorIdx} 轮分叉出新会话——源会话保留`));
    }
    this.state = { ...this.state, backfill: anchor.text }; // 锚点轮输入回填（重发经正常任务提交进链）
    this.notify();
  }

  /** 退出清理（规格 §3.5）：清空闲兜底节拍定时器——防长驻进程重挂/多实例测试下定时器累积（评审 Important-1）；幂等 */
  dispose(): void {
    if (this.kickTimer !== undefined) clearInterval(this.kickTimer);
    this.kickTimer = undefined;
    // MCP 连接收口：关闭 stdio 子进程防悬挂（fire-and-forget，退出路径零阻塞）
    void this.runtime.harness.mcpClose();
  }

  private closeTask(): void {
    if (this.state.status !== 'running' && this.state.status !== 'awaiting-plan') return;
    this.taskAbort = undefined;
    this.state = {
      ...this.state,
      status: 'idle',
      metrics: { ...this.state.metrics, turnStartedAt: 0 },
      children: [], // 生命周期清空（规格 §4.4）：正常归档后本已为空，此处兜底孤儿面板
    };
    this.childBufs.clear();
    this.spawnCalls = [];
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
      ...(this.state.model ? { tier: this.state.model } : {}),
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
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, sessionTurns: this.state.metrics.sessionTurns + 1 },
      live: undefined,
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
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
          ...(this.state.model ? { tier: this.state.model } : {}),
          ...(this.state.effort ? { effort: this.state.effort } : {}),
          ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
        });
        if (r.stopReason === 'interrupted') this.pushInterruptedNotice();
        this.reportIncomplete(r, 'warn');
        this.closeTask();
        return;
      }
      // 主链任务（§11 只增不改）：当前指令行尾追进链，reactor 会话作用域收束自动回写全量步骤与结论/补丁行
      ctx.appendInstructionLine(`Current instruction: ${goal}`);
      const r = await this.runtime.runTask(goal, {
        ...(this.state.model ? { tier: this.state.model } : {}),
        ...(this.state.effort ? { effort: this.state.effort } : {}),
        ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
      });
      if (r.stopReason === 'interrupted') this.pushInterruptedNotice();
      this.reportIncomplete(r, 'warn');
      this.closeTask();
    } catch (e) {
      this.pushMsg('system', t(`Error: ${e instanceof Error ? e.message : String(e)}`, `发生错误：${e instanceof Error ? e.message : String(e)}`), { level: 'error' });
      this.state = { ...this.state, status: 'error' };
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
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, sessionTurns: this.state.metrics.sessionTurns + 1 },
      live: undefined,
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.turnMissHinted = false; // 新任务轮：轮首 miss 判定重置（观测小件）
    this.taskAbort = new AbortController();
    this.notify();
    try {
      this.runtime.harness.context.appendInstructionLine(`Current instruction: ${goal} (/goal)`);
      this.pushMsg('system', t(`✻ /goal: ${goal}`, `✻ /goal：${goal}`));
      const r = await this.runtime.runLoop(goal, {
        ...(this.state.model ? { tier: this.state.model } : {}),
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
      this.state = { ...this.state, status: 'error' };
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
    // 自由文本参数命令（目标/关注点/记忆内容）不在枚举范围，带参放行
    const FREE_TEXT_ARGS = new Set(['/compact', '/plan', '/goal', '/memory-add']);
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
    if (cmd === '/tasks') {
      // 后台任务表（规格 D7，对标 CC /tasks）：id/kind/status/label + 输出路径；模型可 read 查看输出、task_stop 停止
      const list = this.runtime.harness.tasks.list();
      if (list.length === 0) {
        this.pushMsg('system', t('No background tasks.', '暂无后台任务。'));
        return;
      }
      const rows = list.map((x) => `${x.id}\t${x.kind}\t${x.status}\t${x.label}\t(output: ${x.outputFilePath})`);
      this.pushMsg('system', t(
        `Background tasks:\n${rows.join('\n')}\nInspect output with read; stop with the task_stop tool.`,
        `后台任务：\n${rows.join('\n')}\n输出可用 read 查看；可用 task_stop 工具停止。`,
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
        this.committedLen = 0;
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
        },
        children: [],
        task: initialTaskState(),
        ...(this.state.model ? { model: this.state.model } : {}),
        live: undefined,
      };
      this.childBufs.clear();
      this.spawnCalls = [];
      this.runtime.harness.context.resetSession();
      this.pushMsg('system', t('Soft reset: messages, todos, session chain and compacted summary cleared; session approvals cleared (memory & ledger kept)', '软重置：消息、待办、会话链与压缩摘要已清空，会话级审批登记已清除（记忆与账本保留）'));
      return;
    }
    if (cmd === '/model') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /model unavailable now', '当前有任务进行中，暂不能执行 /model'), { level: 'warn' });
        return;
      }
      const current = this.state.model;
      const answer = await this.askUser({
        question: t(current ? `Switch model tier (current: ${current})` : 'Switch model tier (current: default)', current ? `切换模型档位（当前 ${current}）` : '切换模型档位（当前默认）'),
        options: (['small', 'medium', 'large'] as const).map((tier) => ({ label: tier, description: tier === current ? t('current', '当前档') : undefined })),
      });
      if (answer.type !== 'selected') {
        this.pushMsg('system', t('Model tier unchanged', '模型档位未变更'));
        return;
      }
      const tier = parseTier(answer.labels[0] ?? '');
      if (!tier) return;
      this.state = { ...this.state, model: tier };
      this.notify();
      this.logModel();
      this.pushMsg('system', t(`Model tier set to ${tier}; applies to subsequent tasks`, `模型档位已设为 ${tier}；对后续任务生效`));
      return;
    }
    if (cmd === '/model-effort') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /model-effort unavailable now', '当前有任务进行中，暂不能执行 /model-effort'), { level: 'warn' });
        return;
      }
      const current = this.state.effort;
      const answer = await this.askUser({
        question: t(current ? `Switch reasoning effort (current: ${current})` : 'Switch reasoning effort (current: adapter default)', current ? `切换思考强度（当前 ${current}）` : '切换思考强度（当前适配器缺省）'),
        options: [...EFFORT_ORDER, 'default' as const].map((v) => ({ label: v, description: v === current ? t('current override', '当前覆盖') : undefined })),
      });
      if (answer.type !== 'selected') {
        this.pushMsg('system', t('Reasoning effort unchanged', '思考强度未变更'));
        return;
      }
      const value = answer.labels[0] ?? '';
      if (value === 'default') {
        this.state = { ...this.state, effort: undefined };
        this.notify();
        this.logModel();
        this.pushMsg('system', t('Reasoning effort cleared; adapter default applies to subsequent tasks', '思考强度已清除；后续任务回适配器缺省'));
        return;
      }
      const effort = parseEffort(value);
      if (!effort) return;
      this.state = { ...this.state, effort };
      this.notify();
      this.logModel();
      // 回执回显实际生效档（规格 §5.2）：端点不支持时探测降级，取 adapter 探测缓存；接口未实现/未探测时与请求档一致
      const resolved = this.runtime.harness.model.resolvedEffort?.(effort) ?? effort;
      this.pushMsg('system', t(`Reasoning effort set to ${resolved}; applies to subsequent tasks`, `思考强度已设为 ${resolved}；对后续任务生效`));
      return;
    }
    if (cmd === '/resume') {
      // 恢复入口（规格 §6/D6）：无参选择卡（mtime 降序 + 首条输入摘要），>8 条 filterable 全量卡（筛选在渲染层）、≤8 条分页；
      // 带参形态已由裸形式守卫统一无法识别——此处只认无参
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /resume unavailable now', '当前有任务进行中，暂不能执行 /resume'), { level: 'warn' });
        return;
      }
      await this.resumeFlow();
      return;
    }
    if (cmd === '/rewind' || cmd === '/fork') {
      // 会话回退/分叉（rewind/fork 规格 §7）：idle 守卫沿 /resume 先例，运行中拒绝
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; ' + cmd + ' unavailable now', '当前有任务进行中，暂不能执行 ' + cmd), { level: 'warn' });
        return;
      }
      await this.branchFlow(cmd === '/rewind' ? 'rewind' : 'fork');
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
    if (cmd === '/memory') return this.memoryList();
    if (cmd === '/memory-add') return this.memoryAdd(text.slice(cmd.length).trim());
    if (cmd === '/memory-rm') return this.memoryRm();
    if (cmd === '/memory-gc') return this.memoryGc();
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
    const builtin = new Set(SLASH_COMMANDS.map((c) => c.slice(1)));
    return this.runtime.harness.skills
      .list()
      .filter((m) => /^[a-z0-9][a-z0-9_-]*$/.test(m.id) && !builtin.has(m.id))
      .map((m) => m.id)
      .sort();
  }

  /** 技能加载单点（规格 D3，自 skillFlow 尾段提取）：链上去重 → resolve → 链尾追持久注入 → 回执；
   *  /skill 选择卡与 /<技能id> 命令同源消费；failed 不派发后续任务（D4） */
  private loadSkill(id: string): 'loaded' | 'already' | 'failed' {
    if (this.runtime.harness.context.chainView().some((s) => s.action === 'skill' && s.observation.includes(`(id=${id} v=`))) {
      this.pushMsg('system', t(`Skill ${id} already loaded in this session`, `技能 ${id} 本会话已加载`));
      return 'already';
    }
    const r = this.runtime.harness.skills.resolve(id);
    if (!r.ok) {
      this.pushMsg('system', t(`Skill load failed: ${r.error.message}`, `技能加载失败：${r.error.message}`), { level: 'warn' });
      return 'failed';
    }
    const m = r.value.manifest;
    // 链尾追持久注入（先例 D2）：头行对齐 loop skillRef 既有格式，正文随后续每帧经链携带
    this.runtime.harness.context.appendChain([{ action: 'skill', observation: `[Skill] ${m.name} (id=${m.id} v=${m.version})\n\n${r.value.body}` }]);
    this.pushMsg('system', t(`Skill loaded: ${m.name} (id=${m.id}) — included in context for subsequent tasks`, `技能已加载：${m.name}（id=${m.id}）——随后续任务进上下文`));
    return 'loaded';
  }

  /** /memory：无参列索引（查看态） */
  private memoryList(): void {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /memory unavailable now', '当前有任务进行中，暂不能执行 /memory'), { level: 'warn' });
      return;
    }
    const store = new MemoryStore(this.root);
    const records = store.list();
    const capacity = store.capacityNotice();
    if (records.length === 0) {
      this.pushMsg('system', [t('No memories yet — /memory-add <text> to add one', '暂无记忆——用 /memory-add <内容> 添加一条'), this.memoryStateLine(), ...(capacity ? [capacity] : [])].join('\n'));
      return;
    }
    const lines = records.map((r) => `- ${r.slug} [${r.type}] (${r.created}) ${r.description}`);
    this.pushMsg('system', [t(`Persistent memories (${records.length}):`, `持久记忆（${records.length} 条）：`), ...lines, this.memoryStateLine(), ...(capacity ? [capacity] : [])].join('\n'));
  }

  /** /memory-add：自由文本内容写入（与自动提取同一写时闸门）；空内容按规格 D2 落统一无法识别文案 */
  private memoryAdd(rest: string): void {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /memory-add unavailable now', '当前有任务进行中，暂不能执行 /memory-add'), { level: 'warn' });
      return;
    }
    if (!rest) {
      this.pushMsg('system', t('Unrecognized command. Use /help to see available commands', '无法识别命令，使用 /help 查看使用方法'), { level: 'warn' });
      return;
    }
    const store = new MemoryStore(this.root);
    const flagged = scanMemoryText(rest);
    if (flagged) {
      this.pushMsg('system', t(`Rejected: session-scoped or unsafe content (${flagged}); not persisted`, `已拒绝：会话性内容或含注入特征（${flagged}），不落盘`), { level: 'warn' });
      return;
    }
    const r = store.add({ type: 'project', description: rest, body: rest });
    if (r.ok) {
      this.pushMsg('system', t(`Added memory: ${r.value.slug} (applies from the next session or refresh point)`, `已添加记忆：${r.value.slug}（下个会话或刷新点生效）`));
    } else if (r.error.code === 'MEMORY_DUPLICATE') {
      this.pushMsg('system', t(`Duplicate memory rejected: ${rest}`, `重复记忆已拒绝：${rest}`), { level: 'warn' });
    } else {
      this.pushMsg('system', r.error.message, { level: 'error' });
    }
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

  /** /memory-rm：多选卡批删（规格 D5/D6）：Space 勾选、Enter 批删、Esc 取消零删除；>8 条 filterable 全量卡（渲染层筛选）、≤8 条分页、勾选跨页累积 */
  private async memoryRm(): Promise<void> {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /memory-rm unavailable now', '当前有任务进行中，暂不能执行 /memory-rm'), { level: 'warn' });
      return;
    }
    const store = new MemoryStore(this.root);
    const records = store.list();
    if (records.length === 0) {
      this.pushMsg('system', t('No memories yet — /memory-add <text> to add one', '暂无记忆——用 /memory-add <内容> 添加一条'), { level: 'warn' });
      return;
    }
    const items = records.map((r) => ({ label: r.slug, description: `${r.type} · ${r.description} (${r.created})` }));
    // >8 条切 filterable 卡（规格 D6/D8）：一次问询勾选批删；≤8 条维持既有分页循环不变
    if (items.length > 8) {
      const answer = await this.askUser({
        question: t('Select memories to delete (Space to toggle, Enter to delete; type to filter)', '选择要删除的记忆（Space 勾选，Enter 批量删除；输入即筛选）'),
        options: items,
        multiple: true,
        filterable: true,
      });
      if (answer.type !== 'selected' || answer.labels.length === 0) {
        this.pushMsg('system', t('No memories removed', '未删除任何记忆'));
        return;
      }
      this.applyMemoryRemoval(store, answer.labels);
      return;
    }
    const moreLabel = t('More…', '更多…');
    const backLabel = t('Back…', '上一页…');
    const picked: string[] = [];
    let page = 0;
    for (;;) {
      const shown = paginateOptions(items, page);
      const answer = await this.askUser({
        question: t('Select memories to delete (Space to toggle, Enter to delete)', '选择要删除的记忆（Space 勾选，Enter 批量删除）'),
        options: shown.options,
        multiple: true,
      });
      if (answer.type !== 'selected') {
        this.pushMsg('system', t('No memories removed', '未删除任何记忆'));
        return;
      }
      // 导航项（More…/Back…）与后续勾选同卡互斥语义外的共存形态：含导航即翻页，其余勾选跨页累积
      const picks = answer.labels.filter((l) => l !== moreLabel && l !== backLabel);
      picked.push(...picks);
      if (answer.labels.includes(moreLabel)) { page += 1; continue; }
      if (answer.labels.includes(backLabel)) { page -= 1; continue; }
      break;
    }
    this.applyMemoryRemoval(store, picked);
  }

  /** 批删执行面（/memory-rm 分页与 filterable 两形态共用单点）：去重→逐条删除→回执 */
  private applyMemoryRemoval(store: MemoryStore, picked: string[]): void {
    const unique = [...new Set(picked)];
    if (unique.length === 0) {
      this.pushMsg('system', t('No memories removed', '未删除任何记忆'));
      return;
    }
    let ok = 0;
    let fail = 0;
    for (const slug of unique) {
      const r = store.remove(slug);
      if (r.ok) ok += 1;
      else fail += 1;
    }
    const capacity = store.capacityNotice();
    this.pushMsg('system', [
      t(ok === 1 ? `Removed 1 memory${fail ? ` (${fail} failed)` : ''}` : `Removed ${ok} memories${fail ? ` (${fail} failed)` : ''}`, `已删除 ${ok} 条${fail ? `（失败 ${fail} 条）` : ''}`),
      ...(capacity ? [capacity] : []),
    ].join('\n'));
  }

  /** /memory-gc：显式整理入口（阈值外 force），与自动整理同一 consolidate 函数 */
  private async memoryGc(): Promise<void> {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /memory-gc unavailable now', '当前有任务进行中，暂不能执行 /memory-gc'), { level: 'warn' });
      return;
    }
    const store = new MemoryStore(this.root);
    if (!isModelSummarizer(this.runtime.harness.model)) {
      this.pushMsg('system', t('Consolidation requires a real model (current channel is stub/scripted)', '整理需要真实模型（当前通道为 stub/scripted）'), { level: 'warn' });
      return;
    }
    if (store.count() === 0) {
      this.pushMsg('system', t('No memories yet — nothing to consolidate', '暂无记忆——没有可整理的内容'), { level: 'warn' });
      return;
    }
    await consolidateMemory({ model: this.runtime.harness.model, root: this.root, force: true });
    this.pushMsg('system', t(`Consolidated persistent memory: ${store.count()} records`, `持久记忆已整理：${store.count()} 条`));
  }

  private onEvent(e: SessionEvent): void {
    // 子代理事件分流（规格 §4.1）：带 payload.subagent 标签的事件路由至面板态，不触达主链任何分支
    const sub = e.payload?.subagent;
    if (typeof sub === 'string' && sub.length > 0) {
      this.onChildEvent(e, sub);
      return;
    }
    this.state = { ...this.state, task: applyTaskState(this.state.task, e) };
    switch (e.type) {
      case 'notice':
        // 收口说明行用户面（规格 §10）：记忆/技能沉淀以一行增量告知（内容为英文链行原文，照原样不译）
        this.pushMsg('system', String(e.payload?.text ?? e.text ?? ''));
        return;
      case 'token':
        // chat 主通道正文增量直连（token 承载纯正文，无协议骨架过滤层）
        this.appendLive('reply', e.text ?? '');
        if (this.state.live?.kind === 'reply') this.flushReply();
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
          },
        };
        this.notify();
        return;
      }
      case 'tool-call': {
        this.closeLive();
        this.committedLen = 0;
        this.pushMsg('tool', toolCallLine(e.text ?? '', e.payload?.input), { kind: 'call' });
        // spawn 调用关联栈（规格 §4.4）：压行 seq + 基名，成对语义下 spawn tool-result 必然紧跟其后弹出归档
        if (e.text === 'spawn') this.spawnCalls.push({ seq: this.msgSeq, base: spawnBaseLabel(e.payload?.input) });
        return;
      }
      case 'tool-result':
        if (e.payload?.tool === 'spawn') this.archiveChild();
        this.pushMsg('tool', e.text ?? '', {
          kind: 'result',
          ok: e.payload?.ok === true,
          detail: typeof e.payload?.full === 'string' ? e.payload.full : undefined,
        });
        return;
      case 'step': {
        // 步数计账：模型动作步（done 收尾帧不计、子代理事件已分流不达此处），会话累计、/new 归零（状态栏 turns/steps 段数据源）
        if (e.text !== 'done') {
          this.state = { ...this.state, metrics: { ...this.state.metrics, sessionSteps: this.state.metrics.sessionSteps + 1 } };
        }
        // phase 阶段行：模型主动播报的当前进度（1-2 行），先于对应动作/答复上屏；无 phase 的 step 与工具行信息重复，不上屏
        const phase = typeof e.payload?.phase === 'string' ? e.payload.phase.trim().slice(0, 200) : '';
        if (phase) this.pushMsg('step', phase);
        return;
      }
      case 'done': {
        const draft = this.state.live?.kind === 'reply' ? this.state.live.text : '';
        this.closeLive();
        if (this.planReplyNoArchive) {
          // 规划轮终稿不重复入档：计划正文仅以确认卡形态上屏一次
          this.committedLen = 0;
          this.refreshMetrics();
          return;
        }
        if (e.payload?.stopReason === 'model-error') {
          // D6：模型失败已由 error 通道上屏，done 收尾帧携带的同一错误文案不再以 assistant 终答身份重复入档
          this.committedLen = 0;
          this.refreshMetrics();
          return;
        }
        const finalText = e.text && e.text.length > 0 ? e.text : draft;
        // 流式切块已入档的部分按前缀去重；终稿兜底补齐尾段（含非流式整段场景），水位归零
        let tail = finalText;
        if (this.committedLen > 0 && finalText.startsWith(draft.slice(0, this.committedLen))) {
          tail = finalText.slice(this.committedLen);
        }
        if (tail.length > 0) this.pushMsg('assistant', tail);
        this.committedLen = 0;
        this.refreshMetrics();
        return;
      }
      case 'error':
        this.closeLive();
        this.committedLen = 0;
        this.pushMsg('system', t(`Error: ${e.text ?? '(no detail)'}`, `错误：${e.text ?? '（无说明）'}`), { level: 'error' });
        this.refreshMetrics();
        return;
      default:
        return; // route / approval-* 不落消息区
    }
  }

  /** 记忆开关状态行（/memory 无参列表尾追；外观面 t() 双语） */
  private memoryStateLine(): string {
    const on = this.memoryOverride ?? resolveMemoryConfig().autoMemory;
    if (this.memoryOverride !== undefined) {
      return this.memoryOverride
        ? t('Persistent memory: ON for this session (session override, not persisted)', '持久记忆：本会话开启（会话内覆盖，不落盘）')
        : t('Persistent memory: OFF for this session (session override, not persisted)', '持久记忆：本会话关闭（会话内覆盖，不落盘）');
    }
    return on
      ? t('Persistent memory: ON', '持久记忆：开启')
      : t('Persistent memory: OFF', '持久记忆：关闭');
  }

  private pushMsg(role: ChatRole, text: string, extra?: Partial<Pick<ChatItem, 'kind' | 'ok' | 'detail' | 'level'>>): void {
    const item: ChatItem = { role, text, ts: Date.now(), seq: ++this.msgSeq, ...(extra ?? {}) };
    this.state = { ...this.state, messages: [...this.state.messages, item] };
    // 消息流入志（单一挂钩点：所有入档消息都经 pushMsg）；恢复注入不经此处（零重复入志）
    this.journal?.log({ t: 'msg', item });
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

  /** 子代理事件处理（规格 §4.3）：首事件创建面板态；增量行化、结构事件即时行化；不触达主链任何分支 */
  private onChildEvent(e: SessionEvent, label: string): void {
    let list = this.state.children;
    let idx = list.findIndex((c) => c.label === label);
    if (idx < 0) {
      list = [...list, { label, startedAt: Date.now(), steps: 0, tokens: 0, transcript: [], tail: [], done: false }];
      idx = list.length - 1;
    }
    const child = list[idx];
    let buf = this.childBufs.get(label) ?? '';
    // 结构事件先冲刷半行（保持转录时序：正文半行 → 结构行）
    let transcript = child.transcript;
    let steps = child.steps;
    let tokens = child.tokens;
    switch (e.type) {
      case 'token':
      case 'reasoning': {
        buf += e.text ?? '';
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        transcript = [...child.transcript, ...parts.filter((l) => l.length > 0)];
        break;
      }
      case 'tool-call': {
        if (buf) {
          transcript = [...transcript, buf];
          buf = '';
        }
        transcript = [...transcript, toolCallLine(e.text ?? '', e.payload?.input)];
        break;
      }
      case 'tool-result': {
        if (buf) {
          transcript = [...transcript, buf];
          buf = '';
        }
        transcript = [...transcript, e.text ?? ''];
        break;
      }
      case 'step':
        steps = child.steps + 1;
        break;
      case 'usage':
        // per-run turnTotal 为该子代理 run 的累计值（单一 run），直接采信
        tokens = typeof e.payload?.turnTotal === 'number' ? e.payload.turnTotal : child.tokens;
        break;
      case 'done':
      case 'error': {
        // 完成态即时落面板（并行批早完成者显终标、不再转圈）：done 终稿行补进转录；归档锚点仍在主链 tool-result
        const isError = e.type === 'error';
        if (buf) {
          transcript = [...transcript, buf];
          buf = '';
        }
        const finalLine = e.text && e.text.length > 0 ? e.text : isError ? 'failed' : 'done';
        transcript = [...transcript, finalLine];
        return this.commitChild(list, idx, { ...child, transcript, steps, tokens, done: true }, buf);
      }
      default:
        return; // ctx/route/approval-* 不入面板态（done/error 已置终态；归档锚点在主链 tool-result）
    }
    this.commitChild(list, idx, { ...child, transcript, steps, tokens }, buf);
  }

  /** 面板态收尾单点：半行留存 + 尾流派生 + 节流通知（常规事件与 done/error 终态共用） */
  private commitChild(list: ChildLiveState[], idx: number, next: ChildLiveState, buf: string): void {
    const label = next.label;
    if (buf) this.childBufs.set(label, buf);
    else this.childBufs.delete(label);
    const withTail: ChildLiveState = { ...next, tail: childTail(next.transcript, buf) };
    this.state = { ...this.state, children: list.map((c, i) => (i === idx ? withTail : c)) };
    this.notifyThrottled();
  }

  /** spawn 结果归档（规格 §4.4）：弹出关联栈（行 seq + 基名）→ 精确/# 前缀/FIFO 匹配未归档子代理 → 半行冲刷 → 转录折入该调用行 detail */
  private archiveChild(): void {
    const pending = this.spawnCalls.shift();
    if (pending === undefined) return;
    const list = this.state.children;
    let idx = list.findIndex((c) => c.label === pending.base);
    if (idx < 0) idx = list.findIndex((c) => c.label.startsWith(`${pending.base}#`));
    if (idx < 0 && list.length > 0) idx = 0;
    if (idx < 0) return; // 未命中（如 INVALID_ARG 即败，零子事件）：静默跳过（规格 §8 孤儿容忍）
    const child = list[idx];
    const buf = this.childBufs.get(child.label) ?? '';
    this.childBufs.delete(child.label);
    const detail = [...child.transcript, ...(buf ? [buf] : [])].join('\n');
    const subagentMeta = { steps: Math.max(1, child.steps), durationMs: Math.max(0, Date.now() - child.startedAt) };
    this.state = {
      ...this.state,
      children: list.filter((_, i) => i !== idx),
      messages: this.state.messages.map((m) => (m.seq === pending.seq ? { ...m, detail, subagentMeta } : m)),
    };
    this.notify();
  }

  /** 追加实时区内容：同类续接；异类先收束旧块（thinking 折叠为摘要行，reply 交由 done 定稿避免重复） */
  private appendLive(kind: LiveBlock['kind'], delta: string): void {
    if (!delta) return;
    const live = this.state.live;
    if (live && live.kind !== kind) this.closeLive();
    const cur = this.state.live;
    if (cur && cur.kind === kind) {
      this.state = { ...this.state, live: { ...cur, text: cur.text + delta } };
    } else {
      this.state = { ...this.state, live: { kind, text: delta, startedAt: Date.now() } };
      this.notify(); // 块首帧即时上屏：保证流式可观测与首字延迟，后续增量并入合帧窗口
      return;
    }
    this.notifyThrottled();
  }

  /**
   * 流式正文安全点增量入档：以「空行段落边界优先、围栏代码块不切、超长段兜底」切块推进水位，
   * 每块一次 pushMsg（对标 Claude Code 打字机式滚动出稿——正文随生成滚入滚动缓冲，不再等 done 整段落屏）。
   */
  private flushReply(): void {
    const draft = this.state.live?.kind === 'reply' ? this.state.live.text : '';
    if (!draft) return;
    if (this.planReplyNoArchive) {
      // 规划轮正文不入档（只以确认卡上屏一次）：水位照常推进，live 预览维持「未入档尾段」口径
      this.committedLen = draft.length;
      if (this.state.live?.kind === 'reply') {
        this.state = { ...this.state, live: { ...this.state.live, committedLen: draft.length } };
      }
      return;
    }
    const seg = stableReplySegment(draft, this.committedLen);
    if (seg === null) return;
    const committed = this.committedLen + seg.length;
    if (seg.trim().length > 0) {
      // 原样入档（含边界换行）：分块拼接 === 终稿，不留重复也不丢段落空行；纯空白段只推进水位
      this.state = {
        ...this.state,
        messages: [...this.state.messages, { role: 'assistant', text: seg, ts: Date.now(), seq: ++this.msgSeq }],
      };
      this.notify();
    }
    this.committedLen = committed;
    if (this.state.live?.kind === 'reply') {
      this.state = { ...this.state, live: { ...this.state.live, committedLen: committed } };
    }
  }

  /** 收束实时区：thinking 折叠为一行摘要；reply 不落消息（终稿由 done 接管） */
  private closeLive(): void {
    const live = this.state.live;
    if (!live) return;
    this.state = { ...this.state, live: undefined };
    if (live.kind === 'thinking') {
      const secs = Math.max(1, Math.round((Date.now() - live.startedAt) / 1000));
      this.pushMsg('thinking', `Thought for ${secs}s`, { detail: live.text });
      return;
    }
    this.notify();
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
  private static readonly NOTIFY_THROTTLE_MS = 120; // 流式合帧窗口：≥100ms 显著降低整帧擦写频率（ink 无逐行 diff，动态区任一行变化即全帧重写），~8 帧/s 观感仍连续
  private notifyTimer?: NodeJS.Timeout;

  private notify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    for (const cb of this.listeners) cb(this.state);
  }

  /** 增量合帧：窗口内多次状态变更只通知一次（监听方取到的总是最新状态）；定时器不持有进程引用 */
  private notifyThrottled(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.notify();
    }, SessionController.NOTIFY_THROTTLE_MS);
    this.notifyTimer.unref();
  }
}

