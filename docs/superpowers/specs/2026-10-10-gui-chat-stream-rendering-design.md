# GUI 会话流渲染升级(Codex 对标二轮) · 设计 spec

> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL-GUI.md 界面表现行口径（Worked 行展开、正文 markdown 即读即显、工具/思考行自动折叠）+ gui/src/pages/chat/ 的 RunEntryView·RunFooter·md-render.tsx 在座；原无状态行）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付 GUI 会话流渲染对标 Codex 二轮全面升级（五批 B1–B5 TDD 交付）：run 状态行（Working 计秒计 tokens → 完成后保留「Worked for Xs」历史行）、工具/思考行对齐与 Input/Output 展开、正文 Markdown 定靶排版、run 尾操作条（复制/分叉/步数/tokens/完成时间）、用户气泡行内编辑卡、全局动效收口。
- 用户裁定六条形态落地：状态行完成后保留为历史行（非仅运行中显示）、展开折叠与流式丝滑动效、正文结束后操作条、气泡编辑态（composer 同款浮卡、发送=新消息可取消——推翻 G9「Edit 钮不做」，无历史改写语义）、操作钮纯图标+统一 Tooltip、Markdown 面定靶收敛折行/层级/边线。
- 关键交互裁定：run 条目作会话流边界条目（idle→running 插入、done/error 封段回填步数/tokens/耗时）；编辑卡与 composer 共用同一条提交分流路径（空闲发送/运行中转向/计划态入规划）；工具结果全文仅内存暂存、不入 journal。
- Markdown 面：代码块禁止折行改横向内滚（此前强折行是排版错乱主因）、代码块语言标+复制钮、mermaid 放大 lightbox 与复制、表格横线斑马纹；高亮异常回落原文转义（注入面纪律不变）。
- 降级与复刻纪律：种子历史条不补 run 标记（快照形态不变、旧轮降级为摘要行展开）；run 元数据缺省逐项省略不渲染 undefined；👍👎/锚点钮不做（无回执端点，「无功能对应物不做」）。
- 验收：chat-reducer run 边界五例 + Chat 测试增补（状态行/展开面/代码块/表格/lightbox/操作条/编辑卡）+ 既有断言兼容（操作钮查询 title→aria-label 迁移为已知必改点）+ gui tsc/vitest 全绿 + 双主题手工过定靶表。

## 现行真值

MANUAL-GUI.md「界面」节·中栏·对话行（Worked 行展开、工具/思考行自动折叠、正文 markdown 即读即显）、MANUAL-GUI.md「快捷键」节、CLAUDE.md §13 交互面构建规范（GUI 组件选型登记与风格铁律）。
