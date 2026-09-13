import { GraphDeps, GraphTermination } from '../types';
import { GraphEngine, GraphNode } from './engine';
import { makeGateNode, makeLoopNode, RuleChecker } from './nodes';
import { makeRoleAgent } from './agents';

/** 全链路流水线缺省终止参数（opts.termination 可按项覆盖） */
const DEFAULT_TERMINATION: GraphTermination = { maxNodes: 500, maxTokens: 2_000_000, timeoutMs: 14_400_000 };

/** 模板产物：纯数据预组装（节点序列 + 终止参数）+ 就绪引擎 */
export interface GraphTemplate {
  name: string;
  nodes: GraphNode[];
  termination: GraphTermination;
  engine: GraphEngine;
}

export interface PipelineOpts {
  /** 测试验证子流程的目标与验收（须含「验收标准：id=描述」段——check 依赖结构化验收清单） */
  goal?: string;
  ruleCheckers?: Record<string, RuleChecker>;
  /** 各角色 Agent 的单次 Reactor 步数上限 */
  maxSteps?: number;
  termination?: Partial<GraphTermination>;
}

/** 软件工程全链路流水线（五节点串行链；测试验证阶段内嵌 testLoop 子流程——「Loop 嵌入 Graph」验收点） */
export function softwarePipelineTemplate(deps: GraphDeps, opts: PipelineOpts = {}): GraphTemplate {
  const termination: GraphTermination = { ...DEFAULT_TERMINATION, ...(opts.termination ?? {}) };
  const nodes: GraphNode[] = [
    makeRoleAgent('planner', deps, { maxSteps: opts.maxSteps }),
    makeRoleAgent('developer', deps, { maxSteps: opts.maxSteps, deps: ['planner'] }),
    makeLoopNode('test-verify', {
      template: 'test-loop',
      goal: opts.goal,
      ruleCheckers: opts.ruleCheckers,
      deps: ['developer'],
    }),
    makeRoleAgent('reviewer', deps, { maxSteps: opts.maxSteps, deps: ['test-verify'] }),
    makeGateNode('delivery-gate', { prompt: '交付确认', deps: ['reviewer'] }),
  ];
  return { name: 'software-pipeline', nodes, termination, engine: new GraphEngine(nodes, deps, termination) };
}
