import { ContextItem, ExecResult, ReasoningEffort, RouteDecision, SessionEvent, StopReason, ChatRequest, ChatResult } from '../types';
import { t } from '../i18n';
import { guardrailStop } from './guardrail';
import { Result } from '../result';
import { ModelAdapter, ModelRouter, ModelTier, RouteHint, UsageHooks } from '../model/adapter';
import type { SubagentRunner } from './subagent';
import { ToolRegistry } from './tools';
import { RunLedger } from './ledger';
import { SafetyChain } from './security/chain';
import { IDENTITY_LINE, MARKDOWN_LINE, TOOL_POLICY_LINE, REFERENCE_DATA_LINE, workDirLine } from './prompts/shared';
import { chainToHistoryItems, ContextManager, runCompaction } from './context';
import { buildMessages, formatToolCallLine, PHASE_ACTION, TOOL_CALL_ACTION, TOOL_RESULT_ACTION } from './context/messages';
import { resolveMemoryConfig } from '../config/memory-config';
import { reactorMaxStepsEnv } from '../config/termination-config';

/** 任务输入：goal 为观测标签（ledger/settle 留痕），不进提示词——真实任务文本走链尾「当前指令行」 */
export interface Task { goal: string; }
export interface StepRecord { step: number; action?: string; observation: string; }
export interface RunResult {
  steps: StepRecord[];
  done: boolean;
  reply?: string;
  tokensUsed?: number;
  /** 路由观测：本 run 实际生效的最后一次决策（模型偏好覆盖时以偏好为准） */
  route?: RouteDecision;
  /** 终止原因（新增）：done=正常完成；model-error=模型失败；其余为护栏越限 */
  stopReason?: StopReason;
  /** 压缩水位（步骤号）：>0 表示此号之前的步骤已折叠进压缩块 */
  compactedUpTo?: number;
}

/** 显式限额：maxSteps/tokenCap/deadlineAt 为硬边界，budget 仅用于上下文窗口压缩判定（两量纲） */
export interface ReactorLimits {
  maxSteps?: number;
  budget?: { total: number; reserve: number };
  /** 累计 token 硬上限（与编排层 maxTokens 同量纲） */
  tokenCap?: number;
  /** 绝对截止时刻（ms epoch） */
  deadlineAt?: number;
}

export interface ReactorOpts extends ReactorLimits {
  routeHint?: RouteHint;
  /** 用户级档位（run 级常量）：显式指定优先于 hint 推导与缺省；整场恒定，不随步重估、无模型自调通道 */
  tier?: ModelTier;
  /** 缺省思考强度（run 级常量，对标 tier）：run 级覆盖优先，缺省回适配器 cfg/env；请求级参数、不进提示词 */
  effort?: import('../types').ReasoningEffort;
  /** 作用域：session=主链（收束自动回写）；fork=私有执行（零回写，graph 节点/内部任务用） */
  scope?: 'session' | 'fork';
  /** fork 私有前缀（graph 组合角色行/节点任务行用）；缺省 seed = 会话链视图（结构性 fork） */
  seedHistory?: StepRecord[];
}

export interface ReactorDeps {
  registry: ToolRegistry;
  safety: SafetyChain;
  context: ContextManager;
  model: ModelAdapter;
  /** 项目根绝对路径（环境事实注入：提示词告知模型工作目录，杜绝相对路径瞎拼） */
  root?: string;
  router?: ModelRouter;
  /** 成功沉淀钩子：任一终态收口触发一次（done / failed / stopped，D4 全终态）；返回的说明行尾追为链尾 notice 行（规格 §10）；抛错被吞并记链行（沉淀失败不倒灌任务成败） */
  settle?: (r: SettlePayload) => string | void | Promise<string | void>;
  /** 记忆提取挂点（auto memory §4）：与 settle 同点、全终态触发一次（失败/中止任务同样入队）；返回的说明行尾追为链尾 notice 行（规格 §10）；旁路纪律=失败不倒灌任务成败（reactor 侧再兜一层 catch） */
  settleMemory?: (r: SettlePayload) => string | void | Promise<string | void>;
  /** 运行中穿插通道（对标 CC queued messages，用户→运行时方向、非模型工具面）：每个步边界 drain 一次，返回待投递的用户穿插行（按入队序、取走即消费）；缺省无通道 */
  steer?: () => string[];
  /** per-run 成本账本（可选）：run 收尾聚合落 runs/<id>；缺省不落账 */
  ledger?: RunLedger;
  /** 事件流旁路（TUI/GUI 公共地基）：发射即旁路，不注入零副作用；主链/账本语义不受影响 */
  onEvent?: (e: SessionEvent) => void;
  /** 子代理执行单元（harness/装配根注入）：run 起止挂/摘 spawn 预算源；缺省无 spawn 能力 */
  runner?: SubagentRunner;
  /** 用户中断信号（Esc/Ctrl+C）：步边界最先检查，在途模型调用经 adapter 即刻中止；中止态转 interrupted 终态 */
  signal?: AbortSignal;
}

/** 收口沉淀载荷（规格 §3.2）：outcome = 终态归一值（done/failed/stopped）；无最终答复时 reply 归一为空串 */
export type SettleOutcome = 'done' | 'failed' | 'stopped';
export interface SettlePayload {
  goal: string;
  reply: string;
  outcome: SettleOutcome;
  digest: string;
}

/** 收口步骤摘要（规格 §3.2）：每步 [tool] 观察首行 → 供 learned 提炼与记忆提取自判；
 *  取尾 maxSteps 步（最近的更有价值）、单步截 itemChars、总长截 totalChars（自头部截、保尾部）。 */
export function buildStepDigest(
  steps: StepRecord[],
  cfg: { maxSteps: number; itemChars: number; totalChars: number },
): string {
  const tail = steps.slice(-cfg.maxSteps);
  const lines = tail.map((s) => {
    const action = (s.action ?? 'note').slice(0, 40);
    const first = String(s.observation ?? '').split('\n')[0].slice(0, cfg.itemChars);
    return `[${action}] ${first}`;
  });
  const out = lines.join('\n');
  return out.length > cfg.totalChars ? out.slice(out.length - cfg.totalChars) : out;
}

/** 并行调用上限：防单轮塞满列表拖长步时延（8 项足够覆盖常用组合） */
const PARALLEL_TOOLS_LIMIT = 8;

/** 最小 Reactor：observe → think → act → observe 线性循环（chat 消息视图单通道） */

export class Reactor {
  constructor(private deps: ReactorDeps) {}

  async run(task: Task, opts?: ReactorOpts): Promise<RunResult> {
    const maxSteps = opts?.maxSteps ?? reactorMaxStepsEnv() ?? 400;
    // 缺省预算：内建缺省 200k（对标长上下文安全水位）；SUNSHINEX_CONTEXT_WINDOW 可按模型最大上下文放大
    // （状态栏「上下文占用」分母与压缩占比共用此基准），非法值静默回退内建缺省
    const envWindow = Number(process.env.SUNSHINEX_CONTEXT_WINDOW ?? '');
    const budget = opts?.budget ?? {
      total: Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 200_000,
      reserve: Math.floor((Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 200_000) / 5),
    };
    const tokenCap = opts?.tokenCap;
    const deadlineAt = opts?.deadlineAt;
    const router = this.deps.router ?? new ModelRouter().bindDefault(this.deps.model);
    // 档位（run 级常量，对标 Claude Code：模型档位是用户级参数）：显式 tier > 外部 hint 推导 > 缺省 medium；
    // 整场恒定——不随上下文占比逐步重估，模型无自调档通道（提示词无档位行）；换档即换模型，
    // 属用户显式触发的跨模型重算事件（CLAUDE.md §11 不变量④）
    const derived = router.route(opts?.routeHint);
    const tier: ModelTier = opts?.tier ?? derived.tier;
    const route: RouteDecision = opts?.tier
      ? {
          tier,
          reason: 'user:tier',
          bound: router.boundTiers().includes(tier),
          adapterProvider: router.resolve(tier).provider,
        }
      : derived;
    const adapter = router.resolve(tier);
    this.emit('route', undefined, { tier: route.tier, reason: route.reason });
    let lastCompactStep = -2; // 滞回：初始可压（step − (−2) ≥ 2 恒成立）
    let reactiveUsed = false; // 反应式压缩兜底：每 run 至多重试一次，防「压缩→仍越限」死循环
    // fork 模型缺省基座：会话链视图即本 run 前缀（结构性 fork，不传 seed 即续接主链）；
    // 新步骤号自链尾续起，prompt 呈「稳定段 → 链前缀 history → 新步尾部追加」形态；guardrail 迭代计数只约束本 run 新增步
    const scope = opts?.scope ?? 'session';
    const seed = opts?.seedHistory ?? this.deps.context.chainView();
    const seedLen = seed.length;
    const seedLastStep = seed.length > 0 ? seed[seed.length - 1].step : 0;
    const steps: StepRecord[] = [...seed];
    // 压缩水位线（步骤号口径，0=无折叠）：>0 时此号及之前的 steps 已由摘要代表、不再进入 history；
    // 初值必须为 0——种子链行未经压缩、必须照常进 history（链即记忆），seedLastStep 只用于收尾回写防双写
    let compactedUpToStep = 0;
    let done = false;
    let reply: string | undefined;
    let tokensUsed = 0; // 真实模型用量累计（adapter usage 回传聚合）
    let cacheHitTokens = 0; // prompt 缓存命中累计（adapter onCache 回传聚合）
    let promptTokens = 0; // prompt tokens 累计（缓存命中率分母，与缓存命中同量纲）
    let usageBase = 0; // per-request 覆盖语义基线：usage 是单请求全量值（流式末帧回传），跨请求累加、请求内覆盖
    let cacheBase = 0;
    let promptBase = 0;
    const startedAt = Date.now();

    // spawn 预算源挂载（仅装配注入 runner 的 reactor）：子代理预算 = 本 run 剩余（动态闭包——
    // tokenCap 内剩余在 spawn 调用时实时取值）；run 为单一出口（循环 break 后直达收尾 return），
    // 收尾处统一摘除；即使异常路径遗留挂载，无活动 run 期间 spawn 不可达、下一次 attach 即覆盖，陈旧闭包无害
    if (this.deps.runner) {
      this.deps.runner.attachParent(() => ({
        maxSteps,
        ...(tokenCap !== undefined ? { tokenCap: Math.max(0, tokenCap - tokensUsed) } : {}),
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        tier,
      }));
    }

    let stopReason: StopReason = 'max-steps'; // 循环出口原因：护栏越限（缺省即步数），done / model-error / interrupted 在各自分支覆盖
    for (;;) {
      // 用户中断（Esc/Ctrl+C）：步边界最先检查——在途工具调用完成后立即停，不进下一模型轮
      if (this.deps.signal?.aborted) {
        stopReason = 'interrupted';
        break;
      }
      // 运行中穿插消费（对标 CC queued messages，用户→运行时方向）：每个步边界 drain 一次，
      // 用户穿插行以 task 记录尾追加 steps——下一装配面 history 自然携带（尾追、零前缀击穿），
      // session 作用域收束时随全量步骤回写主链（可审计、跨轮可见）。
      // 消费门=本 run 已起步（≥1 新步）：起步前穿插留通道，避免吞进零新步 done 终稿；
      // 仅 session 主链消费：fork 私有面不回写主链，穿插行落进去即静默丢失——交会话层收口兜底补跑
      if (this.deps.steer && scope === 'session' && steps.length > seedLen) {
        const lines = this.deps.steer().filter((l) => l.trim().length > 0);
        if (lines.length > 0) {
          const base = steps.length > 0 ? steps[steps.length - 1].step : seedLastStep;
          const injected = lines.map((line, i) => ({ step: base + 1 + i, action: 'task' as const, observation: line }));
          steps.push(...injected);
          this.emit('step', 'task', { step: injected[injected.length - 1].step });
        }
      }
      const step = steps.length > 0 ? steps[steps.length - 1].step + 1 : 1;
      const hit = guardrailStop({
        now: Date.now(),
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        tokensUsed,
        ...(tokenCap !== undefined ? { tokenCap } : {}),
        // 本 run 新增完成轮数（模型轮=完成步）：chat 主通道一轮入多条链行（phase/调用/观察共用同一轮步号），按去重步号计
        iteration: new Set(steps.slice(seedLen).map((s) => s.step)).size,
        maxIterations: maxSteps,
      });
      if (hit) {
        stopReason = hit;
        break;
      }
      // observe: 装配 → 估算 → 滞回门 → 收敛环（spec §2.2：压缩当轮即以收敛后上下文组装）
      let items = this.deps.context.assemble(this.toHistory(steps, compactedUpToStep));
      let est = this.deps.context.window.estimate(items);
      const overThreshold = () =>
        this.deps.context.window.shouldCompact({ total: budget.total, used: est.used, reserve: budget.reserve });
      // 滞回门（跨步节流，环外判定一次）：≥2 新步开闸；est > total 硬越限应急旁路——保证全程 est ≤ total（C1）
      const gateOpen = step - lastCompactStep >= 2 || est.used > budget.total;
      if (gateOpen && overThreshold()) {
        // 收敛环（环内不受滞回限制）：压缩 → 重注入 → 重装配重估；续环条件为硬越限（est > total）越阈即止，至多 2 轮
        let rounds = 0;
        do {
          // 水位先算：折叠步骤号只依赖 steps/seed，与压缩结果无关（折链交由 runCompaction 统一执行）
          compactedUpToStep = steps.length > 0 ? steps[steps.length - 1].step : seedLastStep;
          // 压缩协调单点：确定性选块 → 摘要（当前 run 模型，失败回退确定性）→ 门禁重注入 → 折链（防「链+压缩块」双份）
          await runCompaction(this.deps.context, items, {
            summaryTokenBudget: Math.floor(budget.reserve / 2),
            rereadTokenBudget: Math.floor(budget.reserve / 2),
            chainFoldedCount: seed.filter((s) => s.step <= compactedUpToStep).length,
            summaryModel: adapter,
          });
          lastCompactStep = step;
          items = this.deps.context.assemble(this.toHistory(steps, compactedUpToStep));
          est = this.deps.context.window.estimate(items);
          rounds++;
        } while (rounds < 2 && est.used > budget.total);
      }

      // 上下文占用水位旁路上屏：think 前为装配面估算（exact:false，只允许向上预告）；
      // 模型回传真实 usage.prompt_tokens 后以 exact:true 覆盖（对标 Claude Code 真实上下文口径）；
      // 事件为旁路遥测不进提示词，前缀缓存零影响
      this.emit('ctx', undefined, { used: est.used, exact: false });

      // think：chat 消息视图单通道（tools 字段下发、tool_calls 结构化动作）；错误经本 try 统一兜底（中断/超长反应式压缩/model-error）。
      // 旁路技能块先取（assemble 消费即清，消息面单独置尾——est 估算暂时低估一个技能块，可容许）
      const chatSkill = this.deps.context.takePendingSkill();
      try {
        // usage 为 per-request 全量值：聚合用「基线 + 本请求覆盖」而非盲目累加——
        // 端点在多个流式帧重复携带 usage 时覆盖语义天然幂等，漏算与重复累计两类口径病一次消除
        usageBase = tokensUsed;
        cacheBase = cacheHitTokens;
        promptBase = promptTokens;
        const outcome = await this.chatRound(adapter, steps, step, compactedUpToStep, chatSkill, {
          onCache: (c) => {
            if (c > 0) cacheHitTokens = cacheBase + c;
          },
          onPrompt: (p) => {
            if (p > 0) {
              promptTokens = promptBase + p;
              // 本请求真实 prompt_tokens 即模型实际看到的上下文占用：以 exact 权威覆盖估算预告
              this.emit('ctx', undefined, { used: p, exact: true });
            }
          },
          onUsage: (t) => {
            if (t > 0) tokensUsed = usageBase + t;
            this.emit('usage', undefined, { tokens: t, turnTotal: tokensUsed, cacheHitTotal: cacheHitTokens, promptTotal: promptTokens });
          },
          onReasoning: (t) => this.emit('reasoning', t),
        }, opts?.effort, this.deps.signal);
        if (outcome.done) {
          done = true;
          reply = outcome.reply;
          stopReason = 'done';
          // step done 事件发射契约（session 收束面/TUI 终态依赖此事件，前缀面不受影响）
          this.emit('step', 'done', { step });
          break;
        }
      } catch (e) {
        // 用户中断在途模型调用：静默转入中断终态，不 emit error（中断回执由会话层统一发）
        if (this.deps.signal?.aborted) {
          stopReason = 'interrupted';
          break;
        }
        const errMsg = e instanceof Error ? e.message : String(e);
        // 反应式压缩兜底（规格 F 项，对标 reactive_compact）：端点超长拒绝（本地估算偏差）→
        // 压缩 + 重试本步一次（reactiveUsed 单发射门）；重试请求前缀与失败请求不同 = 合法重写点语义
        if (isContextOverflowError(errMsg) && !reactiveUsed) {
          reactiveUsed = true;
          this.emit('error', 'Context overflow at the endpoint — compacting and retrying once');
          await runCompaction(this.deps.context, items, {
            summaryTokenBudget: Math.floor(budget.reserve / 2),
            rereadTokenBudget: Math.floor(budget.reserve / 2),
            chainFoldedCount: seed.filter((s) => s.step <= compactedUpToStep).length,
            summaryModel: adapter,
          });
          lastCompactStep = step;
          // 重试本步：步号由链尾派生（steps 未变则下轮同号），重建装配面后 continue
          items = this.deps.context.assemble(this.toHistory(steps, compactedUpToStep));
          // 退位重试：移除本 run 末步（若有）使下轮步号复用当前步号，且不产生空洞
          if (steps.length > 0) steps.pop();
          continue;
        }
        reply = e instanceof Error ? e.message : 'Model call failed';
        this.emit('error', reply);
        stopReason = 'model-error';
        break;
      }
    }

    // 主链作用域收束回写：存续新步骤 + 结论行/补丁行尾追进链（fork 模型 §5；fork 作用域私有不回写）
    if (scope === 'session') {
      const foldedSeed = seed.filter((s) => s.step <= compactedUpToStep).length;
      if (foldedSeed > 0) this.deps.context.trimChainFront(foldedSeed);
      const cut = Math.max(compactedUpToStep, seedLastStep);
      this.deps.context.appendChain(
        steps
          .filter((s) => s.step > cut)
          .map((s) => ({ ...(s.action !== undefined ? { action: s.action } : {}), observation: s.observation })),
      );
      if (done && reply) {
        this.deps.context.appendChain([{ action: 'reply', observation: reply }]);
      } else {
        this.deps.context.appendChain([{ action: 'note', observation: `Task ended without completion (${stopReason ?? 'unknown'})` }]);
      }
    }

    // 收口说明行（规格 §10）：settle/settleMemory 产出的说明尾追为链尾 notice 行（模型面）+ notice 事件（用户面）；
    // 触发面=全终态（done / failed / stopped，D4）；任何失败不倒灌任务成败（旁路纪律）；本会话新增记忆/技能以此一条行告知（不加工具面）
    const announce = (source: 'memory' | 'skills', text: string): void => {
      this.deps.context.appendChain([{ action: 'notice', observation: text }]);
      this.deps.onEvent?.({ type: 'notice', text, payload: { source, text }, ts: Date.now() });
    };
    // 终态归一 + 收口步骤摘要（规格 §3.2）：失败/中止任务同样入队；材料面三键缺省来自 memory-config
    const cfg = resolveMemoryConfig();
    const outcome: SettleOutcome = done ? 'done' : (stopReason === 'model-error' ? 'failed' : 'stopped');
    const digest = buildStepDigest(steps, {
      maxSteps: cfg.stepDigestMaxSteps,
      itemChars: cfg.stepDigestItemChars,
      totalChars: cfg.stepDigestTotalChars,
    });
    const settlePayload: SettlePayload = { goal: task.goal, reply: reply ?? '', outcome, digest };
    // 沉淀钩子仅主链触发（规格 §3.1 + fork 不变量）：fork 私有执行零主链回写——内部规划/分析/图节点产物不进记忆与技能，
    // 否则收口说明行会击穿 fork 隔离（runtime.test「fork 作用域零主链回写」为钉子）；
    // 技能沉淀：全终态触发一次；抛错吞掉记链行（链即记忆，事件走链），不倒灌任务成败
    if (scope === 'session' && this.deps.settle) {
      try {
        const line = await this.deps.settle(settlePayload);
        if (line) announce('skills', line);
      } catch (e) {
        this.deps.context.appendChain([{ action: 'note', observation: `Settle failed (not propagated to task outcome): ${e instanceof Error ? e.message : String(e)}` }]);
      }
    }
    // 记忆提取钩子（auto memory §4）：同点并行、独立一次性模型调用；任何失败静默（旁路纪律，收口永不因记忆而失败）
    if (scope === 'session' && this.deps.settleMemory) {
      try {
        const line = await this.deps.settleMemory(settlePayload);
        if (line) announce('memory', line);
      } catch {
        // 静默降级：提取抛错/网络失败不影响任务收口
      }
    }
    // per-run 成本账本：tokens/路由决策/时长随收尾落 runs/<id>；落账失败不倒灌任务结果（存储同源，此处吞错）
    if (this.deps.ledger) {
      try {
        this.deps.ledger.record({
          goal: task.goal,
          done,
          steps: steps.length,
          tokensUsed,
          durationMs: Date.now() - startedAt,
          ...(route ? { route: { tier: route.tier, reason: route.reason } } : {}),
        });
      } catch {
        // 账本失败不倒灌任务成败
      }
    }
    // 收尾事件：done 必发（正常/异常路径共用出口）；error 已在失败点提前发出
    this.emit('done', reply, { steps: steps.length, tokensUsed, stopReason });
    // spawn 预算源摘除：只在 run 存续期有效，防 run 外孤儿派生（Runner INVALID_STATE 兜底）
    this.deps.runner?.detachParent();
    return { steps, done, reply, tokensUsed, route, stopReason, ...(compactedUpToStep > 0 ? { compactedUpTo: compactedUpToStep } : {}) };
  }

  /** 事件发射器：仅旁路通知；onEvent 缺省为零开销空转 */
  private emit(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): void {
    this.deps.onEvent?.({ type, text, payload, ts: Date.now() });
  }

  private toHistory(steps: StepRecord[], fromStep: number): ContextItem[] {
    return chainToHistoryItems(steps.filter((s) => s.step > fromStep));
  }

  /** 稳定段（消息面）：身份/输出约定/工具政策/工作目录——逐字节冻结；工具清单经 tools 字段下发、动作经 tool_calls 结构化承载 */
  private chatStableSegment(): string {
    return [
      IDENTITY_LINE,
      MARKDOWN_LINE,
      'When calling tools you may include a short "phase" sentence as the message content naming the current stage (what the upcoming tool calls are for); include it only when entering a new stage, and skip it for consecutive actions within the same stage and for trivial single-step actions.',
      TOOL_POLICY_LINE,
      'exec and ask tools run exclusively on their own; multiple other tools may be called in parallel within a single round.',
      REFERENCE_DATA_LINE,
      'Work on the task given by the last task-instruction line in the context; complete it fully, then give the final answer as your final response.',
      workDirLine(this.deps.root ?? this.deps.context.root),
    ].join('\n');
  }

  /** 模型一轮：buildMessages 消息视图 + tools 字段 → 结构化动作消费。
   *  一轮多条链行（phase/调用/观察）共用同一轮步号（迭代计数按去重步号），role:tool 按序配对回喂；finish=stop 即收束 */
  private async chatRound(
    adapter: ModelAdapter,
    steps: StepRecord[],
    step: number,
    fromStep: number,
    skill: string | null,
    hooks: UsageHooks,
    effort: ReasoningEffort | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ done: boolean; reply?: string }> {
    const startedAt = Date.now();
    this.emit('model-start', undefined, { step });
    const messages = buildMessages({
      stableSegment: this.chatStableSegment(),
      snapshot: this.deps.context.snapshotView(),
      compacted: this.deps.context.compactedView(),
      // 压缩水位过滤：压缩点前的链行已折叠进压缩块，不得双份回流（runCompaction 契约）
      chain: steps.filter((s) => s.step > fromStep),
      pendingSkill: skill,
    });
    const tools = [...this.deps.registry.list()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, ...(t.parameters ? { parameters: t.parameters } : {}) } }));
    const req: ChatRequest = { messages, tools, ...(signal ? { signal } : {}), ...(effort !== undefined ? { effort } : {}) };
    let result: ChatResult;
    if (adapter.chatStream) {
      result = await adapter.chatStream(req, (t) => this.emit('token', t), hooks);
    } else {
      result = await adapter.chat(req, hooks);
    }
    this.emit('model-end', undefined, { step, ms: Date.now() - startedAt });
    if (result.finish === 'stop') return { done: true, reply: result.content || 'Done' };

    const calls = result.toolCalls;
    if (calls.length === 0) {
      // tool_calls 空批（含非协议文本出牌）：纠偏观察回喂，原文随旁白可见（fail-bounded 不当崩溃）
      const n = steps.length > 0 ? steps[steps.length - 1].step + 1 : 1;
      const obs = result.content
        ? 'No tool calls were returned. If this was meant as a final answer, finish with a stop round instead; otherwise call a tool. Output seen: ' + result.content.slice(0, 200)
        : 'No tool calls were returned; call a tool or finish with a final answer.';
      this.emit('step', t('(no action)', '（无动作）'), { step: n });
      steps.push({ step: n, observation: obs });
      return { done: false };
    }

    // 执行面校验（参数 schema 表达不了跨调用约束）：并行批禁 exec/ask（须单发独占）、超上限拒绝；单调用不限
    const overLimit = calls.length > PARALLEL_TOOLS_LIMIT;
    const rejected =
      overLimit ||
      (calls.length > 1 &&
        calls.some((c) => {
          const cat = this.deps.registry.get(c.name)?.category;
          return cat === 'bash' || cat === 'ask' || cat === 'worktree' || cat === undefined;
        }));
    const rejection = overLimit
      ? `Parallel batch rejected: exceeds the limit of ${PARALLEL_TOOLS_LIMIT} tools; use fewer calls per round`
      : 'Parallel batch rejected: exec and ask must run exclusively on their own; remove them and retry, or fall back to a single-tool call';

    // 轮内链行共用同一轮步号（step 形参）：护栏按去重步号计模型轮、压缩水位/收尾回写行级过滤对同号行天然一致
    const callIds = calls.map((_, i) => `step:${step}-idx:${i}`);
    this.emit('step', calls[0].name, { step, phase: result.content || undefined });
    if (result.content) steps.push({ step, action: PHASE_ACTION, observation: result.content });
    // 调用行先行入链（批内连续，buildMessages 聚合为 assistant+tool_calls）；被拒/坏参调用同样入链保证 role:tool 配对完整
    for (const c of calls) steps.push({ step, action: TOOL_CALL_ACTION, observation: formatToolCallLine(c.name, c.argsJson) });

    const argsOf = calls.map((c) => {
      try {
        return JSON.parse(c.argsJson) as Record<string, unknown>;
      } catch {
        return null;
      }
    });

    // 调用行先行上屏（执行前发射：长工具执行中调用行即可见，TUI 实时性契约）
    for (let i = 0; i < calls.length; i++) {
      this.emit('tool-call', calls[i].name, { input: argsOf[i] ?? {}, callId: callIds[i], status: 'pending' });
    }

    if (rejected) {
      for (let i = 0; i < calls.length; i++) {
        this.emit('tool-result', rejection.slice(0, 200), { ok: false, full: rejection, tool: calls[i].name, callId: callIds[i], status: 'failed' });
        steps.push({ step, action: TOOL_RESULT_ACTION, observation: rejection });
      }
      return { done: false };
    }

    const results = await Promise.all(
      calls.map((c, i) => (argsOf[i] === null ? null : this.deps.registry.execute(c.name, argsOf[i] as Record<string, unknown>, this.deps.safety))),
    );
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const args = argsOf[i];
      const r = results[i];
      const obs =
        args === null || r === null
          ? 'Tool call "' + c.name + '" arguments are not valid JSON: ' + c.argsJson.slice(0, 200) + ' — fix the arguments and retry'
          : this.describe(r);
      this.emit('tool-result', obs.slice(0, 200), { ok: r !== null && r.ok, full: obs, tool: c.name, callId: callIds[i], status: r !== null && r.ok ? 'completed' : 'failed' });
      steps.push({ step, action: TOOL_RESULT_ACTION, observation: obs });
      if (r !== null && r.ok && (c.name === 'read' || c.name === 'grep')) {
        const p = (args as { path?: unknown } | null)?.path;
        if (typeof p === 'string' && p.length > 0) this.deps.context.trackFile(p);
      }
    }
    return { done: false };
  }

  private describe(r: Result<ExecResult>): string {
    if (r.ok) {
      const out = r.value.stdout || r.value.stderr || 'ok';
      return out.length > 2000 ? `${out.slice(0, 2000)}\n...(truncated)` : out;
    }
    return r.error.message.startsWith(r.error.code) ? r.error.message : `${r.error.code}: ${r.error.message}`;
  }
}

/** 端点侧上下文超长错误识别（规格 F 项）：本地估算偏差时端点拒绝（OpenAI 兼容端点常见措辞，
 *  大小写不敏感）；仅匹配明确超限特征串，其余错误走既有 model-error 通道不误触发压缩 */
export function isContextOverflowError(message: string): boolean {
  return /prompt[_ ]too long|context length|maximum context|too many tokens|request too large/i.test(message);
}
