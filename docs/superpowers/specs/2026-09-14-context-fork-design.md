# 上下文 fork 模型治理设计
- 日期：2026-09-14
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：CLAUDE.md §11「上下文模型：单一基座 + fork」以现行真值载明并径引本 spec＋src/harness/context/chain-ledger.ts 与 context/index.ts chainView/appendChain/trimChainFront 在座；原状态行留档：「- 状态：设计定稿（用户逐节确认）；实施计划待 writing-plans 产出」）
- 关联：CLAUDE.md §11（前缀缓存第一要义）；plan_cache_continuous_fix（5f85ac8 / f4cd5e2）；prefix_cache_audit（唯一击穿点：技能首帧注入前部）；92ab44a（ctx 水位 exact 口径）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付「单一基座 + fork」上下文模型：主链是唯一上下文基座，任何执行单元都是「基座 + 尾部追加」，跨任务/fork/并发帧间差异只允许出现在尾部；验收锚点=回归矩阵 1–6 逐条用例钉死（全量测试 + selfcheck 绿）。
- 主任务全量执行轨迹（含全部工具观察）在链上续接，废除 plan 步骤「前序只留结论行」的结构性裁剪（用户裁决对标 Claude Code），任务边界不再重算上下文。
- 三项关键裁决：记忆段逐帧注入退出提示词（settle/compaction 事件行改走链尾追加，跨会话沉淀仍走文件）；goal 槽取消、真实任务文本只以指令行存在链尾；fork 收窄为「需要隔离私有步骤」的单元（graph 节点/子 agent），TUI 主任务修正轮与 plan 步骤归主链追加。
- 技能首帧注入移尾，修复 prefix_cache_audit 唯一明确击穿点（出现/消失击穿面归零）；压缩是唯一合法整体重写点，压缩块与链永不双份。
- 关键取舍（否决备选登记）：链收敛单点持有（否决 TUI/graph/CLI 各持一份、靠纪律对齐的方案）；messages 数组形态重构被否决（前缀收益相同但需推翻整个协议面，非本轮瓶颈）。

## 现行真值

现行模型见 CLAUDE.md §11 前缀缓存（单一基座 + fork 上下文模型与核心不变量）、§3 目录结构（context/ 会话链与 fork 链件落位）。
