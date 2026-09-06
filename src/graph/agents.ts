import { AgentRole, GraphDeps, GraphNodeOutput } from '../types';
import { GraphNode } from './engine';
import { toReactorBudget } from '../loop/nodes';
import { Reactor } from '../harness/reactor';

/** 四角色任务框定（多角色子 Agent 预设：只做框定与档位建议，不新增模型通道） */
export const ROLE_PRESETS: Record<AgentRole, { label: string; framing: string }> = {
  planner: { label: '规划师', framing: '需求拆解、方案与路径设计' },
  developer: { label: '开发者', framing: '代码实现、重构与修复' },
  tester: { label: '测试工程师', framing: '测试用例生成、执行与失败分析' },
  reviewer: { label: '审查员', framing: '规范、逻辑与安全审查，产出审查报告' },
};

export interface RoleAgentOpts {
  maxSteps?: number;
  /** 上游依赖节点 id（编排接线用） */
  deps?: string[];
}

/** 多角色子 Agent：角色框定 + 单次 Reactor run（预算按 Graph 剩余换算；done→pass，未完成→failed 交错误局部化接管） */
export function makeRoleAgent(role: AgentRole, deps: GraphDeps, opts: RoleAgentOpts = {}): GraphNode {
  const preset = ROLE_PRESETS[role];
  return {
    id: role,
    kind: 'agent',
    deps: opts.deps ?? [],
    run: async (ctx, _d, inputs): Promise<GraphNodeOutput> => {
      const goal = String(ctx.state.goal ?? '');
      const upstream = Object.entries(inputs)
        .map(([id, o]) => `- ${id}: ${o.reply ?? '（无产出）'}`)
        .join('\n');
      const task = `${goal}\n\n你的角色：${preset.label}（${role}），职责：${preset.framing}。${
        upstream ? `\n上游产出（作为输入上下文）：\n${upstream}` : ''
      }`;
      const budget = toReactorBudget(Math.max(0, ctx.termination.maxTokens - ctx.tokensUsed));
      const reactor = new Reactor({
        safety: deps.safety,
        registry: deps.registry,
        context: deps.context,
        model: deps.model,
        ...(deps.router ? { router: deps.router } : {}),
      });
      const result = await reactor.run({ goal: task }, { maxSteps: opts.maxSteps, budget });
      return {
        nodeId: role,
        status: result.done ? 'pass' : 'failed',
        reply: result.reply,
        tokens: result.tokensUsed ?? 0,
      };
    },
  };
}
