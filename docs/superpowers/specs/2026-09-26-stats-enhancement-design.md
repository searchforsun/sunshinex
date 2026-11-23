# 子代理与主链任务统计增强设计

- 日期：2026-09-26
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：活文档 MANUAL.md:383「整段记录折叠进 ● [SPAWN] 调用行（单行摘要含步数/耗时尾注）」，代码在座——src/tui/session.ts:431「任务统计基线（规格 §3.2）」+ closeTask done 路径 formatTaskStatsLine 统计行（session.ts:843）、chat-model.ts sessionChildTokens/turnChildTokens 状态栏合并口径、child-panel.ts doneAt 冻结耗时；原状态行留档：「- 状态：设计已获用户确认（三项关键取舍均经用户裁决）」）
- 关联：`2026-09-26-child-inspector-view-design.md`（§3.1 子代理单行面板、§4 transcript 结构化）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 子代理完成统计留存（用户裁决①「归档行内补统计」）：面板 done 行补全步数/耗时/tokens，耗时冻结在完成时刻不随渲染跳动；归档后由 SPAWN 调用行 detail 尾追统计摘要行入历史区、/resume 可回放——真机反馈的 done 行瞬态蒸发问题消除。
- 主 agent 任务收尾统计（用户裁决②「dim 系统行·入档」）：任务正常完成时正文尾追统计行随 journal 入档；任务级基线差值口径对单轮与 plan 多步骤任务均正确；中断/error 路径不加噪声。
- 状态栏 token 口径合并（用户裁决③「合并为总数」）：↑tokens = 主链 + 子代理合计、仅 /new 归零；ctx 水位与 cache 命中率维持仅主链口径——子代理 tokens 不占主上下文窗口，子代理缓存命中率无法统一计算、裁决先不加。
- 硬约束守恒：历史区保持零重绘（统计行走「尾追入档」既有合法通道）、统计行双语外观面不进提示词与稳定段、零新增依赖、fork-safe。

## 现行真值

现行统计与回看口径见 MANUAL.md 5.3 子智能体（SPAWN 调用行折叠与展开）、八、快捷键（Ctrl+B 子智能体浏览模式）。
