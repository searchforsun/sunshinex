import { CriterionResult, LoopContext, NodeOutput } from '../types';
import { ModelRouter } from '../model/adapter';
import { Reactor } from '../harness/reactor';
import { LoopDeps, LoopEngineNode } from './engine';

/** 剩余预算 → Reactor 预算（纯函数）：total 保底 1，reserve 为 total 的 1/5 */
export function toReactorBudget(remaining: number): { total: number; reserve: number } {
  const total = Math.max(remaining, 1);
  return { total, reserve: Math.floor(total / 5) };
}

/** 未过验收项回注（纯函数）：ctx.state.deficits 非空时在 goal 后追加清单段，空则原样返回 */
export function withDeficits(goal: string, ctx: LoopContext): string {
  const deficits = ctx.state.deficits;
  if (!Array.isArray(deficits) || deficits.length === 0) return goal;
  const lines = (deficits as CriterionResult[]).map((d) => `- ${d.id}: ${d.desc}`).join('\n');
  return `${goal}\n\n上次未过验收项：\n${lines}`;
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

/** 模型判据：构造判据 prompt（准则描述 + goal + agentReply 证据），期望 {"passed":bool,"evidence":str} */
async function modelJudge(
  adapter: { complete(prompt: string): Promise<string> },
  criterion: { id: string; desc: string },
  goal: string,
  agentReply: string,
): Promise<CriterionResult> {
  const prompt = [
    `你是验收判据模型。目标：${goal}`,
    `执行答复（证据）：${agentReply}`,
    `验收标准 ${criterion.id}：${criterion.desc}`,
    '仅回复一个 JSON 对象：{"passed":boolean,"evidence":string}',
  ].join('\n');
  let raw: string;
  try {
    raw = await adapter.complete(prompt);
  } catch (e) {
    return { id: criterion.id, desc: criterion.desc, passed: false, evidence: e instanceof Error ? e.message : '模型判据调用失败' };
  }
  try {
    const j = JSON.parse(raw) as { passed?: unknown; evidence?: unknown };
    return {
      id: criterion.id,
      desc: criterion.desc,
      passed: j.passed === true,
      evidence: typeof j.evidence === 'string' ? j.evidence : undefined,
    };
  } catch {
    // fail-bounded：判据输出不可解析 → 判不通过，不静默放行
    return { id: criterion.id, desc: criterion.desc, passed: false, evidence: '模型判据输出非 JSON' };
  }
}

/** 判定通道：ruleCheckers 谓词优先；否则 router.resolve('small')，抛错回退 deps.model */
async function judgeOne(
  deps: LoopDeps,
  ruleCheckers: Record<string, (io: { ctx: LoopContext; goal: string }) => Promise<boolean> | boolean>,
  criterion: { id: string; desc: string },
  ctx: LoopContext,
  goal: string,
): Promise<CriterionResult> {
  const rule = ruleCheckers[criterion.id];
  if (rule) {
    const passed = await rule({ ctx, goal });
    return { id: criterion.id, desc: criterion.desc, passed };
  }
  let adapter: { complete(prompt: string): Promise<string> };
  try {
    adapter = (deps.router ?? new ModelRouter()).resolve('small');
  } catch {
    adapter = deps.model; // 回退主模型（报告登记：router 未绑定小档时判据走主通道）
  }
  return modelJudge(adapter, criterion, goal, typeof ctx.state.agentReply === 'string' ? ctx.state.agentReply : '');
}

/** agent 节点：Reactor 执行（goal 经 deficit 回注），预算按剩余 token 换算 */
export function agentNode(deps: LoopDeps, opts?: { maxSteps?: number }): LoopEngineNode {
  return {
    id: 'agent',
    kind: 'agent',
    run: async (ctx: LoopContext, input: NodeOutput | null): Promise<NodeOutput> => {
      // 注：NodeOutput 无 goal 字段（计划笔误），engine.run 已把 goal 写入 ctx.state，agentNode 从 state 取
      const goal = withDeficits(typeof ctx.state.goal === 'string' ? ctx.state.goal : '', ctx);
      const budget = toReactorBudget(ctx.termination.maxTokens - ctx.tokensUsed);
      const reactor = new Reactor(deps);
      const r = await reactor.run({ goal }, { maxSteps: opts?.maxSteps, budget });
      return { status: r.done ? 'done' : 'fail', reply: r.reply, tokens: r.tokensUsed ?? 0 };
    },
  };
}

/** check 节点：准则三优先级（输入清单 > goal 内嵌段 > fail）；规则谓词优先、模型判据兜底；全过 done、未过写 deficits */
export function checkNode(
  deps: LoopDeps,
  opts?: { ruleCheckers?: Record<string, (io: { ctx: LoopContext; goal: string }) => Promise<boolean> | boolean> },
): LoopEngineNode {
  return {
    id: 'check',
    kind: 'check',
    run: async (ctx: LoopContext, input: NodeOutput | null): Promise<NodeOutput> => {
      // 准则来源三优先级：显式输入清单 > goal 内嵌段 > fail（解析失败不静默通过）
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
        if (!parsed) {
          return { status: 'fail', reply: '无验收标准（解析失败不静默通过）', tokens: 0 };
        }
        criteria = parsed;
      }

      const goal = typeof ctx.state.goal === 'string' ? ctx.state.goal : '';
      for (let i = 0; i < criteria.length; i++) {
        criteria[i] = await judgeOne(deps, opts?.ruleCheckers ?? {}, criteria[i], ctx, goal);
      }

      const failed = criteria.filter((c) => !c.passed);
      if (failed.length === 0) return { status: 'done', criteria, tokens: 0 };
      ctx.state.deficits = failed;
      return {
        status: 'fail',
        criteria,
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
