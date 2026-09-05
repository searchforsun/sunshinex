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

/** 三档算力档位（模型路由） */
export type ModelTier = 'small' | 'medium' | 'large';

/** 记忆层级 */
export type MemoryLevel = 'working' | 'episodic' | 'skill';

/** 工具类别：read/write/bash/network */
export type ToolCategory = 'read' | 'write' | 'bash' | 'network';

/** 工具输入 */
export interface ToolInput {
  [key: string]: unknown;
}

/** 沙箱执行结果 */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 权限决策 */
export type PermissionDecision = 'allow' | 'ask' | 'deny';

/** 上下文条目 */
export interface ContextItem {
  kind: 'system' | 'instruction' | 'memory' | 'history' | 'tool' | 'result';
  content: string;
  meta?: Record<string, unknown>;
}

/** 工具执行器签名（经安全链执行） */
export type ToolExecutor = (input: ToolInput) => Promise<ExecResult>;
