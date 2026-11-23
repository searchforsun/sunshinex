# 会话 Rewind + Fork 设计规格（对标 CC /rewind · Codex 不可变分档）

> 日期：2026-09-20
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md §5.4 会话回退与分叉现行口径（对话/代码三选恢复、write/edit pre-image 影子快照 sessions/_blobs/、fork 血缘标注）+ src/tui/session.ts /rewind·/fork 分支与 session-snapshots.ts 在座；原状态行留档：「状态：设计定稿（七节呈现经用户批准；两项范围裁决用户拍板）」）
> 自审：2026-09-20 修正三处——分支点边界语义（锚点行不进新档、upToLine=锚点行号−1）、代码回退收集面（含当轮写入）、upToLine=1（仅 header 空档）合法化。
> 复审：2026-09-20 §6.2 收集面由「血缘上溯」修正为「单文件收集」——逐字节前缀复制下锚点前历史（含血缘祖先事件）已物理内含于当前档，无需上溯；祖先档分支点之后的事件属平行时间线，纳入将造成重复回退（正确性缺陷，非仅简化）。
> 前置：docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md（journal 基建）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付会话时间维双操作：/rewind 当前会话回退到任意任务轮（对话必选、代码可选，被回掉历史保留随时可回）与 /fork 从任意会话任意任务轮复制平行会话（含 /resume「Fork from…」入口）——对标 Claude Code /rewind 与 Codex fork/revert。
- 核心裁决=Codex 式不可变分档收编为单一原语：rewind 与 fork 底层同为「复制源前缀到锚点+新档记血缘+切活动指针」，原档永存、与 append-only 纪律一致、「回到被回掉的未来」免费获得；就地截断否决。
- 锚点=每任务轮恰一条的 user 事件，天然 checkpoint 不新增事件类型；schema 仅 additive 可选字段（血缘元数据+影子快照清单）版本号不升——旧档对新代码即普通会话档，v1 兼容零破坏。
- 代码回退=write 工具 pre-image 影子快照（CC 同口径）：只跟踪自家写入，exec 副作用/外部编辑/symlink 不跟踪、非 git 替代；回退收集面取单档案内每文件行号最早一条 pre-image，祖先档平行时间线事件不参与（复审修正，正确性缺陷级）。
- 锚点轮输入不进新档、改由输入框回填可编辑重发（对齐 CC 回填语义，防提示词重复）；分支点边界语义经自审修正三处（锚点行不进新档、代码回退含当轮写入、仅 header 空档合法化）。
- 验收：分档逐字节前缀复制+分档续写下一帧 prompt 与源档锚点时点逐字节一致（钉子断言）；对话/代码三态恢复、fork 血缘标注、v1 旧档兼容、错误边界（越界/前缀行损坏/blob 缺失）如实回执；全量门禁绿。

## 现行真值

现行 /rewind、/fork 行为见 MANUAL.md §5.4 会话回退与分叉（/rewind · /fork）；会话档目录口径见 MANUAL.md §三 目录与文件、CLAUDE.md §3 目录结构（session-journal/session-snapshots 落位）。
