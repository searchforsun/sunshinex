import { AgentRole, GraphDeps, GraphTermination } from '../types';
import { GraphEngine, GraphNode } from './engine';
import { graphNodesEnv } from '../config/termination-config';
import { makeGateNode, makeLoopNode, RuleChecker } from './nodes';
import { makeRoleAgent } from './agents';
import { rolePreset } from '../harness/subagent';
import { t } from '../i18n';

/** 全链路流水线缺省终止参数（opts.termination 可按项覆盖；env 语义键可放宽节点步，墙钟不进 settings）。
 *  P2/T6 起导出：板路径（run-pipeline CLI）复用 timeoutMs 作 settle 总帽（min 上限在消费侧裁定） */
export const DEFAULT_TERMINATION: GraphTermination = { maxNodes: 1000, maxTokens: 2_000_000, timeoutMs: 86_400_000 };

/** 模板产物：纯数据预组装（节点序列 + 终止参数）+ 就绪引擎 */
export interface GraphTemplate {
  name: string;
  nodes: GraphNode[];
  termination: GraphTermination;
  engine: GraphEngine;
}

interface PipelineOpts {
  /** 测试验证子流程的目标与验收（须含「验收标准：id=描述」段——check 依赖结构化验收清单） */
  goal?: string;
  ruleCheckers?: Record<string, RuleChecker>;
  /** 各角色 Agent 的单次 Reactor 步数上限 */
  maxSteps?: number;
  termination?: Partial<GraphTermination>;
}

/** 软件工程全链路流水线（五节点串行链；测试验证阶段内嵌 testLoop 子流程——「Loop 嵌入 Graph」验收点） */
export function softwarePipelineTemplate(deps: GraphDeps, opts: PipelineOpts = {}): GraphTemplate {
  const envNodes = graphNodesEnv();
  const termination: GraphTermination = {
    ...DEFAULT_TERMINATION,
    ...(envNodes !== undefined ? { maxNodes: envNodes } : {}),
    ...(opts.termination ?? {}),
  };
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
    makeGateNode('delivery-gate', { prompt: t('Delivery confirmation', '交付确认'), deps: ['reviewer'] }),
  ];
  return { name: 'software-pipeline', nodes, termination, engine: new GraphEngine(nodes, deps, termination) };
}

/** 模板宏化产物（P2/T6）：模板五节点 → 任务板任务集的纯数据映射，消费面（run-pipeline CLI）直接落 TaskBoard。 */
export interface TemplateTaskSpec {
  id: string;
  title: string;
  spec: string;
  dependsOn: string[];
  gated?: boolean;
}

/** 模板宏化（P2/T6）：softwarePipelineTemplate 的五节点链 → 自包含任务集（纯函数零 deps，不触 engine/GraphDeps）。
 *  - planner/developer/reviewer = role 任务：spec 首行 `Role: <framing>`（ROLE_PRESETS 经 rolePreset，与 makeRoleAgent
 *    的 fork 角色行同源单点），次行 `Current instruction: <goal>`（agents.ts taskLine 口径）；
 *  - test-verify = loop 任务：spec 注明 test-loop 语义（goal + ruleCheckers 清单）；
 *  - delivery-gate = gated 任务：交付前人工审批提示（板语义 pending 顶住派发，review(approved) 解锁）。
 *  dependsOn 按模板边：planner[]、developer[planner]、test-verify[developer]、reviewer[test-verify]、
 *  delivery-gate[reviewer]。spec 恒英文单语（进执行体提示词，CLAUDE.md §15）。 */
export function templateToTaskSpecs(goal: string, opts: { ruleCheckers?: string[] } = {}): TemplateTaskSpec[] {
  const roleSpec = (role: AgentRole): string => `Role: ${rolePreset(role).framing}\nCurrent instruction: ${goal}`;
  const checkers = opts.ruleCheckers ?? [];
  const testSpec = [
    'Test-loop task: iterate on the target until every acceptance criterion in the instruction passes.',
    `Current instruction: ${goal}`,
    ...(checkers.length > 0 ? [`Rule checkers: ${checkers.join(', ')}`] : []),
  ].join('\n');
  return [
    { id: 'planner', title: 'planner', spec: roleSpec('planner'), dependsOn: [] },
    { id: 'developer', title: 'developer', spec: roleSpec('developer'), dependsOn: ['planner'] },
    { id: 'test-verify', title: 'test-verify', spec: testSpec, dependsOn: ['developer'] },
    { id: 'reviewer', title: 'reviewer', spec: roleSpec('reviewer'), dependsOn: ['test-verify'] },
    { id: 'delivery-gate', title: 'delivery-gate', dependsOn: ['reviewer'], gated: true, spec: 'Delivery gate: human approval required before final delivery. Approve to finalize this pipeline run.' },
  ];
}
