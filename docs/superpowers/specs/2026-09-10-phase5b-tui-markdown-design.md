# 阶段五 5B · TUI 正文 Markdown 渲染与交互增强（对标 Codex / Claude Code）设计

> 日期：2026-09-10
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md §四界面元素表「正文｜模型答复（Markdown 渲染）」+CLAUDE.md §13 依赖台账 markdown-it/markdansi 行；代码 src/tui/markdown.ts、md-ansi.ts 在座；原状态行留档：「> 状态：设计待用户评审后转入 writing-plans」）
> 关联：`docs/superpowers/specs/2026-09-10-phase5a-tui-polish-design.md`（5A 精装）、`docs/superpowers/plans/2026-09-10-phase5a-tui-polish.md`、`docs/ROADMAP.md` 阶段五、`TUI-MANUAL.md`
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付 TUI 正文从裸文本升级为 Markdown 结构化渲染（标题/列表/代码块/表格/行内代码/引用/分割线，表格按 CJK 宽度对齐），并同批交付用户全选的七项交互增强：工具行增强（高亮+参数摘要+结果展开全文）、思考可展开/折叠、多行输入、历史命令与斜杠补全、状态栏增强（模型名+本轮耗时）、diff 块红绿。
- 关键取舍：Markdown 解析本件定案为自研轻量两级解析器（块级+行内纯函数、零新增依赖、可单测），不引 markdown-it 等库；现行渲染链已按后续 markdansi 批次演进（CLAUDE.md §13 台账承载）。
- 流式容错是本件验收核心：流式中途未闭合围栏/表格降级为普通段落不闪烁、未闭合行内标记按字面输出不吞字，done 定稿后权威重渲（权威来源仍是 done 载荷，与 5A 口径一致）。
- reactor 侧纯加法向后兼容：tool-result 事件增完整观察载荷（200 字符截断摘要语义不变）、思考折叠不再丢弃全文——二者共同支撑工具结果与思考的 Tab 展开全文。
- 键盘面以 `/` 前缀分流消解 Tab 键复用冲突：`/` 开头走命令补全、否则走展开切换；↑↓ 历史仅空闲态生效、多行态光标内不触发。
- 边界（YAGNI）：不升级 ink、不做 tokenizer 级语法高亮（仅 diff 红绿+可选轻量着色）、不做鼠标交互/主题配置/滚动视口（长会话由终端 scrollback 承担）。
- 验收：tsc strict 零报错+全量测试绿+selfcheck 保持流式冒烟口径+真实终端手工验收七项可视形态（既有 5A 用例全量保持通过）。

## 现行真值

MANUAL.md §四 基本用法（界面元素表：正文 Markdown 渲染、工具调用行/结果行、思考摘要 Tab 展开、状态栏）、MANUAL.md §八 快捷键（Tab/Ctrl+O 折叠展开）、CLAUDE.md §13 组件选型登记（TUI Markdown/markdansi/highlight.js 行）。
