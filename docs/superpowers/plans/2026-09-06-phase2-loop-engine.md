# 阶段二实施计划：Loop Engine 与专用模板

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task.
> 上游 spec：`docs/superpowers/specs/2026-09-06-phase2-loop-engine-design.md`（`90944e1`，已批准）
> 基线：HEAD `90944e1`，全量 **113/113/0**（`npm test` 实测）。终态预期 **129/129/0**（新增 16 例；执行期用例数微调在执行记录登记）。
> 约束：零新增 npm 依赖；`node --test`；tsc strict 不动；既有 113 用例断言语义零改动。

## Global Constraints

- 分层依赖方向不变：loop → harness/model。agent 节点内嵌 `Reactor.run()`，禁止自建执行器或旁路模型/工具通道。
- 向后兼容硬约束：`ModelAdapter.complete` 仅追加**可选**第二参 `hooks?: { onUsage?: (tokens: number) => void }`，返回类型 `Promise<string>` 不变；`RunResult.tokensUsed` 为新增可选字段；`LoopResult` 保留为兼容别名。
- 计量语义：tokens 必须来自模型真实用量回传（OpenAI `resp.usage.total_tokens`；stub/scripted 报 0）；禁止计数占位；预算超支 **pause** 不伪造完成。
- 文档纪律：计划锚点与实仓不符时，先勘误计划再实现（「实现服从 spec、文档回正」）。
- 每步用 `sandbox__edit` 修改 src/（root-owned，shell 直写 EACCES）；同一文件多处编辑分轮串行；提交显式 `git add <paths>`，禁止 `git add -A`。

## File Structure

```text
src/types.ts                    # T2：NodeOutput/CriterionResult/LoopContext 扩展/LoopNodeBase；LoopResult 兼容别名
src/model/adapter.ts            # T1：complete 追加可选 onUsage；extractUsage 纯函数
src/model/adapter.test.ts       # T1：usage 解析与回调用例
src/harness/reactor.ts          # T1：complete 调用点接线；RunResult.tokensUsed 透出
src/harness/reactor.test.ts     # T1：用量聚合用例
src/loop/engine.ts              # T3：LoopEngine 主干重写（淘汰占位实现）
src/loop/nodes.ts               # T4：agent/check/gate/router 四类节点
src/loop/engine.test.ts         # T3/T4/T5：引擎语义 + 节点 + 模板端到端（新建）
src/loop/templates.ts           # T5：三大模板工厂
src/index.ts                    # T6：selfcheck 增 Loop 行
scripts/probe-loop-smoke.js     # T6：测试闭环模板真实模型冒烟（手动，不入门禁）
docs/…                          # T6：spec 状态定稿 + 本计划勾选/执行记录 + ROADMAP 阶段二行
```

## Task 1: Token 计量贯通——adapter usage 回传与 Reactor tokensUsed 透出

**现状锚点**（实仓原文）：
- `adapter.ts:3-6`：`export interface ModelAdapter { readonly provider: string; complete(prompt: string): Promise<string>; }`
- `reactor.ts:10`：`export interface RunResult { steps: StepRecord[]; done: boolean; reply?: string; }`
- `reactor.ts:74`：`raw = await router.resolve(effectiveTier).complete(this.buildPrompt(items, effectiveTier));`
- `reactor.ts:116`：`return { steps, done, reply };`

- [ ] **Step 1: 写失败测试**（adapter.test +2、reactor.test +2）
  - adapter.test：`extractUsage` 纯函数——输入 `{usage:{total_tokens: 42}}` 返回 42；输入 `{}` 返回 0；
  - adapter.test：StubAdapter/ScriptedAdapter 的 `complete(p, {onUsage})` 回调收到 0；
  - reactor.test：非零聚合——构造 FakeAdapter（complete 经 `hooks.onUsage(5)` 上报）驱动 Reactor 一轮 done，断言 `r.tokensUsed === 5`；
  - reactor.test：ScriptedAdapter 全程 → `r.tokensUsed === 0` 且字段存在（接线证明）。
- [ ] **Step 2: 红灯**：`npm run build` 零错 + `npm test` 新用例失败（接口不存在）。
- [ ] **Step 3: 实现**
  - adapter.ts：接口加可选 `hooks` 参数；新增 `export function extractUsage(data: unknown): number`（读 `usage.total_tokens`，非正整数回 0）；OpenAIAdapter 在 `resp.json()` 后解析并 `hooks?.onUsage?.(n)`；Stub/Scripted 回调 0；
  - reactor.ts：`RunResult` 增 `tokensUsed?: number`；run 内 `let used = 0`，`:74` 调用点传 `hooks: { onUsage: (t) => { used += t; } }`；返回 `{ steps, done, reply, tokensUsed: used }`。
- [ ] **Step 4: 绿灯**：build 0 错 + **117/117/0**。
- [ ] **Step 5: 提交**：`git add src/model/adapter.ts src/model/adapter.test.ts src/harness/reactor.ts src/harness/reactor.test.ts && git commit -m "feat(loop): token 计量贯通——adapter usage 回传与 Reactor tokensUsed 透出（P2 T1）"`

## Task 2: Loop 类型重构（types.ts 登记）

**现状锚点**：`types.ts:27-38`（LoopNodeKind/LoopContext{iteration,state}/LoopResult 字符串枚举）。

- [ ] **Step 1: 类型扩展**（纯类型，无新测试；编译与既有全绿即门禁）
  - `LoopContext` 增 `tokensUsed: number; startedAt: number;`（保留 iteration/state）；
  - 新增 `NodeOutput { status: 'pass'|'fail'|'retry'|'done'; reply?: string; criteria?: CriterionResult[]; route?: string; tokens: number; }`；
  - 新增 `CriterionResult { id: string; desc: string; passed: boolean; evidence?: string; }`；
  - 新增 `LoopNodeBase { id: string; kind: LoopNodeKind; }`；`LoopNodeFn = (ctx: LoopContext, io: NodeIO) => Promise<NodeOutput>`；
  - `LoopResult` 原文保留（兼容别名注释）。
- [ ] **Step 2: 门禁**：build 0 错；engine.ts 占位若编译破，做**最小兼容适配**（T3 将整体淘汰，不留临时分支）；全量 117/117/0。
- [ ] **Step 3: 提交**：`git add src/types.ts src/loop/engine.ts && git commit -m "refactor(types): Loop 节点结构化类型与预算账户上下文（P2 T2）"`

## Task 3: LoopEngine 主干重写——四重终止与预算贯通

- [ ] **Step 1: 写失败测试**（engine.test 新建 +5）
  1. 验收终止：手工节点序列 [agent(done)→check(pass)] → status done、iterations=1；
  2. 迭代耗尽：永 loop 节点 + maxIterations=3 → status failed、iterations=3；
  3. 超时：`timeoutMs` 极小 + 慢节点 → failed（错误含「超时」）；
  4. 预算超支：节点单轮上报 tokens > maxTokens → **paused**（非 failed），result.tokensUsed 如实、不伪造 done；
  5. router 跳转：route 指向合法节点 id 正确跳转；指向不存在 id → failed（fail-bounded，不静默）。
  测试基建：手工 `LoopNodeFn` + 最小 `NodeIO`（scripted 应答注入），不依赖 Reactor。
- [ ] **Step 2: 红灯**：engine.test 编译/断言失败。
- [ ] **Step 3: 实现**（engine.ts 重写，淘汰占位 LoopNode/push/budget 计数）
  - `LoopEngine { constructor(nodes: Array<LoopNodeBase & { run: LoopNodeFn }>, deps, termination: { maxIterations; maxTokens; timeoutMs }, hooks?) }`；
  - `async run(goal: string, opts?: { state?; dryRun?: boolean }): Promise<LoopRunResult>`；`LoopRunResult { status: 'done'|'failed'|'paused'; iterations: number; tokensUsed: number; reply?: string; criteria?: CriterionResult[]; state: Record<string, unknown>; error?: string }`；
  - 主干顺序执行 + router.route 跳转；每节点边界检查四重终止（顺序：验收通过 done → iteration 上限 failed → 超时 failed → tokens 上限 paused）；`ctx.tokensUsed += output.tokens`。
- [ ] **Step 4: 绿灯**：**122/122/0**。
- [ ] **Step 5: 提交**：`git add src/loop/engine.ts src/loop/engine.test.ts && git commit -m "feat(loop): LoopEngine 主干——四重终止与预算贯通（P2 T3）"`

## Task 4: 四类节点 + /goal 自验证

- [ ] **Step 1: 写失败测试**（engine.test +4）
  1. /goal 解析：goal 含「验收标准：c1=…; c2=…」→ CheckNode 产出结构化 criteria（id/desc）；空清单/解析失败 → NodeOutput fail（不静默通过）；
  2. deficit 修正：check 未过项写入 `ctx.state.deficits`，AgentNode 重试轮 goal 附注未过项清单（断言传给 Reactor 的 goal 含 deficit 文本）；
  3. gate 断言：谓词 false → fail 带 reason；true → pass；
  4. AgentNode 预算换算：maxTokens 剩余换算为 Reactor `budget.total`（FakeAdapter 捕获 opts 断言）且 tokensUsed 回传累加。
- [ ] **Step 2: 红灯** → **Step 3: 实现**（nodes.ts）
  - `agentNode(deps, opts?)`：内嵌 `new Reactor(deps).run({ goal: withDeficits(goal, ctx) }, { budget: remaining 换算 })`；NodeOutput.tokens = r.tokensUsed ?? 0；
  - `checkNode(deps, opts?)`：criteria 解析（显式传入 > goal 内嵌段 > fail）；判定双通道——`ruleCheckers` 注册表（注入式谓词）优先，未注册项经 `deps.router.resolve('small')` 模型判据；全过 done / 存在未过 fail+deficits；
  - `gateNode(opts?)`：注入谓词 `(ctx) => Promise<{ passed: boolean; reason?: string }>`；
  - `routerNode(opts?)`：依 output/state.route 映射下一节点 id。
- [ ] **Step 4: 绿灯**：**126/126/0**。
- [ ] **Step 5: 提交**：`git add src/loop/nodes.ts src/loop/engine.test.ts && git commit -m "feat(loop): 四类节点与 /goal 自验证——规则优先+模型兜底+deficit 修正（P2 T4）"`

## Task 5: 三大专用模板（纯数据预组装）

- [ ] **Step 1: 写失败测试**（engine.test +3，scripted 端到端）
  1. 代码重构：tmp 文件 `a.ts` 引用改名 → agent 执行更新引用 → check 规则校验器（grep 断言旧引用清零）通过 → done；
  2. 测试闭环：目标测试先红（写一个必失败用例文件）→ agent 修复 → check 执行验证绿 → done；
  3. 代码审查：文件含高危标记 → agent 审查产出问题清单 → gate 非空断言 → agent 修复 → check 复检零高危 → done。
- [ ] **Step 2: 红灯** → **Step 3: 实现**（templates.ts）
  - `codeRefactorTemplate(deps) / testLoopTemplate(deps) / codeReviewTemplate(deps)`：各返回 `{ nodes, termination, criteriaTemplate }`；节点序列同 spec §3.5（3-4 节点）；termination 缺省 { maxIterations: 4, maxTokens: 60_000, timeoutMs: 10 分钟 }。
- [ ] **Step 4: 绿灯**：**129/129/0**。
- [ ] **Step 5: 提交**：`git add src/loop/templates.ts src/loop/engine.test.ts && git commit -m "feat(loop): 三大专用模板——重构/测试闭环/代码审查（P2 T5）"`

## Task 6: selfcheck 扩展 + 真实模型冒烟 + 回写收口

- [ ] **Step 1: selfcheck 扩展**：`index.ts` 在 harness 行后新增 `loop :` 行（组装 codeReviewTemplate 最小配置打印节点数与终止参数）；`npm run selfcheck` 输出含该行且 exit 0。
- [ ] **Step 2: 真实模型冒烟**：新建 `scripts/probe-loop-smoke.js`——测试闭环模板 × DeepSeek（.env，R2b 式手动不入门禁）：tmp 内置一个必失败用例，模型经模板修正至绿；断言 done、criteria 全过、tokensUsed > 0；exit 0。
- [ ] **Step 3: 全量回归 + 回写**：build 0 错、全量绿、selfcheck 过；spec 状态「评审稿」→「已实施交付」（提交链 + C1-C5 结论）；本计划勾选/执行记录；ROADMAP 阶段二行勾选。
- [ ] **Step 4: 提交**：feat(selfcheck+smoke) 与 docs 回写（可两笔或按实况合并，提交信息注明 P2 T6）。

## 验收映射（spec §7 C1-C5）

| # | 标准 | 承载 Task |
| --- | --- | --- |
| C1 | 三大模板 scripted 端到端 | T5 |
| C2 | 四重终止逐一实证 | T3 |
| C3 | 计量贯通 + 超支暂停 | T1 + T3 |
| C4 | /goal 解析失败不静默 + deficit 修正 | T4 |
| C5 | 零回归 + selfcheck Loop 行 | 全程门禁 + T6 |

## Self-Review

- T1 选择回调计量而非改 complete 返回类型：返回类型被 reactor/loop/既有测试多处消费，改签名破坏面大；回调零破坏且 OpenAI usage 为旁路信息。已列入 Global Constraints 硬约束。
- T3 以手工 LoopNodeFn 测引擎语义、T4 落具体节点：分层使引擎语义与节点行为解耦，测试定位清晰。
- tokensUsed 断言依赖 adapter 真实回传；scripted/stub 恒 0，非零路径用 FakeAdapter 覆盖——真实端到端由 T6 冒烟承载（DeepSeek usage）。
- 计划中 122/126/129 为按新增用例数推算的预期值；执行期若用例拆分微调，以执行记录登记实测为准。
- 三模板测试需要可执行的规则校验器（grep/npm test 谓词）——注入式注册表设计使模板测试不依赖内嵌命令；具体命令绑定留 T6/selfcheck 与用户侧装配。
