import { AgentRole, GraphDeps, GraphNodeOutput, SessionEvent } from '../types';
import { GraphNode } from './engine';
import { toReactorBudget } from '../loop/nodes';
import { Reactor } from '../harness/reactor';
import { pick } from '../i18n';

/** 四角色任务框定（多角色子 Agent 预设：只做框定与档位建议，不新增模型通道）；label/framing 存双语静态对，取值经 rolePreset 运行期求值 */
export const ROLE_PRESETS: Record<AgentRole, { label: { en: string; zh: string }; framing: { en: string; zh: string } }> = {
  planner: { label: { en: 'Planner', zh: '规划师' }, framing: { en: 'requirement breakdown, solution and path design', zh: '需求拆解、方案与路径设计' } },
  developer: { label: { en: 'Developer', zh: '开发者' }, framing: { en: 'code implementation, refactoring and fixes', zh: '代码实现、重构与修复' } },
  tester: { label: { en: 'Tester', zh: '测试工程师' }, framing: { en: 'test case generation, execution and failure analysis', zh: '测试用例生成、执行与失败分析' } },
  reviewer: { label: { en: 'Reviewer', zh: '审查员' }, framing: { en: 'convention, logic and security review with a review report', zh: '规范、逻辑与安全审查，产出审查报告' } },
};

/** 角色预设运行期取值（语言随 --language 装配后设定，禁止模块级 pick 冻结） */
function rolePreset(role: AgentRole): { label: string; framing: string } {
  const p = ROLE_PRESETS[role];
  return { label: pick(p.label.en, p.label.zh), framing: pick(p.framing.en, p.framing.zh) };
}

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
    run: async (ctx, _d, inputs): Promise<GraphNodeOutput> => {
      const goal = String(ctx.state.goal ?? '');
      const upstream = Object.entries(inputs)
        .map(([id, o]) => `- ${id}: ${o.reply ?? pick('(no output)', '（无产出）')}`)
        .join('\n');
      const task = `${goal}\n\n${pick(
        `Your role: ${preset.label} (${role}), responsibilities: ${preset.framing}.`,
        `你的角色：${preset.label}（${role}），职责：${preset.framing}。`,
      )}${
        upstream ? `\n${pick('Upstream outputs (as input context):', '上游产出（作为输入上下文）：')}\n${upstream}` : ''
      }`;
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
        { goal: task },
        {
          maxSteps: opts.maxSteps,
          budget,
          tokenCap: remaining,
          deadlineAt: ctx.startedAt + ctx.termination.timeoutMs,
        },
      );
      return {
        nodeId: role,
        status: result.done ? 'pass' : 'failed',
        reply: result.reply,
        tokens: result.tokensUsed ?? 0,
      };
    },
  };
}
