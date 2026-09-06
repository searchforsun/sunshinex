# 阶段二设计：Loop Engine 与专用模板

> 日期：2026-09-06
> 状态：评审稿（供用户评审，确认后转入 writing-plans）
> 上游：`docs/Arch-Plan.md` §2.1.3/§4.2、`docs/ROADMAP.md` 阶段二、统一运行时主链设计（A1-A5 零旁路原则）
> 基线：HEAD `f338311`，全量 113/113/0，`src/loop/engine.ts` 为占位骨架

## 1. 定位与设计立场

Loop 层是运行在 Harness 底座之上的**迭代编排层**：把「单任务自主迭代」从 Reactor 的单轮
observe→think→act 循环，升级为多节点协作的**生成→校验→修正→终止**闭环。

设计立场（有机结合而非能力拼接）：

- **单一数据流**：LoopEngine 只有一个执行主干——节点序列 + Router 分支。不存在第二条旁路执行
  逻辑；check/gate/router 是主干的纯逻辑节点，不是另一套引擎。
- **复用而非重写**：agent 节点内嵌 `Reactor.run()`（压缩闭环、预算、安全链、记忆沉淀全部复用），
  Loop 不自建执行器；Loop 的终止与预算控制**贯通** Reactor 的预算参数，而非在其外另设并行体系。
- **模板即配置**：三大专用模板不是三套代码，而是 LoopEngine 的三种预组装配置（节点序列 + 验收
  标准模板 + 终止参数），与自定义 Loop 同构，天然支持扩展。

## 2. 现状与差距

| 项 | 现状 | 差距 |
| --- | --- | --- |
| `src/loop/engine.ts` | 占位骨架：同步 run、budget 每次 +1 计数占位、无节点实现 | 节点体系、真实计量、异步、终止语义全部待实装 |
| `src/types.ts` | `LoopContext/LoopNodeKind/LoopResult` 占位类型 | 需扩展为结构化上下文与结果类型 |
| 节点 | 无 | 四类节点待实现 |
| /goal | 无 | 验收标准解析与逐项自检待实现 |
| 模板 | 无 | 三大模板待实现 |
| CLI | 无 CLI 入口 | 阶段二仅落命令语义层（见 §7） |

## 3. 核心设计

### 3.1 类型体系（src/types.ts 登记）

```ts
/** Loop 节点类型（沿用） */
export type LoopNodeKind = 'agent' | 'check' | 'gate' | 'router';

/** 节点执行产物：结构化结果替代字符串枚举 */
export interface NodeOutput {
  status: 'pass' | 'fail' | 'retry' | 'done';
  reply?: string;                          // agent 最终答复 / check 说明
  criteria?: CriterionResult[];            // check 节点产出
  route?: string;                          // router 产出：下一节点 id
  tokens: number;                          // 本节点真实消耗（agent 来自 Reactor 用量，其余 0）
}

export interface CriterionResult {
  id: string;             // 验收子项 id（如 c1）
  desc: string;           // 验收描述
  passed: boolean;
  evidence?: string;      // 判定依据摘录
}

/** 迭代上下文：状态载体 + 预算账户 */
export interface LoopContext {
  iteration: number;
  state: Record<string, unknown>;
  tokensUsed: number;                      // 累计 token（贯通计量）
  startedAt: number;                       // Date.now()，超时终止基准
}
```

`LoopResult` 字符串枚举保留为 NodeOutput.status 的窄化别名，旧引用零破坏。

### 3.2 LoopEngine 主干（重写 src/loop/engine.ts）

```ts
export interface LoopTermination {
  maxIterations: number;        // 迭代上限
  maxTokens: number;            // 累计 token 上限
  timeoutMs: number;            // 墙钟超时
}

export interface LoopNodeBase {
  id: string;                   // 节点 id（router.route 指向它）
  kind: LoopNodeKind;
}

export class LoopEngine {
  constructor(
    private nodes: LoopNodeBase[],                 // 有序节点序列（主干）
    private deps: { safety: SafetyChain; registry: ToolRegistry;
                    context: ContextManager; model: ModelAdapter; router?: ModelRouter },
    private termination: LoopTermination,
    private hooks?: { onNodeEnd?: (n: LoopNodeBase, o: NodeOutput) => void },
  );
  async run(goal: string, opts?: { dryRun?: boolean }): Promise<LoopRunResult>;
}
```

执行语义：

1. 主干顺序执行节点；`router` 节点依据 `output.route` 跳转（未命中节点 id 视为 fail-bounded 错误，
   立即 fail 并记录，不静默重试）。
2. **四重终止**（每节点边界检查）：
   - 验收通过：check 节点全过 + agent done → 立即 done；
   - `iteration > maxIterations` → fail（耗尽）；
   - `Date.now() - startedAt > timeoutMs` → fail（超时）；
   - `tokensUsed > maxTokens` → **pause（非 fail）**：超支自动暂停返回现场，不伪造完成。
3. **预算贯通**：agent 节点把 `remaining = maxTokens - tokensUsed` 换算进 Reactor 的
  `budget.total`（与 reserve 固定比例），Reactor 的真实 token 用量（completion usage）回传累加到
  `tokensUsed`。Loop 不自建计量。为此 Reactor `RunResult` 需透出 `tokensUsed`（新增可选字段，
  零破坏）。
4. dry-run：gate/check 节点照常产出判定，agent 节点不执行真实模型调用（改由 scripted 应答），
  输出执行计划预览。

### 3.3 四类节点

| 节点 | 职责 | 实现 |
| --- | --- | --- |
| agent | 执行子任务（内嵌 Reactor.run，透传 budget 换算与 scripted 注入） | `AgentNode` |
| check | /goal 验收：解析验收标准清单，逐项判定（small 档模型判据 + 规则校验器） | `CheckNode` |
| gate | 断言/人工闸门：评估谓词或挂起等待确认（CLI 阶段实现断言式，人工确认留接口） | `GateNode` |
| router | 按 state/output 分流到目标节点 id；缺省顺序流 | `RouterNode` |

节点为纯函数式组件：`(ctx, deps, input) => Promise<NodeOutput>`，共享 `ctx.state`
（如 agent 产出 → check 输入 → router 分流依据），不各自持全局。

### 3.4 /goal 自我验证机制

- goal 中 `验收标准:` 段（或独立传入）解析为结构化清单 `Criterion[]`（id/desc/passed）；
- 解析失败或空清单 → check 直接 fail 并说明（不静默通过）；
- check 判定双通道：规则校验器（可执行断言，如「测试全绿」）优先，模型判据（small 档）兜底；
- 未通过项 → agent 节点带 deficit（未过项清单）重试，重试上下文注入「上次未过项与证据」，
  修正方向明确而非盲目重跑。

### 3.5 三大专用模板（预组装配置）

| 模板 | 节点序列 | 验收标准模板 |
| --- | --- | --- |
| 代码重构 | agent(重构) → check(语法/测试/引用同步) → router(未过→agent 补正) | 测试全绿 + 构建零错 + 引用零悬空 |
| 测试闭环 | agent(生成测试) → check(执行测试) → router(失败→agent 修复) | 目标测试全绿且非空 |
| 代码审查 | agent(审查) → gate(问题清单非空断言) → router(有→agent 修复→check 复检) | 复检零高危 + diff 可应用 |

模板 = `{ nodes, termination, criteriaTemplate }` 纯数据配置，`LoopEngine` 统一执行；自定义
Loop 与模板同构。

## 4. 与既有约束的对齐

- **零旁路**：agent 节点是 Reactor 的唯一执行通道；check 的模型判据走同一 ModelRouter（small 档
  建议信号），不新建模型调用通道。
- **零新增依赖**：node:test + 现有类型；diff 生成器阶段二仅要求「可应用的最小 diff 摘要」，完整
  diff 生成器列入阶段四。
- **types.ts 登记**：新增类型全部进 `src/types.ts`（§3.1），LoopResult 保持兼容别名。
- **HOME 不可写**：测试临时目录走 os.tmpdir()，与既有测试一致。

## 5. 测试策略（node:test，scripted 优先）

- 单测：LoopEngine 四重终止各一例；router 跳转/未命中；预算贯通（agent 回传用量累加）；check
  双通道（规则/模型判据）；gate 断言。
- 模板端到端：三模板 scripted 端到端各一例（重构：引用同步；测试闭环：失败→修复→绿；审查：
  问题→修复→复检通过）。
- 真实模型冒烟：测试闭环模板 × DeepSeek 真实端点（R2b 式，手动不入门禁，参照 P1-1 C2 模式）。

## 6. 交付边界

- 阶段二交付：完整 LoopEngine + 四类节点 + /goal 机制 + 三模板（scripted 端到端 + 真实冒烟）+
  Reactor tokensUsed 透出 + selfcheck 扩展（Loop 一行）。
- 不含：完整 diff 生成器、人工 gate 的交互式确认、GUI、CLI 可执行包（仅命令语义映射文档）。

## 7. 验收标准（C1-C5）

| # | 标准 | 失败信号 |
| --- | --- | --- |
| C1 | 三大模板 scripted 端到端各跑通「生成→校验→修正→终止」 | 任一模板死循环/误终止 |
| C2 | 四重终止逐一实证：验收通过/迭代耗尽/超时/预算超支暂停 | 任一终止路径失效或误触发 |
| C3 | Token 计量贯通：agent 用量如实累加，超支暂停而非伪造完成 | 计量占位、超支仍报完成 |
| C4 | /goal 验收：解析失败不静默通过；未过项带 deficit 修正 | 空清单静默通过、盲目重试 |
| C5 | 零回归 + selfcheck 含 Loop 行 | 既有 113 测试任意回归 |

## 8. Self-Review

- 现状差距表与实仓一致（engine.ts 占位、types 占位、无节点/模板）。
- 预算贯通依赖 Reactor 透出 tokensUsed——新增可选字段，零破坏，已在 §3.2 说明。
- 三大模板节点序列刻意最小（3-4 节点），端到端可控；完整 diff 生成器按 Arch-Plan 归入阶段四。
- CLI 按 ROADMAP 阶段二「CLI 专项命令接入」保留语义映射，不做可执行包（阶段五 GUI 前置是 CLI，
  其打包列入阶段二 plan 的可选尾任务，由 plan 决定）。
