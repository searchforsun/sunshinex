# 插件体系 + browser use / computer use 系统插件设计（工具结果图片通道前置）

- 日期：2026-10-26
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：活文档 CLAUDE.md §113/§124/§135 插件治理层与 manifest safety 三类问线、MANUAL.md §514-542 插件节（browser-use/computer-use 双内置、plugins list/validate、安装即信任）+ ROADMAP §151 [x] 引本规格，代码在座——plugins/ 内置 browser-use、computer-use、schema 三目录，src/config/plugins.ts 装载单点，src/cli/commands/plugins.ts CLI，docs/PLUGIN-DEV.md 开发指南；原状态行留档：「- 状态：已实施（2026-10-26，SDD 22 任务，T22 收口；两插件 defaultEnabled false 等）」）
- 范围：src/config（plugins 语义键）、src/harness（插件装配 + MCP 客户端图片提取 + guard 声明式安全消费）、src/types（ExecResult.images 等）、src/serve（设置端点）、gui（设置页插件 pane + 工具行图片渲染）、plugins/（新工作区目录：两个内置插件，其一含自建 MCP server）+ plugins/schema（manifest JSON Schema）+ plugins CLI（list/validate）+ docs/PLUGIN-DEV.md（插件开发指南）
- 前置关系：图片功能（2026-10-26 已交付）打通了**用户随行图片**全链（`src/images.ts` 单源 → `SteerLine/SessionEvent/HistoryStep.images` → `buildMessages` 多模态 user 行 → wire image_url 块）；本设计补全**工具观察图片回流**这半边（截屏能力的生命线），并以「插件」为治理层承载 browser use / computer use 两个能力。
- 业界调研锚点（2026-10-26 三路调研，详见会话记录）：浏览器自动化事实标准 = Playwright MCP（a11y snapshot+ref 主线，vision 兜底）；桌面自动化收敛动作面（screenshot/click/type/key/scroll/drag/wait）；结构优先、视觉兜底为工程共识；OpenAI 兼容协议 `role:"tool"` 消息无图片通道，业界标准变通 = 图片随合成 user 帧注入（与既有链行图片通道同形）；高危桌面动作业界共识 = 默认人工确认 + 能力默认关。
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付插件体系治理层 + browser-use / computer-use 两系统内置插件 + 工具结果图片通道前置（M0′，截屏能力的生命线）：两插件缺省关闭、显式 opt-in（规则无例外），computer use v1 Windows 先行（macOS/Linux 后置、manifest 声明即设置页置灰）。
- 关键裁决「插件=治理/分发层」：能力后端仍是进程外 MCP server，治理与执行分离（动作只从 Tool 面出、必经安全链、进程隔离天然）；「插件=进程内原生工具加载器」方案否决（隔离与安全链根基被绕开）；现有内置工具/mcp.json/技能三扩展机制语义不变，插件层只叠加统一治理。
- 框架交付面（先立框架、两插件即首批消费者，避免为具体插件硬编码开关与安全线）：manifest 规范化（manifestVersion 版本化锚、JSON Schema 单源固化随包分发）、`plugins list/validate` CLI（作者 lint 工具可进 CI）、docs/PLUGIN-DEV.md 开发指南、GUI 设置页插件 pane（启用开关/config 展示/告警徽标，生效=下次会话装配不热切换）。
- 声明式安全契约随框架落地：插件对贡献工具自声明风险类别、guard 按声明通用消费（内置无特权、未声明走通用 MCP 审批 fail-closed）；信任模型=安装第三方插件即信任其进程；现行三类问线口径由 CLAUDE.md §5 与 MANUAL.md §6.4 承载。
- 图片通道：MCP image content 收进工具结果全链回流、链行图片回填、wire 经合成 user 帧透出（业界标准形态）；历史图片渲染期剪枝只保留最近 N 行（journal 全量留档、回放审计完整），harness 层恒零转码。
- 兼容红线：用户 mcp.json/技能目录/内置工具三机制零变化、无 settings 迁移；插件未启用=工具不存在（非「注册后禁用」）；用户 mcp.json 恒遮蔽插件同名 server。
- 两插件形态与验收：browser-use 钉版 Playwright MCP（复用系统 Chrome、a11y snapshot 结构优先、持久 profile 登录态跨会话）；computer-use 自建零原生依赖 MCP server（Node+持久 PowerShell worker、UIA 结构化优先+截屏兜底、坐标缩放置账单点）；TDD 钉面覆盖 manifest 容错/两级遮蔽/启用态合并/名单合成/三类声明→guard 行为矩阵/图片通道链路/worker 协议与坐标反算/端点与 pane 契约，治理文档同步+selfcheck。

## 现行真值

MANUAL.md §6.4 插件（plugins）（双内置、装载根、启用禁用、安全与信任模型）、CLAUDE.md §3 目录结构（plugins/ 工作区根行）、CLAUDE.md §5 主链工具面（插件贡献工具条）、docs/PLUGIN-DEV.md（插件开发指南）。
