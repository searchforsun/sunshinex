# 多 Agent 编排子系统设计规格(TaskBoard / Teammate / Executor 三维正交)

- **日期**:2026-10-04
- **状态**:已实施交付（2026-11-23 D83 批二状态回写核证：spec §13 P0–P3 落地记录齐备 + MANUAL.md §5.6 智能体团队现行口径；src/taskboard/（TaskBoard/Teammate/Executor）与 src/delegation/projection.ts 在座；原状态行留档：「- **状态**:设计定稿,待评审,未实施」）
- **来源**:六轮架构讨论收敛(现状分析 → 落地设计与取舍 → 正交性修正 → 持久化与恢复 → 外部执行体 → 上下文缓存)
- **关联**:`docs/ROADMAP.md`(阶段五 5A/5B)、`docs/Tech Architecture/01~04`、`docs/superpowers/specs/` 同级设计规格
- **对照系**:Claude Code Agent Teams(官方文档 + 第三方逆向:共享任务列表 + 文件 mailbox + 扁平 teammate)
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付多 Agent 编排子系统（P0–P3 全部落地）：任务（做什么）/角色（是什么）/执行体（在哪跑）三维正交解耦，既有 spawn 的「任务↔执行体 1:1 焊死」成为特例；P0 统一委派投影可见性 → P1 TaskBoard 核心 → P2 Teammate 长驻+外部执行体+L2 消息 → P3 GUI 看板，每阶段独立交付零大爆炸重写。
- 核心定调「不适合的是静态、不是 DAG」：编排重心从节点图移到任务列表，动态拓扑载体=任务列表+依赖而非可变图对象；GraphEngine 降级为「预填任务列表的模板宏」（调度器官移植进任务板、pipeline/selfcheck 零迁移），消灭两套平行编排断层。
- TaskBoard 核心：team 目录 event sourcing（事件流真相源+快照缓存）、lead 侧建任务/设依赖/指派/评审工具面（建任务限流、加边环检测 fail-fast）、harness 强制状态回写（回合结束自动推进，不依赖模型自觉——直接消除 Claude Code 官方承认的状态滞后坑）；上游 failed 下游标 blocked 等 lead 裁决、不自动 skip。
- 崩溃恢复硬验收：任务板/收件箱/执行体三层 kill -9 任意时刻恢复——任务从事件流、消息从位点、执行体从回合边界恢复，全部 journal/append-only 重放、无任何需人工修复的中间态，无完成记录的 claimed 任务保守回池；P1 以崩溃注入测试守门，P2 验收 3 个 teammate 消化 6+ 任务、预算帽触发优雅排队、外部执行体与内部无感同现，各阶段全量门禁+selfcheck 绿（各批提交哈希见原文 §13 落地记录可溯）。
- 执行体异构「协调与观察层统一、执行层异构」：internal-fork（subagent 保留、不进可重派任务池以保外部可替换性）/ internal-team（长驻 teammate）/ external-cli（claude code stream-json 适配器，黑盒降级）——外部进度经事件翻译进统一事件面，TUI/GUI/journal 对内外无感。
- 团队协作分层交付：L1 结构共享（推摘要+工具拉详情）必交付；L2 消息通道回合边界投递（非实时中断）、至少一次+注入幂等而非精确一次；L3 工件协调永久回避（worktree 隔离+lead 合并，不发明文件锁协议）。
- 缓存与交互裁定：三类执行体共用三层上下文形状+append-only 纪律（agent.md 装配期冻结、同层批量快照派发、压缩避活跃期、TTL 默认不心跳保活）；TUI 不做终端 DAG 图、做 Ctrl+T 任务视图，GUI 从依赖关系自动推导看板与 DAG。

## 现行真值

MANUAL.md §5.6 智能体团队与任务协作（任务清单/依赖/retryOf/团队工具与 Ctrl+T 看板）、MANUAL.md §5.3 子智能体（spawn 与 `executor: external-cli` 行）、CLAUDE.md §3 目录结构（src/taskboard/ 与 src/delegation/ 落位）、CLAUDE.md §5 主链工具面（智能体团队八件套）。
