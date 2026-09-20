# 子代理显示逐行展开/折叠设计

- 日期：2026-09-20
- 状态：已获用户批准（设计呈现 → 批准）
- 关联：2026-09-15 TUI 子代理显示规格（ChildPanel / 归档折入 SPAWN 行 detail）、transcript-view ▶ 阶段行视图

## 1. 问题

子代理归档后，整段思考 + 工具转录折入 `[SPAWN]` 调用行 `detail`，用户查看手段只有两个且都不合适：

1. 全场 Tab 历史展开——全场性开关，无法只看某一个子代理，展开后与全部其它工具行的全文混排，噪音大；
2. 折叠态只有 `● [SPAWN] <target>` 单行，任务名之外的步数/耗时摘要缺失，「不友好」的主要来源。

目标对标 Claude Code 的局部展开浏览感：每个子代理任务行可独立展开/折叠，折叠=任务名摘要行，展开=思考与工具内容。

## 2. 范围与非目标

- 范围：纯 TUI 渲染层与交互层（ToolRow / App 键盘分发 / ui-state 保留态）。零提示词改动、零工具清单新增、零前缀缓存影响、零 journal schema 变更。
- 非目标（YAGNI）：
  - 不做展开态内二次折叠（子代理转录内部再分级折叠）；
  - 不做子代理专属全屏视图；
  - 不改运行中 ChildPanel 实时面板（恒 4 行实时尾流已达标）；
  - 展开状态不持久化进会话日志（瞬态 UI 态，/resume 恢复默认折叠）。

## 3. 交互设计

### 3.1 键位：Ctrl+B 子代理浏览模式

- **Ctrl+B** 进入子代理浏览模式（仅 SPAWN 行存在时生效；无 SPAWN 行时为 no-op）。
- 浏览模式内：
  - **↑/↓** 在 SPAWN 调用行之间移动高亮（高亮行以反色或加亮标记头部行）；
  - **Enter** 切换当前高亮行的展开/折叠；
  - **Esc** 退出浏览模式，回输入态（已展开的行保持展开）。
- 不使用裸 ↑/↓ 直接选中：空闲态 ↑/↓ 已被输入历史导航占用（App.tsx 既有分流），Ctrl+B 模式内短时接管无冲突。
- 运行中不可进入（与 Tab 历史展开同门槛）；awaiting-approval / selector 等独占键盘态由既有分发顺序自然优先，无需新分支。

### 3.2 两态渲染（ToolRow）

折叠态（缺省）：

```
● [SPAWN] <任务名>（<steps> steps · <耗时>）
```

- 尾注数据来源：spawn 归档时在 ChatItem 上补充（见 §4），缺省缺失时省略尾注只显 `● [SPAWN] <任务名>`。

展开态：

```
▾ [SPAWN] <任务名>（<steps> steps · <耗时>）
    <转录行 1>
    <转录行 2>
    …
```

- 头行图标 `●` → `▾` 表达展开；转录行逐行缩进 4 空格重放（与既有 detail 展开同缩进口径）。
- 转录正文原样重放（思考流 + 工具调用/结果行），不做二次加工。

### 3.3 与既有机制正交

- **Tab**（行数维度全场展开/折叠）：行为不变。Tab 全场展开时 SPAWN 行 detail 照旧全文重放（`collapsed=false` 既有路径）；局部展开状态只在折叠/局部视图生效。
- **Ctrl+O**（内容深度维度）：不变。
- 两套机制正交并存，Ctrl+B 只新增「逐行局部」这一档。

## 4. 数据面

- `ChatItem`（call 行，SPAWN 归档）新增可选字段 `subagentMeta?: { steps: number; durationMs: number }`：
  - `steps`：归档时从 ChildLiveState.steps 取；
  - `durationMs`：归档时间 − startedAt；
  - 缺省 undefined 时折叠行省略尾注（容忍 INVALID_ARG 即败等零转录场景）。
- 归档点（session.ts `archiveChild`）在写入 `detail` 的同一次 map 中一并写入 meta，零额外遍历。
- 展开状态：`Set<number>`（按行 seq），存放于 `RetainedUiState`（ui-state.ts），跨 resize 重挂保留、随会话生命周期存在；不进 journal、/resume 后为空集（默认全折叠）。

## 5. 键盘分发与渲染管线落点

- App.tsx `useInput`：在既有分支（approval / plan / selector / Tab / Ctrl+O / 输入历史）之后、普通字符输入之前插入浏览模式分支；浏览模式为 App 本地 state（`browseMode: boolean` + `browseCursor: number`），光标经 ref 持有防闭包滞后（对标 AskQuestion/审批卡先例）。
- MessageList/Transcript 渲染：把展开集合与浏览高亮下传 ToolRow；高亮行仅在浏览模式激活时呈现。
- 浏览模式激活时输入框照常渲染但按键不落入（模式独占），状态栏或模式行给一行提示（`t()` 双语外观文案，如 "subagent browse · ↑↓ move · Enter toggle · Esc exit"）。

## 6. 错误与边界

- 无 SPAWN 行按 Ctrl+B：no-op（可选择性给一条 dim 提示，取「静默 no-op」为缺省，避免噪音）。
- SPAWN 行被 /new 清空：展开集合与光标随消息清空一并失效（以 seq 存在性校验，残留 seq 无对应行即忽略）。
- 极长转录：展开态全量重放属用户显式动作，接受长输出；不做内部窗口截断（与 Tab 展开同口径）。
- 并发多个子代理：每条 SPAWN 调用行独立条目，天然逐行。

## 7. 测试与验收矩阵

| # | 断言 |
|---|------|
| A1 | 折叠态：`● [SPAWN] name（N steps · Xs）` 单行，无转录行；meta 缺失时无尾注 |
| A2 | Enter 切换：展开态头行 `▾`、转录逐行缩进重放与 detail 一致；再按折叠复原 |
| A3 | Ctrl+B 无 SPAWN 行 no-op；有 SPAWN 行进入浏览模式且 Esc 退出后按键回输入态 |
| A4 | ↑/↓ 高亮移动边界钳制（首行再 ↑ 不动、尾行再 ↓ 不动） |
| A5 | 展开状态跨 resize 重挂保留（RetainedUiState）；/new 后失效 |
| A6 | 运行中 Ctrl+B 不进入（与 Tab 同门槛） |
| A7 | Tab 全场展开与 Ctrl+B 局部展开互不破坏（Tab 展开时局部态仍成立；回归既有 ToolRow.spawn / transcript-view 用例零误伤） |
| A8 | journal 无新事件类型、重放后展开态为空集 |

门禁：tsc strict 零报错、相关定向套件（ToolRow.spawn / App / session / ui-state / transcript-view）全绿、全量测试 fail 0、`pnpm selfcheck` OK。

## 8. 落点表

| 改动 | 文件 |
|------|------|
| 两态渲染 + meta 尾注 | src/tui/components/ToolRow.tsx |
| ChatItem.subagentMeta 登记 | src/tui/session.ts（含 archiveChild 写点） |
| 浏览模式键盘状态机 | src/tui/components/App.tsx |
| 展开集合/光标保留 | src/tui/ui-state.ts（RetainedUiState） |
| 浏览模式提示文案（t() 双语） | App.tsx（外观面） |
| 手册 | TUI-MANUAL.md 快捷键段 |
