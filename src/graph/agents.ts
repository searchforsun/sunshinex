import { AgentRole, GraphDeps, GraphNodeOutput, SessionEvent } from '../types';
import { GraphNode } from './engine';
import { toReactorBudget } from '../loop/nodes';
import { Reactor } from '../harness/reactor';
import { ROLE_PRESETS, rolePreset } from '../harness/subagent';
import { pick } from '../i18n';

export { ROLE_PRESETS };

/** 角色 Agent 事件发射器：deps 注入即透传，缺省空转（Graph onEvent 贯通点） */
function makeAgentEmitter(deps: GraphDeps): ((e: SessionEvent) => void) | undefined {
  return deps.onEvent;
}

export interface RoleAgentOpts {
  maxSteps?: number;
  /** 上游依赖节点 id（编排接线用） */
  deps?: string[];
}

/** 多角色子 Agent：角色框定 + 单次 Reactor run（预算按 Graph 剩余换算；done→pass，未完成→failed 交错误局部化接管） */
export function makeRoleAgent(role: AgentRole, deps: GraphDeps, opts: RoleAgentOpts = {}): GraphNode {
  const preset = rolePreset(role);
  return {
    id: role,
    kind: 'agent',
    deps: opts.deps ?? [],
    run: async (ctx, _d, _inputs): Promise<GraphNodeOutput> => {
      const goalLabel = String(ctx.state.goal ?? '');
      const context = deps.context;
      // fork 组合：主链快照 + 角色行 + 节点任务行（上游结论已在链上，前置依赖天然可见，不再拼入任务文本）
      const base = context.chainView();
      const nextStep = base.length > 0 ? base[base.length - 1].step + 1 : 1;
      const seedHistory = [
        ...base,
        { step: nextStep, action: 'role', observation: pick(`Your role: ${preset.label} (${role}); duties: ${preset.framing}`, `你的角色：${preset.label}（${role}），职责：${preset.framing}`) },
        { step: nextStep + 1, action: 'task', observation: pick(`Current instruction: ${goalLabel}`, `当前指令：${goalLabel}`) },
      ];
      const remaining = Math.max(0, ctx.termination.maxTokens - ctx.tokensUsed);
      const budget = toReactorBudget(remaining);
      const reactor = new Reactor({
        safety: deps.safety,
        registry: deps.registry,
        context: deps.context,
        model: deps.model,
        ...(deps.router ? { router: deps.router } : {}),
        ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
        ...(deps.ledger ? { ledger: deps.ledger } : {}),
      });
      const result = await reactor.run(
        { goal: goalLabel },
        {
          maxSteps: opts.maxSteps,
          budget,
          tokenCap: remaining,
          deadlineAt: ctx.startedAt + ctx.termination.timeoutMs,
          ...(deps.tier ? { tier: deps.tier } : {}),
          scope: 'fork',
          seedHistory,
        },
      );
      // 子代理返回制：私有步骤不回主链，终态仅回写一行结论/补丁（下游 fork 经主链快照天然可见）
      if (result.done && result.reply) {
        context.appendChain([{ action: 'node', observation: `${preset.label}：${result.reply}` }]);
      } else {
        context.appendChain([{ action: 'note', observation: `${preset.label}: ${pick('node did not finish', '节点未完成收束')} (${result.stopReason ?? 'failed'})` }]);
      }
      return {
        nodeId: role,
        status: result.done ? 'pass' : 'failed',
        reply: result.reply,
        tokens: result.tokensUsed ?? 0,
      };
    },
  };
}
