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
  /** 技能模板形参名列表（阶段四技能调度：skillRef.params 按 manifest.params 白名单过滤） */
  params?: string[];
  /** 技能形态（阶段四：prompt = 上下文注入模板；缺省视作 prompt） */
  kind?: 'prompt';
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
  /** 内层执行的终止原因（agent 节点透传 Reactor 的 stopReason） */
  stopReason?: StopReason;
}

/** Loop 节点公共字段 */
export interface LoopNodeBase {
  id: string;
  kind: LoopNodeKind;
}

/** Loop 节点执行结果（NodeOutput.status 引用） */
export type LoopResult = 'pass' | 'fail' | 'done';

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
  /** 当前生效终止参数（引擎注入；resume 调预算后同步）——节点预算换算的依据 */
  termination: GraphTermination;
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
  /** 终止原因（新增）：done=全部完成；其余为护栏越限或 gate 挂起 */
  stopReason?: StopReason;
}

/** Graph 终止参数 */
export interface GraphTermination {
  maxNodes: number;
  maxTokens: number;
  timeoutMs: number;
}

/** Graph 节点依赖容器（结构复用 LoopDeps 五件套，模型/工具/上下文同源零旁路） */
export type GraphDeps = import('./loop/engine').LoopDeps;

/** 工作流节点定义（数据形态；经 validateWorkflow 校验、instantiateWorkflow 装配执行） */
export interface GraphNodeDef {
  id: string;
  kind: GraphNodeKind;
  deps: string[];
  config: Record<string, unknown>;
}

/** 工作流定义：零依赖数据契约（TS 类型 + 手写校验器等义 JSON Schema 语义，spec §3.6） */
export interface WorkflowDef {
  name: string;
  nodes: GraphNodeDef[];
  termination: GraphTermination;
}

/** 三档算力档位（模型路由） */
export type ModelTier = 'small' | 'medium' | 'large';

/** 记忆层级 */
export type MemoryLevel = 'working' | 'episodic' | 'skill';

/** 工具类别（阶段四扩容：network=webfetch 等网络工具，external=MCP 服务器工具） */
export type ToolCategory = 'read' | 'write' | 'bash' | 'network' | 'external';

/** 模型路由决策留痕（tier + reason + 实际承载适配器，随 run 结果可观测） */
export interface RouteDecision {
  tier: ModelTier;
  reason: string;
  /** 该档是否显式绑定适配器（false = 回退默认档） */
  bound: boolean;
  /** 实际承载适配器的 provider（回退时为默认适配器的 provider） */
  adapterProvider: string;
}

/** TUI/GUI 公共事件面（阶段五 5A SessionEvents；运行时唯一旁路，缺省不发射） */
export type SessionEventType =
  | 'token' | 'reasoning' | 'usage' | 'tool-call' | 'tool-result' | 'step'
  | 'route' | 'approval-request' | 'approval-resolved'
  | 'done' | 'error';

export interface SessionEvent {
  type: SessionEventType;
  /** token/reasoning 增量文本 / step 动作摘要 / error 原因 */
  text?: string;
  /** 结构化载荷：tool 名与输入摘要、RouteDecision、done 统计等 */
  payload?: Record<string, unknown>;
  ts: number;
}

/** 终端化审批请求（guard asker 注入点契约，Task 2 接入） */
export interface ApprovalRequest {
  id: string;
  kind: 'command' | 'mcp' | 'webfetch' | 'write';
  subject: string;
  reason?: string;
}

export type ApprovalDecision = 'allow' | 'always' | 'deny';

/** 知识库命中条目（kb_search 出参；score 为归一化相似度） */
export interface KbHit {
  id: string;
  text: string;
  score: number;
}

/** 技能引用（运行时上下文注入载体：id 定位技能，params 填充 manifest.params 模板形参） */
export interface SkillRef {
  id: string;
  params?: Record<string, string>;
}

/** MCP 服务器装配配置（SUNSHINE.md「MCP 服务器」分区解析产物）。transport 缺省 = stdio（既有配置零改动）；url 仅远程传输（http/sse）使用，command/args 仅 stdio 使用 */
export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'http' | 'sse';
  url?: string;
}

/** Embedding 供给端接缝（阶段四向量知识库：local-json 后端与未来远端实现均实现此接口） */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

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

/** 终止原因：done=正常完成；model-error=模型调用失败；其余为护栏触发（D7 顺序：超时 → 预算 → 迭代/步数） */
export type StopReason = 'done' | 'max-steps' | 'deadline' | 'budget' | 'model-error';

/** 护栏可返回的越限原因（不含「正常完成」与「模型失败」——那两类由调用方判定） */
export type LimitReason = Extract<StopReason, 'max-steps' | 'deadline' | 'budget'>;
