# 长任务终止参数收编 settings.json 与缺省放宽 — 设计规格

> 日期：2026-09-20 ｜ 状态：待用户评审 ｜ 线：长任务终止参数（brainstorming → writing-plans）

## 1. 背景与目标

用户裁决：墙钟时长不再是长任务的常规终止条件——工具执行慢（install/build/测试套件）、思考内容长只烧钟不烧步数，时长限对合法推进的长任务属纯误伤；循环失控的正确量纲是「无进展」（步数/轮次/token），不是时间。据此：

1. 终止以步数/轮次/节点数为主承载，收编 settings.json 语义键（用户可调）；
2. 墙钟时长降格为失控保底常量，缺省大幅放宽，不进 settings；
3. token 预算不动（走 paused 可续走语义，非硬死）。

## 2. 现状事实（已核实）

| 事实 | 落点 |
|---|---|
| Reactor 缺省步数 `opts?.maxSteps ?? 200` | `src/harness/reactor.ts:127` |
| Graph 角色代理缺省步数 `opts.maxSteps ?? 200` | `src/graph/agents.ts:52` |
| Loop 模板缺省终止 `{maxIterations:100, maxTokens:1M, timeoutMs:7_200_000}` | `src/loop/templates.ts` `DEFAULT_TERMINATION` |
| 长任务时间兜底 `LONG_TASK_TIMEOUT_MS = 14_400_000`（4h，longTaskTemplate 显式覆盖） | `src/loop/templates.ts` |
| Graph 模板缺省终止 `{maxNodes:500, maxTokens:2M, timeoutMs:14_400_000}` | `src/graph/templates.ts` `DEFAULT_TERMINATION` |
| 语义键映射表（现有 27 键，展平进 `SUNSHINEX_*` env 槽） | `src/config/settings.ts` `SEMANTIC_KEYS` |
| env 解析先例（run 内解析一次、非法值忽略回缺省） | `src/config/memory-config.ts`、`src/runtime.ts`（reasoningEffort/tier） |
| guardrail 步边界判定（超时→预算→步数）、子代理 deadline=父剩余换算 | `src/harness/guardrail.ts`、`src/harness/subagent.ts` |

## 3. 设计

### 3.1 新增三枚语义键（SEMANTIC_KEYS 单点登记）

| 语义键 | env 槽 | 量纲 | 消费点 |
|---|---|---|---|
| `maxSteps` | `SUNSHINEX_MAX_STEPS` | Reactor 单 run 步数上限 | reactor / graph 角色代理 |
| `maxLoopIterations` | `SUNSHINEX_MAX_LOOP_ITERATIONS` | Loop 修正环节点执行步上限 | loop 模板 assemble |
| `maxGraphNodes` | `SUNSHINEX_MAX_GRAPH_NODES` | Graph 全链路节点步累计上限 | graph 模板 assemble |

解析口径沿 memory-config `positiveInt` 先例：未设/空串回 undefined（消费点取内置缺省）；非正整数（零/负/小数/NaN/非法文本）fail-fast 抛错并带槽名——配置错误显式暴露，不静默吞（tier/effort 的非法忽略回退不适用：档位枚举与数值限额口径不同）。

### 3.2 兜底常量放宽（时间不进 settings）

| 维度 | 现 | 新 | 落点 |
|---|---|---|---|
| Reactor 缺省步数 | 200 | **400** | reactor.ts / graph/agents.ts 两处 `?? 200` |
| Loop 轮数 | 100 | **200** | loop/templates.ts `DEFAULT_TERMINATION` |
| Loop 墙钟 | 2h | **12h**（43_200_000） | 同上 |
| 长任务时间兜底 | 4h | **24h**（86_400_000） | `LONG_TASK_TIMEOUT_MS`（对齐 Graph） |
| Graph 节点步 | 500 | **1000** | graph/templates.ts `DEFAULT_TERMINATION` |
| Graph 墙钟 | 4h | **24h**（86_400_000） | 同上 |

token 预算（Loop 1M / Graph 2M）不动；`LoopTermination` / `GraphTermination` 类型零改动（timeoutMs 保持必填）；guardrail、StopReason `'deadline'`、子代理预算换算零改动。

### 3.3 注入链与解析单点

优先级：**显式入参 > settings 语义键（env 槽）> 内置缺省**。

- 新增 `src/config/termination-config.ts`：三个纯解析器 `reactorMaxStepsEnv()` / `loopIterationsEnv()` / `graphNodesEnv()`，内部共用 positiveInt 局部助手（沿 memory-config.ts 形态）；环境变量运行期不变，run/assemble 内解析一次。
- 消费落点（收口四处，调用面零改动）：
  1. `reactor.ts` run：`opts?.maxSteps ?? reactorMaxStepsEnv() ?? 400`——单点覆盖 TUI 直跑 / loop agentNode / graph 角色 / 子代理缺省全路径（子代理显式传 budget 时不受影响）；
  2. `graph/agents.ts:52`：`opts.maxSteps ?? reactorMaxStepsEnv() ?? 400`——与 reactor 同源同值，防两处漂移；
  3. `loop/templates.ts` assemble：合并序 `DEFAULT_TERMINATION < env(maxIterations) < opts.termination`——env 只注 maxIterations，墙钟不从 env 注入（D1）；
  4. `graph/templates.ts` assemble：合并序 `DEFAULT_TERMINATION < env(maxNodes) < opts.termination`——同上只注 maxNodes。
- 该合并序天然覆盖全部消费路径：CLI run/pipeline、TUI /goal 与 runTask、graph 内嵌 loop 节点均经两处 assemble，无须改 resolveTemplate 签名与 CLI/TUI 调用面。

### 3.4 关键裁决

- **D1 时间不进 settings**：墙钟是失控保底常量而非用户常规配置面；暴露配置等于鼓励依赖时间终止，与「完成驱动、宽预算」取向相悖。用户裁决「时间限不合理」的直接体现。
- **D2 注入收口两处 assemble + reactor 单点**：不改 resolveTemplate / runLoop / buildDeps 签名，调用面零触碰。
- **D3 两处 `?? 200` 收敛同一解析器**：reactor 与 graph/agents 共用 `reactorMaxStepsEnv()`，防缺省值漂移。
- **D4 settings 全表钉子同步**：SEMANTIC_KEYS 27→30 键，settings.test.ts 全表计数与逐键映射断言同步。

## 4. 验证面

- `settings.test.ts`：三新键映射 + 展平写槽 + 全表计数 27→30 钉子。
- `termination-config` 套件（新）：合法值生效 / 未设·空串回 undefined / 零·负·小数·非法串 fail-fast 抛错带槽名。
- reactor 套件：env 缺省生效用例（`SUNSHINEX_MAX_STEPS=2` → 第 2 步 max-steps 终态）、显式入参优先于 env 用例。
- 模板套件：合并序用例（env < opts.termination）、放宽后常量断言（200 / 12h / 24h / 1000 / 24h）。
- 既有测试盘查：grep 钉死 200 缺省或模板 timeoutMs 字面值的用例同步更新。
- 文档同步：CLAUDE.md §12 缺省清单数值 + 墙钟「失控保底」定位 + settings 三键提及；README settings 键表；TUI-MANUAL 配置模板三行。
- 门禁：`pnpm build` + 全量测试 + `pnpm selfcheck`。

## 5. 不做（YAGNI）

- token 预算键化（paused 可续走，非硬死，无常调需求）；
- 墙钟键化（D1）；
- 每模板独立键（三键按层足够，模板级差异走显式入参）；
- CLI flag 面（settings 语义键已够，需要时再按 reasoningEffort 先例补 flag）。

## 6. 自审登记

- §2 现状数值与行号均经本日仓内核实；实施时以现行字节为准，行号漂移不属偏差。
- §3.3 落点 1 的 env 解析沿 reactor 既有先例注释（「环境变量运行期不变，run 内解析一次」），不构成前缀缓存影响面（不进提示词）。
- 两处 assemble 合并序实施时须保持既有 `opts?.termination` 展开位次不变，仅在其前插入 env 段。
