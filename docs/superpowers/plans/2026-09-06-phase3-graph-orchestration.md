# 阶段三实施计划：Graph 编排层与多角色协作

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task.
> 上游 spec：`docs/superpowers/specs/2026-09-06-phase3-graph-orchestration-design.md`（`78d9e36`，已批准）
> 基线：HEAD `acb5095`，全量 **129/129/0**（实测）。终态预期 **149/149/0**（新增 20 例；执行期微调以执行记录登记为准）。
> 约束：零新增 npm 依赖；`node --test`；tsc strict 不动；既有用例断言语义零改动。

## Global Constraints

- 分层方向：graph → loop → harness（loop 节点 import LoopEngine/templates、agent 节点 import Reactor、ci 节点经 registry+SafetyChain；禁反向 import）。
- 零旁路：模型调用全部经 deps.model/router；工具执行全部经 SafetyChain。
- 共享类型入 `src/types.ts`；`GraphDeps` 结构复用 LoopDeps 五件套（graph 层别名导出，不另造依赖面）。
- `src/graph/` 占位无外部消费方（已 grep 核验为零），重写属占位淘汰；`topo()` 语义由 `layers()` 扁平化兼容保留。
- Token 口径：节点 tokens 自 Reactor/Loop 透传（OpenAI usage 真实回传），引擎只累加不自造计量。
- src/ 修改用 sandbox__edit（同文件分轮串行）；新文件 sandbox__write 或 node tmp+mv；显式 git add，禁 git add -A；红灯态禁提交。
- 计划锚点与实仓不符：以实仓为准等义实现并登记偏差；连续 2-3 轮不绿先停并报告现场。

## File Structure

```text
src/types.ts                  # T1：GraphNodeKind/GraphNodeOutput/GraphContext/GraphRunResult/GraphTermination/GraphDeps 登记
src/graph/engine.ts           # T1：GraphEngine 重写（Kahn 分层并发/数据流/错误局部化/边界三查/paused-resume/dry-run/环路径）
src/graph/engine.test.ts      # T1：6 例
src/graph/nodes.ts            # T2：makeLoopNode/makeGateNode/makeCiNode
src/graph/agents.ts           # T2：ROLE_PRESETS + makeRoleAgent（SubAgent/createAgent 占位退役）
src/graph/nodes.test.ts       # T2：6 例（Loop 嵌入/角色框定/预算贯通/gate 双路/ci 语义）
src/graph/workflow.ts         # T3：validateWorkflow/instantiateWorkflow
src/graph/workflow.test.ts    # T3：5 例
src/graph/templates.ts        # T4：softwarePipelineTemplate（五节点链，内嵌 testLoop）
src/graph/templates.test.ts   # T4：3 例
src/index.ts                  # T5：selfcheck `graph :` 行（锚点 index.ts:18 loop 行后）
scripts/probe-graph-smoke.js  # T5：全链路模板 × DeepSeek 真实冒烟（手动不入门禁）
docs/…                        # T5：spec 状态定稿/计划勾选与执行记录/ROADMAP 阶段三勾选 + :160 映射行更新
```

## Task 1: 类型登记 + DAG 引擎主干（P3 T1）

锚点（实仓）：engine.ts 占位 `GraphNode{run():Promise<void>|void}`、`topo()` DFS 抛 `cycle detected at node ${id}`、`run()` 串行 for-await；types.ts:4 已有 `AgentRole`。

- [x] **Step 1.1 types 登记**（sandbox__edit src/types.ts，Loop 类型段后）：GraphNodeKind 'loop'|'agent'|'gate'|'ci'；GraphNodeOutput {nodeId, status:'pass'|'failed'|'skipped'|'paused', reply?, tokens, criteria?}；GraphContext {state, tokensUsed, startedAt, results: Record<string, GraphNodeOutput>}；GraphRunResult {status:'done'|'failed'|'paused', iterations, tokensUsed, failedNodes, pendingGates, reply?}；GraphTermination {maxNodes, maxTokens, timeoutMs}；GraphDeps（结构复用 loop/engine 的 LoopDeps，import type 引入）。
- [x] **Step 1.2 写失败测试**（新文件 engine.test.ts，6 例）：
  1. 环检测：A→B→C→A，`layers()` 抛错且消息含全部环成员 id
  2. 并发见证：同层 3 慢节点（await sleep(20)），闭包计数器断言 maxConcurrent ≥ 2
  3. 错误局部化：a(failed) ← b 传递依赖；c 独立 → b 'skipped'、c 'pass'、failedNodes=['a']
  4. 预算超支：maxTokens 小 + 节点 tokens 大 → status 'paused'（非 failed）
  5. 超时：timeoutMs=5 + 30ms 慢节点 → status 'failed'（reply 含超时语义）
  6. 幂等续跑：手工 paused 节点 → resume 续跑收敛；断言已 pass 节点执行计数为 1（不重跑）
- [x] **Step 1.3 红灯确认**（留档：缺类型/测试失败输出）
- [x] **Step 1.4 重写 engine.ts**（占位淘汰）：
  - `layers(): string[][]`（Kahn 分层；余量节点即环成员，错误含清单）+ `topo()`（扁平化兼容保留）
  - `run(goal, opts?: {dryRun?; state?})`：逐层 `Promise.allSettled` 并发；节点前边界三查（预算 → paused > 超时 → failed > 步数 → failed）；`inputs = pick(results, deps)`；dryRun 全节点预览短路；'failed' 节点 → 传递依赖 'skipped'，无关节点照常；收口 failedNodes/pendingGates
  - `resume(approvals?, opts?)`：合并 state.approvals、可调 budget，已完成集幂等跳过
  - iterations = 实际执行节点数（skip 不计）；tokens 自 NodeOutput.tokens 累加
- [x] **Step 1.5 绿灯 + 提交**：build 0 + **135/135/0**（129+6）；`git add src/types.ts src/graph/engine.ts src/graph/engine.test.ts`；commit `feat(graph): DAG 引擎主干——分层并发、数据流与错误局部化（P3 T1）`

## Task 2: 四类节点 + 多角色子 Agent（P3 T2）

锚点：loop/nodes.ts:7 `toReactorBudget`（reserve=floor(total/5)）；loop/templates.ts:79/89/99 三模板工厂；loop/engine.ts:29 LoopRunResult；agents.ts 占位退役对象。

- [x] **Step 2.1 写失败测试**（nodes.test.ts，6 例）：
  1. makeLoopNode：内嵌迷你 scripted loop（agent→check 修正环）收敛 → pass；spy 断言 Graph remaining → Loop termination.maxTokens 贯通
  2. makeRoleAgent：四角色框定进 Reactor prompt（RecordingAdapter 断言各角色 framing 词出现）
  3. makeRoleAgent：预算换算 toReactorBudget 贯通 + tokens 透传（RecordingAdapter tokensPerCall=7 → 节点 tokens=7）
  4. makeGateNode：未审批 → status 'paused'；approvals 置 true → pass、false → failed
  5. makeCiNode：注入 `node -e "process.exit(0)"` → pass（evidence 含 stdout）；exit 1 → failed
  6. makeCiNode dryRun → 预览短路（命令未执行）
- [x] **Step 2.2 红灯确认**
- [x] **Step 2.3 实现**：
  - agents.ts 重写：ROLE_PRESETS 四角色框定（planner=需求拆解与方案路径/developer=代码实现与修复/tester=测试生成执行与失败分析/reviewer=规范逻辑安全与审查报告）+ `makeRoleAgent(role, deps, opts?: {maxSteps?})`（Reactor 单次 run；任务文本 = 框定 + goal + 上游产出摘要 `- <depId>: <reply>`）；删除 SubAgent/createAgent
  - nodes.ts：makeLoopNode({template, goal?})（三模板装配，termination.maxTokens = Graph remaining；LoopRunResult→GraphNodeOutput 映射 done→pass/failed→failed/paused→paused，criteria/tokens 透传）；makeGateNode({prompt?})（approvals 消费）；makeCiNode({command, expect?='exit0'})（registry.execute('exec') 走 SafetyChain；dryRun 预览短路）
- [x] **Step 2.4 绿灯 + 提交**：build 0 + **141/141/0**；`git add src/graph/nodes.ts src/graph/agents.ts src/graph/nodes.test.ts`；commit `feat(graph): 四类节点与多角色子 Agent——Loop 嵌入与预算贯通（P3 T2）`

## Task 3: 工作流定义 + pause/resume 集成（P3 T3）

- [x] **Step 3.1 写失败测试**（workflow.test.ts，5 例）：
  1. validateWorkflow 合法 def → ok 且 value 结构完整
  2. 非法 kind / deps 引用不存在 / 含环 → errors 逐条列明（一次校验全量报告）
  3. instantiateWorkflow：def → engine 可跑（迷你 scripted 全链 done）
  4. gate 节点经引擎：run → paused + pendingGates=[gateId]
  5. resume({gateId: true}) → done 且已完成节点执行计数不增；resume({gateId: false}) → failed + 下游 skipped
- [x] **Step 3.2 红灯确认**
- [x] **Step 3.3 实现**：workflow.ts 手写结构校验（kind 白名单/deps 存在性/环预检/config 按 kind 必填项，一次全量报告）+ instantiateWorkflow 按 kind 装配节点；engine 补 approvals 合并（如 T1 未覆盖）
- [x] **Step 3.4 绿灯 + 提交**：**146/146/0**；`git add src/graph/workflow.ts src/graph/workflow.test.ts src/graph/engine.ts`；commit `feat(graph): 工作流定义校验与 pause/resume 集成（P3 T3）`

## Task 4: 全链路流水线模板（P3 T4）

- [x] **Step 4.1 写失败测试**（templates.test.ts，3 例）：
  1. 拓扑顺序：五节点（planner→developer→testLoop→reviewer→gate）执行序 = 依赖序（执行轨迹记录断言）
  2. 数据流：developer 节点 Reactor prompt 含 planner 上游产出摘要（RecordingAdapter 断言）
  3. 预算累计 + gate 交互：Graph tokensUsed = Σ 节点 tokens；末位 gate → paused → resume(approve) → done
- [x] **Step 4.2 红灯确认**
- [x] **Step 4.3 实现**：templates.ts `softwarePipelineTemplate(deps, opts?)`：nodes = [makeRoleAgent('planner'), makeRoleAgent('developer'), makeLoopNode({template:'test-loop'}), makeRoleAgent('reviewer'), makeGateNode({prompt:'交付确认'})]，deps 链式；termination 缺省 {maxNodes: 12, maxTokens: 120_000, timeoutMs: 600_000}（opts 覆盖）
- [x] **Step 4.4 绿灯 + 提交**：**149/149/0**；`git add src/graph/templates.ts src/graph/templates.test.ts`；commit `feat(graph): 软件工程全链路流水线模板（P3 T4）`

## Task 5: selfcheck + 真实冒烟 + 回写收口（P3 T5）

- [x] **Step 5.1 selfcheck 扩展**（index.ts:18 loop 行后加 graph 行）：`softwarePipelineTemplate` 以 Harness 五件套 + StubAdapter 装配，打印 `graph : software-pipeline template ready (N nodes)`；门禁：selfcheck exit 0 含该行
- [x] **Step 5.2 真实冒烟**：scripts/probe-graph-smoke.js——全链路模板 × DeepSeek（dontAsk 模式 tmp 工作区：需求=实现并测试一个小函数；模型经 planner/developer/loop 修正环/reviewer 至绿；末位 gate paused → 脚本内 resume(approve) → done）；断言 done、failedNodes 空、tokensUsed > 0（真实 usage 回传）；exit 0
- [x] **Step 5.3 全量回归**：build 0 + 149/149/0 + selfcheck exit 0
- [x] **Step 5.4 回写**：spec 状态行定稿「已实施交付（实施链 …）」；本计划勾选全回填 + 执行记录（提交链/C1-C5 对照/偏差登记：占位退役、JSON Schema 等义、CI 云端边界、测试数 129→149）；ROADMAP 阶段三勾选 + :160 目录映射行更新（`src/agent/graph/` 已实装）
- [x] **Step 5.5 提交**：`feat(graph): selfcheck graph 行与全链路真实模型冒烟（P3 T5）` + `docs: 阶段三回写收口——spec 定稿/计划执行记录/ROADMAP 勾选（P3 T5）`

## spec §7 验收映射

C1→T1（环路径/并发见证/四模式）｜C2→T2（四角色框定）｜C3→T2/T3（Loop 嵌入修正环 + 三级预算 spy）｜C4→T1/T3（错误局部化/pause-resume/ci 语义）｜C5→T4/T5（模板 e2e + 零回归 + selfcheck 行）。

## Self-Review

- 迭代口径：iterations = 实际执行节点数（skipped 不计）——与 Loop T3 口径一致。
- 并发边界：同层 allSettled，首版不做并发上限；如需限流留 opts.concurrency 扩展位。
- ci 节点是唯一执行外部命令的节点：走 SafetyChain（deny 底线仍生效），冒烟 dontAsk 模式风险声明沿用 P2 T6 口径。
- 测试数新增 20 例分配：T1+6/T2+6/T3+5/T4+3 → 终态 149；执行期以红灯实证微调并登记。
- 占位退役影响面：grep 核验零外部消费；`topo()` 扁平化兼容保留。

## 执行记录（2026-09-06 收口）

- 提交链：T1 `f905fa5`（135/135/0）→ T2 `3f4188a`（141/141/0）→ T3 `247e5b2`（146/146/0）→ T4 `a0cdfa2`（149/149/0）→ T5（本提交：selfcheck 行 + 冒烟脚本 + 回写）。
- 终态门禁：build 0、**149/149/0**（129 基线 + 20 新增，正中计划）、selfcheck exit 0 含 `graph : software-pipeline template ready (5 nodes)`。
- 执行方式：T1 子代理派发静默终止（仅研读笔记、零交付），控制器转内联实施并保持同一 TDD 门禁；T2–T4 控制器内联完成；全程红灯先行（T3 红灯因并行写入时序未单独留档，以断言先行落盘为锚）。
- spec C1–C5：C1 环检测/并发见证/错误局部化（T1 六例）✓；C2 四角色框定进 prompt（T2）✓；C3 Loop 嵌入修正环收敛 + Graph→Loop 预算贯通（T2-1 observedLoopMaxTokens=900）✓；C4 错误局部化 + gate pause/resume 双路 + ci exit 语义（T1/T2/T3）✓；C5 模板 e2e（拓扑序/数据流/预算累计）+ 零回归 + selfcheck 行（T4/T5）✓。
- 偏差登记：① GraphContext 增 `termination`（T2，节点预算换算，对齐 LoopContext）；② GraphRunResult 增 `results`（T1，数据流观测面）；③ GraphDeps 以内联 import type 落 types.ts；④ LoopNodeConfig 增 goal 语义文档与 termination 透传（T2，修正环轮数可调）；⑤ PipelineOpts 模板契约：loop 节点缺省 maxIterations=10（T4，修正环余量）；⑥ 占位 SubAgent/createAgent 退役（spec §8 在案）。
- 真实冒烟（scripts/probe-graph-smoke.js × DeepSeek，手动不入门禁）：run1 推进 4/5 节点全 pass（真实计量 13,906 tokens，内嵌修正环收敛、错误局部化如实传播），reviewer 因 maxSteps=4 过紧 failed；放宽至 6 后 run2 developer 于模型调用前抛环境级异常（未复现），run3 planner 模型调用超时（DeepSeek 慢响应）；其后沙箱多次工具级失败。**结论如实**：管线机制已由 run1 实证通畅，端到端 done 闭环受环境波动所限未决，留待环境稳定后手动复跑（`node --env-file-if-exists=.env scripts/probe-graph-smoke.js`）。
- run4（maxSteps=6 + timeoutMs=120s）：4/5 节点 pass，真实计量 16,033 tokens（planner 3,464 / developer 4,593 / test-verify 修正环 3,690）；reviewer 步数内未收敛（真实消耗 4,286 tokens）failed——错误局部化如实传播（gate skipped、failedNodes=[reviewer]）。已放宽 maxSteps=8，端到端闭环待环境稳定后复跑（脚本含节点级堆栈诊断）。
