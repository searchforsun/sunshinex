# 记忆调度优化与 learned 技能语义提炼设计规格

> 背景：用户三问（auto memory 与 learned skills 的提示词是什么 / 是否对标明星产品 / 调度时机是否需要空闲与周期触发）+ 两轮裁决（①调度方案 A=队列+空闲消化+空闲兜底节拍，钉死「后台提取不得阻塞用户」；②learned 用语义提示词提取而非 goal 写死，钉死「对标 Hermes」；③补 CC 记忆提取时机对标调研）。
> 2026-09-19 第三轮修订：用户裁决「运行中由大模型自动触发为主，后台任务兜底和优化；原子工具规范改『只保留原始工具的规范』，核心 harness 能力可定义专属工具、效果优先」——in-band 自主写入由「登记方向」收编为主通道（`memory_write` 工具 §3.7），后台队列降级为兜底与优化面（D5）。
> 对标实证：Hermes 官方文档 Skills System / Curator / Heartbeat 页 + GitHub 仓库；Claude Code 官方文档 Memory 页（2026-09-19）。
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：活文档 MANUAL.md:158-159「memoryIdleKickMs 后台沉淀空闲兜底节拍 / stepDigestMaxSteps 后台提取材料预算」、CLAUDE.md §132 内置工具清单含 memory_write、ROADMAP §50/§93 [x] 记忆双轨与「语义化提炼 lessons-not-logs」，代码在座——src/harness/memory/pipeline.ts（队列/kick/drain）、src/harness/skills/learned-extract.ts（语义提炼）、src/harness/memory/guards.ts（闸门单点）、tools/builtin.ts 注册 memory_write；注记：§3.8 curator-lite 未随批落地（src/ 无 curation 面），learned 库空闲整理未实现；原无状态行）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付记忆沉淀双通道：运行中模型经 `memory_write` 自主写入为主通道（2026-09-19 用户修订收编），任务收口后台队列为兜底与优化面——钉死「后台提取不得阻塞用户」：收口零等待入队、单 worker 串行消费、TUI 空闲 kick+空闲兜底节拍（空队列零调用）、CLI 命令收尾 drain。
- learned 技能语义提炼对标 Hermes「lessons, not logs」：素材=goal+reply+步骤摘要 digest，产出含 When to Use/Procedure/Pitfalls/Verification 语义小节；判无可复用教训不落盘（宁少勿滥）、技术失败回退确定性写盘（沉淀永不因故障丢失）；失败/中止任务也入队、由提炼器自判有无可复用教训（覆盖「被纠正」路径）。
- 记忆提取面吸收 Claude Code 三点：保守条款（提取为零也合法）、索引 near-limit 提醒档、素材面与跳过项维持既批口径。
- 原子工具规范改写随本件落地：原始操作面复用既有原子工具、核心 harness 能力可为模型定义专属工具（memory_write 经安全链登记直达 store、不绕过既有质量闸门）——现行口径由 CLAUDE.md §5 承载。
- 旁路纪律：pipeline 异常全吞降级，任务收口与命令退出永不因记忆/提炼失败而失败；后台模型调用不进主链、不进前缀缓存统计；双写由 store 归一去重收敛。
- 登记未落地：curator-lite（learned 库空闲整理，相似合并/description 改写）设计在座但未随批实现；skill_write 专属工具、usage 统计、write_approval、绝对周期定时器登记不做。
- 验收 18 条：收口零等待、无模型回退逐字节一致、串行消费、提炼四小节与截断、worth:false 零落盘、空闲 kick 与兜底节拍、memory_write 过五重闸门与幂等、前缀回归绿。

## 现行真值

MANUAL.md §二 配置（memoryIdleKickMs / stepDigestMaxSteps 字段行）、MANUAL.md §四 会话命令表 /memory 族命令、CLAUDE.md §3 目录结构（harness/memory/ 与 harness/skills/learned-extract.ts 落位）、CLAUDE.md §5 主链工具面（memory_write 在册）。
