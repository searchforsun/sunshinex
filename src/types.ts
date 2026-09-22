import type { Result } from './result';

/** 多角色子 Agent 角色枚举 */
export type AgentRole = 'planner' | 'developer' | 'tester' | 'reviewer';

/** 极简 JSON Schema 形态（工具 parameters 与后续消息面共用；不覆盖全量规范，只登记声明面用到的关键字段） */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  minItems?: number;
  maxItems?: number;
}

/** 模型侧单次工具调用（消息视图形态；wire 层 tool_calls 由 adapter 聚合为此形态） */
export interface ToolCallSpec {
  id: string;
  name: string;
  /** 模型产出的原始入参 JSON 串；非法 JSON 不在类型层解析，由消费面 role:tool 回喂纠偏 */
  argsJson: string;
}

/** 一轮模型侧动作（adapter 聚合产物：旁白与工具调用同轮，function calling 探针④） */
export interface StructuredAction {
  /** 本轮旁白（phase 载体；空串 = 该轮无 ▶ 行） */
  content: string;
  toolCalls: ToolCallSpec[];
}

/** OpenAI 协议兼容消息（D1：链为唯一事实源，消息为 buildMessages 的派生视图形态） */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCallSpec[] }
  | { role: 'tool'; content: string; toolCallId: string };

/** function calling 的 tools 字段下发形态（注册表 parameters 逐工具映射） */
export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters?: JsonSchema };
}

/** chat 轮请求（消息视图 + 工具下发面；tool_choice 由适配器缺省 auto） */
export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ChatTool[];
  signal?: AbortSignal;
  effort?: ReasoningEffort;
}

/** chat 轮聚合结果：finish=stop 时 content 即 reply；finish=tool_calls 时 content 为旁白、toolCalls 为动作批 */
export interface ChatResult {
  finish: 'stop' | 'tool_calls';
  content: string;
  toolCalls: ToolCallSpec[];
}

/** 统一执行面上的工具描述 */
export interface ToolSpec {
  name: string;
  description: string;
  /** 参数 JSON Schema（function calling：API tools 字段下发形态；注册时逐工具声明，strict 兼容口径——additionalProperties:false、全字段 required、可选项 null 联合；确属自由入参的口子登记宽松点） */
  parameters?: JsonSchema;
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
  /** 模型判据三值裁决（规则谓词不产生；缺省按 passed 推导 met/not-yet） */
  verdict?: 'met' | 'not-yet' | 'impossible';
}

/** Loop 节点结构化输出 */
export interface NodeOutput {
  status: LoopResult;
  reply?: string;
  criteria?: CriterionResult[];
  route?: string;
  tokens: number;
  /** 内层步骤 history（agent 节点透传，供调用方链式 seed 下一 run） */
  history?: HistoryStep[];
  /** 内层执行的终止原因（agent 节点透传 Reactor 的 stopReason） */
  stopReason?: StopReason;
  /** 节点请求引擎立即终局（check 判据 impossible / 判据不可恢复错误 → failed；可恢复重试耗尽 → paused） */
  terminal?: { status: 'failed' | 'paused'; error: string };
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
  /** 终止原因契约（D8）：护栏类终止（deadline/budget/max-steps）必带对应原因；
   *  gate 挂起与节点失败不携带——undefined = 非护栏越限，下游不得将其解释为护栏触发 */
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

/** 思考强度七档（OpenAI 兼容 reasoning_effort，请求级参数、不进提示词）：类型登记于 types.ts（新增共享类型须登记先例） */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 记忆层级 */
export type MemoryLevel = 'working' | 'episodic' | 'skill';

/** todo_write 条目状态（规格 D5）：三态——「同刻恰一个 in_progress」为使用纪律，由工具 description 承载 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** 会话 todo 清单条目（原 TUI 局部类型升格共享：harness 工具面与 TUI 状态面同源，规格 D2 单点状态面） */
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

/** 工具类别（阶段四扩容：network=webfetch 等网络工具，external=MCP 服务器工具，subagent=spawn 子代理派生） */
export type ToolCategory = 'read' | 'write' | 'bash' | 'network' | 'external' | 'subagent' | 'ask' | 'worktree' | 'todo';

/** AskQuestion 问询请求（ask_question 工具入参钳制后的装配面；customIndex=「Other…」末项下标，allowCustom 时存在） */
export interface AskUserRequest {
  question: string;
  options: Array<{ label: string; description?: string }>;
  /** 多选形态：Space 勾选、Enter 提交全部勾选 */
  multiple?: boolean;
  /** 「Other…」自由输入项下标（allowCustom 时由工具执行面合成于末项） */
  customIndex?: number;
}

/** AskQuestion 裁决三态：勾选 / 自定义文本 / 放弃（放弃属正常观察非错误，模型据此调整策略） */
export type AskUserAnswer =
  | { type: 'selected'; labels: string[] }
  | { type: 'custom'; text: string }
  | { type: 'dismissed' };

/** 问询接缝：工具执行面经此挂起等用户裁决（TUI=会话问询管线 / CLI=TTY 编号输入 / headless=dismissed 桩） */
export type AskUserSeam = (req: AskUserRequest) => Promise<AskUserAnswer>;


/** 子代理 spawn 入参（三形态：agent_id=注册/预设引用；prompt=内联临时；可同传=框定+任务） */
export interface SubagentSpawnInput {
  agent_id?: string;
  prompt?: string;
  /** 时间线卡片短标题（缺省 agent_id ?? 'subagent'） */
  label?: string;
  /** 子代理工具名子集（缺省 = 父全量 − spawn）；未知名由 spawn 输入面校验 fail-fast */
  tools?: string[];
  /** 隔离通道（规格 §9/D9）：'worktree' = fork 前建专属树并在树内执行，收口随树生命周期；优先于 agent.md frontmatter */
  isolation?: 'worktree';
  /** 预留语义位：v1 传 true 报 NOT_SUPPORTED（后台两段式后批开通） */
  background?: boolean;
}

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
  | 'ctx' | 'done' | 'error' | 'notice' | 'model-start' | 'model-end';

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
  kind: 'command' | 'mcp' | 'webfetch' | 'websearch' | 'write';
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
/** 任务终态原因（interrupted=用户主动中断：Esc/Ctrl+C 触发，模型与工具调用经 AbortSignal 尽快停下） */
export type StopReason = 'done' | 'max-steps' | 'deadline' | 'budget' | 'model-error' | 'interrupted';

/** 护栏可返回的越限原因（不含「正常完成」与「模型失败」——那两类由调用方判定） */
export type LimitReason = Extract<StopReason, 'max-steps' | 'deadline' | 'budget'>;

/** TUI 提交的收口投影：只暴露会话层需要的「是否完成 / 终答 / 用量 / 终止原因」，不泄漏引擎结果内部形态 */
/** 跨 run 链式执行的步骤记录（与 Reactor StepRecord 同形；类型自包含，types 层不反向依赖 harness） */
export interface HistoryStep {
  step: number;
  action?: string;
  observation: string;
}

export interface RunOutcome {
  done: boolean;
  reply?: string;
  tokensUsed: number;
  stopReason?: StopReason;
  /** 本 run 的步骤 history：/plan 逐步执行经 seedHistory 续入下一 run（前缀缓存连续性） */
  history?: HistoryStep[];
}
