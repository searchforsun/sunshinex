# Codex 桌面端美学交互 1:1 复刻 · 设计 spec

> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：活文档 MANUAL-GUI.md §120 设置·通用外观组「主题 / 暗色气泡」现行真值，代码在座——gui/src/app.css §1 B1 令牌地基（--surface/--accent #339cff/--bubble-user、[data-theme='light'] 整块覆盖、color-scheme）与 app.css:743「G9-B3 会话流(spec §3)：用户右胶囊/日期分隔/流区限宽」（entry-user flex 尾对齐 + .user-bubble，EntryViews.tsx 装配）；原无状态行）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- GUI（gui/）视觉与交互语言对 Codex 桌面端 1:1 复刻，B1→B5 五批独立交付、随批截图对拍逐项闭合调研底稿差距表；全部数值以调研底稿（2026-10-08-codex-desktop-audit.md）为唯一来源、本文只定实现。
- 用户三裁决落地：accent 弃青、采纳 Codex 中性黑白 + #339cff 蓝仅 info/焦点/链接；用户消息改右对齐胶囊；B1 双主题一次到位（暗色缺省 + 亮色整块覆盖、缺省跟随系统、首 paint 前主题引导防 FOUC）。
- B1 令牌地基：app.css 头部重写为 Codex 双主题令牌（面/字/边/语义/形状/海拔/动效/尺度），全部规则改走 token 零写死色值（含 hljs 语法色双主题表）；单一 CSS 文件约束不变。
- 壳与会话流组件形态对齐：侧栏/组头/会话行统一胶囊行制（竖条制全废）、主面左上圆角分层去分割线；日期分隔纯函数、工具行/代码块/diff/审批卡浮面制零实线边、composer 贴底悬浮与 28px 圆形实心发送钮。
- 复刻纪律：信息架构以本项目既有功能为准、不为复刻造假入口——Scheduled/Plugins 等无功能导航项与无功能对应物（权限/模型 pill、用户消息 Edit 钮）不做，留待功能落地时按 Codex 形态补；TabStrip/Board/Files 等功能结构只换皮不动。
- 降级安全：corner-shape @supports 回落常规圆角、主题引导失败缺省暗色、剪贴板失败 tertiary 态提示，均不弹错不阻断。

## 现行真值

现行 GUI 外观口径见 MANUAL-GUI.md「设置」通用外观组（主题/暗色气泡/字体预设）与「界面」（中栏对话·用户气泡）、CLAUDE.md §13 交互面构建规范（GUI 对标 Codex 工作台质量基线）。
