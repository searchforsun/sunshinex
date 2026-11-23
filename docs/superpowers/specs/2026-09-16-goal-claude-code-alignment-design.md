# /goal 对齐 Claude Code 形态（条件自由化 · 三值裁决 · 错误分级）设计规格

- 日期：2026-09-16
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：活文档 MANUAL.md:375-376 现行真值「满足/未满足/不可满足三值自评、判据服务不可用自动重试 3 次后暂停、重跑 /goal 续走」+ ROADMAP §64 [x]「verdict 三值 met/not-yet/impossible、错误分级重试 ≤3 次」，代码在座——src/loop/nodes.ts verdict 三值与 fatal/recoverable 分级重试、src/loop/engine.ts:192 terminal 通道、src/types.ts:142/157 CriterionResult.verdict 与 NodeOutput.terminal；原状态行留档：「- 状态：方案 B（核心对齐）经会话内裁决批准（范围问卷通道超时按 fork/子代理两计划先例收束），待实施」）
- 关联：`2026-09-15-tui-goal-loop-entry-design.md`（/goal v1 薄入口与主链纪律）、`2026-09-14-context-fork-design.md`（会话链模型）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- /goal 对齐 Claude Code 三项核心语义（方案 B 核心对齐）：条件自由化——goal 无内嵌「验收标准：」段时整体作为单一隐式判据走模型裁决，废除「无验收标准即 fail 空转烧安全网」旧路径；三值裁决——met/not-yet/impossible，任一判据 impossible 立即终局 failed；判据错误分级——「调用失败」与「判定未通过」严格区分。
- 关键裁决：评估器复用既有 check 节点而非 CC 的 Stop-hook 外置形态（语义同构、零新机制）；impossible 与不可恢复错误走既有 failed+error 通道、可恢复重试耗尽走既有 paused 态——零新终态、零新拼装面、LoopRunResult 零新字段。
- 错误分级口径：认证/配额/模型不存在类 fatal 不重试直接 failed；超时/断连/过载/限流类 recoverable 重试 ≤3 次后 paused（复用既有暂停态，重跑 /goal 续走）；未知类别保守归 recoverable（宁暂停不误清除）。
- 覆盖边界：错误分级只对齐判据评估器，agent 工作模型失败维持 failed 现状（宁停不误）；既有内嵌多判据行为回归零变化；规则谓词保持二值不产生 verdict；改动全在 loop 层，CLI `run --goal="自由文本"` 同步受益。
- 拆线登记：goal 跨天持久化恢复拆独立特性线，本件只保证 goal 状态为纯可序列化数据、为将来恢复预留；后台 check-in 退避、/goal clear 跨轮清除等登记不做。
- 验收 8 条：自由文本 goal 无空转、内嵌判据回归不变、impossible 终局 iterations 远小于安全网上限、fatal/recoverable 分流正确、判据输出不可解析维持 fail-bounded、CLI 同语义、全量回归+selfcheck 绿+主链前缀稳定零影响。

## 现行真值

MANUAL.md §5.2 goal 验收修正环（三值自评、判据服务不可用重试 3 次后暂停、重跑 /goal 续走）、MANUAL.md §四 会话命令表 /goal 行、CLAUDE.md §3 目录结构（src/loop/ nodes.ts「/goal 判据」落位）。
