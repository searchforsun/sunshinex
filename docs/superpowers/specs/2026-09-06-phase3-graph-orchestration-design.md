# 阶段三设计：Graph 编排层与多角色协作

> 日期：2026-09-06
> 状态：已实施交付（实施链 f905fa5 → 3f4188a → 247e5b2 → a0cdfa2；终态门禁 build 0 / 149-149-0 / selfcheck 0）
> 上游：`docs/Arch-Plan.md` §2.1.2/§3.3/§4.1/第三阶段、`docs/ROADMAP.md` 阶段三、统一运行时主链（零旁路）、Loop Engine（阶段二交付）
> 基线：HEAD `acb5095`，全量 129/129/0，`src/graph/` 为占位（topo 环检测可复用，其余待实装）

## 1. 定位与设计立场

Graph 层是 Loop 层之上的**编排层**：回答「谁先跑、谁并行、产出给谁」，不亲自执行任何模型/工具动作。

设计立场（有机结合，非能力拼接）：

- **调度与执行分离**：GraphEngine 只做 DAG 调度（拓扑分层、并发、数据流、错误局部化、终止记账）；执行体全部复用既有引擎——loop 节点内嵌 LoopEngine，agent 节点直接驱动 Reactor，工具执行仍走 SafetyChain。Graph 层**不新增第四条执行路径**。
- **三级预算贯通**：Graph 总预算 → Loop 节点预算 → Reactor 预算，按剩余量逐级换算（复用 `toReactorBudget` 比例）；超支在 Graph 边界 **paused**（与 Loop paused 语义同构）。
- **错误局部化**（Arch-Plan §2.1.2）：节点 fail 只标记该节点，传递依赖自动 skipped，**无关分支照常执行**，不做全局回滚；结果携带 `failedNodes` 清单。
- **人机分离**：人工审批节点 pause 等待（`paused` + `pendingGates`），提供 `resume` 续跑接口；CI/CD 节点只做「命令注入 + 结果解析」，真实云端触发经用户配置命令或阶段四 MCP 接入（见 §6 边界）。

## 2. 现状与差距

| 项 | 现状 | 差距 |
| --- | --- | --- |
| `src/graph/engine.ts` | topo() DFS 环检测 ✓；串行执行；`GraphNode.run()` 无输入输出 | 分层并发、数据流、错误局部化、预算记账、终止语义、Loop 嵌入待实装 |
| `src/graph/agents.ts` | `SubAgent` 占位（同步字符串进出、 fabricated 输出） | 四角色预设 + Reactor 驱动待实装；占位接口退役（偏差登记，见 §8） |
| `src/types.ts` | 无 Graph 类型（`AgentRole` 已有） | GraphNodeKind/GraphContext/GraphRunResult/WorkflowDef 登记 |
| 模板 | 无 | 软件工程全链路流水线模板（内嵌测试闭环 Loop） |
| selfcheck | 无 graph 行 | 沿用阶段二 loop 行模式 |

## 3. 核心设计

### 3.1 类型体系（src/types.ts 登记）

```ts
/** Graph 节点类型 */
export type GraphNodeKind = 'loop' | 'agent' | 'gate' | 'ci';

/** 节点执行产物（节点间数据流载体） */
export interface GraphNodeOutput {
  nodeId: string;
  status: 'pass' | 'failed' | 'skipped' | 'paused';
  reply?: string;
  tokens: number;                    // 节点真实消耗（loop/agent 自 Reactor/Loop 透传）
  criteria?: CriterionResult[];      // 内嵌 Loop 的验收产物
}

/** Graph 运行上下文（状态 + 预算账户 + 数据流表） */
export interface GraphContext {
  state: Record<string, unknown>;    // goal 与跨节点共享变量（含 approvals）
  tokensUsed: number;                // Graph 总预算记账
  startedAt: number;
  results: Record<string, GraphNodeOutput>;  // nodeId → 输出（数据流表）
}

/** Graph 运行结果 */
export interface GraphRunResult {
  status: 'done' | 'failed' | 'paused';
  iterations: number;                // 已执行节点步数（与 Loop T3 口径一致）
  tokensUsed: number;
  failedNodes: string[];
  pendingGates: string[];            // paused 时非空
  reply?: string;
}
```

`LoopDeps` 五件套（safety/registry/context/model/router?）被 Graph 全部节点复用，Graph 层定义 `GraphDeps = LoopDeps` 结构别名，不另造依赖面。

### 3.2 GraphEngine 主干（重写 src/graph/engine.ts）

```ts
export type GraphNodeFn = (ctx: GraphContext, deps: GraphDeps,
  inputs: Record<string, GraphNodeOutput>) => Promise<GraphNodeOutput> | GraphNodeOutput;
export interface GraphNode extends LoopNodeBase { deps: string[]; run: GraphNodeFn; }
export interface GraphTermination { maxNodes: number; maxTokens: number; timeoutMs: number; }

export class GraphEngine {
  constructor(nodes: GraphNode[], deps: GraphDeps, termination: GraphTermination,
              hooks?: { onNodeEnd?: (n: GraphNode, o: GraphNodeOutput) => void });
  async run(goal: string, opts?: { dryRun?: boolean; state?: Record<string, unknown> }): Promise<GraphRunResult>;
  async resume(approvals?: Record<string, boolean>, opts?: { budget?: Partial<GraphTermination> }): Promise<GraphRunResult>;
}
```

执行语义：

1. **拓扑分层**：`layer(id) = 1 + max(layer(deps))`；同层节点 `Promise.allSettled` **并发**，层间串行——并行=同层多节点，汇合=下游多依赖（fan-in 聚合上游产出），分支=上游多下游（fan-out）。环检测沿用 topo() DFS，错误信息携带**环路径**。
2. **边界三查**（每节点执行前，顺序固定）：tokensUsed ≥ maxTokens → **paused**；超时 → failed；iterations ≥ maxNodes → failed。
3. **数据流**：节点入参 `inputs = pick(ctx.results, deps)`（全部直接上游产出；上游 failed/skipped 时其产出原样可见，供下游判定）。
4. **错误局部化**：节点 'failed' → 标记该节点，传递依赖置 'skipped'（依赖链上任一 failed/skipped 即 skip），**无关节点照常**；run 收口 status='failed' + failedNodes。
5. **幂等续跑**：`results` 已有 'pass' 的节点跳过不再执行——`resume` 复用同一调度遍历，天然从断点继续。
6. 主干走完：存在 failed → failed；否则 done。

### 3.3 四类节点

| kind | 职责 | 实现 |
| --- | --- | --- |
| loop | 内嵌 Loop 子流程（spec 验收：Loop 子流程可嵌入 Graph 节点） | `makeLoopNode`：按 config 组装三模板之一或自定义节点序列；输出映射 LoopRunResult（done→pass、failed→failed、paused→paused，criteria/tokens 透传）；**预算贯通**：Graph remaining → Loop `termination.maxTokens` |
| agent | 多角色单任务 | `makeRoleAgent(role)`：角色预设（任务框定 + 建议档位）→ 单次 Reactor run；`toReactorBudget(remaining)` 换算；done→pass、未完成→failed（错误局部化接管） |
| gate | 人工审批 | `makeGateNode({ prompt })`：`ctx.state.approvals[id]===true` → pass；`===false` → failed；未审批 → **paused**（pendingGates 挂起），resume 消费审批后续跑 |
| ci | CI/CD | `makeCiNode({ command, expect?: 'exit0' })`：经 registry exec（零旁路走 SafetyChain）执行注入命令，exit 0 → pass（evidence=stdout 尾部）；非零 → failed。真实 GitHub Actions/GitLab 触发=用户注入具体命令（如 gh CLI），平台 API 集成不做（§6） |

### 3.4 多角色子 Agent（重写 src/graph/agents.ts）

```ts
export type AgentRole = 'planner' | 'developer' | 'tester' | 'reviewer';  // types.ts 既有
export const ROLE_PRESETS: Record<AgentRole, { label: string; framing: string }>;
// planner: 需求拆解、方案与路径；developer: 代码生成/重构/修复；tester: 用例生成/执行/分析；reviewer: 规范/逻辑/安全与审查报告
export function makeRoleAgent(role: AgentRole, deps: GraphDeps, opts?): GraphNode;
```

- 角色预设只做**任务框定与档位建议**（写入任务文本与 router 建议信号），不新增模型通道——模型调用仍经 deps.model/router。
- 占位 `SubAgent`/`createAgent`（同步字符串接口）退役：无法承载异步 NodeOutput 数据流，属占位淘汰而非接口破坏（§8 登记）。

### 3.5 预算贯通与终止（三级换算）

- Graph `termination.maxTokens` 为总预算；每节点执行前 `remaining = maxTokens − tokensUsed`：
  - loop 节点 → Loop `termination.maxTokens = remaining`（Loop 内部自管 reserve 换算）
  - agent 节点 → Reactor `budget = toReactorBudget(remaining)`（复用 Loop T4 既有函数）
- 超支 → **paused**（非 failed，不伪造完成）；`resume(approvals?, { budget })` 可携调整后预算续跑；paused 的 loop 节点 resume 时**重跑该子流程**（Loop 无中态恢复，如实声明）。

### 3.6 工作流定义（零依赖）

```ts
export interface WorkflowDef {
  name: string;
  nodes: Array<{ id: string; kind: GraphNodeKind; deps: string[]; config: Record<string, unknown> }>;
  termination: GraphTermination;
}
export function validateWorkflow(def: unknown): { ok: true; value: WorkflowDef } | { ok: false; errors: string[] };
export function instantiateWorkflow(def: WorkflowDef, deps: GraphDeps): { name: string; engine: GraphEngine };
```

- 手写结构校验（kind 合法性、deps 引用存在性、无环预检、必填 config），**不引 JSON Schema 库**（Arch-Plan §3.3 的 Schema 语义以 TS 类型 + 校验器等义落地，偏差登记）。
- 校验器对未知 config 字段不宽松放行：逐 kind 白名单校验，错误逐条列明。

### 3.7 全链路流水线模板

`softwarePipelineTemplate(deps, opts)`——Arch-Plan §2.1.2 六阶段的阶段内可实现子集：

```text
需求分析(planner) → 编码实现(developer) → 测试验证(loop: testLoop 子流程) → 代码审查(reviewer) → 交付确认(gate)
```

- 依赖链：developer←planner、testLoop←developer、reviewer←testLoop、gate←reviewer（串行为主，测试验证阶段为内嵌 Loop——正是「节点嵌套 Loop」验收点）。
- 架构设计并入需求分析输出（单 planner 节点承担两段框定，节点数与预算友好；完整六阶段并行拆分留扩展）。
- scripted e2e：五节点全 stub（loop 子流程用迷你 scripted loop），断言拓扑顺序、数据流（planner 产出流向 developer 任务文本）、预算累计。

## 4. 与既有约束的对齐

- **零旁路**：模型调用全部经 ModelAdapter/Router，工具执行（ci 节点）经 registry+SafetyChain，loop/agent 节点全部内嵌既有引擎 ✓
- **零新增依赖**：拓扑分层、结构校验、并发调度手写（Promise.allSettled）✓
- **分层方向**：graph → loop → harness ✓（loop 节点 import LoopEngine/templates；agent 节点 import Reactor）
- **types.ts 登记**：Graph 全部共享类型入 types.ts ✓
- **既有测试零改动**：graph 现无测试，`src/graph/` 占位无外部消费方（实施前 grep 复核）✓

## 5. 测试策略（node:test，scripted 优先）

- 引擎单测：环检测（含环路径信息）、分层并发见证（同层节点并发时间戳重叠）、四种流程模式各一、错误局部化（fail→skipped 传播 + 无关分支完成）、预算 paused、gate pause/resume（approve/reject 两路）、dry-run 预览、幂等续跑
- 节点单测：makeLoopNode（内嵌迷你 scripted loop 修正环 + 预算贯通断言）、makeRoleAgent（四角色框定进 prompt，RecordingAdapter 断言）、makeGateNode、makeCiNode（exit 0/非零/evidence）
- 模板 e2e：全链路流水线 scripted 端到端（拓扑顺序 + 数据流 + 预算累计）
- selfcheck：`graph :` 行（模板装配成功 + 节点数），exit 0

## 6. 交付边界

**包含**：DAG 引擎（分层并发/四种模式/环检测/错误局部化）、四类节点、四角色预设、全链路流水线模板、pause/resume、WorkflowDef 校验、selfcheck 行、scripted e2e、真实模型冒烟（全链路模板 × DeepSeek，手动不入门禁，沿用 R2b/Loop 冒烟模式）。

**不含（如实边界）**：GitHub Actions/GitLab 云端 API 客户端（网络与凭据依赖；CI 节点以命令注入承载，真实触发由用户配置命令或阶段四 MCP 接入）；工作流市场/分享/持久化（仅内存实例级 pause/resume）；JSON Schema 校验库（TS 类型 + 手写校验器等义）；GUI。

## 7. 验收标准（C1–C5）

| # | 标准 | 失败信号 |
| --- | --- | --- |
| C1 | DAG 核心：环检测报出环路径；同层并发有见证（时间戳重叠）；串行/并行/分支/汇合四模式端到端各一 | 环误判/漏判、并发退化为串行、某模式不可表达 |
| C2 | 多角色：四角色预设框定进任务文本（RecordingAdapter 断言），scripted 端到端 | 角色框定丢失、串通道 |
| C3 | Loop 嵌入：loop 节点内嵌测试闭环修正环收敛；三级预算贯通（Graph→Loop→Reactor 逐级 spy 断言）；Graph 超支 paused | 预算断裂/双记账、修正环失效 |
| C4 | 错误局部化（fail→skipped 传播且无关分支完成）+ gate pause/resume 双路 + ci exit 语义 | 全局回滚、resume 丢状态、ci 结果误判 |
| C5 | 全链路模板 e2e + 零回归（129 例既有断言零改动）+ selfcheck graph 行 | 任一回归 |

## 8. Self-Review

- 占位 `SubAgent`/`createAgent` 退役：CLAUDE.md「保持现有接口不变」适用于业务接口；占位接口同步字符串语义无法承载异步数据流，属占位淘汰——已列为显式偏差，实施期 grep 复核零外部消费后再删。
- 引擎 status 语义与 Loop 对齐：'done'/'failed'/'paused' 三态 + 节点级 'skipped'；迭代口径沿用「已完成节点执行步」（T3 落地口径）。
- gate 节点与 Loop 层 gate 的区别：Graph gate 的暂停/审批是编排语义（人机协作），Loop gate 是轮内断言——两者不复用实现，避免语义混淆。
- CI 云端集成的诚实边界：不假装能触发 GitHub Actions（无凭据/网络通道交付），命令注入是唯一真实路径，已写入 §6 与 ROADMAP 回写口径。
- 预算三级换算的 spy 断言点：Graph ctx.tokensUsed、Loop termination.maxTokens、Reactor budget.total 三处可观测，C3 可实证。
- 架构设计并入需求分析节点：六阶段流水线的完整并行拆分留作 opts 扩展，首版五节点串行链预算友好——取舍已声明。
