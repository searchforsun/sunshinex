import { ContextItem, ExecResult, RouteDecision, SessionEvent } from '../types';
import { guardrailStop } from './guardrail';
import { StopReason } from '../types';
import { Result } from '../result';
import { ModelAdapter, ModelRouter, ModelTier, RouteHint, UsageHooks } from '../model/adapter';
import { ToolRegistry } from './tools';
import { RunLedger } from './ledger';
import { SafetyChain } from './security/chain';
import { ContextManager } from './context';

export interface Task { goal: string; }
export interface StepRecord { step: number; action?: string; observation: string; tier?: ModelTier; }
export interface RunResult {
  steps: StepRecord[];
  done: boolean;
  reply?: string;
  tokensUsed?: number;
  /** 路由观测：本 run 实际生效的最后一次决策（模型偏好覆盖时以偏好为准） */
  route?: RouteDecision;
  /** 终止原因（新增）：done=正常完成；model-error=模型失败；其余为护栏越限 */
  stopReason?: StopReason;
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
}

export interface ReactorDeps {
  registry: ToolRegistry;
  safety: SafetyChain;
  context: ContextManager;
  model: ModelAdapter;
  router?: ModelRouter;
  /** 成功沉淀钩子：仅 done 且有 reply 时触发一次；抛错被吞并记 episodic（沉淀失败不倒灌任务成败） */
  settle?: (r: { goal: string; reply: string }) => void;
  /** per-run 成本账本（可选）：run 收尾聚合落 runs/<id>；缺省不落账 */
  ledger?: RunLedger;
  /** 事件流旁路（TUI/GUI 公共地基）：发射即旁路，不注入零副作用；主链/账本语义不受影响 */
  onEvent?: (e: SessionEvent) => void;
}

interface Action { tool?: string; input?: Record<string, unknown>; done: boolean; reply?: string; tier?: unknown; }

type ParseResult =
  | { ok: true; action: Action }
  | { ok: false; raw: string };

/** 最小 Reactor：observe → think → act → observe 线性循环 */
export class Reactor {
  constructor(private deps: ReactorDeps) {}

  async run(task: Task, opts?: ReactorOpts): Promise<RunResult> {
    const maxSteps = opts?.maxSteps ?? 200;
    const budget = opts?.budget ?? { total: 200_000, reserve: 40_000 };
    const tokenCap = opts?.tokenCap;
    const deadlineAt = opts?.deadlineAt;
    const steps: StepRecord[] = [];
    const router = this.deps.router ?? new ModelRouter().bindDefault(this.deps.model);
    let lastRoute: RouteDecision | undefined; // 路由观测：实际生效的最后一次决策（随 run 结果返回）
    let prefTier: ModelTier | undefined; // 模型一次性偏好：仅影响下一轮
    let compactedUpTo = 0; // 压缩水位线：此前 steps 已由摘要代表，不再进入 history
    let lastCompactStep = -2; // 滞回：初始可压（step − (−2) ≥ 2 恒成立）
    let done = false;
    let reply: string | undefined;
    let tokensUsed = 0; // 真实模型用量累计（adapter usage 回传聚合）
    let cacheHitTokens = 0; // prompt 缓存命中累计（adapter onCache 回传聚合）
    const startedAt = Date.now();

    let stopReason: StopReason = 'max-steps'; // 循环出口原因：护栏越限（缺省即步数），done / model-error 在各自分支覆盖
    for (let step = 1; ; step++) {
      const hit = guardrailStop({
        now: Date.now(),
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        tokensUsed,
        ...(tokenCap !== undefined ? { tokenCap } : {}),
        iteration: step - 1, // 已完成步数：与 maxSteps 的既有语义一致（step 从 1 起）
        maxIterations: maxSteps,
      });
      if (hit) {
        stopReason = hit;
        break;
      }
      // observe: 装配 → 估算 → 滞回门 → 收敛环（spec §2.2：压缩当轮即以收敛后上下文组装）
      let items = this.deps.context.assemble(task.goal, this.toHistory(steps, compactedUpTo));
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
          compactedUpTo = steps.length;
          lastCompactStep = step;
          items = this.deps.context.assemble(task.goal, this.toHistory(steps, compactedUpTo));
          est = this.deps.context.window.estimate(items);
          rounds++;
        } while (rounds < 2 && est.used > budget.total);
      }

      // 档位决策（循环内）：模型一次性偏好优先，否则经 route() 正式入参决策——外部 hint 的 role 优先，
      // 复杂度信号缺省时以实时预算占比推导（同原 tierStar 语义），决策留痕随 run 结果返回
      const ratio = est.used / budget.total;
      const decision = router.route({
        ...(opts?.routeHint ?? {}),
        complexity: opts?.routeHint?.complexity ?? (ratio >= 0.6 ? 'high' : step <= 2 && ratio < 0.2 ? 'low' : 'mid'),
      });
      const effectiveTier = prefTier ?? decision.tier;
      lastRoute = prefTier
        ? { tier: prefTier, reason: 'model:preference', bound: router.boundTiers().includes(prefTier), adapterProvider: router.resolve(prefTier).provider }
        : decision;
      this.emit('route', undefined, { tier: lastRoute.tier, reason: lastRoute.reason });
      prefTier = undefined; // 一次性消费

      // think: 经 ModelAdapter 决策（带动作协议 prompt）
      const prompt = this.buildPrompt(items, effectiveTier);
      let raw: string;
      try {
        raw = await this.callModel(router.resolve(effectiveTier), prompt, {
          onCache: (c) => {
            cacheHitTokens += c;
          },
          onUsage: (t) => {
            tokensUsed += t;
            this.emit('usage', undefined, { tokens: t, turnTotal: tokensUsed, cacheHitTotal: cacheHitTokens });
          },
          onReasoning: (t) => this.emit('reasoning', t),
        });
      } catch (e) {
        reply = e instanceof Error ? e.message : '模型调用失败';
        this.emit('error', reply);
        stopReason = 'model-error';
        break;
      }

      const parsed = this.parse(raw);
      if (!parsed.ok) {
        // 模型未按 JSON 输出：把原文回填为观察，给模型一次自我纠正机会
        steps.push({ step, observation: `模型输出非 JSON（截断）：${raw.slice(0, 400)}`, tier: effectiveTier });
        this.deps.context.memory.record('project', `step ${step}: 模型输出未解析`);
        continue;
      }

      const action = parsed.action;
      this.emit('step', action.tool ?? (action.done ? 'done' : '（无动作）'), { step });
      prefTier = action.tier === 'small' || action.tier === 'medium' || action.tier === 'large' ? action.tier : undefined;
      if (action.done) {
        done = true;
        reply = action.reply ?? '完成';
        stopReason = 'done';
        break;
      }

      if (!action.tool) {
        steps.push({ step, observation: '动作缺少 tool 字段', tier: effectiveTier });
        this.deps.context.memory.record('project', `step ${step}: 动作缺 tool`);
        continue;
      }

      // act: 经安全链执行
      this.emit('tool-call', action.tool, { input: action.input });
      const r = await this.deps.registry.execute(action.tool, action.input ?? {}, this.deps.safety);
      const observation = this.describe(r);
      this.emit('tool-result', observation.slice(0, 200), { ok: r.ok, full: observation });
      steps.push({ step, action: action.tool, observation, tier: effectiveTier });
      if (r.ok && (action.tool === 'read' || action.tool === 'grep')) {
        const p = (action.input ?? {}).path;
        if (typeof p === 'string' && p.length > 0) this.deps.context.trackFile(p);
      }
      // observe: 写回记忆
      this.deps.context.memory.record('project', `step ${step}: ${observation}`);
    }

    // 任务收尾：清退 working 层（done 与 maxSteps 耗尽共用此出口）
    this.deps.context.memory.endTask();
    // 成功沉淀钩子：maxSteps 耗尽 / 模型失败路径不触发；抛错吞掉记 episodic，不倒灌任务成败
    if (done && reply && this.deps.settle) {
      try {
        this.deps.settle({ goal: task.goal, reply });
      } catch (e) {
        this.deps.context.memory.record('settle', `沉淀失败（不倒灌任务成败）：${e instanceof Error ? e.message : String(e)}`);
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
          ...(lastRoute ? { route: { tier: lastRoute.tier, reason: lastRoute.reason } } : {}),
        });
      } catch {
        // 账本失败不倒灌任务成败
      }
    }
    // 收尾事件：done 必发（正常/异常路径共用出口）；error 已在失败点提前发出
    this.emit('done', reply, { steps: steps.length, tokensUsed, stopReason });
    return { steps, done, reply, tokensUsed, route: lastRoute, stopReason };
  }

  /** 事件发射器：仅旁路通知；onEvent 缺省为零开销空转 */
  private emit(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): void {
    this.deps.onEvent?.({ type, text, payload, ts: Date.now() });
  }

  /** 模型调用：优先 completeStream（token 增量逐段发射）；适配器未实现时降级 complete（token 整段一次发） */
  private async callModel(adapter: ModelAdapter, prompt: string, hooks: UsageHooks): Promise<string> {
    const streamable = adapter as ModelAdapter & {
      completeStream?: (p: string, onDelta: (t: string) => void, hooks?: UsageHooks) => Promise<string>;
    };
    if (typeof streamable.completeStream === 'function') {
      return streamable.completeStream(prompt, (t) => this.emit('token', t), hooks);
    }
    const out = await adapter.complete(prompt, hooks);
    this.emit('token', out);
    return out;
  }

  private buildPrompt(items: ContextItem[], tier: ModelTier): string {
    // 段序固定「身份 → 工具清单 → 输出协议 → 上下文 → 档位提示」：稳定段前置提升 provider 端 KV 前缀缓存命中，
    // 档位随步变化置于尾部，避免每步击穿前缀；工具清单按名排序，产出与注册顺序无关
    const tools = [...this.deps.registry.list()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');
    const contextText = items.map((i) => i.content).join('\n');
    return [
      '你是 SunshineX 智能体，通过调用工具完成任务。',
      '可用工具：',
      tools,
      '',
      '每次只回复一个 JSON 对象，不要输出任何其它文字。格式二选一：',
      '1) 调用工具：{"tool":"<工具名>","input":{...},"done":false}',
      '2) 任务完成：{"done":true,"reply":"<最终答复>"}',
      '',
      '上下文：',
      contextText,
      '',
      `当前服务档位：${tier}；如需调整下一轮算力，在回复 JSON 中加 "tier": "small|medium|large"`,
    ].join('\n');
  }

  private toHistory(steps: StepRecord[], fromStep: number): ContextItem[] {
    return steps
      .filter((s) => s.step > fromStep)
      .map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` }));
  }

  private parse(raw: string): ParseResult {
    try {
      const j = JSON.parse(raw) as Action;
      return { ok: true, action: { tool: j.tool, input: j.input, done: j.done === true, reply: j.reply, tier: j.tier } };
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
