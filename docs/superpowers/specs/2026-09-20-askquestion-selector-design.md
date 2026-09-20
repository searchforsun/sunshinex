# AskQuestion 工具与 TUI 统一选择器交互设计（2026-09-20）

> 目标：①TUI 全部选择题交互统一为「上下选择 + 空格选定」的 OptionSelector 组件（对标 Claude Code）；②新增 harness 工具 `ask_question`（display: AskQuestion），让模型主动向用户出选择题，支持单选 / 多选（空格勾选）/ 自定义输入。
> 前缀缓存登记：工具清单 +1 = 一次全量前缀断点（§5 纪律内，本次新增经用户裁决）。

## 1. 背景与问题

用户指令原话：「遇到选择题的时候，交互方式变一下，对标CC. 支持上下选择某一项，空格选定。包括tui其他的交互，权限确认，plan确认，同时加一个 AskQuestion组件，单独一个工具，隶属于harness, 不过这个支持多选，和用户自定义输入。」

现状四个「选择题」交互面形态不一，且模型无主动问询通道：

| 交互面 | 现状 | 问题 |
|---|---|---|
| 权限确认卡 | y/a/n 单键（App.tsx `approvalKeyToDecision`） | 无上下选择，不可扩展选项 |
| /plan 确认卡 | y/n 单键 | 同上 |
| /resume 列表 | 纯文本编号列表，输入数字选择 | 无上下选择交互 |
| 模型问询 | 无（模型只能靠回复正文引导用户） | 模型缺结构化问询工具 |

## 2. 设计总览

两块交付物，一套交互底座：

1. **OptionSelector 统一选择器组件**（TUI 渲染层）：↑/↓ 移动高亮、Space 选定（单选即选即提交、多选为勾选）、Enter 提交、Esc 取消、数字 1–9 快选、「Other…」项切内联文本输入。四个消费面共用：权限确认卡、/plan 确认卡、/resume 列表、AskQuestion 卡。
2. **`ask_question` 工具**（harness 新增）：模型主动向用户出选择题，支持单选 / 多选 / 自定义输入——对标 Claude Code 的 AskUserQuestion。

## 3. 关键裁决

### D1 工具注册与类别

- 工具 id `ask_question`（清单按名排序自动就位首位），display 名 AskQuestion。
- `ToolCategory` 新增 `'ask'`，并行策略与 exec 同待遇：**单发独占**，不进并行批（交互阻塞型工具）。
- tool-verbs 登记 `ask_question: 'ASK'`。

### D2 入参契约（英文 description，§15）

```json
{
  "question": "string, the question to ask",
  "options": [{ "label": "string", "description": "string, optional" }],
  "multiple": "boolean, optional (default false)",
  "allowCustom": "boolean, optional (default false)"
}
```

- options 钳制 2–8 项；缺 options 或超界报 `INVALID_ARG`。
- `multiple=true`：Space 勾选/取消勾选，Enter 提交所有勾选项。
- `allowCustom=true`：选项末尾追加「Other…」项，选中后切文本输入行。

### D3 观察回文本（英文单语，进模型上下文）

- 单选：`answer: <label>`
- 多选：`answers: <label1>; <label2>`
- 自定义：`custom: <text>`（多选时可与勾选项混合：`answers: a; b; custom: <text>`）
- Esc 取消：`user dismissed the question (no selection)`——模型应据此调整策略而非重试同问。
- 工具 description（草案）：
  > Ask the user a question with selectable options. Use when you need the user to choose between alternatives or provide free-form input. Supports single/multi select and a custom "Other" text answer. Returns the user's selection.

### D4 键盘语义（对标 CC）

| 键 | 单选 | 多选 |
|---|---|---|
| ↑/↓ | 移动高亮 | 移动高亮 |
| Space | 选定并提交（=Enter） | 勾选/取消勾选 |
| Enter | 提交高亮项 | 提交所有勾选项 |
| Esc | 取消（dismiss） | 取消（dismiss） |
| 1–9 | 快选对应项并提交 | 快选对应项（勾选翻转） |
| Other… 项 | 切文本输入，Enter 提交 `custom:` | 同左 |

### D5 asker 通路（核心机制，复用审批挂起管线）

- 复用 `ApprovalRequest` 挂起管线形态，但走**独立新类型**（不复用审批 kind，避免审批语义污染）：

```ts
// types.ts 新增
export interface AskUserRequest {
  id: string;                 // q-<seq>
  question: string;
  options: { label: string; description?: string }[];
  multiple?: boolean;
  allowCustom?: boolean;
}
export type AskUserAnswer =
  | { type: 'selected'; labels: string[] }
  | { type: 'custom'; text: string }
  | { type: 'dismissed' };
```

- `SessionController` 新增 `askUser(req): Promise<AskUserAnswer>`：挂起（status `awaiting-question` + state.question）→ 渲染层选择器接管键盘 → 裁决回填 → 恢复 running。
- 不经 guard/asker（免审批——它本身就是问询通道；沿 spawn 免审批先例）。

### D6 会话状态扩展

- `SessionStatus` 新增 `'awaiting-question'`。
- `TuiState` 新增 `question?: AskUserRequest`。
- `shouldPumpOnIdleBeat` 判据追加 `!pendingQuestion`（问询挂起时不消费后台队列）。

### D7 CLI/headless 回落

- TUI 不可用（CLI run/pipeline、headless）时，askUser 回落为 **stdin 编号输入**：
  ```
  ? <question>
    1) <label>
    2) <label>
  选择 (1-2, 空格分隔多选, 回车提交): _
  ```
  多选以空格分隔编号；输入 `0` 或直接回车=dismissed；自定义=输入 `c` 后切自由文本。
- headless（无 TTY）时无法交互 → 直接返回 `{ type: 'dismissed' }`（观察回 `user dismissed…`），任务不因问询挂死。

### D8 预算/deadline 语义

- 问询挂起期间 **暂停 deadline 计时**（等待用户作答不应烧任务预算）——落地时与审批卡现行 deadline 语义对齐：若审批卡已暂停，则 question 同形态；若未暂停，则本批一并补齐（审批与问询同语义，登记计划偏差）。

## 4. TUI 渲染形态（对标 Claude Code AskUserQuestion 卡）

```
┌─ AskQuestion ─────────────────────────────┐
│ <question>                                 │
│ ❯ 1. <label1> — <description>              │
│   2. <label2> — <description>              │
│   3. Other…  (自由输入)                     │
│ ↑/↓ move · space select · enter submit     │
└───────────────────────────────────────────┘
```

- 多选时每行前缀 `◉/○`；已选高亮。
- 单选 Space/Enter/数字直达即提交。
- 渲染层只消费 `AskUserRequest` 数据面（AskQuestionCard.tsx），键盘事件在 App.tsx 统一分发（`state.status === 'awaiting-question'` 分支）。

## 5. T3 迁移面（三面切统一选择器）

| 交互面 | 现状 | 迁移后 |
|---|---|---|
| 权限确认卡 | y/a/n 单键 | Yes / Yes, and don't ask again / No (esc) 三项选择器；**y/a/n 单键快捷保留并存**（approvalKeyToDecision 不删，选择器高亮与快捷键双通道） |
| /plan 确认卡 | y/n 单键 | Execute plan / Keep planning (esc) 两项选择器；y/n 快捷保留 |
| /resume | 编号文本列表 | 会话列表选择器（↑/↓ + Enter 恢复 + Esc 取消 + 数字直达保留）；`/resume [n|id]` 显式参数路径不变 |

## 6. 落点表

| 落点 | 内容 |
|---|---|
| src/types.ts | AskUserRequest / AskUserAnswer / ToolCategory + 'ask' |
| src/harness/tools/builtin.ts | ask_question 工具注册（第 8 可选参 AskFacade：`(req) => Promise<AskUserAnswer>`） |
| src/harness/tools.ts | 安全链登记 ask_question → 免审批（沿 spawn 分支形态） |
| src/harness/index.ts | AskFacade 装配（可注入/缺省 stub：无 asker 时返回 dismissed） |
| src/tui/tool-verbs.ts | ask_question: 'ASK' |
| src/tui/session.ts | SessionStatus + 'awaiting-question'、askUser 挂起管线、pendingQuestion |
| src/tui/components/OptionSelector.tsx | 统一选择器（新组件） |
| src/tui/components/AskQuestionCard.tsx | AskQuestion 卡（消费 AskUserRequest） |
| src/tui/components/App.tsx | awaiting-question 键盘分发分支 + 选择器渲染 |
| src/cli/commands/run-loop.ts / run-pipeline.ts | headless 回落（stdin 编号输入 / 无 TTY dismissed） |

## 7. YAGNI 登记（本批不做）

- CC 单卡多问（questions 数组）——v1 单问，多次调用连问；登记为后续扩展。
- 问询超时自动 dismiss。
- GUI 面问询卡（GUI 线整体后置）。
- ask_question 的会话级「不再询问」登记（无意义——每次问询本就是等用户裁决）。

## 8. 验收矩阵

1. TUI ask_question：模型调用 → 卡片渲染 → ↑/↓ + Enter → 观察回 `answer: <label>`，链行零前缀击穿。
2. 多选：Space 勾选 × N + Enter → `answers: a; b`。
3. allowCustom：Other… → 文本输入 → `custom: <text>`。
4. Esc → `user dismissed…`；headless 无 TTY → 同 dismissed。
5. CLI stdin：编号输入 → 对应 label 回观察。
6. 权限卡/plan 卡/resume：选择器形态 + 单键快捷并存回归。
7. ask 类并行独占：ask_question 与其他工具混入并行批 → 整批拒绝（同 exec 拒绝文案形态）。
8. 工具清单：selfcheck 含 ask_question、按名排序、总数 11 项（工具清单 +1）。
9. awaiting-question 期间不消费后台队列（shouldPumpOnIdleBeat 负向用例）。
