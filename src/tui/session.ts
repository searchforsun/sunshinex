import { ApprovalDecision, ApprovalRequest, HistoryStep, ModelTier, SessionEvent } from '../types';
import { RunOutcome, TuiRuntime, TuiRuntimeOpts, createRuntime } from './runtime';
import { parseTier } from '../runtime';
import { estimateTokens } from '../harness/context/window';
import { ReplyStreamExtractor } from './stream-extractor';
import { stableReplySegment } from './reply-flusher';
import { toolCallLine } from './tool-verbs';
import { describeIncomplete } from './stop-reason';
import { t } from '../i18n';
import { ContextManager, chainToHistoryItems, runCompaction } from '../harness/context';
import { sunshineInitGoal } from '../harness/sunshine-init';
import { DEFAULT_GOAL_TEMPLATE, TEMPLATE_NAMES } from '../loop/templates';
import * as fs from 'fs';
import * as path from 'path';

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
  /** 可展开原文：thinking 折叠行的思考全文 / tool 结果行的完整 observation（入档后折叠打印，供后续 transcript 视图） */
  detail?: string;
}

export interface TodoItem {
  text: string;
  done: boolean;
}

export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'awaiting-plan' | 'error';

export interface StatusMetrics {
  turnStartedAt: number;
  turnTokens: number;
  /** 本轮 prompt 缓存命中 tokens（usage 事件 cacheHitTotal 聚合；状态栏缓存命中率的分子） */
  turnCacheTokens: number;
  /** 本轮 prompt tokens（usage 事件 promptTotal 聚合；缓存命中率分母，与 turnCacheTokens 同量纲） */
  turnPromptTokens: number;
  runs: number;
  hitRate: number;
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
  /** 用户级模型档位（/model 会话内切换；undefined = 缺省主模型，run 级常量不随步重估） */
  model?: ModelTier;
}

export interface SessionOpts extends TuiRuntimeOpts {
  /** manual 模式审批回调（终端化审批装配点；渲染层注入交互实现） */
  asker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
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
function slashHelp(): string {
  return t(
    'Commands: /init analyze & write SUNSHINE.md · /goal run full verify-fix loop: /goal <goal> [--template=code-refactor|test-loop|code-review] · /new new session (soft reset) · /compact compress context · /status session & ledger summary · /model model tier (small|medium|large) · /help show this list',
    '命令：/init 分析生成/完善 SUNSHINE.md · /goal 运行完整验收修正环：/goal <目标> [--template=code-refactor|test-loop|code-review] · /new 新会话（软重置） · /compact 压缩上下文 · /status 会话与账本摘要 · /model 模型档位（small|medium|large） · /help 本清单',
  );
}

/** 会话控制器：事件进 → 状态变更（渲染层订阅）；斜杠命令解析、FIFO 排队、审批挂起/回填；纯逻辑可独立单测 */
export class SessionController {
  readonly runtime: TuiRuntime;
  /** 项目根：/init 生成 SUNSHINE.md 的基准目录（与 runtime 装配同源） */
  private readonly root: string;
  private readonly extractor = new ReplyStreamExtractor((t) => this.appendLive('reply', t));
  /** 流式正文已入档水位（done 终稿前缀长度）：安全点切块入档用，reset 回合随 extractor 一并归零 */
  private committedLen = 0;
  /** /plan 规划轮：计划正文只以确认卡上屏一次，流式切块与 done 终稿均不再重复入档（重复显示根因） */
  private planReplyNoArchive = false;
  /** usage 整场基线：每个模型轮开始前同步为当前累计，事件按「基线 + 本轮 per-run 值」聚合（/plan 步骤间不重置窗口） */
  private usageBase = { tokens: 0, cache: 0, prompt: 0 };
  private state: TuiState = {
    messages: [],
    todos: [],
    status: 'idle',
    metrics: { turnStartedAt: 0, turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, runs: 0, hitRate: 0, ctxUsed: 0 },
    children: [],
  };
  private listeners = new Set<(s: TuiState) => void>();
  private queue: { goal: string; resolve: () => void }[] = [];
  /** 消息全局单调序号（Static 区 key 唯一性来源）；/new 清空消息但不回绕 */
  private msgSeq = 0;
  /** 子代理半行缓冲（label → 未成行）：token/reasoning 增量拼接、遇换行成行入 transcript */
  private childBufs = new Map<string, string>();
  /** spawn 调用关联栈（FIFO）：主链 spawn tool-call 压栈（行 seq + 关联基名）、spawn tool-result 弹出归档（规格 §4.4 配对语义） */
  private spawnCalls: { seq: number; base: string }[] = [];
  private pendingApproval?: { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void };
  /** 挂起的计划确认卡（/plan 流程）；confirmPlan 裁决后清除 */
  private pendingPlan?: { items: string[] };
  /** 裁决权注入（SessionOpts.asker）：挂起语义不变，回填后咨询并以其为最终裁决 */
  private autoAsker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;

  constructor(opts: SessionOpts) {
    this.root = opts.root;
    this.runtime = opts.runtime ?? createRuntime({
      root: opts.root,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.tier ? { tier: opts.tier } : {}),
      onEvent: (e) => this.onEvent(e),
    });
    const suspendAsker = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      // 终端化审批：guard ask → 挂起（awaiting-approval + 审批卡）→ 裁决回填 → 继续；
      // 有外部 asker（headless/脚本）时委托之，状态转换保持一致便于观测与渲染
      this.state = { ...this.state, status: 'awaiting-approval', approval: req };
      this.notify();
      // 挂起等回填（App 模态/测试直调）；opts.asker 为裁决权注入，回填后咨询并以其为最终裁决
      let d = await new Promise<ApprovalDecision>((resolve) => {
        this.pendingApproval = { req, resolve };
      });
      if (this.autoAsker) d = await this.autoAsker(req);
      this.state = { ...this.state, approval: undefined, status: 'running' };
      this.notify();
      return d;
    };
    this.autoAsker = opts.asker;
    if (opts.mode === 'manual') this.runtime.harness.security.setAsker(suspendAsker);
    this.state = { ...this.state, metrics: { ...this.state.metrics, runs: this.runtime.harness.ledger.summary().runs } };
    if (opts.tier) this.state = { ...this.state, model: opts.tier };
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
    // 用户输入回显上屏（含斜杠命令）：消息流完整呈现对话轮次（/plan <目标> 此前整行蒸发）；内部 goal 提示词仍不上屏
    this.pushMsg('user', text);
    if (text.startsWith('/')) {
      if (text.split(/\s+/)[0] === '/model') {
        this.handleModel(text);
        return;
      }
      await this.handleSlash(text);
      return;
    }
    this.extractor.reset();
        this.committedLen = 0;
    if (this.state.status === 'running' || this.state.status === 'awaiting-approval') {
      this.pushMsg('system', t(`Queued: ${text}`, `已排队：${text}`));
      return new Promise<void>((resolve) => this.queue.push({ goal: text, resolve }));
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
    await this.runPlanItems(pending.items);
  }

  private async startPlanFlow(goal: string): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0 },
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.notify();
    let planText = '';
    this.planReplyNoArchive = true;
    try {
      // 规划段与执行段同链（H1）：经主链的 Loop 长任务模板。
      // 原实现是裸调 graph 角色节点——手工构造的 termination 无人读取（装饰性），
      // 且 loop → graph 会形成反向依赖；角色框定改为提示词级（依赖方向保持 graph → loop → harness）。
      // 规划段 fork 隔离：verbose 规划提示词与规划结论不进会话链（§11 边界登记——链只承载任务与执行轨迹），
      // 执行段（runPlanItems）才逐条指令行入链；角色框定保持提示词级（依赖方向 graph → loop → harness）
      const verbosePlanningPrompt = t(
        `Produce a numbered step plan for the goal below, one step per line formatted "1. step"; output only step lines, no explanations, no code fences.\nGoal: ${goal}`,
        `为下面的目标产出编号步骤计划，每行形如「1. 步骤」；只输出步骤行，不要解释、不要代码块。\n目标：${goal}`,
      );
      const r = await this.runInternalTask(verbosePlanningPrompt, t('Produce a numbered step plan', '产出编号步骤计划'));
      if (!r.done) {
        throw new Error(describeIncomplete(r.stopReason) || t('Planning incomplete', '规划未完成'));
      }
      planText = r.reply ?? '';
    } catch (e) {
      this.pushMsg('system', t('Planning failed: ', '规划失败：') + (e instanceof Error ? e.message : String(e)));
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
      this.pushMsg('system', t('No numbered steps produced (each line must be "1. xxx"), cancelled', '规划未产出编号步骤（每行需形如「1. xxx」），已取消'));
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
    this.state = { ...this.state, todos: items.map((t) => ({ text: t, done: false })), status: 'running' };
    this.notify();
    const ctx = this.runtime.harness.context;
    // 计划纪律走链（只增不改）：每轮只完成最后一条当前指令，不执行/预判/重排后续任务
    ctx.appendChain([{ action: 'note', observation: t(
      'Plan discipline: each round completes only the last "Current instruction"; do not execute, anticipate, or reorder other tasks.',
      '计划纪律：每轮只完成最后一条「当前指令」指定任务；不要执行、预判或重排后续任务。',
    ) }]);
    for (let i = 0; i < items.length; i++) {
      this.pushMsg('step', `Step ${i + 1}/${items.length} — ${items[i]}`);
      this.state = {
        ...this.state,
        metrics: { ...this.state.metrics, turnStartedAt: Date.now() },
      };
      this.usageBase = { tokens: this.state.metrics.turnTokens, cache: this.state.metrics.turnCacheTokens, prompt: this.state.metrics.turnPromptTokens };
      this.notify();
      ctx.appendChain([{ action: 'task', observation: t(`Current instruction: ${items[i]}`, `当前指令：${items[i]}`) }]);
      try {
        const r: RunOutcome = await this.runtime.runTask(items[i], this.state.model ? { tier: this.state.model } : undefined);
        if (!r.done) {
          const note = describeIncomplete(r.stopReason);
          if (note.length > 0) this.pushMsg('system', note);
          this.pushMsg('system', t(`Step incomplete: ${items[i]}; remaining steps paused`, `步骤未完成：${items[i]}；剩余步骤暂停`));
          break;
        }
        const todos = [...this.state.todos];
        todos[i] = { ...todos[i], done: true };
        this.state = { ...this.state, todos };
        // 步骤全量轨迹与结论行已由 reactor 会话作用域自动入链（fork 模型：不再只留结论行）
        // 步骤正文已随流式管线入档（flushReply 切块 + done 补尾），此处不再重复上屏（Step 切换时上一阶段正文重复的根因）
      } catch (e) {
        this.pushMsg('system', t('Step failed: ' + items[i] + ' (' + (e instanceof Error ? e.message : String(e)) + '); remaining steps paused', '步骤失败：' + items[i] + '（' + (e instanceof Error ? e.message : String(e)) + '）；剩余步骤暂停'));
        break;
      }
    }
    this.closeTask();
  }

  /** 任务收束：回 idle 并停表（turnStartedAt=0，idle 态不再显示耗时）。本轮 tokens/缓存命中保留为上一轮统计（下次提交进 running 时重置）；error 态保留现场便于回看出错时刻 */
  private closeTask(): void {
    if (this.state.status !== 'running' && this.state.status !== 'awaiting-plan') return;
    this.state = {
      ...this.state,
      status: 'idle',
      metrics: { ...this.state.metrics, turnStartedAt: 0 },
      children: [], // 生命周期清空（规格 §4.4）：正常归档后本已为空，此处兜底孤儿面板
    };
    this.childBufs.clear();
    this.spawnCalls = [];
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
    });
  }

  private async runTaskFlow(goal: string, opts?: { forkInstruction?: string }): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0 },
      live: undefined,
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.notify();
    try {
      const ctx = this.runtime.harness.context;
      if (opts?.forkInstruction) {
        // 内部 verbose 任务（/init 等）：fork 隔离——提示词经 fork 尾追承载、不进会话链（防污染对话流）
        const base = ctx.chainView();
        const r = await this.runtime.runTask(goal, {
          scope: 'fork',
          seedHistory: [...base, { step: (base.length > 0 ? base[base.length - 1].step : 0) + 1, action: 'task', observation: opts.forkInstruction }],
          ...(this.state.model ? { tier: this.state.model } : {}),
        });
        const noteF = describeIncomplete(r.stopReason);
        if (!r.done && noteF.length > 0) this.pushMsg('system', noteF);
        this.closeTask();
        return;
      }
      // 主链任务（§11 只增不改）：当前指令行尾追进链，reactor 会话作用域收束自动回写全量步骤与结论/补丁行
      ctx.appendChain([{ action: 'task', observation: t(`Current instruction: ${goal}`, `当前指令：${goal}`) }]);
      const r = await this.runtime.runTask(goal, this.state.model ? { tier: this.state.model } : undefined);
      const note = describeIncomplete(r.stopReason);
      if (!r.done && note.length > 0) this.pushMsg('system', note);
      this.closeTask();
    } catch (e) {
      this.pushMsg('system', t(`Error: ${e instanceof Error ? e.message : String(e)}`, `发生错误：${e instanceof Error ? e.message : String(e)}`));
      this.state = { ...this.state, status: 'error' };
      this.notify();
      return; // error 态保留计时现场（sticky），下次提交进 running 时重置
    }
  }

  /** /goal 完整修正环（规格 2026-09-15-tui-goal D2/D3）：模板名已经 handleSlash 预校验（入链前拒绝）；
   *  任务行入链带 /goal·模板 标注 → runLoop → 终态回执（status/iterations/criteria/tokens）→ closeTask。
   *  异常路径同 runTaskFlow 切 error 粘滞（保留现场）；已入链任务行不回滚（append-only，失败以链上轨迹为准） */
  private async runGoalFlow(goal: string, template: string): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0 },
      live: undefined,
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.notify();
    try {
      this.runtime.harness.context.appendChain([
        { action: 'task', observation: t(`Current instruction: ${goal} (/goal · ${template})`, `当前指令：${goal}（/goal · ${template}）`) },
      ]);
      this.pushMsg('system', t(`✻ /goal: ${template} · ${goal}`, `✻ /goal：${template} · ${goal}`));
      const r = await this.runtime.runLoop(goal, { template, ...(this.state.model ? { tier: this.state.model } : {}) });
      const lines = (r.criteria ?? []).map((c) => `  ${c.passed ? '✓' : '✗'} ${c.id} ${c.desc}`);
      if (r.status === 'done') {
        this.pushMsg('system', [
          t(
            `✻ /goal done: ${template} · ${r.iterations} iteration(s) · ${r.tokensUsed} tokens`,
            `✻ /goal 完成：${template} · ${r.iterations} 轮 · ${r.tokensUsed} tokens`,
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
      this.pushMsg('system', t(`Error: ${e instanceof Error ? e.message : String(e)}`, `发生错误：${e instanceof Error ? e.message : String(e)}`));
      this.state = { ...this.state, status: 'error' };
      this.notify();
      return;
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      await this.runTaskFlow(next.goal);
      next.resolve();
    }
  }

  /** /model：无参查询当前档位；带参设置（small|medium|large）。档位是 run 级常量，对后续任务生效 */
  private handleModel(text: string): void {
    const rest = text.trim().split(/\s+/).slice(1).join(' ');
    if (!rest) {
      this.pushMsg('system', t(
        this.state.model ? `Current model tier: ${this.state.model}` : 'Current model tier: default (SUNSHINEX_MODEL)',
        this.state.model ? `当前模型档位：${this.state.model}` : '当前模型档位：默认（SUNSHINEX_MODEL）',
      ));
      return;
    }
    const tier = parseTier(rest);
    if (!tier) {
      this.pushMsg('system', t('Usage: /model small|medium|large', '用法：/model small|medium|large'));
      return;
    }
    this.state = { ...this.state, model: tier };
    this.notify();
    this.pushMsg('system', t(`Model tier set to ${tier}; applies to subsequent tasks`, `模型档位已设为 ${tier}；对后续任务生效`));
  }

  private async handleSlash(text: string): Promise<void> {
    const cmd = text.split(/\s+/)[0] ?? text;
    if (cmd === '/help') {
      this.pushMsg('system', slashHelp());
      return;
    }
    if (cmd === '/init') {
      // Claude Code /init 同款模型驱动：发起真实分析任务，模型自行 read/ls/grep 感知代码库并 write 生成/完善 SUNSHINE.md；
      // 写盘经安全链（manual 模式经 asker 审批），装载走 ContextLoader 每轮 assemble 从磁盘读取，写盘即对后续轮次生效
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /init unavailable now', '当前有任务进行中，暂不能执行 /init'));
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
        this.pushMsg('system', existed ? t('SUNSHINE.md written (updated); auto-loaded into context each turn', '已写入 SUNSHINE.md（完善）：随每轮上下文自动装载') : t('SUNSHINE.md written (created); auto-loaded into context each turn', '已写入 SUNSHINE.md（新建）：随每轮上下文自动装载'));
      } else {
        this.pushMsg('system', t('SUNSHINE.md not written: task incomplete, rerun /init', 'SUNSHINE.md 未生成：任务未完成，可重新执行 /init'));
      }
      return;
    }
    if (cmd === '/status') {
      const s = this.runtime.harness.ledger.summary();
      this.pushMsg('system', t(`Ledger: ${s.runs} runs / ${s.tokens} tokens; messages: ${this.state.messages.length}; todos: ${this.state.todos.length}`, `账本：${s.runs} runs / ${s.tokens} tokens；消息 ${this.state.messages.length} 条；待办 ${this.state.todos.length} 项`));
      return;
    }
    if (cmd === '/new') {
      this.runtime.harness.security.clearSessionAllows();
      this.extractor.reset();
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
          hitRate: this.state.metrics.hitRate,
        },
        children: [],
        ...(this.state.model ? { model: this.state.model } : {}),
        live: undefined,
      };
      this.childBufs.clear();
      this.spawnCalls = [];
      this.runtime.harness.context.resetSession();
      this.pushMsg('system', t('Soft reset: messages, todos, session chain and compacted summary cleared; session approvals cleared (memory & ledger kept)', '软重置：消息、待办、会话链与压缩摘要已清空，会话级审批登记已清除（记忆与账本保留）'));
      return;
    }
    if (cmd === '/compact') {
      // 压缩协调单点（与 Reactor 自动压缩同链路，规格 D5）：补链参与（chainView 转 history 条目）→ 压缩 → 摘要（会话模型，失败回退）→ 折链
      const ctx = this.runtime.harness.context;
      const chainItems = chainToHistoryItems(ctx.chainView());
      const items = ctx.assemble(chainItems);
      const before = ctx.window.estimate(items).used;
      const r = await runCompaction(ctx, items, {
        summaryTokenBudget: 2000,
        rereadTokenBudget: 2000,
        chainFoldedCount: chainItems.length,
        summaryModel: this.runtime.harness.model,
      });
      const after = ctx.window.estimate(ctx.assemble()).used;
      this.state = { ...this.state, metrics: { ...this.state.metrics, ctxUsed: after } };
      this.pushMsg('system', t(`Compressed: ${r.chunks.length} summary chunks re-injected (ctx ${before} → ${after} tokens)`, `已压缩：${r.chunks.length} 个摘要块重注入（水位 ${before} → ${after} tokens）`));
      return;
    }
    if (cmd === '/plan') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; planning unavailable now', '当前有任务进行中，暂不能开始规划'));
        return;
      }
      const goal = text.slice(cmd.length).trim();
      if (!goal) {
        this.pushMsg('system', t('Usage: /plan <goal> — plan numbered steps first, confirm, then execute step by step', '用法：/plan <目标>——先规划产出编号步骤，确认后逐项执行'));
        return;
      }
      await this.startPlanFlow(goal);
      return;
    }
    if (cmd === '/goal') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /goal unavailable now', '当前有任务进行中，暂不能执行 /goal'));
        return;
      }
      const rest = text.slice(cmd.length).trim();
      const tm = rest.match(/--template=(\S+)/);
      const template = tm?.[1] ?? DEFAULT_GOAL_TEMPLATE;
      const goal = rest.replace(/--template=\S+\s*/g, '').trim();
      if (!goal) {
        this.pushMsg('system', t(
          'Usage: /goal <goal> [--template=code-refactor|test-loop|code-review] — runs the verify-fix loop until your condition is met; state the goal as one measurable end state (e.g. /goal all tests in src/auth pass), or embed multiple criteria inline (验收标准：t1=…)',
          '用法：/goal <目标> [--template=code-refactor|test-loop|code-review]——运行验收修正环，直至目标条件满足；目标用一句可度量的终态描述（如 /goal src/auth 测试全绿），复杂目标可内嵌多判据（验收标准：t1=…）',
        ));
        return;
      }
      if (!TEMPLATE_NAMES.includes(template)) {
        this.pushMsg('system', t(
          `Unknown template: ${template} (available: ${TEMPLATE_NAMES.join('/')})`,
          `未知模板：${template}（可选 ${TEMPLATE_NAMES.join('/')}）`,
        ));
        return;
      }
      await this.runGoalFlow(goal, template);
      return;
    }
    this.pushMsg('system', t(`Unknown command: ${cmd} (/help for list)`, `未知命令：${cmd}（/help 查看清单）`));
  }

  private onEvent(e: SessionEvent): void {
    // 子代理事件分流（规格 §4.1）：带 payload.subagent 标签的事件路由至面板态，不触达主链任何分支
    const sub = e.payload?.subagent;
    if (typeof sub === 'string' && sub.length > 0) {
      this.onChildEvent(e, sub);
      return;
    }
    switch (e.type) {
      case 'token':
        this.extractor.feed(e.text ?? '');
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
        // per-run 值叠加任务级基线：/plan 逐步执行整场累计（步骤切换不重置窗口，命中率按全程口径）
        const t = this.usageBase.tokens + e.payload.turnTotal;
        const c = this.usageBase.cache + (typeof e.payload.cacheHitTotal === 'number' ? e.payload.cacheHitTotal : 0);
        const p = this.usageBase.prompt + (typeof e.payload.promptTotal === 'number' ? e.payload.promptTotal : 0);
        const m = this.state.metrics;
        if (t === m.turnTokens && c === m.turnCacheTokens && p === m.turnPromptTokens) return; // 数值未变的重复 usage 不触发重渲染
        this.state = { ...this.state, metrics: { ...m, turnTokens: t, turnCacheTokens: c, turnPromptTokens: p } };
        this.notify();
        return;
      }
      case 'tool-call': {
        this.closeLive();
        this.extractor.reset();
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
        // phase 阶段行：模型主动播报的当前进度（1-2 行），先于对应动作/答复上屏；无 phase 的 step 与工具行信息重复，不上屏
        const phase = typeof e.payload?.phase === 'string' ? e.payload.phase.trim().slice(0, 200) : '';
        if (phase) this.pushMsg('step', phase);
        return;
      }
      case 'done': {
        const draft = this.state.live?.kind === 'reply' ? this.state.live.text : '';
        this.closeLive();
        this.extractor.reset();
        if (this.planReplyNoArchive) {
          // 规划轮终稿不重复入档：计划正文仅以确认卡形态上屏一次
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
        this.extractor.reset();
        this.committedLen = 0;
        this.pushMsg('system', t(`Error: ${e.text ?? '(no detail)'}`, `错误：${e.text ?? '（无说明）'}`));
        this.refreshMetrics();
        return;
      default:
        return; // route / approval-* 不落消息区
    }
  }

  private pushMsg(role: ChatRole, text: string, extra?: Partial<Pick<ChatItem, 'kind' | 'ok' | 'detail'>>): void {
    this.state = {
      ...this.state,
      messages: [...this.state.messages, { role, text, ts: Date.now(), seq: ++this.msgSeq, ...(extra ?? {}) }],
    };
    this.notify();
  }

  /** 测试注入口：直喂 SessionEvent 走完整分流路径（等价 runtime onEvent 回调），生产路径零改动 */
  onEventForTest(e: SessionEvent): void {
    this.onEvent(e);
  }

  /** 子代理事件处理（规格 §4.3）：首事件创建面板态；增量行化、结构事件即时行化；不触达主链任何分支 */
  private onChildEvent(e: SessionEvent, label: string): void {
    let list = this.state.children;
    let idx = list.findIndex((c) => c.label === label);
    if (idx < 0) {
      list = [...list, { label, startedAt: Date.now(), steps: 0, tokens: 0, transcript: [], tail: [] }];
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
      default:
        return; // done/error/ctx/route/approval-* 不入面板态（归档锚点在主链 tool-result）
    }
    if (buf) this.childBufs.set(label, buf);
    else this.childBufs.delete(label);
    const next: ChildLiveState = { ...child, transcript, steps, tokens, tail: childTail(transcript, buf) };
    list = list.map((c, i) => (i === idx ? next : c));
    this.state = { ...this.state, children: list };
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
    this.state = {
      ...this.state,
      children: list.filter((_, i) => i !== idx),
      messages: this.state.messages.map((m) => (m.seq === pending.seq ? { ...m, detail } : m)),
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

  /** done/error 后刷新账本 runs 与本轮缓存命中率（缓存命中 tokens / prompt tokens，分子分母同量纲；无 usage 回传时为 0） */
  private refreshMetrics(): void {
    const m = this.state.metrics;
    this.state = {
      ...this.state,
      metrics: {
        ...m,
        runs: this.runtime.harness.ledger.summary().runs,
        hitRate: m.turnPromptTokens > 0 ? Math.min(1, m.turnCacheTokens / m.turnPromptTokens) : 0,
      },
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

