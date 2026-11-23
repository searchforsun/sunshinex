# GUI 产品面重构(Codex 面 → sunshinex 底层,G10)· 设计 spec

> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL-GUI.md 现行载明模型/计划模式 pill、排队条与归档会话页＋src/serve/daemon.ts GET /commands、/session/:id/model|tier|effort|mode、steer/cancel、rewind、fork 与 /memory/rm 端点在座（注释引 G10 spec §6/C1d）；原状态行留档：「原无状态行」）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付 GUI 产品面按 Codex 布局五区重构：侧栏扁平双区（Projects/Recents）、主对话区（思考链折叠行、工具行图标化、GitHub 标准 md+mermaid）、composer（「/」命令面板、模型/权限 pill、排队条）、设置页全功能重排行式控件化（枚举键下拉化、居中窄列）、全局去冗余（阴影/图标/文字收敛+hover 提示制）。
- 方法论纪律：从 Codex 产品面上层切入映射到 sunshinex 底层——每个 Codex 面元素必须落到真实底层，无底层能力的 UI 一律不做；sunshinex 独有能力以 Codex 视觉语言拓展。
- TUI 能力全量承载审计闭环：25 个斜杠命令+非命令能力（steer 队列显示与撤回、ask、审批、子代理、任务板）全部在 GUI 有 Codex 形态承载或显式 N/A（/terminal-setup 为 TUI 专属），无遗漏项。
- 底层防漂移纪律：命令面板清单复用 TUI 单点经 daemon 端点下发（防 gui/tui 双清单漂移，同源断言为唯一防漂移钉子）；命令适配层操作共享 runtime，禁止复制 TUI 会话逻辑。
- 用户四项裁定落定：composer 模型/权限 pill 运行中真切换（扩 daemon）、计划模式映射 /plan 流程（纠正初版「只读围栏」方案并弃用）、设置页全功能重排、TUI 已有能力一项不漏全部承载。
- 非目标显式：不做无底层导航项（Scheduled/Plugins/Explore）、不做文件上传、不译会话内容（双语仅 GUI chrome）、不改 TUI 本身。

## 现行真值

现行 GUI 产品面见 MANUAL-GUI.md（界面、右栏标签、设置三节为五区现行口径）；GUI 构建联调与测试门禁见 CLAUDE.md §2 常用命令、§13 交互面构建规范（GUI 风格铁律）。
