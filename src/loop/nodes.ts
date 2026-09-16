import { CriterionResult, HistoryStep, LoopContext, NodeOutput } from '../types';
import { pick } from '../i18n';
import { ModelRouter } from '../model/adapter';
import { Reactor } from '../harness/reactor';
import { SPAWN_TOOL_NAME } from '../harness/subagent';
import { LoopDeps, LoopEngineNode } from './engine';

/** 剩余预算 → Reactor 预算（纯函数）：total 保底 1，reserve 为 total 的 1/5 */
export function toReactorBudget(remaining: number): { total: number; reserve: number } {
  const total = Math.max(remaining, 1);
  return { total, reserve: Math.floor(total / 5) };
}

/** /goal 内嵌验收段解析：`验收标准：c1=描述1; c2=描述2`（容忍中英文分号与空白）；无段返回 null */
export function parseCriteria(goal: string): CriterionResult[] | null {
  const m = goal.match(/验收标准[:：]\s*([^\n]+)/);
  if (!m) return null;
  const items = m[1]
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) return null;
  const out: CriterionResult[] = [];
  for (const item of items) {
    const pair = item.match(/^([^=＝]+)[=＝]\s*(.+)$/);
    if (!pair) continue;
    out.push({ id: pair[1].trim(), desc: pair[2].trim(), passed: false });
  }
  return out.length > 0 ? out : null;
}

/** check 节点输入清单：CriterionResult 形状（id+desc）优先 */
type CriteriaInput = Array<{ id?: unknown; desc?: unknown }>;

function isCriteriaInput(v: unknown): v is CriteriaInput {
  return Array.isArray(v) && v.every((c) => c !== null && typeof c === 'object' && 'id' in c && 'desc' in c);
}

/** 判据错误分级：fatal（认证/配额/模型不存在 → 立即清除）与 recoverable（超时/断连/过载/限流 → 重试后暂停）；fatal 模式优先，均未中按 recoverable（保守暂停） */
export function classifyJudgeError(message: string): 'fatal' | 'recoverable' {
  if (/401|402|403|unauthorized|forbidden|quota|insufficient|billing|invalid api key|model not found/i.test(message)) return 'fatal';
  return 'recoverable';
}

/** 判据评估内部结果：judged=判定成功（含 impossible）；blocked=调用失败（分级后终止评估） */
type JudgeOutcome =
  | { kind: 'judged'; result: CriterionResult }
  | { kind: 'blocked'; severity: 'fatal' | 'recoverable'; message: string };

const MAX_JUDGE_RETRIES = 3; // 可恢复错误重试上限（不含初次；对标 CC「retry 3 times then pause」）

/** 模型判据：构造判据 prompt（准则描述 + goal + agentReply 证据），期望 {"passed":bool,"impossible":bool,"evidence":str}；调用失败按分级处置（fatal 不重试、recoverable 重试 ≤3 次后 blocked） */
async function modelJudge(
  adapter: { complete(prompt: string): Promise<string> },
  criterion: { id: string; desc: string },
  goal: string,
  agentReply: string,
): Promise<JudgeOutcome> {
  const prompt = [
    `你是验收判据模型。目标：${goal}`,
    `执行答复（证据）：${agentReply}`,
    `验收标准 ${criterion.id}：${criterion.desc}`,
    pick(
      'Reply with a single JSON object: {"passed":boolean,"impossible":boolean,"evidence":string}',
      '仅回复一个 JSON 对象：{"passed":boolean,"impossible":boolean,"evidence":string}',
    ),
  ].join('\n');
  let raw: string | undefined;
  try {
    raw = await adapter.complete(prompt);
  } catch (e) {
    const message = e instanceof Error ? e.message : '模型判据调用失败';
    if (classifyJudgeError(message) === 'fatal') {
      return { kind: 'blocked', severity: 'fatal', message };
    }
    for (let retry = 0; retry < MAX_JUDGE_RETRIES; retry++) {
      try {
        raw = await adapter.complete(prompt);
        break;
      } catch (e2) {
        const m2 = e2 instanceof Error ? e2.message : '模型判据调用失败';
        if (classifyJudgeError(m2) === 'fatal') {
          return { kind: 'blocked', severity: 'fatal', message: m2 };
        }
      }
    }
    if (raw === undefined) {
      return { kind: 'blocked', severity: 'recoverable', message };
    }
  }
  try {
    const j = JSON.parse(raw) as { passed?: unknown; impossible?: unknown; evidence?: unknown };
    const impossible = j.impossible === true;
    return {
      kind: 'judged',
      result: {
        id: criterion.id,
        desc: criterion.desc,
        passed: j.passed === true,
        ...(impossible ? { verdict: 'impossible' as const } : {}),
        evidence: typeof j.evidence === 'string' ? j.evidence : undefined,
      },
    };
  } catch {
    // fail-bounded：判据输出不可解析 → 判不通过，不静默放行（不算调用失败）
    return { kind: 'judged', result: { id: criterion.id, desc: criterion.desc, passed: false, evidence: '模型判据输出非 JSON' } };
  }
}

/** 判定通道：ruleCheckers 谓词优先；否则 router.resolve('small')，抛错回退 deps.model */
async function judgeOne(
  deps: LoopDeps,
  ruleCheckers: Record<string, (io: { ctx: LoopContext; goal: string }) => Promise<boolean> | boolean>,
  criterion: { id: string; desc: string },
  ctx: LoopContext,
  goal: string,
): Promise<JudgeOutcome> {
  const rule = ruleCheckers[criterion.id];
  if (rule) {
    const passed = await rule({ ctx, goal });
    return { kind: 'judged', result: { id: criterion.id, desc: criterion.desc, passed } };
  }
  let adapter: { complete(prompt: string): Promise<string> };
  try {
    adapter = (deps.router ?? new ModelRouter()).resolve('small');
  } catch {
    adapter = deps.model; // 回退主模型（报告登记：router 未绑定小档时判据走主通道）
  }
  return modelJudge(adapter, criterion, goal, typeof ctx.state.agentReply === 'string' ? ctx.state.agentReply : '');
}

/** agent 节点：Reactor 执行（修正要求走链行/私有前缀，goal 已降级为观测标签），预算按剩余 token 换算 */
export function agentNode(deps: LoopDeps, opts?: { maxSteps?: number }): LoopEngineNode {
  return {
    id: 'agent',
    kind: 'agent',
    run: async (ctx: LoopContext, input: NodeOutput | null): Promise<NodeOutput> => {
      // 注：NodeOutput 无 goal 字段（计划笔误），engine.run 已把 goal 写入 ctx.state，agentNode 从 state 取
      const goal = typeof ctx.state.goal === 'string' ? ctx.state.goal : '';
      const scope = deps.scope ?? 'session';
      const rawSeed = ctx.state.seedHistory;
      const seedHistory = Array.isArray(rawSeed) ? (rawSeed as HistoryStep[]) : undefined;
      // 修正要求走链（主链）/并入私有前缀（fork）：goal 不再承载任务文本改写（goal 已降级为观测标签）
      const deficits = Array.isArray(ctx.state.deficits) ? (ctx.state.deficits as Array<{ id: string; desc: string }>) : [];
      if (deficits.length > 0) {
        const line = `${pick('Fix requirements from last review:', '修正要求（上次未过验收项）：')}\n${deficits.map((d) => `- ${d.id}: ${d.desc}`).join('\n')}`;
        if (scope === 'session') {
          deps.context.appendChain([{ action: 'deficit', observation: line }]);
        } else if (seedHistory) {
          const next = (seedHistory.length > 0 ? seedHistory[seedHistory.length - 1].step : 0) + 1;
          seedHistory.push({ step: next, action: 'deficit', observation: line });
        }
      }
      const remaining = Math.max(0, ctx.termination.maxTokens - ctx.tokensUsed);
      const budget = toReactorBudget(remaining);
      // 「spawn 只在主链工具面」全局不变量收口：fork 私有面派生剔除 spawn 且不携 runner（无嵌套挂载）
      const childDeps: LoopDeps =
        scope === 'fork'
          ? { ...deps, registry: deps.registry.derive({ exclude: [SPAWN_TOOL_NAME] }) }
          : deps;
      const reactor = new Reactor(childDeps);
      const r = await reactor.run(
        { goal },
        {
          maxSteps: opts?.maxSteps,
          budget,
          tokenCap: remaining,
          deadlineAt: ctx.startedAt + ctx.termination.timeoutMs,
          ...(deps.tier ? { tier: deps.tier } : {}),
          scope,
          ...(seedHistory && seedHistory.length > 0 ? { seedHistory } : {}),
        },
      );
      // fork 作用域跨轮接续：步骤经 state.seedHistory 累积（主链作用域由链自然续接，不线程）
      if (scope === 'fork') ctx.state.seedHistory = r.steps;
      return {
        status: r.done ? 'done' : 'fail',
        reply: r.reply,
        tokens: r.tokensUsed ?? 0,
        history: r.steps,
        ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
      };
    },
  };
}

/** check 节点：准则三优先级（输入清单 > goal 内嵌段 > goal 隐式条件）；规则谓词优先、模型判据兜底；全过 done、未过写 deficits */
export function checkNode(
  deps: LoopDeps,
  opts?: { ruleCheckers?: Record<string, (io: { ctx: LoopContext; goal: string }) => Promise<boolean> | boolean> },
): LoopEngineNode {
  return {
    id: 'check',
    kind: 'check',
    run: async (ctx: LoopContext, input: NodeOutput | null): Promise<NodeOutput> => {
      // 准则来源三优先级：显式输入清单 > goal 内嵌段 > goal 整体隐式条件（规格 §4 条件自由化）
      let criteria: CriterionResult[];
      if (isCriteriaInput(input?.criteria)) {
        criteria = input.criteria.map((c) => ({
          id: String(c.id),
          desc: String(c.desc),
          passed: false,
        }));
      } else {
        const goal = typeof ctx.state.goal === 'string' ? ctx.state.goal : '';
        const parsed = parseCriteria(goal);
        // 条件自由化（规格 §4）：无内嵌段时 goal 整体作为单一隐式条件（走模型判据），替代「立即 fail 空转」
        criteria = parsed ?? [{ id: 'condition', desc: goal, passed: false }];
      }

      const goal = typeof ctx.state.goal === 'string' ? ctx.state.goal : '';
      const outcomes: JudgeOutcome[] = [];
      for (let i = 0; i < criteria.length; i++) {
        const outcome = await judgeOne(deps, opts?.ruleCheckers ?? {}, criteria[i], ctx, goal);
        outcomes.push(outcome);
        if (outcome.kind === 'judged' && outcome.result.verdict === 'impossible') break; // 短路：不可满足即整体终局（规格 §5）
      }

      // 聚合优先级（规格 §5）：impossible 短路 > fatal > recoverable 耗尽 > 常规 done/deficits
      const judged = outcomes
        .filter((o): o is Extract<JudgeOutcome, { kind: 'judged' }> => o.kind === 'judged')
        .map((o) => o.result);
      const imp = judged.find((c) => c.verdict === 'impossible');
      if (imp) {
        return {
          status: 'fail',
          criteria: judged,
          tokens: 0,
          terminal: { status: 'failed', error: `目标判定不可满足：${imp.evidence ?? imp.desc}` },
        };
      }
      const fatal = outcomes.find(
        (o): o is Extract<JudgeOutcome, { kind: 'blocked' }> => o.kind === 'blocked' && o.severity === 'fatal',
      );
      if (fatal) {
        return {
          status: 'fail',
          criteria: judged,
          tokens: 0,
          terminal: { status: 'failed', error: `判据评估不可用（认证/配额/模型）：${fatal.message}` },
        };
      }
      const exhaust = outcomes.find((o): o is Extract<JudgeOutcome, { kind: 'blocked' }> => o.kind === 'blocked');
      if (exhaust) {
        return {
          status: 'fail',
          criteria: judged,
          tokens: 0,
          terminal: { status: 'paused', error: `判据评估暂不可用（已重试 ${MAX_JUDGE_RETRIES} 次）：${exhaust.message}` },
        };
      }

      const failed = judged.filter((c) => !c.passed);
      if (failed.length === 0) return { status: 'done', criteria: judged, tokens: 0 };
      ctx.state.deficits = failed;
      return {
        status: 'fail',
        criteria: judged,
        reply: `未过项: ${failed.map((c) => `${c.id}=${c.desc}`).join('; ')}`,
        tokens: 0,
      };
    },
  };
}

/** gate 节点：外部断言谓词，passed → pass，否则 fail + reason */
export function gateNode(
  opts?: { assert?: (ctx: LoopContext) => Promise<{ passed: boolean; reason?: string }> | { passed: boolean; reason?: string } },
): LoopEngineNode {
  return {
    id: 'gate',
    kind: 'gate',
    run: async (ctx: LoopContext): Promise<NodeOutput> => {
      const assert = opts?.assert ?? (() => ({ passed: true }));
      const r = await assert(ctx);
      if (r.passed) return { status: 'pass', tokens: 0 };
      return { status: 'fail', reply: r.reason, tokens: 0 };
    },
  };
}

/** router 节点：产出 route 跳转目标；undefined → 顺序续流 */
export function routerNode(
  opts?: { route?: (io: { ctx: LoopContext; prev: NodeOutput | null }) => string | undefined },
): LoopEngineNode {
  return {
    id: 'router',
    kind: 'router',
    run: (ctx: LoopContext, prev: NodeOutput | null): NodeOutput => {
      const route = opts?.route?.({ ctx, prev });
      return route !== undefined ? { status: 'pass', route, tokens: 0 } : { status: 'pass', tokens: 0 };
    },
  };
}
