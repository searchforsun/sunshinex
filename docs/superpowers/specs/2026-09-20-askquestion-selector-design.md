# AskQuestion 工具与 TUI 统一选择器交互设计（2026-09-20）

> 目标：①TUI 全部选择题交互统一为「上下选择 + 空格选定」的 OptionSelector 组件（对标 Claude Code）；②新增 harness 工具 `ask_question`（display: AskQuestion），让模型主动向用户出选择题，支持单选 / 多选（空格勾选）/ 自定义输入。
> 前缀缓存登记：工具清单 +1 = 一次全量前缀断点（§5 纪律内，本次新增经用户裁决）。
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md §五「AskQuestion 问询卡」（单选/多选/Other…/Esc）与 CLAUDE.md §5 内置工具清单 ask_question，src/tui/components/OptionSelector.tsx 与 src/harness/tools/builtin.ts ask_question 工厂在座；原状态行留档：「原无状态行」）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付 TUI 统一选择器：四个「选择题」交互面（权限确认卡、/plan 确认卡、/resume 会话列表、模型问询卡）统一为「上下选择 + 空格选定」同一组件形态（对标 Claude Code），原有单键快捷（y/n、数字直达）保留并存。
- 交付 ask_question 工具：模型主动向用户出选择题，支持单选 / 多选（勾选）/「Other…」自定义输入；问询类工具单发独占、不进并行批（交互阻塞型）。
- 关键取舍「独立问询类型」：复用审批挂起管线的形态但不复用审批语义（独立新类型，避免审批语义污染）；免审批——它本身就是问询通道（沿 spawn 免审批先例）。
- 观察回文本英文单语且语义自明：单选/多选/自定义/用户放弃各一形态；Esc 放弃时模型收到「已跳过」并据此调整策略而非重试同问。
- 边界语义：问询挂起期间暂停 deadline 计时（等用户作答不烧预算）、不消费后台队列；CLI 无交互终端回落为编号输入，完全 headless 按放弃处理——任务不因问询挂死。
- YAGNI 登记：单卡多问（questions 数组）、问询超时自动放弃、GUI 问询卡均后置。

## 现行真值

MANUAL.md §六 权限档与审批（AskQuestion 问询卡现行键位与回落口径）、CLAUDE.md §5 编码规范（内置工具清单 ask_question）、§3 目录结构（src/tui/components/ 统一选择器组件现行落位）。
