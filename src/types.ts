/** 多角色子 Agent 角色枚举 */
export type AgentRole = 'planner' | 'developer' | 'tester' | 'reviewer';

/** 统一执行面上的工具描述 */
export interface ToolSpec {
  name: string;
  description: string;
}

/** 技能清单（skills/{id}/skill.md 解析结果） */
export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
}

/** 项目上下文（SUNSHINE.md 解析结果） */
export interface ProjectContext {
  name: string;
  rules: string[];
  architecture: string[];
}

/** Loop 节点类型 */
export type LoopNodeKind = 'agent' | 'check' | 'gate' | 'router';

/** Loop 迭代上下文 */
export interface LoopContext {
  iteration: number;
  state: Record<string, unknown>;
}

/** Loop 节点执行结果 */
export type LoopResult = 'pass' | 'fail' | 'retry' | 'done';

/** 记忆层级 */
export type MemoryLevel = 'working' | 'episodic' | 'skill';
