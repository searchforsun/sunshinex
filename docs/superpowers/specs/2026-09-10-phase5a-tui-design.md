# 阶段五 5A · 交互式 TUI（对标 Claude Code）设计

> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：CLAUDE.md §3/§13「TUI…均已交付」+ MANUAL.md（CLI + TUI 全册现行真值）；src/tui/ ink+React 全量在座；原状态行留档：「> **状态：** 待评审（brainstorming 产出；用户已逐节确认四节设计）」）
> **上游：** docs/ROADMAP.md 阶段五 5A（TUI 优先交付）；对标 Claude Code 交互范式
> **范围裁定：** 5A/5B 拆分立项——本 spec 只覆盖 5A TUI 与共享底座契约，5B GUI 另立 spec（其依赖本 spec 定稿的 SessionEvents 与 asker 契约）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付交互式 TUI 作为与 CLI 并列的新入口（不改造既有 CLI 命令）：会话 REPL、流式输出、plan-mode、待办清单同步、权限审批终端化五条能力对标 ROADMAP 5A 全量落座。
- 渲染选型定案 Ink（React 组件化，Claude Code/Gemini CLI 同款）：流式渲染与 markdown/diff 生态开箱即用；否决原生 ANSI 自研（工作量数倍、长期维护最贵）与 blessed 系（维护停滞）；依赖登记用途边界=仅 TUI 渲染层，运行时零接触。
- 进程模型取同进程：事件共享内存、审批可 await，渲染消费事件队列不阻塞运行时；子进程 RPC 隔离留给 5B GUI 确有隔离需求再抽（YAGNI）。
- 交付 SessionEvents 事件面作为 GUI 公共地基：Reactor/Loop 只增可选事件注入，缺省零副作用、既有调用方零改动；事件只进队列不反向影响主链，异常路径发 error/done 收束。
- 权限审批终端化补齐阶段一留白：manual 模式经 asker 注入走终端审批模态；always 为会话级内存登记不落盘、会话结束即失效；无 asker 降级语义零变化，dontAsk 不走 asker（免审批≠免策略）。
- 架构分层纪律：渲染组件层纯展示不含业务逻辑，会话状态机不依赖渲染层可独立单测，运行时不感知 TUI 存在（唯一侵入面=可选事件注入+asker）。
- 验收：TUI 会话内完成一次含计划确认、审批与修正环的真实任务，流式可视、待办同步；selfcheck 增 tui 行 headless 走通一次含事件流的任务。

## 现行真值

现行 TUI 能力与命令面见 MANUAL.md（§四 基本用法命令总表、§八 快捷键）；构建选型与分层纪律现行真值见 CLAUDE.md §3 目录结构（src/tui/ 落位）、§13 交互面构建规范。
