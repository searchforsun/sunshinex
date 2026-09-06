import {
  CriterionResult,
  LoopContext,
  LoopNodeBase,
  LoopTermination,
  NodeOutput,
} from '../types';
import { ModelAdapter, ModelRouter } from '../model/adapter';
import { ToolRegistry } from '../harness/tools';
import { SafetyChain } from '../harness/security/chain';
import { ContextManager } from '../harness/context';

/** 节点执行函数：async 或同步返回皆可；input 为上一节点输出（首轮 null） */
export type LoopNodeFn = (ctx: LoopContext, input: NodeOutput | null) => Promise<NodeOutput> | NodeOutput;

/** 节点：公共字段 + 执行函数（淘汰占位 LoopNode 接口） */
export type LoopEngineNode = LoopNodeBase & { run: LoopNodeFn };

/** 依赖容器（T4 收紧：显式五件套；router 可选，为档位判据与模型兜底提供注入位） */
export interface LoopDeps {
  safety: SafetyChain;
  registry: ToolRegistry;
  context: ContextManager;
  model: ModelAdapter;
  router?: ModelRouter;
}

/** Loop 运行结果：终态三分 done/failed/paused；paused 仅用于预算超支（不伪造完成） */
export interface LoopRunResult {
  status: 'done' | 'failed' | 'paused';
  iterations: number;
  tokensUsed: number;
  reply?: string;
  criteria?: CriterionResult[];
  state: Record<string, unknown>;
  error?: string;
}

/** Loop 引擎：主干顺序执行 + router 跳转；每节点边界四重终止检查（验收→迭代→超时→预算） */
export class LoopEngine {
  private nodes: LoopEngineNode[];
  private index: Map<string, number>;
  private deps: LoopDeps;
  private termination: LoopTermination;
  private hooks: { onNodeEnd?: (node: LoopEngineNode, out: NodeOutput, ctx: LoopContext) => void };

  constructor(
    nodes: Array<LoopNodeBase & { run: LoopNodeFn }>,
    deps: LoopDeps,
    termination: LoopTermination,
    hooks?: { onNodeEnd?: (node: LoopEngineNode, out: NodeOutput, ctx: LoopContext) => void },
  ) {
    this.nodes = [...nodes];
    this.index = new Map();
    for (let i = 0; i < nodes.length; i++) this.index.set(nodes[i].id, i);
    this.deps = deps;
    this.termination = termination;
    this.hooks = hooks ?? {};
    if (this.nodes.length === 0) throw new Error('LoopEngine: 节点清单为空');
  }

  /** 运行至终态；dryRun 经 ctx.state.__dryRun 透传给节点 */
  async run(
    goal: string,
    opts?: { state?: Record<string, unknown>; dryRun?: boolean },
  ): Promise<LoopRunResult> {
    const ctx: LoopContext = {
      iteration: 0,
      state: { ...(opts?.state ?? {}), goal, ...(opts?.dryRun ? { __dryRun: true } : {}) },
      tokensUsed: 0,
      startedAt: Date.now(),
      termination: this.termination,
    };
    let cursor = 0;
    let input: NodeOutput | null = null;

    while (true) {
      const node = this.nodes[cursor];

      // 边界检查（本轮执行前）：② iteration 上限 failed → ③ 超时 failed → ④ tokens 上限 paused
      if (ctx.iteration >= this.termination.maxIterations) {
        return this.finish(ctx, 'failed', {
          error: `iteration 上限（${this.termination.maxIterations}）已耗尽`,
        });
      }
      if (Date.now() - ctx.startedAt >= this.termination.timeoutMs) {
        return this.finish(ctx, 'failed', {
          error: `执行超时（超过 ${this.termination.timeoutMs}ms）`,
        });
      }
      if (ctx.tokensUsed >= this.termination.maxTokens) {
        return this.finish(ctx, 'paused', {
          error: `token 预算超支（used ${ctx.tokensUsed} ≥ max ${this.termination.maxTokens}）`,
        });
      }

      const out = await node.run(ctx, input);
      ctx.iteration += 1; // iterations = 已完成的节点执行步（所有终态统一按此报告）
      ctx.tokensUsed += out.tokens; // 引擎统一累加，节点不自管
      this.hooks.onNodeEnd?.(node, out, ctx);

      // ① 验收通过：节点自报 done，或 check 节点全过（pass）→ 成功终态（每步后最先判定，优先于失败与上限）
      if (out.status === 'done' || (node.kind === 'check' && out.status === 'pass')) {
        return this.finish(ctx, 'done', { reply: out.reply, criteria: out.criteria });
      }

      // check 节点 fail = 验收未过（续流至 router 修正环，fail-bounded 由迭代/超时兜底）；其余节点 fail = 硬失败
      if (out.status === 'fail' && node.kind !== 'check') {
        return this.finish(ctx, 'failed', {
          error: `节点 ${node.id} fail：${out.reply ?? '（无说明）'}`,
        });
      }
      input = out;

      // 路由：显式 route 优先；否则顺序推进（环式回绕，route 跳转与顺序执行共用同一步进）
      if (out.route !== undefined) {
        const next = this.index.get(out.route);
        if (next === undefined) {
          return this.finish(ctx, 'failed', {
            error: `未知 route 目标节点 id：${out.route}`,
          });
        }
        cursor = next;
      } else {
        cursor = (cursor + 1) % this.nodes.length;
      }
    }
  }

  /** 终态组装：iterations 取 ctx.iteration 实测值 */
  private finish(
    ctx: LoopContext,
    status: LoopRunResult['status'],
    extra: { reply?: string; criteria?: CriterionResult[]; error?: string },
  ): LoopRunResult {
    const r: LoopRunResult = {
      status,
      iterations: ctx.iteration,
      tokensUsed: ctx.tokensUsed,
      state: ctx.state,
    };
    if (extra.reply !== undefined) r.reply = extra.reply;
    if (extra.criteria !== undefined) r.criteria = extra.criteria;
    if (extra.error !== undefined) r.error = extra.error;
    return r;
  }
}
