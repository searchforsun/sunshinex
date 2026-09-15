# TUI `/goal`：完整 Loop 能力入口 设计规格

- 日期：2026-09-15
- 状态：设计已批准（会话内呈现确认 + 用户定名 `/goal`），待实施
- 关联：`2026-09-14-context-fork-design.md`（会话链模型 / 主链追加语义）、`2026-09-14-subagent-design.md`（D5 主链唯一入口先例）

## 1. 背景与目标

Loop 引擎（agent → check → router 修正环）现有唯一用户入口是 CLI `sunshinex run`（三大模板：code-refactor / test-loop / code-review）；TUI 侧任务一律经 `longTaskTemplate`（单 agent 节点、无 check 节点，完成以模型自报 done 为准）。本规格为 TUI 新增斜杠命令 `/goal`：一条命令直达完整修正环能力，交互形态对标 Claude Code 斜杠命令直执行（无规划轮、无确认卡）。

定名沿革：设计讨论期暂名 `/go`，用户裁决定名 `/goal`（目标驱动语义），无别名。

## 2. 方案对比与关键裁决

| 方案 | 形态 | 结论 |
|------|------|------|
| A. 薄入口直跑模板 | `/goal <目标> [--template=X]` → `resolveTemplate()` → `engine.run()` | **采纳**：对标直执行形态，改动面最小（约 4 源文件 + 2 文档） |
| B. `/plan` 同款两段式 | 规划轮 → 确认卡 → 执行 | 否决：与 `/plan`（规划+逐步直执行）职责重叠，多一轮模型调用与一次确认 |
| C. WorkflowDef / 技能通道 | 统一编排面 | 否决：WorkflowDef 尚无任何用户入口，独立后续规格 |

| # | 裁决 | 内容 |
|----|------|------|
| D1 | 定名 | `/goal <目标> [--template=code-refactor\|test-loop\|code-review]`，缺省 `test-loop`（对齐 CLI `run`），无别名 |
| D2 | 薄入口直跑 | 无规划轮、无确认卡；守卫（无参用法提示 / 运行中拒绝 / 未知模板报错）通过后直入引擎 |
| D3 | 主链纪律 | 开跑前 `appendChain` 任务行（observation 带 `/goal · 模板` 标注）；修正环全程主链追加；零新增提示词拼装面 |
| D4 | 模板工厂上移 | `resolveTemplate` + `FACTORIES` 迁入 `src/loop/templates.ts`，CLI 改引；防 CLI/TUI 两处工厂漂移（对齐 Runner 单点同款理由） |
| D5 | 轮次可见性 | 本期以终态回执（status / iterations / criteria / tokens）承载修正环轮次可见性，不加新事件类型（YAGNI） |

## 3. 命令形态与交互

```text
/goal <目标> [--template=code-refactor|test-loop|code-review]
```

- 目标为空 → 用法提示（含「验收标准：id=描述」内嵌示例），不入链、不启引擎、不切状态；
- 任务运行中 → 拒绝（复用 submit 既有运行中守卫，与 `/init`、`/plan` 同款）；
- 未知模板名 → session 预校验（导出模板名清单）报错列可选值；`resolveTemplate` 工厂抛错为兜底防线；
- 用户输入回显：submit 分发前统一入档的既有机制覆盖，零新增；
- 启动提示：单行系统消息（`✻ /goal：<模板> · <目标摘要>`），对齐 `/init` 先例；
- Tab 补全与 `/help`：`App.tsx` SLASH_COMMANDS / SLASH_HELP 清单各增一条。

## 4. 语义：目标即验收准则载体

完全沿用 CLI `run` 的 goal 约定：目标内嵌「验收标准：id=描述」段时，`checkNode` 三优先级中「goal 内嵌验收标准段」直接生效；未内嵌时 check 走 small 档模型判据兜底（独立一次性调用、禁时变字段，既有行为不变）。用法提示文案携带一行内嵌示例，引导用户书写可判据目标。

## 5. 会话链与 fork 纪律（前缀缓存第一要义落点）

- 任务行：`appendChain([{ action: 'task', observation: \`${goal}（/goal · ${template}）\` }])`，形态对齐 CLI run-loop 入链（单发 run 同款 action）加模板标注；
- 引擎作用域缺省主链（session）：seed 缺省 `chainView()`，agent 步骤与结论行由 Reactor 会话作用域自动回写——零新增回写代码；
- `runLoop` 不开放 `seedHistory` / `scope` 参数（修正环主链语义固定；fork 化留待真实需求）；
- 前缀缓存：无新拼装面（不新增任何独立提示词组装），`/goal` 主链与裸任务同构——既有「相邻步前缀稳定」回归矩阵覆盖，无需新增用例，跑全量回归确认。

## 6. 接缝与改动面

**src/loop/templates.ts**
- 迁入 `resolveTemplate(deps, name, opts?: TemplateOpts)` 与 `FACTORIES`，并导出模板名清单（供 session 预校验）；签名与行为不变；
- CLI 侧同构冗余类型 `TemplateRuleOpts` 随迁删除（`TemplateOpts.ruleCheckers` 已覆盖），CLI 直接用 `TemplateOpts`。

**src/cli/commands/run-loop.ts**
- 删除本地 `FACTORIES` / `resolveTemplate` / `TemplateRuleOpts`，改引 loop 层；对外行为零变化。

**src/tui/runtime.ts**
- `loopDeps` 构造抽私有函数（如 `buildLoopDeps(overrides?)`），`runTask` / `runLoop` 共用，防两处漂移；
- `TuiRuntime` 增 `runLoop(goal: string, opts?: { template?: string; tier?: ModelTier })`：`resolveTemplate(runDeps, template)` → `engine.run(goal)`，返回 LoopEngine 既有结果类型原样透传（零新共享类型登记）；tier 线程与 `runTask` 同口径；不开放 `seedHistory` / `scope`。

**src/tui/session.ts**
- `handleSlash` 增 `'/goal'` 分支：解析（`--template=` 提取后从目标文本剔除，余文为目标）→ 守卫 → 私有 `runGoalFlow(goal, template)`；
- `runGoalFlow` 顺序（防悬空任务行）：`resolveTemplate` 校验在先（抛错即拒、未入链）→ 入链任务行 → 状态切换与复位（`runTaskFlow` 同骨架：metrics / usageBase / 流式水位）→ `await runtime.runLoop(...)` → 终态回执 → `closeTask()`（try/finally 保证异常路径状态必回 idle）；
- 终态回执：done → 摘要（status / iterations / tokens + criteria 逐项 ✓/✗）；非 done（越限 / 超时 / 错误）→ 失败回执（status / error + 未过项），宁停不误。

**App.tsx / 文档**
- `SLASH_COMMANDS` 补 `'/goal'`、`SLASH_HELP` 增行；
- TUI-MANUAL.md 命令表与 plan 模式段旁补 `/goal` 条目；README.md 补一句（TUI 亦可触发修正环模板）。

**i18n 与测试**
- 用户可见文案就地 `t()` 双语成对（用法 / 报错 / 启动提示 / 回执）；测试断言语言中性（`pick` 缺省 en，fork 实施先例）；
- 新增 `session.goal.test.ts`：对应 §9 验收矩阵（桩模型）；
- runtime 套件：`runLoop` 装配（模板命中、tier 线程、未知模板报错）；
- 既有 run-loop CLI 测试：工厂上移后 import 口径同步；
- 全量 `pnpm test` + `pnpm selfcheck` 门禁。

## 7. 显示与可见性

零新增渲染件。Loop 引擎经 `LoopDeps.onEvent` 透传的 Reactor 事件（token / reasoning / tool-call / tool-result / step / usage / ctx）由 session 既有 switch 全量消费——▶ 阶段行、●/⎿ 工具对、思考流、状态栏、子代理面板照常实时上屏。check 判据为独立小模型调用，不产生事件（静默，既有行为）。修正环轮次可见性以终态回执 iterations + criteria 承载（D5）；「每轮 check 结论卡」留作后续独立增强。

## 8. 错误边界

- 未知模板：预校验报错列可选值，不入链不启引擎；工厂抛错为兜底；
- 引擎异常 / 预算越限：失败回执（status / error + 未过 criteria 摘要），宁停不误；
- `closeTask` try/finally：任何异常路径状态必回 idle；
- 失败不回滚链：append-only 纪律，任务行与已产生轨迹保留，失败以链上轨迹为准；
- plan 只读模式：guard 对写操作如实拒绝（不特殊处理）；manual 模式 write / exec 走既有审批卡。

## 9. 验收矩阵

1. `/goal` 无参 → 用法提示；链零写入、状态零切换、引擎零调用；
2. `--template=nope` → 报错列出三模板；不入链；
3. 任务运行中 `/goal` → 拒绝提示；
4. 正常跑通（桩模型）：链上出现任务行 + 修正环轨迹 + 结论行；消息流 Reactor 步骤行实时可见；
5. 终态回执含 status / iterations / criteria / tokens，criteria 逐项 ✓/✗；
6. `/new` 清链后 `/goal` 空链起跑正常；
7. 全量测试 + selfcheck 绿；`/goal` 无新拼装面，既有前缀稳定用例全绿。

## 10. YAGNI 与否决备选登记

- 不做：模板选择卡、规划轮、确认卡、Graph / `/workflow`、WorkflowDef、新事件类型、`ruleCheckers` 进 TUI、`/goal` 别名；
- 否决备选：方案 B（两段式，与 `/plan` 重叠）、方案 C（WorkflowDef 通道，入口未建）、Loop 节点边界事件（动 types.ts 事件面 + 渲染面，本期终态回执已承载轮次可见性）。

## 11. 自审

- 定名一致性：全文 `/goal`，无 `/go` 残留；
- 类型面：零新共享类型（复用 LoopEngine 结果类型与 `CriterionResult`）；
- 范围：不含 Graph / WorkflowDef；改动面 4 源文件 + 2 文档 + 测试；
- 与 fork 规格一致性：主链追加 / append-only / 无新拼装面逐条对齐，无冲突条款。
