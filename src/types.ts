import type { Result } from './result';

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

/** Loop 迭代上下文（预算账户：tokensUsed 累计、startedAt 起始时钟、termination 终止参数） */
export interface LoopContext {
  iteration: number;
  state: Record<string, unknown>;
  tokensUsed: number;
  startedAt: number;
  termination: LoopTermination;
}

/** Loop 终止参数（迭代上限 / token 预算 / 超时） */
export interface LoopTermination {
  maxIterations: number;
  maxTokens: number;
  timeoutMs: number;
}

/** 验收标准单条判定结果 */
export interface CriterionResult {
  id: string;
  desc: string;
  passed: boolean;
  evidence?: string;
}

/** Loop 节点结构化输出 */
export interface NodeOutput {
  status: LoopResult;
  reply?: string;
  criteria?: CriterionResult[];
  route?: string;
  tokens: number;
}

/** Loop 节点公共字段 */
export interface LoopNodeBase {
  id: string;
  kind: LoopNodeKind;
}

/** Loop 节点执行结果（兼容别名，NodeOutput.status 引用） */
export type LoopResult = 'pass' | 'fail' | 'retry' | 'done';

/* ===== Graph 编排层（阶段三） ===== */

/** Graph 节点类型 */
export type GraphNodeKind = 'loop' | 'agent' | 'gate' | 'ci';

/** 节点执行产物（节点间数据流载体） */
export interface GraphNodeOutput {
  nodeId: string;
  status: 'pass' | 'failed' | 'skipped' | 'paused';
  reply?: string;
  tokens: number;
  criteria?: CriterionResult[];
}

/** Graph 运行上下文：状态 + 预算账户 + 数据流表 */
export interface GraphContext {
  state: Record<string, unknown>;
  tokensUsed: number;
  startedAt: number;
  results: Record<string, GraphNodeOutput>;
}

/** Graph 运行结果（results 为数据流观测面，随结果返回） */
export interface GraphRunResult {
  status: 'done' | 'failed' | 'paused';
  iterations: number;
  tokensUsed: number;
  failedNodes: string[];
  pendingGates: string[];
  reply?: string;
  results: Record<string, GraphNodeOutput>;
}

/** Graph 终止参数 */
export interface GraphTermination {
  maxNodes: number;
  maxTokens: number;
  timeoutMs: number;
}

/** Graph 节点依赖容器（结构复用 LoopDeps 五件套，模型/工具/上下文同源零旁路） */
export type GraphDeps = import('./loop/engine').LoopDeps;

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

/** Tool 执行后端：命令与文件 IO 的统一执行面（process 现行，Docker/SSH 预留接口位） */
export interface ToolBackend {
  /** 后端标识，如 process / docker / ssh */
  readonly name: string;
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>>;
  readFile(absPath: string): string;
  /** 写入含父目录自动创建（维持现行 write 语义） */
  writeFile(absPath: string, content: string): void;
  listFiles(root: string, pattern: string): string[];
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
