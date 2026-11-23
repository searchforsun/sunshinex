# 四类资源存储与设置规范化设计（skills / MCP / plugins / agents）

- 日期：2026-10-28
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：docs/ROADMAP.md [x] 设置存储规范化 catalog、CLAUDE.md §3 catalog/ 结构化单点描述、src/catalog/ 全套模块（providers/agents/plugins/mcp/skills/approvals/permissions/watch/sunx）在座、MANUAL.md §四 /mcp /agents /plugins /providers 两级遮蔽面板现行真值；原状态行留档：「- 状态：设计定稿（待用户审阅 → 实现计划）」）
- 范围：src/catalog（新共享存储库）、src/config（settings/plugins 加载语义 + providers 规范化 + 散键退役）、src/config.ts（loadMcpServers 项目级复活）、src/harness/subagent.ts（agents 两级+enabled+兼容读）、src/model/catalog.ts（缺省内芯恒为 choices[0]）、src/serve（设置端点对称补齐 + WS config-changed 帧 + 文件监听）、src/cli（资源全套子命令 + settings get/set + providers）、src/tui（/mcp /agents /plugins /skills /providers 面板）、gui/src/settings（ScopeSwitcher/SearchBar/ResourceCard/EditorDrawer 共享组件 + 11 页统一卡片风格）
- 前置关系：插件体系（2026-10-26 设计已实施）提供 manifest/两级发现/安全契约；本设计不改动插件 manifest 规范，只恢复其开关的项目级生效、并把四类资源的存储、作用域、UI、CLI、TUI、实时同步统一到一套规范。
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付四类资源（skills / MCP / plugins / agents）存储与设置规范化：统一「项目遮蔽全局」作用域（同 id/同名视图标注遮蔽关系）——MCP 项目级文件复活加载、插件开关恢复项目级生效、agents 迁入 `.sunshinex/` 体系（旧位置一次性自动迁移后退役、不做兼容读），推翻 2026-10-27「应用级」裁定。
- 关键取舍「单文件惯例 + settings.json 元数据中枢」：mcp.json 每作用域一档（格式不变）、agent.md 增可选 enabled；否决「每类文件夹 + registry.json」（迁移面大、破坏 mcp.json 生态惯例）。
- 安全阀：项目级 MCP 首次启用需一次确认（防克隆仓库自带 mcp.json 自动拉起进程）；拒绝过的不再询问；全局条目免批准（用户亲手配置的机器级文件）。
- 交付双向实时同步：daemon 文件监听 + WS 广播 + 打开的设置页自动刷新，外部编辑/CLI 修改 ≤1s 反映；watch 不可用时降级现状语义（即读 + 写后自刷）不阻塞。
- 交付三端能力：CLI 全套 CRUD + settings get/set（--scope 缺省 project）、TUI 面板（启停 + 遮蔽标注，编辑引导 CLI/$EDITOR）、GUI 统一卡片风格（作用域切换器/搜索/编辑抽屉，11 页统一视觉）；skills 保持只读（无开关无增删改）。
- 模型与提供方规范化并入：providers 平级列表成为模型配置唯一事实源，全局级散键退役；默认模型恒为第一 provider × 第一 model（顺序即优先级、首位标默认），档位路由改按 models 条目 tier 标注。
- 代码架构取舍：新建共享存储库、各端薄封装消费同一合并逻辑（否决原地修补——作用域逻辑继续漂移，与全泛型资源引擎——对四类属过度设计）；写面守原子写与 JSONC 注释保护纪律。

## 现行真值

CLAUDE.md §3 目录结构（src/catalog/ 设置存储结构化单点现行落位）、§6 技能规范（多级根装载与两级遮蔽）；MANUAL.md §二 配置（结构化键两级遮蔽口径）、§四 基本用法（/mcp /agents /plugins /providers 面板）。
