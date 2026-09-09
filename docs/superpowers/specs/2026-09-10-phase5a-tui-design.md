# 阶段五 5A · 交互式 TUI（对标 Claude Code）设计

> **状态：** 待评审（brainstorming 产出；用户已逐节确认四节设计）
> **上游：** docs/ROADMAP.md 阶段五 5A（TUI 优先交付）；对标 Claude Code 交互范式
> **范围裁定：** 5A/5B 拆分立项——本 spec 只覆盖 5A TUI 与共享底座契约，5B GUI 另立 spec（其依赖本 spec 定稿的 SessionEvents 与 asker 契约）

## 1. 背景与目标

- 现状：CLI 三命令（selfcheck/run/pipeline）无流式无交互；`manual` 权限模式的 ask 交互在阶段一明确留白（只读放行、写拒绝）；`completeStream` 三适配器已实现但无调用方。
- 目标（对齐 ROADMAP 5A 六条）：交互式会话 REPL、流式输出、plan-mode、待办清单同步、权限审批终端化、渲染选型定案。
- 定位：TUI 是与 CLI 并列的新入口（`sunshinex tui [dir]`），不改造既有 CLI 命令。

## 2. 技术选型（ROADMAP 要求评审定案）

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| **Ink（React 式组件化 TUI）** | **定案** | Claude Code / Gemini CLI 同款；流式渲染、markdown/diff/spinner 生态开箱即用；组件化契合「有机结合而非能力拼接」 |
| 原生 ANSI 自研 | 否 | 零依赖契合哲学，但流式渲染/终端兼容/markdown/diff 全部自研，工作量数倍且长期维护成本最高 |
| blessed 系 | 否 | 布局能力强但社区维护近乎停滞、API 陈旧 |

- 依赖登记（依赖政策）：`ink`、`react`（runtime）；`ink-testing-library`、`@types/react`（dev）。用途边界：仅 TUI 渲染层，运行时零接触。
- 进程模型：**同进程**——事件共享内存、审批可 `await`；子进程 RPC 隔离留待 5B GUI 确有隔离需求再抽（YAGNI）。渲染不阻塞运行时：渲染消费事件队列、运行时只 push 不等待。

## 3. 架构

```text
┌─ Ink 组件层（纯渲染：消息流/输入框/审批模态/待办面板/状态栏）
├─ SessionController（纯 TS 状态机：事件进 → 状态变更 → 渲染指令；命令解析；可独立单测）
└─ 运行时（Harness/Reactor 复用，不 fork 不旁路；唯一侵入面 = 可选 onEvent + asker）
```

- 分层纪律：组件层不含业务逻辑；SessionController 不依赖 Ink（纯逻辑，node:test 直测）；运行时不感知 TUI 存在。

### 3.1 SessionEvents 事件面（本阶段核心新增，GUI 公共地基）

事件统一类型 `SessionEvent`（可辨识联合）在 `src/types.ts` 登记（新增共享类型按规范入库）；「SessionEvents 事件面」指本节整组事件契约：

| 事件 | 载荷要点 | 来源 |
| --- | --- | --- |
| `token` | 文本增量 | `completeStream` 的 `onDelta`（Scripted/Stub 整段一次发） |
| `tool-call` / `tool-result` | 工具名/输入摘要/输出摘要 | Reactor 工具执行前后 |
| `step` | 步号、动作、观测摘要 | 循环每步 |
| `route` | `RouteDecision`（tier/reason） | 复用 P4R 观测面 |
| `approval-request` / `approval-resolved` | 请求与裁决 | asker 链路（3.2） |
| `done` | done 标志与最终 reply（可为空） | run 收尾唯一出口，正常/异常路径都发 |
| `error` | 失败原因 | 模型失败/异常路径（done 之前发出） |

- Reactor 与 Loop 各增**可选** `onEvent?: (e: SessionEvent) => void`（deps 注入）；缺省 `undefined` 零副作用，既有用例与调用方零改动。
- 事件只进队列不反向影响主链；异常路径（模型失败/maxSteps 耗尽）发 `error`/`done` 后收束。

### 3.2 权限审批终端化（阶段一留白的正式落点）

- `SecurityGuard` 增**可选** `asker?: (req: ApprovalRequest) => Promise<'allow' | 'always' | 'deny'>` 注入：manual 模式遇非白名单操作 → 发 `approval-request` → TUI 渲染模态 → await 用户选择回填 → gate 继续/拒绝。
- `always`：会话级 allow 规则登记（内存态），不落盘、不改用户配置；会话结束即失效。
- 无 asker 时行为与现状完全一致（降级语义零变化）；`dontAsk` 模式不走 asker（免审批 ≠ 免策略，硬底线仍先行）。

### 3.3 plan-mode 与待办同步

- plan-mode：任务下达后先经 Graph 规划节点产出执行计划 → TUI 呈现计划确认卡（确认/修改/放弃）→ 确认后按计划节点逐步执行；拒绝则回到输入态。
- 待办面板：数据源为计划节点状态，节点状态变化映射为事件驱动刷新（对应 ROADMAP「任务拆解与状态实时同步」）。

### 3.4 会话底座与命令面

- TUI 会话 = 同一 ContextManager 上连续多次 `reactor.run`：session/episodic 记忆/成本账本（`runs/<id>`）天然三面同源，满足 ROADMAP「三面数据互通」的 TUI 侧。
- 最小斜杠命令面：`/new`（新会话）/`/compact`（走 ContextManager 既有压缩）/`/status`（会话与账本摘要）/`/help`。首版不做命令扩展机制。

## 4. 测试与验收

- SessionController 纯逻辑单测：事件序列 → 状态断言、斜杠命令解析、审批状态机。
- ink-testing-library 组件测试：审批模态交互、待办面板渲染、流式文本块追加。
- asker 脚本应答（假交互）打通 guard→TUI→guard 全链路单测。
- selfcheck 增 `tui` 行：headless 走通一次含事件流的 scripted 任务。
- 验收（对齐 ROADMAP）：TUI 会话内完成一次含计划确认、审批与修正环的真实任务，流式可视、待办同步。

## 5. 边界与不做（本 spec）

- 5B GUI 全部条目（对话工作台、diff 对比、编排看板、托盘/全局快捷键/通知、多端同步面）。
- 子进程隔离与 IPC 协议（同进程已满足 5A；GUI 需要时另立）。
- markdown/diff 富渲染插件：首版纯文本 + 基本着色，富渲染首版交付后按需评估。
- 远程访问/多会话并行/多终端复用同一会话。

## 6. 风险与开放问题

| # | 风险/开放问题 | 对策 |
| --- | --- | --- |
| R1 | Ink 与 Node ≥22.9 / 终端兼容性 | 实施首任务先做连通性冒烟；失败回退：Renderer 接缝抽象，退原生 ANSI 最小面 |
| R2 | react+ink 依赖链体积 | 依赖政策登记用途边界（仅渲染层）；不引入状态管理库 |
| R3 | 流式 token 与 JSON 输出协议的交互 | token 事件仅作展示流；动作解析仍以完整输出为准（解析器零改动） |
| R4 | 审批阻塞主链（await 期间事件停摆） | 审批是显式用户交互，允许停摆；模态内可见已发生事件，超时不自动放行（宁停不误） |
