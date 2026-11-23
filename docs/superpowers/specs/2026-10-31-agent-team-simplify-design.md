# 智能体团队简化设计规格（Team / 五态任务机 / 停等重试 / 消息 / GUI）
- **日期**: 2026-10-31
- **状态**: 已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL-GUI.md 右栏「智能体团队」一队一卡/五态点色/划线/hover 停现行口径 + MANUAL.md §5.6 retryOf 重试链与五态符号；src/taskboard/model.ts 五态 LEGAL/teamId/retryOf 在座；原状态行留档：「- **状态**: 设计定稿，待用户审阅后进入 implementation plan」）
- **来源**: 任务板 GUI 与团队语义重构讨论（状态徽标 → 停钮 → 团队实体 → 流程简化）
- **路径裁定**: 方案 1——在现有 TaskBoard 上增加 Team 聚合层；**禁止兼容**（旧状态名、gate/审批、用户气泡队头、双读映射一律删除）
- **关联**: `docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md`（本规格对其状态机、gate、卡头聚合做破坏性收敛）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 智能体团队收敛为一条简单主链：建队（系统生成 teamId）→ 成员与任务绑队 → 五态生命周期 → 可停可等 → 失败/取消后新 id 重试挂 retryOf 重试链 → 成员互发消息进上下文 + 转录气泡。
- 五态任务机（pending/running/success/failed/cancelled）由代码门禁强制，非法迁移明确报错（含当前态与允许去向）；gate/审批/review 等旧形态无兼容全删除。
- 停止唯一入口：task_stop 覆盖 pending 与 running 一律 cancelled，GUI 停钮与模型同一条链、终态幂等；task_wait 见任一终态即收口。
- 重启自愈：装载时全部非终态一律 cancelled、禁止静默改回 pending 重跑——装载后不存在可被盲等的非终态任务。
- 重试无专用工具：create_task + retryOf 挂 DAG 重试边（不参与派发阻塞；依赖边仍须上游全 success），多次重试成链、每条指直接前驱。
- 成员消息同队互投：接收方执行前尾追进私有链（前缀缓存纪律），转录气泡带来源名可跳转；fork 子面禁止发送。

## 现行真值

现行口径见 MANUAL.md §5.6 智能体团队与任务协作（五态 / retryOf / 团队工具与消息）、MANUAL-GUI.md 右栏标签（智能体团队一队一卡与五态点色）。
