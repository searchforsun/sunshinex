import { AgentRole, GraphDeps, WorkflowDef } from '../types';
import { GraphEngine, GraphNode } from './engine';
import { makeCiNode, makeGateNode, makeLoopNode } from './nodes';
import { makeRoleAgent, ROLE_PRESETS } from './agents';

const KINDS = ['loop', 'agent', 'gate', 'ci'] as const;

export type WorkflowValidateResult =
  | { ok: true; value: WorkflowDef }
  | { ok: false; errors: string[] };

/** 工作流结构校验：一次全量报告（kind 白名单 / deps 存在性 / 环预检 / 按 kind 必填 config） */
export function validateWorkflow(def: unknown): WorkflowValidateResult {
  const errors: string[] = [];
  if (typeof def !== 'object' || def === null) return { ok: false, errors: ['工作流定义必须为对象'] };
  const d = def as Record<string, unknown>;
  if (typeof d.name !== 'string' || d.name.length === 0) errors.push('name 必须为非空字符串');

  const nodes = Array.isArray(d.nodes) ? (d.nodes as Record<string, unknown>[]) : null;
  if (!nodes || nodes.length === 0) errors.push('nodes 必须为非空数组');

  const t = d.termination as Record<string, unknown> | undefined;
  if (
    typeof t !== 'object' ||
    t === null ||
    typeof t.maxNodes !== 'number' ||
    typeof t.maxTokens !== 'number' ||
    typeof t.timeoutMs !== 'number'
  ) {
    errors.push('termination 必须含数字型 maxNodes/maxTokens/timeoutMs');
  }

  if (nodes && nodes.length > 0) {
    // 两遍扫描：先收集全部 id（deps 允许引用后置节点），再逐项校验
    const ids = nodes.map((n) => (typeof n.id === 'string' && n.id.length > 0 ? n.id : ''));
    nodes.forEach((n, idx) => {
      const id = ids[idx];
      if (!id) errors.push(`nodes[${idx}] 缺少非空 id`);
      const kind = String(n.kind ?? '');
      if (!(KINDS as readonly string[]).includes(kind)) errors.push(`节点 ${id || `#${idx}`} kind 非法：${kind || '（缺失）'}`);
      if (!Array.isArray(n.deps)) {
        errors.push(`节点 ${id || `#${idx}`} deps 必须为数组`);
        return;
      }
      for (const dep of n.deps as unknown[]) {
        if (typeof dep !== 'string' || !ids.includes(dep)) errors.push(`节点 ${id} 引用不存在的依赖：${String(dep)}`);
      }
      const config = (typeof n.config === 'object' && n.config !== null ? n.config : {}) as Record<string, unknown>;
      if (kind === 'ci' && typeof config.command !== 'string') errors.push(`节点 ${id}（ci）缺少必填 command`);
      if (kind === 'agent' && !(typeof config.role === 'string' && config.role in ROLE_PRESETS)) {
        errors.push(`节点 ${id}（agent）role 必须为 ${Object.keys(ROLE_PRESETS).join('/')}`);
      }
    });
    // 环预检：Kahn 计数（仅统计工作流内已声明的依赖）
    const indeg = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of ids) {
      indeg.set(id, 0);
      dependents.set(id, []);
    }
    for (const n of nodes) {
      const id = n.id as string;
      for (const dep of (Array.isArray(n.deps) ? n.deps : []) as string[]) {
        if (!indeg.has(dep)) continue;
        indeg.set(id, (indeg.get(id) ?? 0) + 1);
        dependents.get(dep)!.push(id);
      }
    }
    let frontier = ids.filter((id) => indeg.get(id) === 0);
    let placed = 0;
    while (frontier.length > 0) {
      placed += frontier.length;
      const next: string[] = [];
      for (const id of frontier) {
        for (const dep of dependents.get(id)!) {
          indeg.set(dep, (indeg.get(dep) ?? 1) - 1);
          if (indeg.get(dep) === 0) next.push(dep);
        }
      }
      frontier = next;
    }
    if (placed < ids.length) {
      const cycle = ids.filter((id) => (indeg.get(id) ?? 0) > 0);
      errors.push(`工作流含环，未入层节点：${cycle.join(' -> ')}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: def as WorkflowDef };
}

/** 按 kind 装配节点（校验通过后调用；agent 节点 id 以 def 声明为准，角色仅决定框定） */
function assembleNode(n: WorkflowDef['nodes'][number], deps: GraphDeps): GraphNode {
  const config = (n.config ?? {}) as Record<string, unknown>;
  switch (n.kind) {
    case 'agent':
      return {
        ...makeRoleAgent(config.role as AgentRole, deps, {
          maxSteps: typeof config.maxSteps === 'number' ? config.maxSteps : undefined,
          deps: n.deps,
        }),
        id: n.id,
      };
    case 'gate':
      return makeGateNode(n.id, {
        prompt: typeof config.prompt === 'string' ? config.prompt : undefined,
        deps: n.deps,
      });
    case 'ci':
      return makeCiNode(n.id, { command: String(config.command), deps: n.deps });
    case 'loop':
      return makeLoopNode(n.id, {
        template: (config.template as 'test-loop' | 'code-refactor' | 'code-review') ?? 'test-loop',
        goal: typeof config.goal === 'string' ? config.goal : undefined,
        ruleCheckers: config.ruleCheckers as never,
        termination: config.termination as never,
        deps: n.deps,
      });
  }
}

/** 工作流装配：def → 就绪引擎 */
export function instantiateWorkflow(def: WorkflowDef, deps: GraphDeps): { name: string; engine: GraphEngine } {
  return { name: def.name, engine: new GraphEngine(def.nodes.map((n) => assembleNode(n, deps)), deps, def.termination) };
}
