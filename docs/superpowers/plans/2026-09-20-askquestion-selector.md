# AskQuestion 工具与统一选择器实施计划（2026-09-20）

规格：`docs/superpowers/specs/2026-09-20-askquestion-selector-design.md`（D1–D8 裁决 + §8 验收矩阵九条）。执行方式沿 fork/子代理/goal/记忆四先例：主代理会话内联 TDD。

## 0. 接口事实基线（2026-09-20 全部精读核实）

| 事实 | 位置 |
|---|---|
| builtinTools 可选参条件注册先例（第 8 参 memoryWrite 注入才注册、两态不变式） | src/harness/tools/builtin.ts:51（签名）、:199-224（memory_write 条件注册段） |
| Harness 聚合装配点（builtinTools 内联调用、HarnessOptions） | src/harness/index.ts:79、:30-43 |
| guard manual 免审批先例（spawn 直名放行） | src/harness/security/guard.ts:57-59（manual 分支）、setAsker:79 |
| SessionStatus 五态 / TuiState.approval / suspendAsker 挂起管线模板 | src/tui/session.ts:45 / :101 / :211-226 |
| App 键盘分发（awaiting-approval :151 / awaiting-plan :156）、审批卡内联渲染 :296、approvalKeyToDecision 纯函数 :17 | src/tui/components/App.tsx |
| /resume 处理器（无参列表 / `<n\|id>` 恢复）与 restoreFromSession | src/tui/session.ts:728-754 / :475 |
| SessionMeta {id, file, updatedAt, firstUser?} | src/tui/session-journal.ts:29 |
| 并行闸门 bash 单发独占（判定与拒绝文案单点） | src/harness/reactor.ts（测试锚 reactor.test.ts:446 一带） |
| tool-verbs VERBS 表 | src/tui/tool-verbs.ts |
| CLI deps 构建入口（run-loop/run-pipeline 消费 buildDeps；readline 先例 confirmApprovals） | src/runtime.ts、src/cli/commands/run-pipeline.ts:10 |
| selfcheck tools 行动态打印、无计数断言 | src/cli/commands/selfcheck.ts:38 |
| 审批契约与决策三值（kind 五类 / allow\|always\|deny） | src/types.ts:194-201 |

## 1. 全局裁决回顾（规格 §3 摘要 + 本计划三处定稿）

- **常驻注册定稿**：builtinTools 第 9 可选参 `ask?: AskUserSeam` **缺省 undefined = 不注册**（沿 memory_write 两态先例，旧直调零扰动）；**Harness 构造缺省传 headlessAskStub（async → dismissed）= 真实 Harness 恒注册 ask_question**。效果：selfcheck/TUI/CLI 三面工具清单 +1 一次到位；builtinTools 直调的既有测试（memory-write BUILTIN_NAMES 清单断言等）零扰动。
- **多选 Other 定稿**：Other… 选中即切自定义输入、提交返回 `{type:'custom'}` 单态（勾选项不混合，对标 CC「Other 即自由作答」）；`AskUserRequest` 增 `customIndex?: number` 供 UI 分流（executor 合成 Other 时写入）。
- **子代理面登记**：derive 不剔除 ask_question（v1 允许子代理问询，seam 同源；如需收窄后续批次）。
- **est 精算风险（P6）**：真实 Harness 工具清单 +1 行使 buildPrompt est 轻微上涨，压缩 est 精算用例如受扰按 70ec1a9 先例重标定。

## 2. Task 1 — OptionSelector 组件（纯渲染 + 键盘语义纯函数）

新增 `src/tui/components/OptionSelector.tsx`：

- Props：`{ title?: string; question: string; options: { label: string; description?: string }[]; multiple?: boolean; cursor: number; picked: number[]; hint?: string }`
- 渲染：题头粗体；每行 `❯`（cursor）/空格缩进 + 多选前缀 `◉/○`；label + dim description；底部 hint 行（`t('↑/↓ move · space select · enter submit · esc cancel', …)`，外观双语）。
- 导出纯函数（独立单测）：
  - `moveCursor(cursor, len, dir)`：↑↓ 循环滚动、边界钳制
  - `togglePick(picked, idx, multiple)`：单选覆盖为 `[idx]`、多选翻转
- 用例：moveCursor 首尾循环边界、togglePick 单/多选语义、组件渲染形态（❯ 高亮行、◉/○ 勾选、hint 行）——沿 App.visual/组件测试先例。

## 3. Task 2 — ask_question 工具全链路

### 3.1 types.ts

- `ToolCategory` 增 `'ask'`。
- `AskUserRequest { id; question; options: {label; description?}[]; multiple?; customIndex? }`
- `AskUserAnswer = { type:'selected'; labels: string[] } | { type:'custom'; text: string } | { type:'dismissed' }`
- `AskUserSeam = (req: AskUserRequest) => Promise<AskUserAnswer>`

### 3.2 builtin.ts（第 9 参）

- 签名追加 `ask?: AskUserSeam`；`ask !== undefined` 才注册：`{ name:'ask_question', category:'ask', description:<规格 D3 英文草案>, executor }`。
- executor：question 非空、options 数组 2–8 且 label 非空（`CodedToolError('INVALID_ARG', …)`）；`allowCustom` 合成 `Other…` 末项并记 customIndex；`await ask(req)` 后按 D3 四态回观察文案：
  - dismissed → `user dismissed the question (no selection)`
  - custom → `custom: <text>`（空文本按 dismissed）
  - selected → multiple ? `answers: <a>; <b>` : `answer: <label>`

### 3.3 安全链 / 并行闸门 / 动词

- guard.ts manual 分支 spawn 行后：`if (tool === 'ask_question') return { allowed: true };`（注释：问询工具即用户交互通道，免审批；deny 规则仍先行）。
- reactor.ts 并行判定：bash 之外追加 ask 拒批；拒绝文案改「并行调用仅限非 exec/ask 工具（exec 与 ask 须单发独占执行）…」。
- tool-verbs.ts：`ask_question: 'ASK'`。

### 3.4 Harness / TUI / CLI 装配

- harness/index.ts：HarnessOptions + `ask?: AskUserSeam`；builtinTools 第 9 参传 `opts.ask ?? headlessAskStub`（导出 stub 供测试）。
- tui/runtime.ts：TuiRuntimeOpts + `onAskUser?: AskUserSeam` → 透传 HarnessOptions.ask。
- tui/session.ts：
  - SessionStatus 增 `'awaiting-question'`；TuiState 增 `question?: AskUserRequest`；`pendingQuestion?: { req; resolve }`。
  - `askUser(req)`：记录 prevStatus（running|idle）→ status='awaiting-question' + state.question + notify → await new Promise（pendingQuestion 挂起）→ 恢复 prevStatus + 清 question + notify → 返回答案；导出 `resolveAnswer(a)` 供渲染层回填。
  - 构造期：ask seam = `opts.onAskUser ?? ((req) => this.askUser(req))`，经 createRuntime 新 opts 透传 Harness。
  - `shouldPumpOnIdleBeat` 增加 `!hasPendingQuestion`（负向用例钉死：问询挂起不消费后台队列）。
- App.tsx：`awaiting-question` 分支——local state（qCursor/qPicked/qCustom/qText，question.id 变更时复位）调度 T1 纯函数；cursor===customIndex 且 Enter/Space → 切内联文本输入（复用输入行渲染），Enter 提交 custom；Esc → dismissed；数字 1–9 快选；resolveAnswer 回填。
- CLI（runtime.ts buildDeps，装配位按 P1 核实）：`ask: cliAskSeam()`——`process.stdin.isTTY` 真 → readline 编号输入（multiple 空格分隔编号、0/空回车=dismissed、Other 号→文本输入）；假 → headlessAskStub。

### 3.5 用例（红灯先行）

builtin 两态注册 + INVALID_ARG×3（空 question/options<2/options>8）+ 观察四态 + Other 合成 customIndex；guard manual 免审批；reactor 混批拒绝 + 单发放行；session 挂起/回填/恢复 + idle 节拍负向；App 键盘五路径（↑↓/Space/Enter/Esc/数字）；tool-verbs ASK 映射；buildDeps TTY 分支（注入桩 readline）。

## 4. Task 3 — 三面迁移（统一选择器）

1. **审批卡**：awaiting-approval 分支选择器化——选项 `[Approve once / Allow for session / Deny (esc)]`（t() 双语），**y/a/n 快捷并存**（approvalKeyToDecision 命中即裁决，否则选择器路径），光标态为 App local state。
2. **plan 卡**：awaiting-plan 同构 `[Execute plan / Keep planning (esc)]`，y/n 并存。
3. **/resume**：无参 → `resumeSelector()` 合成 AskUserRequest（label=id、description=firstUser 截 60、**最新 8 条钳制** + 尾行提示其余用 `/resume <id>`）→ askUser 挂起（prevStatus=idle）→ selected 按 label 匹配 id → restoreFromSession；dismissed → `Resume cancelled` 回执；`/resume <n|id>` 显式路径原样保留。
4. 用例：审批选择器路径 + y/a/n 快捷回归、plan 双路径、resume 选择器恢复/Esc/数字直达/显式参数回归、既有审批卡断言同步。

## 5. Task 4 — 文档与三重门禁

- TUI-MANUAL：快捷键段补选择器键位；权限审批 / plan 确认 / resume 形态更新；ask_question 用户侧说明（模型何时会用、headless 行为）。
- README 工具清单 + ask_question 一行；CLAUDE.md §5 工具清单登记（+1 断点已批）。
- 门禁：tsc strict 0、全量 fail 0 skipped 0、selfcheck OK（tools 行含 ask_question）。
- 收尾自审：动态面盘点零新增（ask description 为静态英文）；grep ask_question 全落点复核；est 精算用例受扰则重标定（P6）；journal 不持久化挂起态核实（P4，对标会话审批登记不持久化先例）。

## 6. 验收矩阵映射（规格 §8 九条）

1–5、7、9 → T2；6 → T3；8 → T2/T4。

## 7. 落点、前置与核实点

- 无跨线前置；memory_write 并发线与本线在 builtin.ts 第 8/9 参相邻——若并发线先落，本线参数顺延，落地时以现场为准（P0）。
- P1：buildDeps 内 Harness 装配形态与 ask 注入点（T2 首日核实）。
- P2：reactor 并行判定单点位置（reactor.test.ts:446 一带已锚定）。
- P4：journal 对 awaiting-question 不持久化（对标审批挂起不持久化）。
- P5：selfcheck TUI 冒烟管线是否断言工具数量（如断言则同步）。
- P7：deadline 计时在问询挂起期间是否暂停——**与审批卡现行语义对齐**（审批卡现行不暂停则问询同形态不暂停，规格 D8 第二分支「本批补齐暂停」转为登记偏差，待需再立批次）；T2 落地时核实 reactor deadline 锚定形态后定案。
