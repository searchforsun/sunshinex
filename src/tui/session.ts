import { ApprovalDecision, ApprovalRequest, HistoryStep, SessionEvent } from '../types';
import { RunOutcome, TuiRuntime, TuiRuntimeOpts, createRuntime } from './runtime';
import { estimateTokens } from '../harness/context/window';
import { ReplyStreamExtractor } from './stream-extractor';
import { stableReplySegment } from './reply-flusher';
import { toolCallLine } from './tool-verbs';
import { describeIncomplete } from './stop-reason';
import { t } from '../i18n';
import { sunshineInitGoal } from '../harness/sunshine-init';
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

export interface TuiState {
  messages: ChatItem[];
  approval?: ApprovalRequest;
  todos: TodoItem[];
  status: SessionStatus;
  metrics: StatusMetrics;
  live?: LiveBlock;
}

export interface SessionOpts extends TuiRuntimeOpts {
  /** manual 模式审批回调（终端化审批装配点；渲染层注入交互实现） */
  asker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 运行时注入位：缺省自建 createRuntime(opts)；测试可注入假实现以隔离长任务 */
  runtime?: TuiRuntime;
}

/** 斜杠命令帮助（运行期求值：语言随 --language 装配后设定，禁止模块级 t() 冻结） */
function slashHelp(): string {
  return t(
    'Commands: /init analyze & write SUNSHINE.md · /new new session (soft reset) · /compact compress context · /status session & ledger summary · /help show this list',
    '命令：/init 分析生成/完善 SUNSHINE.md · /new 新会话（软重置） · /compact 压缩上下文 · /status 会话与账本摘要 · /help 本清单',
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
  };
  private listeners = new Set<(s: TuiState) => void>();
  private queue: { goal: string; resolve: () => void }[] = [];
  /** 消息全局单调序号（Static 区 key 唯一性来源）；/new 清空消息但不回绕 */
  private msgSeq = 0;
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
  }

  getState(): TuiState {
    return this.state;
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
      const r = await this.runtime.runTask(
        t(
          `Produce a numbered step plan for the goal below, one step per line formatted "1. step"; output only step lines, no explanations, no code fences.\nGoal: ${goal}`,
          `为下面的目标产出编号步骤计划，每行形如「1. 步骤」；只输出步骤行，不要解释、不要代码块。\n目标：${goal}`,
        ),
      );
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
    // 上下文最小化：goal 只承载恒定执行协议——完整计划清单与阶段编号不进模型上下文（模型见到全量清单会自行
    // 重排/跳步，「Step 3/4」类自编进度即源于此），每轮只见「前序结论 + 当前指令」；goal 恒定且 seed 只做
    // history 尾部追加，前缀缓存连续性不受影响。指令行不带编号，前序只保留结论（reply）不带全量观察
    const planGoal = t(
      'Execute the plan step by step: each round complete only the single task given by the "Current instruction" at the end of the history, then end the round with done; do not execute, anticipate, or reorder other tasks.',
      '按计划逐步完成任务：每轮只完成 history 末尾「当前指令」指定的单一任务，完成即以 done 收束本轮；不要执行、预判或重排后续任务。',
    );
    const seed: HistoryStep[] = [];
    for (let i = 0; i < items.length; i++) {
      this.pushMsg('step', `Step ${i + 1}/${items.length} — ${items[i]}`);
      this.state = {
        ...this.state,
        metrics: { ...this.state.metrics, turnStartedAt: Date.now() },
      };
      this.usageBase = { tokens: this.state.metrics.turnTokens, cache: this.state.metrics.turnCacheTokens, prompt: this.state.metrics.turnPromptTokens };
      this.notify();
      seed.push({ step: seed.length + 1, action: 'plan', observation: t(`Current instruction: ${items[i]}`, `当前指令：${items[i]}`) });
      try {
        const opts = seed.length > 0 ? { seedHistory: [...seed] } : undefined;
        const r: RunOutcome = await this.runtime.runTask(planGoal, opts);
        if (!r.done) {
          const note = describeIncomplete(r.stopReason);
          if (note.length > 0) this.pushMsg('system', note);
          this.pushMsg('system', t(`Step incomplete: ${items[i]}; remaining steps paused`, `步骤未完成：${items[i]}；剩余步骤暂停`));
          break;
        }
        const todos = [...this.state.todos];
        todos[i] = { ...todos[i], done: true };
        this.state = { ...this.state, todos };
        // 前序上下文只保留结论（reply）：全量观察不再进后续 prompt（防上下文随步骤膨胀、防历史轨迹干扰当前决策）
        if (r.reply) seed.push({ step: seed.length + 1, action: 'reply', observation: r.reply });
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
    };
    this.notify();
  }

  private async runTaskFlow(goal: string): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0 },
      live: undefined,
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.notify();
    try {
      const r = await this.runtime.runTask(goal);
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

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      await this.runTaskFlow(next.goal);
      next.resolve();
    }
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
      // 提示词属内部实现不上屏，仅一行启动提示；分析过程经工具实时流可见
      this.pushMsg('system', existed ? t('/init: analyzing project, updating SUNSHINE.md…', '/init：分析项目，完善 SUNSHINE.md…') : t('/init: analyzing project, generating SUNSHINE.md…', '/init：分析项目，生成 SUNSHINE.md…'));
      await this.runTaskFlow(sunshineInitGoal(this.root, existed));
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
        live: undefined,
      };
      this.pushMsg('system', t('Soft reset: messages and todos cleared, session approvals cleared (memory & ledger kept)', '软重置：消息与待办已清空，会话级审批登记已清除（记忆与账本保留）'));
      return;
    }
    if (cmd === '/compact') {
      // 复用 Reactor 同款窗口压缩链：组装当前上下文 → 压缩 → 重注入（与自动压缩同一机制，手动即时触发）
      const items = this.runtime.harness.context.assemble('', []);
      const before = this.runtime.harness.context.window.estimate(items).used;
      const chunks = await this.runtime.harness.context.window.compact(items, { summaryTokenBudget: 2000 });
      await this.runtime.harness.context.applyCompaction(chunks, { rereadTokenBudget: 2000 });
      const after = this.runtime.harness.context.window.estimate(this.runtime.harness.context.assemble('', [])).used;
      this.state = { ...this.state, metrics: { ...this.state.metrics, ctxUsed: after } };
      this.pushMsg('system', t(`Compressed: ${chunks.length} summary chunks re-injected (ctx ${before} → ${after} tokens)`, `已压缩：${chunks.length} 个摘要块重注入（水位 ${before} → ${after} tokens）`));
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
    this.pushMsg('system', t(`Unknown command: ${cmd} (/help for list)`, `未知命令：${cmd}（/help 查看清单）`));
  }

  private onEvent(e: SessionEvent): void {
    switch (e.type) {
      case 'token':
        this.extractor.feed(e.text ?? '');
        if (this.state.live?.kind === 'reply') this.flushReply();
        return;
      case 'reasoning':
        this.appendLive('thinking', e.text ?? '');
        return;
      case 'ctx': {
        // reactor 每轮装配后的占用水位（estimate 口径）：真实回传 usage.prompt_tokens 可用时优先（更准）
        const used = typeof e.payload?.promptTokens === 'number' && e.payload.promptTokens > 0 ? e.payload.promptTokens : (typeof e.payload?.used === 'number' ? e.payload.used : this.state.metrics.ctxUsed);
        const m = this.state.metrics;
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
      case 'tool-call':
        this.closeLive();
        this.extractor.reset();
        this.committedLen = 0;
        this.pushMsg('tool', toolCallLine(e.text ?? '', e.payload?.input), { kind: 'call' });
        return;
      case 'tool-result':
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

