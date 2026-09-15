import { AgentRole, GraphDeps, GraphNodeOutput } from '../types';
import { GraphNode } from './engine';
import { AgentRegistry, ROLE_PRESETS, SubagentRunner, rolePreset } from '../harness/subagent';
import { pick } from '../i18n';

export { ROLE_PRESETS };

export interface RoleAgentOpts {
  maxSteps?: number;
  /** 上游依赖节点 id（编排接线用） */
  deps?: string[];
}

/** Runner 回退装配（deps.runner 未注入的装配面/测试用）：生产三处装配（Harness/CLI/TUI）一律注入；
 * 回退仅收敛内建预设面（角色 agent_id 恒命中内建，无需目录加载） */
function ensureRunner(deps: GraphDeps): SubagentRunner {
  if (deps.runner) return deps.runner;
  const agents = new AgentRegistry();
  agents.registerBuiltins();
  return new SubagentRunner(
    {
      registry: deps.registry,
      safety: deps.safety,
      context: deps.context,
      model: deps.model,
      ...(deps.root ? { root: deps.root } : {}),
      ...(deps.router ? { router: deps.router } : {}),
      ...(deps.ledger ? { ledger: deps.ledger } : {}),
      ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    },
    agents,
  );
}

/** 多角色子 Agent：薄入口收敛（Runner 单一权威——fork 组装/终态回写/护栏全在 Runner 单点，防两处拼装漂移）；
 * agent_id 直取预设角色、任务行 = 当前指令行（与 spawn 通道同模板）、预算按 Graph 剩余换算；
 * done→pass，未完成→failed 交错误局部化接管（补丁行由 Runner 回写） */
export function makeRoleAgent(role: AgentRole, deps: GraphDeps, opts: RoleAgentOpts = {}): GraphNode {
  const preset = rolePreset(role);
  const runner = ensureRunner(deps);
  return {
    id: role,
    kind: 'agent',
    deps: opts.deps ?? [],
    run: async (ctx): Promise<GraphNodeOutput> => {
      const goalLabel = String(ctx.state.goal ?? '');
      const remaining = Math.max(0, ctx.termination.maxTokens - ctx.tokensUsed);
      const r = await runner.runSubagent(
        { agent_id: role, label: preset.label },
        {
          taskLine: pick(`Current instruction: ${goalLabel}`, `当前指令：${goalLabel}`),
          budget: {
            maxSteps: opts.maxSteps ?? 200,
            tokenCap: remaining,
            deadlineAt: ctx.startedAt + ctx.termination.timeoutMs,
            ...(deps.tier ? { tier: deps.tier } : {}),
          },
        },
      );
      if (r.ok) {
        return { nodeId: role, status: 'pass', reply: r.value.reply, tokens: r.value.tokens };
      }
      return { nodeId: role, status: 'failed', tokens: 0 };
    },
  };
}
