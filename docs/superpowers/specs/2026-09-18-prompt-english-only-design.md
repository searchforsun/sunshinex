# 提示词英文化改造设计规格

> 目标：把「双语」收窄为**外观显示**一条线，一切进入模型上下文的文案恒为**英文单语**——消除同一意图两套语料各自演化造成的语义漂移，并修掉当前 143 处「en 缺省下照样泄漏进模型」的中文串。

## 1. 问题

i18n 基座有 `t(en, zh)` 与 `pick(en, zh)` 两个别名，后者标称「模型侧文案」。实测这类双语提示词共 98 处且中英并行维护，另有一批串**根本没走 `pick`**，直接以中文写死。由此产生两类问题：

- **P1 语义漂移**：同一提示词意图维护中英两份，改动只落一侧即行为分叉；提示词随 `--language` 变化意味着同一产品两套行为，而测试通常只覆盖单侧。
- **P2 真泄漏（bug）**：`pick` 之外的裸中文字面量在 en 缺省下照样进模型上下文（观察、错误、链行、工具描述、摘要与记忆提示词），实测 **143 处**，语言开关管不住。

实测数据（2026-09-18 沙箱，括号深度扫描，排除注释）：

| 类别 | 数量 | 涉及文件 |
|------|------|----------|
| `pick()` 包裹中文 | 98 | 20 |
| 提示词面裸中文 | 143 | 32 |
| 链行误用 `t()`（`tui/session.ts` 362 / 374 / 524 / 552） | 4 | 1 |
| 界面 `t()` 双语（**保留**） | ≈150 | tui/session、tui/components、cli |
| 假阳性：局部函数 `pick`（`config/env.ts:64-66`） | 3 | 1 |

## 2. 规范依据

CLAUDE.md §15「语言规范：外观双语、提示词恒英文」（提交 `f7693a7`）已定稿。本规格是它的落地设计，不再重复论证规范本身。

## 3. 归属规则（唯一判据：能否被模型读到）

| 消费方 | 形态 | 落点 |
|--------|------|------|
| 模型上下文 | **英文裸串** | 系统提示词、工具 name/description、观察、错误、压缩摘要提示词、记忆提取与整理提示词、子代理角色框定、生成类 goal（`/init`、判据、规划轮）、**写链行**（`appendChain` 的 observation/note/deficit/reply 行） |
| 仅用户可见 | `t(en, zh)` 双语 | TUI chrome（状态栏/审批卡/帮助/横幅/待办）、CLI 用法与交互询问、selfcheck 输出、`stop-reason`、**节点回执字面量**（gate 审批通过/拒绝/等待、CI 通过/失败、dry-run 预览、引擎汇总与 fail 说明——只上屏、不写链，见 B-1） |
| 双消费 | **拆两份** | `tui/session.ts` 链行走英文裸串；同句上屏走 `t()` |

判据是「能否被模型读到」，不是「是否上屏」。

### 3.1 边界裁决（据实登记，可单独否决）

- **B-1 执行面按「是否写链」二分（2026-09-18 逐点核实后更正）**：核实 `appendChain` 全仓落点——`graph/nodes.ts:58/60`、`loop/nodes.ts:148`、`subagent.ts:254/258/264`、`reactor.ts:292/298/300/309`、`tui/session.ts:362/374/524/551`、`cli/commands/{run-loop,run-pipeline}.ts`；**`graph/engine.ts` 与 `loop/engine.ts` 均无 appendChain 调用**：
  - **写链的行** → 英文单语（进模型上下文）：loop 节点结论行与「子流程未完成收束」、deficit 行、子代理结论/失败行、reactor 的 note/reply 行。
  - **纯回执字面量** → 保留 `t()` 双语（只上屏，属**死的用户显示**）：gate 的「审批通过/拒绝/等待」、CI 通过/失败、`[dry-run] 预览`、引擎汇总（全部节点完成/等待人工审批/存在失败节点）、节点 fail 的 error 文案。
  - **更正登记**：本规格初版把 graph/loop 全层判为英文，论据「loop 分支已把 `reply` 写链」只对 **loop 节点**成立（其 `reply` 是模型产出）；gate/ci 节点 `reply` 是引擎自写字面量且不写链，属外观面——初版判决有误，此处修正。
- **B-2 事件按来源归属**：`emit('error'|'step'|'phase')` 的文本若同源作为观察写链（如 `steps.push({ observation })`），整段英文；同一来源不为上屏另造中文。
- **B-3 子代理角色**：`ROLE_PRESETS` 的 `label`/`framing` 与 `agents/{id}/agent.md` 注册物料英文单语（角色行直接进 fork 提示词）。
- **B-4 工具 description**：英文单语（经 `buildPrompt` 工具清单进入模型）。
- **B-5 机器消费标题不译**：SUNSHINE.md 的 `项目名称` / `架构原则` / `MCP 服务器` / `## Compact Instructions` / `## 压缩指令` 等字面匹配点（`config.ts`、`context/loader.ts`、`context/window.ts`）保持原样。
- **B-6 功能性非 ASCII 豁免**：`knowledge/chunk.ts` 的分块标点集、TUI 字形（`⎿ ✓ ✗ ✻ ●`）与 box-drawing 线符、`SUNSHINE.md` 等专名——不属提示词文案，列入审计白名单。

## 4. `pick` 处置

**删除导出**：`src/i18n.ts` 仅保留 `t` / `getLanguage` / `setLanguage` / `parseLanguage`；98 处调用点改英文裸串。理由：

1. 零运行时分支；
2. 机械可校验（裸串可直接断言零 CJK）；
3. 消除「模型侧双语」这一概念——规范既已废止该形态，保留包装只会诱导后人再喂双语。

连带：`i18n.test.ts` 的 `pick` 断言删除；全仓 `pick` import 清理；`config/env.ts` 的局部 `pick` 重命名为 `pickEnv`（消除审计歧义，不作功能改动）。

## 5. 改造批次（每批独立门禁 + 提交）

| 批次 | 范围 | 量级 |
|------|------|------|
| **B1 工具与上下文** | `harness/tools.ts`、`tools/{builtin,output-archive,websearch}`、`context/{index,window,summarizer}`、`knowledge/*` | ≈47 |
| **B2 记忆** | `memory/{store,writer,extractor,consolidate}` | ≈43 |
| **B3 图与循环** | `loop/{nodes,engine,templates}`、`graph/{nodes,agents,workflow,engine,templates}` | ≈57（其中回执字面量改 `t()` 双语，仅写链行改英文） |
| **B4 核心与安全适配** | `reactor`、`subagent`、`sunshine-init`、`model/adapter`、`security/{guard,chain,sandbox}`、`mcp/client`、`skills*` | ≈110 |
| **B5 收尾** | `tui/session.ts` 四处链行（362/374/524/552）+ 文档同步 | 4 + 文档 |

总计 ≈245 处（`pick` 98 + 裸中文 143 + 链行 4）+ 文档，批次量为量级估计。每批以 `pnpm build` + 定向测试 + 全量测试 + `selfcheck` 收口后提交。

## 6. 验证机制

1. **提示词面零 CJK 审计用例**（新增 `src/harness/prompt-language.test.ts`）：对提示词面文件清单（`harness/`、`loop/`、`graph/`、`model/` 的非测试源文件）与 `tui/session.ts` 的 `appendChain(...)` 调用点，扫描字符串字面量断言零非 ASCII；白名单仅 B-5 / B-6 登记项。这比逐个断言文案更抗漂移。
2. **界面双语回归**：保留 `stop-reason`、StatusBar、TUI chrome 的 zh 断言，证明外观层未被误伤。
3. **前缀稳定回归**：既有「相邻步前缀稳定」用例必须保持绿（提示词文本改动不得破坏前缀连续性）。
4. 逐批定向 + 全量 + `selfcheck`；提交前 `tsc` strict 零报错。

## 7. 文档同步

- `README.md` / `TUI-MANUAL.md` 的 `--language` 说明改为「只影响界面外观；提示词恒英文」。
- CLAUDE.md §15 已落（`f7693a7`），本轮不再改。

## 8. 风险与取舍

- **英文为重拟而非逐字直译**（对标 Claude Code 提示词语气），中文语料删除后代码内不可回溯；如需回溯依赖 git 历史。本轮不留对照附录（用户已确认照此推进）。
- **体积变化**：英文串略长，可能触发既有断言中的长度/字数假设，红灯逐个修。
- **审计白名单需随目录增长维护**，登记在用例注释内。
- **不做**：不引入词典文件、不新增语言配置项、不改产出语言规则（§15 保留「产出语言由模型按项目自判」）。

## 9. 验收矩阵

1. 全仓 `pick(` 零命中（`config/env.ts` 局部函数已改名），`src/i18n.ts` 不再导出 `pick`。
2. 提示词面零非 ASCII（审计用例绿）。
3. 界面 `t()` 双语用例全绿（zh 断言保留）。
4. `pnpm build` tsc strict 零报错；全量测试 fail 0；`pnpm selfcheck` OK。
5. 前缀稳定回归用例绿。
6. README / TUI-MANUAL 语言口径同步完成。
7. `tui/session.ts` 四处链行为英文，同句上屏文案仍随 `--language` 双语。
8. **节点回执双语钉子**：`--language=zh` 下 graph gate/CI/引擎汇总回执呈中文（`t()` 双语），仅写链行进模型时为英文——防「把死的用户显示一并英文化」的回退。
