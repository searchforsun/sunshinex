import { ContextItem, ExecResult, RouteDecision, SessionEvent } from '../types';
import { pick } from '../i18n';
import { guardrailStop } from './guardrail';
import { StopReason } from '../types';
import { Result } from '../result';
import { ModelAdapter, ModelRouter, ModelTier, ResponseFormat, RouteHint, UsageHooks } from '../model/adapter';
import { resolveStructuredFormat } from './action-schema';
import type { SubagentRunner } from './subagent';
import { ToolRegistry } from './tools';
import { RunLedger } from './ledger';
import { SafetyChain } from './security/chain';
import { ContextManager } from './context';

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
  /** 成功沉淀钩子：仅 done 且有 reply 时触发一次；抛错被吞并记 episodic（沉淀失败不倒灌任务成败） */
  settle?: (r: { goal: string; reply: string }) => void;
  /** per-run 成本账本（可选）：run 收尾聚合落 runs/<id>；缺省不落账 */
  ledger?: RunLedger;
  /** 事件流旁路（TUI/GUI 公共地基）：发射即旁路，不注入零副作用；主链/账本语义不受影响 */
  onEvent?: (e: SessionEvent) => void;
  /** 子代理执行单元（harness/装配根注入）：run 起止挂/摘 spawn 预算源；缺省无 spawn 能力 */
  runner?: SubagentRunner;
}

/** 并行动作项：一轮同时执行的多个工具调用（除 exec 外均可并行） */
interface ParallelToolCall { tool: string; input?: Record<string, unknown>; }
interface Action { tool?: string; input?: Record<string, unknown>; tools?: ParallelToolCall[]; done: boolean; reply?: string; phase?: string; }
/** 并行调用上限：防单轮塞满列表拖长步时延（8 项足够覆盖常用组合） */
const PARALLEL_TOOLS_LIMIT = 8;

type ParseResult =
  | { ok: true; action: Action }
  | { ok: false; raw: string };

/** 最小 Reactor：observe → think → act → observe 线性循环 */
export class Reactor {
  constructor(private deps: ReactorDeps) {}

  async run(task: Task, opts?: ReactorOpts): Promise<RunResult> {
    const maxSteps = opts?.maxSteps ?? 200;
    // 结构化输出（run 级常量）：请求级 response_format 随每次模型调用下发，端点侧约束动作信封形态；
    // 环境变量运行期不变，run 内解析一次（对齐 CONTEXT_WINDOW 先例）
    const responseFormat = resolveStructuredFormat(process.env.SUNSHINEX_STRUCTURED_OUTPUT);
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

    let stopReason: StopReason = 'max-steps'; // 循环出口原因：护栏越限（缺省即步数），done / model-error 在各自分支覆盖
    for (;;) {
      const step = steps.length > 0 ? steps[steps.length - 1].step + 1 : 1;
      const hit = guardrailStop({
        now: Date.now(),
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        tokensUsed,
        ...(tokenCap !== undefined ? { tokenCap } : {}),
        iteration: steps.length - seedLen, // 本 run 新增完成步数：maxSteps 只约束本 run 新增步
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
          const chunks = await this.deps.context.window.compact(items, {
            summaryTokenBudget: Math.floor(budget.reserve / 2),
          });
          await this.deps.context.applyCompaction(chunks, { rereadTokenBudget: Math.floor(budget.reserve / 2) });
          compactedUpToStep = steps.length > 0 ? steps[steps.length - 1].step : seedLastStep;
          // fork 模型压缩协调：折叠的链前缀同步裁出会话链，压缩块与链永不双份
          this.deps.context.trimChainFront(seed.filter((s) => s.step <= compactedUpToStep).length);
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

      // think: 经 ModelAdapter 决策（带动作协议 prompt）
      const prompt = this.buildPrompt(items);
      let raw: string;
      try {
        // usage 为 per-request 全量值：聚合用「基线 + 本请求覆盖」而非盲目累加——
        // 端点在多个流式帧重复携带 usage 时覆盖语义天然幂等，漏算与重复累计两类口径病一次消除
        usageBase = tokensUsed;
        cacheBase = cacheHitTokens;
        promptBase = promptTokens;
        raw = await this.callModel(adapter, prompt, {
          onCache: (c) => {
            if (c > 0) cacheHitTokens = cacheBase + c; // 0 值忽略：占位/缺字段不得冲掉已累计的真实值
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
        }, responseFormat);
      } catch (e) {
        reply = e instanceof Error ? e.message : '模型调用失败';
        this.emit('error', reply);
        stopReason = 'model-error';
        break;
      }

      const parsed = this.parse(raw);
      if (!parsed.ok) {
        // 模型未按 JSON 输出：把原文回填为观察，给模型一次自我纠正机会
        steps.push({ step, observation: pick(`Model output is not valid JSON (truncated): ${raw.slice(0, 400)}`, `模型输出非 JSON（截断）：${raw.slice(0, 400)}`) });
        continue;
      }

      const action = parsed.action;
      // 终稿步骤不透传 phase：阶段说明只属于工具动作步骤，答复流式入档中途不再插入阶段行
      this.emit('step', action.tool ?? (action.done ? 'done' : '（无动作）'), { step, phase: action.done ? undefined : action.phase });
      if (action.done) {
        done = true;
        reply = action.reply ?? '完成';
        stopReason = 'done';
        break;
      }

      if (action.tools && action.tools.length > 0) {
        await this.runParallelTools(step, action, steps);
        continue;
      }

      if (!action.tool) {
        steps.push({ step, observation: pick('Action is missing the tool field', '动作缺少 tool 字段') });
        continue;
      }

      // act: 经安全链执行
      this.emit('tool-call', action.tool, { input: action.input });
      const r = await this.deps.registry.execute(action.tool, action.input ?? {}, this.deps.safety);
      const observation = this.describe(r);
      this.emit('tool-result', observation.slice(0, 200), { ok: r.ok, full: observation, tool: action.tool });
      steps.push({ step, action: action.tool, observation });
      if (r.ok && (action.tool === 'read' || action.tool === 'grep')) {
        const p = (action.input ?? {}).path;
        if (typeof p === 'string' && p.length > 0) this.deps.context.trackFile(p);
      }
      // 观察只入 history（单一来源）：memory 注入段位于 goal/history 之前，逐步写记忆会击穿其后全部 KV 前缀缓存
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
        this.deps.context.appendChain([{ action: 'note', observation: pick(`Task ended without completion (${stopReason ?? 'unknown'})`, `任务未完成收束（${stopReason ?? 'unknown'}）`) }]);
      }
    }

    // 成功沉淀钩子：maxSteps 耗尽 / 模型失败路径不触发；抛错吞掉记链行（链即记忆，事件走链），不倒灌任务成败
    if (done && reply && this.deps.settle) {
      try {
        this.deps.settle({ goal: task.goal, reply });
      } catch (e) {
        this.deps.context.appendChain([{ action: 'note', observation: pick(`Settle failed (not propagated to task outcome): ${e instanceof Error ? e.message : String(e)}`, `沉淀失败（不倒灌任务成败）：${e instanceof Error ? e.message : String(e)}`) }]);
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

  /** 模型调用：优先 completeStream（token 增量逐段发射）；适配器未实现时降级 complete（token 整段一次发）。
   * format（可选 response_format）两路同源透传，结构化输出对流式/非流式形态无感 */
  private async callModel(adapter: ModelAdapter, prompt: string, hooks: UsageHooks, format?: ResponseFormat): Promise<string> {
    const streamable = adapter as ModelAdapter & {
      completeStream?: (p: string, onDelta: (t: string) => void, hooks?: UsageHooks, format?: ResponseFormat) => Promise<string>;
    };
    if (typeof streamable.completeStream === 'function') {
      return streamable.completeStream(prompt, (t) => this.emit('token', t), hooks, format);
    }
    const out = await adapter.complete(prompt, hooks, format);
    this.emit('token', out);
    return out;
  }

  private buildPrompt(items: ContextItem[]): string {
    // 段序固定「身份 → 工具清单 → 输出协议 → 上下文」：全段逐字节稳定，同任务相邻步仅 history 尾部追加（前缀缓存第一要义）；
    // 工具清单按名排序，产出与注册顺序无关。模型档位是用户级会话参数（--tier / /model），不进提示词、不随步重估
    const tools = [...this.deps.registry.list()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');
    const contextText = items.map((i) => i.content).join('\n');
    // 稳定段双语（pick：en/zh 就地成对；语言经 --language 装配后全程恒定，同会话内不因语言分叉前缀）
    return [
      pick(
        'You are SunshineX, a general-purpose agent that completes tasks by calling tools.',
        '你是 SunshineX 智能体，通过调用工具完成任务。',
      ),
      // 输出约定（跨交互面通用）：唯一格式耦合点是 Markdown 本身；呈现效果由 TUI/GUI 各自负责，提示词不感知渲染层
      pick(
        'Write the final answer (the reply field) in Markdown; prefer tables for comparisons and multi-field enumerations.',
        '最终答复（reply 字段）使用 Markdown 输出；对比、多字段枚举类信息优先用表格呈现。',
      ),
      // phase 约定（进度行防刷屏）：仅「阶段切换」时携带，同阶段连续动作不重复报，非关键动作不报
      pick(
        'Each reply JSON may optionally carry "phase":"<one sentence naming the current stage>": include it only when entering a new stage, saying what the upcoming tool calls are for; do not repeat it for consecutive actions within the same stage, and skip it for trivial single-step actions.',
        '每次回复的 JSON 可选携带 "phase":"<当前阶段一句话>"：仅在进入新阶段时携带，随工具调用说明即将做什么；同阶段连续动作无需重复携带，简单单步动作不必携带。',
      ),
      pick('Available tools:', '可用工具：'),
      tools,
      '',
      pick(
        'Tool choice: whenever a dedicated tool covers the action (read/grep/glob and other read-only queries), use it; exec is only the fallback for actions no dedicated tool covers; do not chain exec cat/head/ls for a single lookup.',
        '工具选择：能用专用工具（read/grep/glob 等只读查询）就用专用工具，exec 只兜底没有专用工具覆盖的动作；单次查证不要用 exec 拼 cat/head/ls 组合拳。',
      ),
      '',
      pick(
        'Work on the task given by the last task-instruction line in the context; complete it fully, then end with done and give the final answer in reply.',
        '处理上下文中最后一条任务指令行给出的任务；完整完成后以 done 收束并在 reply 给出最终答复。',
      ),
      '',
      pick('Reply with exactly one JSON object and nothing else. Two forms:', '每次只回复一个 JSON 对象，不要输出任何其它文字。格式二选一：'),
      pick(
        '1) Tool call: {"tool":"<name>","input":{...},"done":false}; multiple non-exec tools may run in parallel in one round: {"tools":[{"tool":"<name>","input":{...}},...],"done":false} — in the parallel form, tools and inputs go inside the tools array and the outer object must not carry a tool field',
        '1) 调用工具：{"tool":"<工具名>","input":{...},"done":false}；除 exec 外的多个工具可一轮并行：{"tools":[{"tool":"<名>","input":{...}},...],"done":false}——并行时工具与入参都写在 tools 数组内，外层不得再有 tool 字段',
      ),
      pick('2) Task done: {"done":true,"reply":"<final answer>"}', '2) 任务完成：{"done":true,"reply":"<最终答复>"}'),
      '',
      pick('Context:', '上下文：'),
      pick(
        `Current working directory (project root): ${this.deps.root ?? this.deps.context.root}`,
        `当前工作目录（项目根）：${this.deps.root ?? this.deps.context.root}`,
      ),
      contextText,
    ].join('\n');
  }

  private toHistory(steps: StepRecord[], fromStep: number): ContextItem[] {
    return steps
      .filter((s) => s.step > fromStep)
      .map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` }));
  }

  /** 一轮并行多个工具（除 exec 外均可并行，对标 Claude Code 的并行调用）：经 Promise.all 并发执行，
   * 结果合并为单条观察回填（tool-call/result 事件仍逐工具发射，TUI 逐行上屏）；
   * exec 为命令类须单发独占执行（命令间有顺序与工作目录依赖），混入即整体拒绝，观察回填供模型自纠 */
  private async runParallelTools(step: number, action: Action, steps: StepRecord[]): Promise<void> {
    const calls = action.tools ?? [];
    const denied =
      calls.length > PARALLEL_TOOLS_LIMIT
        ? pick(`Parallel batch exceeds the limit of ${PARALLEL_TOOLS_LIMIT} tools`, `并行调用超过上限 ${PARALLEL_TOOLS_LIMIT} 项`)
        : calls.some((c) => {
            const cat = this.deps.registry.get(c.tool)?.category;
            return cat === 'bash' || cat === undefined;
          })
          ? pick('Parallel batch allows only non-exec tools (exec must run exclusively on its own)', '并行调用仅限非 exec 工具（exec 须单发独占执行）')
          : '';
    if (denied) {
      const obs = pick(`Parallel batch rejected: ${denied}; remove exec and retry, or fall back to a single tool call`, `并行调用被拒绝：${denied}；请移除 exec 后重试，或改用单工具调用`);
      steps.push({ step, action: 'parallel', observation: obs });
      return;
    }
    const results = await Promise.all(calls.map((c) => this.deps.registry.execute(c.tool, c.input ?? {}, this.deps.safety)));
    const parts: string[] = [];
    // 上屏按调用序成对流出（call+result 相邻）：执行本身仍是 Promise.all 并发，
    // 但视图上每个工具行紧跟自己的结果行，不出现「调用行连排、结果行连排」的割裂
    results.forEach((r, i) => {
      this.emit('tool-call', calls[i].tool, { input: calls[i].input });
      const obs = this.describe(r);
      this.emit('tool-result', obs.slice(0, 200), { ok: r.ok, full: obs, tool: calls[i].tool });
      parts.push(`[${calls[i].tool}] ${obs}`);
      const p = (calls[i].input ?? {}).path;
      if (r.ok && (calls[i].tool === 'read' || calls[i].tool === 'grep') && typeof p === 'string' && p.length > 0) {
        this.deps.context.trackFile(p);
      }
    });
    const observation = `[并行 ${calls.length} 项]\n${parts.join('\n')}`;
    steps.push({ step, action: calls.map((c) => c.tool).join('+'), observation });
  }

  private parse(raw: string): ParseResult {
    try {
      let parsed = JSON.parse(raw) as unknown;
      // 模型偶发以顶层数组输出信封，两种畸形都要归一，否则动作被静默吞掉（该轮无工具执行也无回复）：
      // ① [{...tools...}]——信封对象被数组包装，取首元素按对象解析；
      // ② [{tool..},{tool..}]——裸的调用清单，整体视为并行动作
      if (Array.isArray(parsed)) {
        const allCalls =
          parsed.length > 0 &&
          parsed.every((c) => !!c && typeof c === 'object' && typeof (c as { tool?: unknown }).tool === 'string');
        parsed = allCalls ? { tools: parsed } : parsed[0];
      }
      if (parsed === null || typeof parsed !== 'object') return { ok: false, raw };
      const j = parsed as Action;
      // 模型常见畸形：把并行负载误装进单工具信封（{"tool":"tools","input":{...并行数组...}}）——
      // "tools" 是并行协议的数组字段名而非工具名，若不归一，单工具路径会拿 "tools" 查注册表报 TOOL_NOT_FOUND，
      // 模型跟着报错文本退化成逐个串行。这里把 input 为数组（或数组直挂 tools 外层）的形态统一归一为 tools 并行动作
      let tools = Array.isArray(j.tools)
        ? (j.tools as unknown[])
            .filter((t): t is ParallelToolCall => !!t && typeof t === 'object' && typeof (t as ParallelToolCall).tool === 'string')
            .map((t) => (t.input && typeof t.input === 'object' ? { tool: t.tool, input: t.input as Record<string, unknown> } : { tool: t.tool }))
        : undefined;
      if (!tools && j.tool === 'tools' && Array.isArray(j.input)) {
        tools = (j.input as unknown[])
          .filter((t): t is ParallelToolCall => !!t && typeof t === 'object' && typeof (t as ParallelToolCall).tool === 'string')
          .map((t) => (t.input && typeof t.input === 'object' ? { tool: t.tool, input: t.input as Record<string, unknown> } : { tool: t.tool }));
      }
      return {
        ok: true,
        action: {
          tool: j.tool,
          input: j.input,
          ...(tools && tools.length > 0 ? { tools } : {}),
          done: j.done === true,
          reply: j.reply,
          phase: typeof j.phase === 'string' ? j.phase : undefined,
        },
      };
    } catch {
      return { ok: false, raw };
    }
  }

  private describe(r: Result<ExecResult>): string {
    if (r.ok) {
      const out = r.value.stdout || r.value.stderr || 'ok';
      return out.length > 2000 ? `${out.slice(0, 2000)}\n...(截断)` : out;
    }
    return r.error.message.startsWith(r.error.code) ? r.error.message : `${r.error.code}: ${r.error.message}`;
  }
}
