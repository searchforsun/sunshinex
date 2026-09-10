# 阶段五 5B · TUI 正文 Markdown 渲染与交互增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 5A 精装基础上，把 TUI 正文从「裸文本」提升为结构化 Markdown 排版（标题/列表/代码块/表格/行内代码/引用/分割线），并补齐六项交互增强：工具行高亮 + 结果展开、思考可展开、多行输入、历史命令 + 斜杠补全、状态栏模型名 + 耗时、diff 红绿。

**Architecture:** 渲染层新增两级 Markdown 解析（块级状态机 + 行内扫描，纯函数零依赖），`MarkdownText` 组件把 IR 映射为 Ink JSX；运行时仅一处纯加法——`tool-result` 事件 payload 增 `full`（完整 observation，`text` 仍 200 截断）；`SessionController` 增 `ChatItem.detail` 通道（思考全文/工具结果全文）；App 单一 `useInput` 扩展键盘（Shift+Enter 多行 / ↑↓ 历史 / Tab 补全与展开分流）。

**Tech Stack:** TypeScript strict（CommonJS，`jsx: react-jsx`）、Node.js ≥ 22.9、ink@^3.2.0（React 18，`Text` 支持 bold/italic/strikethrough/inverse/backgroundColor/wrap，`Box` 无 backgroundColor）、node:test + node:assert/strict、既有 `src/tui/test-ink.ts` 渲染替身（零新增依赖）。

**上游 spec:** `docs/superpowers/specs/2026-09-10-phase5b-tui-markdown-design.md`（用户已确认 reactor 加 `full` 载荷）

## Global Constraints

- tsconfig strict 开启；CommonJS + `moduleResolution: Node`；`rootDir: src`；禁无理由 any。
- 不新增任何 npm 依赖；不升级 ink（锁 `ink@^3.2.0` CJS 线）。
- 运行时仅一处纯加法：`tool-result` payload 增 `full`，`text` 语义不变；其余协议字段、工具链、权限链、路由、`run`/`pipeline` 输出零改动。
- TUI 局部类型留在 `src/tui/session.ts`；Markdown IR 类型留在 `src/tui/markdown.ts`（非共享，不进 `src/types.ts`）。
- 消息终稿权威性：流式提取/渲染只服务观感，`assistant` 消息一律取 `done` 载荷。
- 渲染职责归口渲染层：前缀与着色由组件补齐，归约层消息文本只存原始正文；`detail` 仅存「可展开原文」，不参与折叠行的默认渲染。
- 全量基线 = 当前用例数（5A 收口后 328+，随本计划逐任务递增）；每任务红 → 绿 → 全量回归 → 独立 commit（`type(scope): 中文描述`）。
- 测试统一「先经控制器驱动至终态再渲染，断言首帧全量映射」；ink3 增量刷帧不可依赖；test-ink 剥除 ANSI 色码，颜色断言只对纯函数返回的结构做（不依赖渲染帧颜色）。
- 只写 `/workspace/wt-*`，禁止写 `/skills`；工作目录 `/workspace/wt-59f36a81fc`。

---

### Task 1: Markdown 解析器纯函数（块级 + 行内 + 表格对齐）

**Files:**
- Create: `src/tui/markdown.ts`
- Test: `src/tui/markdown.test.ts`

**Interfaces:**
- Consumes: `displayWidth`（`src/tui/text-band.ts`，Task 4 已建）。
- Produces:
  - `export type MdInline = { kind: 'text'; text: string } | { kind: 'bold'; children: MdInline[] } | { kind: 'italic'; children: MdInline[] } | { kind: 'code'; text: string } | { kind: 'strike'; children: MdInline[] }`
  - `export type MdBlock = { type: 'heading'; level: 1|2|3|4|5|6; inlines: MdInline[] } | { type: 'paragraph'; inlines: MdInline[] } | { type: 'fence'; lang: string; code: string } | { type: 'list'; ordered: boolean; items: MdInline[][] } | { type: 'quote'; inlines: MdInline[] } | { type: 'table'; headers: MdInline[][]; rows: MdInline[][][] } | { type: 'hr' }`
  - `export function parseMarkdown(text: string): MdBlock[]`
  - `export function inlineText(inlines: MdInline[]): string`（行内 → 纯文本，表格对齐与降级用）
  - `export function alignTable(headers: string[], rows: string[][], columns: number): string[]`（返回补齐行：表头 + 分隔线 + 数据行）

**解析规则（权威口径）:**

- 块级（按行切分，`\n`）：
  - ` ``` ` 或 ` ```lang ` 开行 → 进入围栏态，收集到下一个 ` ``` ` 闭栏为 `fence`（`lang` 取开栏围栏后文本，缺省 `''`）；**到文本末尾仍未闭栏** → 把已收集行（含开栏行）降级为 `paragraph`（流式容错）。
  - `#{1,6} ` 前缀 → `heading`（level = `#` 数，≥6 归 6）。
  - `- ` / `* ` / `+ ` 前缀 → `list ordered:false`；`\d+[.、] ` 前缀 → `list ordered:true`；相邻同型列表行合并为一个 block，每行一个 item。
  - `> ` 前缀 → `quote`，相邻行合并为一个 block（每行去掉 `> ` 后拼 `\n`）。
  - `|` 开头的相邻行，且第二行是「仅含 `-`/`:`/`|`/空格 的分隔行」→ `table`；分隔行用于判定（渲染时丢弃），单元格按 `|` 分割去首尾空单元。
  - `---` / `***` / `___` 独立行（仅含该字符与空格）→ `hr`。
  - 空行 → 分隔块（吞掉）。
  - 其余 → `paragraph`（连续非空普通行合并，行间以 `\n` 连接）。
- 行内（作用于 heading / paragraph / quote / list item / 表格单元格）：扫描优先级 `**`/`__`（bold）→ `~~`（strike）→ `` ` ``（code）→ `*`/`_`（italic）；**任何未闭合标记按字面原样输出**（不吞字）。code 内不再嵌套解析。

**alignTable 规则:** 每列宽度 = 该列所有单元格 `displayWidth` 的最大值；单元格超 `columns` 按剩余列均分截断（保留首尾可读，超出以 `…` 标尾）；列数 × 最小宽（2）> `columns` 时返回空数组（渲染层据此降级为逐行文本）。每行以 `| ` 连接列、列间 ` | ` 分隔；表头与数据行间插一行 `|---|` 分隔线。

- [ ] **Step 1: 写失败测试**（`src/tui/markdown.test.ts`）

覆盖：标题各级别；无序/有序列表合并与 item 切分；围栏代码块含 lang；未闭合围栏降级 paragraph；引用合并；表格解析（headers/rows 形状）+ 分隔行不落数据；hr；行内 bold/italic/code/strike 嵌套与未闭合回退；`inlineText` 递归拼纯文本；`alignTable` CJK 对齐、截断、超宽返回空数组。

- [ ] **Step 2: 运行确认失败** —— `npm test 2>&1 | grep -E "markdown|Cannot find module" | tail -20`（模块不存在，编译失败）
- [ ] **Step 3: 实现 `markdown.ts`**（纯函数，零 IO；对齐逻辑复用 `text-band.displayWidth`）
- [ ] **Step 4: 运行确认通过** —— `npm test 2>&1 | grep -E "markdown|failures" | tail -20`
- [ ] **Step 5: 全量回归 + Commit** —— `npm test 2>&1 | tail -8`、`npm run build 2>&1 | tail -5`

```bash
git add src/tui/markdown.ts src/tui/markdown.test.ts
git commit -m "feat(tui): Markdown 解析器纯函数（块级/行内/表格对齐）"
```

---

### Task 2: MarkdownText 渲染组件 + MessageList 接入

**Files:**
- Create: `src/tui/components/MarkdownText.tsx`
- Modify: `src/tui/components/MessageList.tsx`（assistant 行 + live reply 草稿）
- Test: `src/tui/components/MarkdownText.visual.test.tsx`

**Interfaces:**
- Consumes: `MdBlock`/`parseMarkdown`/`inlineText`/`alignTable`（Task 1）、`bandLines`（text-band）。
- Produces: `export function MarkdownText({ text, columns }: { text: string; columns: number }): JSX.Element`

**渲染映射（权威口径）:**

| 块 | JSX | 样式 |
| --- | --- | --- |
| heading | 行内序列 | level 1/2 加粗 + 黄色；3/4 加粗；5/6 加粗 + 暗灰 |
| paragraph | 行内序列 | 默认前景 |
| fence | `Text` 逐行 `backgroundColor`（色带）+ 首行 dim 语言标签（lang 非空时） | 代码行 dimColor 前景 |
| list | 无序 `• `、有序 `n. `（1..N 连续重排）+ 缩进 2 空格 | 默认 |
| quote | 每行前缀 `│ ` + 缩进 | 暗青 |
| table | `alignTable` 非空则逐行输出（表头加粗），空则降级为逐行原始文本 | 表头加粗 |
| hr | 单行 `─` 铺满 `columns` | 暗灰 |

行内 → JSX：`bold`→`<Text bold>`、`italic`→`<Text italic>`、`strike`→`<Text strikethrough>`、`code`→`<Text backgroundColor>`（反色底）、`text`→裸文本。行内节点经 `inlineText` 取纯文本用于宽度计算；代码块色带用 `bandLines` 同款补空格思路（Text backgroundColor 整行铺色）。

**接入点:** `MessageList.tsx` 中 `assistant` 行与 `LiveArea` 的 `reply` 分支由 `<Text>{text}</Text>` 改为 `<MarkdownText text={...} columns={columns} />`（`LiveArea` 需把 `columns` 透传进去）。

- [ ] **Step 1: 写失败测试**（`MarkdownText.visual.test.tsx`，经 test-ink 渲染）：喂 `# 标题`、`- a\n- b`、` ```js\ncode\n``` `、`| 环境 | 副本 |\n| --- | --- |\n| 生产 | 3 |`、`**加粗**` 等，断言帧文本**不含** `#`/`- `/````/`**` 等符号、**含**正文内容（标题文字、列表项、代码正文、单元格文本）；`columns` 传 100。
- [ ] **Step 2: 运行确认失败** —— `npm test 2>&1 | grep -E "MarkdownText|Cannot find module" | tail -20`
- [ ] **Step 3: 实现 `MarkdownText.tsx` + 改 `MessageList.tsx`**
- [ ] **Step 4: 运行确认通过** —— `npm test 2>&1 | grep -E "MarkdownText|failures" | tail -20`
- [ ] **Step 5: 全量回归 + Commit**（既有 App.visual 断言「助手裸文本」仍过：裸文本是 Markdown 子集，`ok`/`done-reply` 等无符号文案照常输出）

```bash
git add src/tui/components/MarkdownText.tsx src/tui/components/MessageList.tsx src/tui/components/MarkdownText.visual.test.tsx
git commit -m "feat(tui): MarkdownText 渲染组件 + 消息区正文结构化排版"
```

---

### Task 3: reactor tool-result 增 full 载荷

**Files:**
- Modify: `src/harness/reactor.ts`（第 133 行）
- Test: `src/harness/reactor.events.test.ts`（追加）

**Interfaces:**
- Consumes: `this.emit('tool-result', text, payload)`。
- Produces: `tool-result` payload 由 `{ ok }` 扩为 `{ ok: boolean; full: string }`，`full` = 完整 `observation`，`text` 仍 `observation.slice(0, 200)`。

- [ ] **Step 1: 写失败测试**（追加用例：脚本适配器触发一次工具执行，断言 `tool-result` 事件的 `payload.full` 为完整 observation、`text.length <= 200`）
- [ ] **Step 2: 运行确认失败** —— 断言 `payload.full` 未定义
- [ ] **Step 3: 实现** —— `this.emit('tool-result', observation.slice(0, 200), { ok: r.ok, full: observation });`
- [ ] **Step 4: 运行确认通过** —— `npm test 2>&1 | grep -E "reactor.events|failures" | tail -20`
- [ ] **Step 5: 全量回归 + Commit**

```bash
git add src/harness/reactor.ts src/harness/reactor.events.test.ts
git commit -m "feat(tui): tool-result 事件增 full 载荷（完整 observation 供结果展开）"
```

---

### Task 4: 会话归约 detail 通道（思考全文保留 + 工具结果全文）

**Files:**
- Modify: `src/tui/session.ts`（`ChatItem` 增 `detail`、`closeLive` 保留思考全文、`tool-result` 归约 `detail`）
- Test: `src/tui/session.detail.test.ts`

**Interfaces:**
- Consumes: `ReplyStreamExtractor`、`toolCallLine`、`SessionEvent`（Task 3 扩后的 payload）。
- Produces: `ChatItem` 增 `detail?: string`；thinking 折叠行 `text = 'Thought for Ns'` 且 `detail = 思考全文`；tool result 行 `detail = payload.full`（无 `full` 时不设）。

- [ ] **Step 1: 写失败测试**（`session.detail.test.ts`）：用 `HookAdapter` 注入 reasoning 增量 + 脚本工具结果，驱动至终态，断言 `thinking` 消息 `detail` 含思考原文、`tool` result 消息 `detail` 为完整 observation；`text` 仍为折叠/摘要形态。
- [ ] **Step 2: 运行确认失败** —— `detail` 字段缺失（TS 编译失败）
- [ ] **Step 3: 实现** —— `ChatItem` 增 `detail?: string`；`pushMsg` 的 `extra` 扩为 `Partial<Pick<ChatItem, 'kind' | 'ok' | 'detail'>>`；`closeLive` 的 thinking 分支改 `pushMsg('thinking', 'Thought for Ns', { detail: live.text })`；`onEvent` 的 `tool-result` 分支改 `pushMsg('tool', e.text ?? '', { kind: 'result', ok: ..., detail: typeof payload.full === 'string' ? payload.full : undefined })`。
- [ ] **Step 4: 运行确认通过** —— `npm test 2>&1 | grep -E "session.detail|failures" | tail -20`
- [ ] **Step 5: 全量回归 + Commit**

```bash
git add src/tui/session.ts src/tui/session.detail.test.ts
git commit -m "feat(tui): 会话归约 detail 通道（思考/工具结果可展开原文）"
```

---

### Task 5: 工具行增强 + 思考/结果 Tab 展开

**Files:**
- Modify: `src/tui/components/ToolRow.tsx`（工具名高亮 + 结果展开）
- Modify: `src/tui/components/MessageList.tsx`（thinking/result 展开态渲染；透传 `expandAll`）
- Modify: `src/tui/components/App.tsx`（`expandAll` 状态 + Tab 切换）
- Test: `src/tui/components/App.expand.test.tsx`

**Interfaces:**
- Consumes: `ChatItem`（含 `detail`，Task 4）、`toolCallLine` 产物文本。
- Produces: `ToolRow({ item, expandAll })`；`MessageList({ messages, live, columns, expandAll })`；App 内 `expandAll: boolean` 状态，idle/error 态 `key.tab` 切换。

**工具行渲染规则:**

- 调用行：`⏺ [VERB] target`——`item.text` 按**首个空格**拆 `VERB` 与 `target`，`VERB` 加方括号并高亮（cyan bold），`target` 暗灰。
- 结果行：`⎿ ✓/✗ 摘要`；`expandAll && detail` 时，`detail` 全文按行展开（dim 前景）渲染在摘要下方（缩进 4 空格）；折叠态且 `detail` 存在时行尾追加 ` [Tab 展开]` 提示。

**思考行渲染:** `thinking` 折叠行 `✻ Thought for Ns`；`expandAll && detail` 时在折叠行下方追加思考全文（dim italic）。

**Tab 分流（权威口径）:** App 的 `useInput` 中，`key.tab` 且 buffer 以 `/` 开头 → 斜杠补全（Task 6）；否则 `key.tab` 在 idle/error 态切换 `expandAll`。两者互斥（`/` 前缀优先）。

- [ ] **Step 1: 写失败测试**（`App.expand.test.tsx`）：驱动控制器至终态（含 reasoning 与工具结果），渲染后断言折叠态含 `[Tab 展开]`；`write('\t')` 后断言展开态含思考/结果全文；再 `write('\t')` 折叠。
- [ ] **Step 2: 运行确认失败** —— 无 `[Tab 展开]`、无 `expandAll` 交互
- [ ] **Step 3: 实现** —— ToolRow/MessageList/App 三处；MessageList 的 `LiveArea` 不参与展开（实时区仍原样）。
- [ ] **Step 4: 运行确认通过** —— `npm test 2>&1 | grep -E "App.expand|failures" | tail -20`
- [ ] **Step 5: 全量回归 + Commit**

```bash
git add src/tui/components/ToolRow.tsx src/tui/components/MessageList.tsx src/tui/components/App.tsx src/tui/components/App.expand.test.tsx
git commit -m "feat(tui): 工具行高亮 + 思考/结果 Tab 展开"
```

---

### Task 6: 输入增强（多行 Shift+Enter / 历史 ↑↓ / 斜杠补全）

**Files:**
- Modify: `src/tui/components/App.tsx`（单一 useInput 扩展 + history 状态 + `slashCandidates` 纯函数）
- Modify: `src/tui/components/InputBox.tsx`（多行 buffer 渲染）
- Test: `src/tui/components/App.input.test.tsx`

**Interfaces:**
- Produces: `export function slashCandidates(buffer: string): string[]`（`/` 前缀前缀匹配命令清单 `['/help','/new','/compact','/status','/plan']`，否则空数组）。

**键盘规则（权威口径，优先级从上到下）:**

1. `key.ctrl && input === 'c'` → 忽略（退出由 SIGINT 处理）。
2. `awaiting-approval` / `awaiting-plan` 分支 → 现有 y/a/n 逻辑不动。
3. `key.tab`：buffer 以 `/` 开头 → 循环补全 `slashCandidates` 至完整命令 + 尾空格；否则 idle/error 态 → 切换 `expandAll`（Task 5）。
4. `key.shift && key.return` → `setBuffer(b => b + '\n')`（多行，不提交）。
5. `key.return` → 提交（`trim` 后空则忽略）；提交成功时 push history（去重、去空、上限 100）。
6. `key.upArrow` / `key.downArrow`（idle/error 态，且 buffer 为空或单行）→ 历史导航（`histIdx` 游标，越界回空缓冲）。
7. `key.backspace` / `key.delete` → 删缓冲尾字符。
8. 其余可打印字符追加。

**InputBox 多行:** buffer 含 `\n` 时按行渲染（`Box flexDirection="column"`，每行 `❯ ` 仅首行、后续行补 2 空格缩进）；`▊` 光标仅 idle/error 态显示在末行。

> 注：ink3 `useInput` 的 `key` 是否可靠携带 `shift`/`tab`/`upArrow`/`downArrow` 以测试替身 `write()` 序列为准（Task 用 `\t`、`\u001b[A`/`\u001b[B` 探针固化；若 ink3 未透传 shift 组合，Shift+Enter 降级为「Tab 补全不受影响、多行改由 `\` 行尾续行」，并在本任务内如实回退）。

- [ ] **Step 1: 写失败测试**（`App.input.test.tsx`）：`slashCandidates('/ne')` 纯函数断言；键盘 `write('/ne\t')` 补全为 `/new `；`write('a\u001b[A')` 历史回填；Shift+Enter 多行（探针确认 ink3 行为后固化）。
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** —— App 增 `history: string[]` / `histIdx: number` 状态与 `slashCandidates`；InputBox 多行。
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 全量回归 + Commit**

```bash
git add src/tui/components/App.tsx src/tui/components/InputBox.tsx src/tui/components/App.input.test.tsx
git commit -m "feat(tui): 输入增强（Shift+Enter 多行/↑↓ 历史/斜杠补全）"
```

---

### Task 7: 状态栏增强（模型名 + 本轮耗时）

**Files:**
- Modify: `src/tui/components/StatusBar.tsx`（props 增 `model`）
- Modify: `src/tui/components/App.tsx`（透传 `info.model`）
- Test: `src/tui/components/StatusBar.test.tsx`

**Interfaces:**
- Produces: `StatusBar({ metrics, status, todos, model })`；状态栏文本追加 `model`（`model ? ` · model ${model}` : ''`）与耗时（`turnStartedAt > 0` 时 ` · ${elapsed}s`，`elapsed = (Date.now() - turnStartedAt) / 1000` 保留 1 位小数）。

- [ ] **Step 1: 写失败测试**（`StatusBar.test.tsx`）：`model` 显示；`turnStartedAt>0` 显示耗时（用固定 `startedAt` 与 `Date.now` 差值可放宽断言为匹配 `\d+(\.\d+)?s`）；`turnStartedAt=0` 不显示耗时。
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** —— StatusBar + App 透传。
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 全量回归 + Commit**

```bash
git add src/tui/components/StatusBar.tsx src/tui/components/App.tsx src/tui/components/StatusBar.test.tsx
git commit -m "feat(tui): 状态栏增强（模型名 + 本轮耗时）"
```

---

### Task 8: diff 红绿 + 手册同步 + selfcheck 收口

**Files:**
- Modify: `src/tui/components/MarkdownText.tsx`（fence 的 diff 分支）
- Modify: `TUI-MANUAL.md`（界面布局/快捷键/故障排查同步）
- Test: `src/tui/components/MarkdownText.diff.test.tsx`（或并入 Task 2 测试）

**Interfaces:**
- Consumes: `MdBlock` fence 块（`lang === 'diff' || lang === 'patch'`）。
- Produces: diff fence 行首 `+` 绿 / `-` 红 / `@@` 青 / 其余（含 ` ` 上下文）暗灰；非 diff fence 维持 Task 2 渲染。

- [ ] **Step 1: 写失败测试**（diff fence 渲染：断言帧含 `+x`/`-y`/`@@` 文本，颜色由纯函数 `diffLineColor(line)` 结构断言，导出可测）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** —— 抽出 `export function diffLineColor(line: string): 'green' | 'red' | 'cyan' | 'gray'` 纯函数 + MarkdownText 应用；同步 TUI-MANUAL.md 第 2/7/9 节（正文 Markdown 排版、快捷键新增 Shift+Enter/↑↓/Tab、故障排查补 Markdown 降级说明）。
- [ ] **Step 4: 运行确认通过** —— `npm test 2>&1 | grep -E "diff|failures" | tail -20`
- [ ] **Step 5: 全量验收** —— `npm run build`、`npm test`、`npm run selfcheck` 三者全绿。
- [ ] **Step 6: Commit**

```bash
git add src/tui/components/MarkdownText.tsx src/tui/components/MarkdownText.diff.test.tsx TUI-MANUAL.md
git commit -m "feat(tui): diff 代码块红绿 + 手册同步 + 全量收口"
```

---

## Spec 覆盖对照（自审）

| spec 章节 | 落地任务 |
| --- | --- |
| §4.1 Markdown 渲染（解析器 + 组件） | Task 1 / 2 |
| §4.2 工具行增强（reactor full + ToolRow） | Task 3 / 5 |
| §4.3 思考可展开（detail 保留 + 展开态） | Task 4 / 5 |
| §4.4 输入增强（多行/历史/补全） | Task 6 |
| §4.5 状态栏增强 | Task 7 |
| §4.6 diff 红绿 | Task 8 |
| §6 错误与降级 | Task 1（未闭合降级）、Task 2（表格降级）、Task 8（手册） |
| §7 测试与验收 | 各 Task 测试 + Task 8 全量验收 |
| §8 边界与不做 | Global Constraints（零依赖/不改协议语义/不动 CLI） |
