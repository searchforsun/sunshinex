import { LoopContext, LoopTermination } from '../types';
import { LoopDeps, LoopEngine, LoopEngineNode } from './engine';
import { agentNode, checkNode, gateNode, routerNode } from './nodes';

/** 三大模板缺省终止参数（opts.termination 可按项覆盖） */
const DEFAULT_TERMINATION: LoopTermination = { maxIterations: 100, maxTokens: 1_000_000, timeoutMs: 7_200_000 };

/** 模板产物：纯数据预组装（节点序列 + 终止参数）+ 就绪引擎 */
export interface LoopTemplate {
  name: string;
  nodes: LoopEngineNode[];
  termination: LoopTermination;
  engine: LoopEngine;
}

export interface TemplateOpts {
  termination?: Partial<LoopTermination>;
  ruleCheckers?: Record<string, (io: { ctx: LoopContext; goal: string }) => Promise<boolean> | boolean>;
}

function assemble(
  name: string,
  nodes: LoopEngineNode[],
  deps: LoopDeps,
  opts?: TemplateOpts,
): LoopTemplate {
  const termination: LoopTermination = { ...DEFAULT_TERMINATION, ...(opts?.termination ?? {}) };
  return { name, nodes, termination, engine: new LoopEngine(nodes, deps, termination) };
}

/** agent 包装：验收权在 check——reactor 的 done/fail 一律降为 pass 续流（中间步属正常推进） */
function execAgent(deps: LoopDeps, opts?: { maxSteps?: number }): LoopEngineNode {
  const inner = agentNode(deps, opts);
  return {
    ...inner,
    run: async (ctx, input) => {
      const out = await inner.run(ctx, input);
      return { ...out, status: 'pass' };
    },
  };
}

/** agent 包装：结论落 ctx.state.agentReply（供 gate 断言与 check 模型判据消费） */
function execAgentWithReply(deps: LoopDeps, opts?: { maxSteps?: number }): LoopEngineNode {
  const inner = execAgent(deps, opts);
  return {
    ...inner,
    run: async (ctx, input) => {
      const out = await inner.run(ctx, input);
      if (typeof out.reply === 'string') ctx.state.agentReply = out.reply;
      return out;
    },
  };
}

/** 修复 agent：跑完后清空 deficits（修正已被本轮消费，复检不因残留 deficits 再入环） */
function repairAgent(deps: LoopDeps, id: string, opts?: { maxSteps?: number }): LoopEngineNode {
  const inner = execAgentWithReply(deps, opts);
  return {
    ...inner,
    id,
    run: async (ctx, input) => {
      const out = await inner.run(ctx, input);
      delete ctx.state.deficits;
      return out;
    },
  };
}

/** 修正环路由：check 未过项（deficits）非空 → 回 agent 定向修正；否则顺序续流 */
function repairRouter(target = 'agent'): LoopEngineNode {
  return routerNode({
    route: ({ ctx }) =>
      Array.isArray(ctx.state.deficits) && ctx.state.deficits.length > 0 ? target : undefined,
  });
}

/** 代码重构：agent(重构) → check(验收规则) → router(未过回 agent 定向修正) */
export function codeRefactorTemplate(deps: LoopDeps, opts?: TemplateOpts): LoopTemplate {
  return assemble(
    'code-refactor',
    [execAgentWithReply(deps), checkNode(deps, { ruleCheckers: opts?.ruleCheckers }), repairRouter()],
    deps,
    opts,
  );
}

/** 测试闭环：agent(生成/修复测试) → check(验证规则) → router(未过回 agent 修复) */
export function testLoopTemplate(deps: LoopDeps, opts?: TemplateOpts): LoopTemplate {
  return assemble(
    'test-loop',
    [execAgentWithReply(deps), checkNode(deps, { ruleCheckers: opts?.ruleCheckers }), repairRouter()],
    deps,
    opts,
  );
}

/** 代码审查：agent(审查) → gate(结论非空) → router(有未过项→fixer / 无→check 复检) → check → fixer */
export function codeReviewTemplate(deps: LoopDeps, opts?: TemplateOpts): LoopTemplate {
  const nodes: LoopEngineNode[] = [
    execAgentWithReply(deps),
    gateNode({
      assert: (ctx) => {
        const reply = typeof ctx.state.agentReply === 'string' ? ctx.state.agentReply : '';
        return reply.length > 0
          ? { passed: true }
          : { passed: false, reason: '审查未产出结论' };
      },
    }),
    routerNode({
      route: ({ ctx }) =>
        Array.isArray(ctx.state.deficits) && ctx.state.deficits.length > 0 ? 'fixer' : 'check',
    }),
    checkNode(deps, { ruleCheckers: opts?.ruleCheckers }),
    repairAgent(deps, 'fixer'),
  ];
  return assemble('code-review', nodes, deps, opts);
}

/** 长任务时间兜底：4h（对齐 Graph DEFAULT_TERMINATION.timeoutMs，D3 单次提交计时口径） */
export const LONG_TASK_TIMEOUT_MS = 14_400_000;

export interface LongTaskOpts extends TemplateOpts {
  /** 单次 agent 的步数上限；缺省交给 Reactor 的 200 */
  agentMaxSteps?: number;
}

/**
 * 长任务：单 agent 节点，**无 check 节点**（D1：完成以模型自报 done 为准，不引入校验环节）。
 * 用 `agentNode` 而非 `execAgent` —— 后者把状态强制降为 pass（为 agent+check 模板设计），
 * 在单节点模板下会让引擎绕回自身直到 maxIterations 耗尽。同时本模板显式把时间兜底提到 4h，
 * 覆盖 Loop 层缺省的 2h（避免同一入口两套时长）。
 */
export function longTaskTemplate(deps: LoopDeps, opts?: LongTaskOpts): LoopTemplate {
  const agentOpts = opts?.agentMaxSteps !== undefined ? { maxSteps: opts.agentMaxSteps } : {};
  return assemble('long-task', [agentNode(deps, agentOpts)], deps, {
    ...opts,
    termination: { timeoutMs: LONG_TASK_TIMEOUT_MS, ...(opts?.termination ?? {}) },
  });
}
