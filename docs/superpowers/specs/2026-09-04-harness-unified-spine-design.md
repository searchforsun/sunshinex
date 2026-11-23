# 第二阶段设计：统一运行时主链（Harness 有机结合）

> 日期：2026-09-04
> 状态：已实施交付（子阶段 1A-1E 全部实施并端到端验收：1A f141544→0c46132、1B 7b81bc8→3fb250d、1C 93fe719→9384497、1D d0f0306→525b340、1E a54236e→bcfcd1f；真实场景验证 docs/superpowers/reports/2026-09-05-phase1-real-scenario-report.md，其发现项由安全收尾与 Phase 2 压缩预算闭环修复收口）
> 关联：docs/superpowers/specs/2026-09-03-phase1-harness-design.md、docs/ROADMAP.md
> 折叠（D83 批一，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付统一运行时主链总纲并经子阶段 1A-1E 全部落地：Context（统一上下文管线）、Loop（决策循环）、Tool（统一动作面）、Safety（统一安全链）、Memory（统一记忆生命周期）五环节按单一数据流串联，Memory 产出回流 Context 形成闭环。
- 设计哲学裁决「有机结合 vs 能力拼接」：不复制不拼接明星产品，拆到能力本质归入主链环节——Claude Code 的上下文来源归 Context、Codex 的算力路由归 Loop 内决策、Hermes 的记忆沉淀归 Memory，三者共通的权限/沙箱/脱敏收敛为同一条安全链。
- 无旁路验收 A1-A5 以「反例即不合格」可证伪落地：上下文唯一入口、动作唯一入口、安全唯一链、记忆唯一生命周期、路由内嵌 Loop。
- 收敛动作清除四类双轨：删内存 Map 版 memory.ts（消除两套记忆并存）、ModelRouter 收敛进 Reactor、read/write 等文件工具与 exec 同走安全链、context 各模块并入 assemble() 统一编排。
- 路线裁决：1A-1E 为 ROADMAP 阶段一内部子阶段（各走独立 spec→plan→实现循环），非独立全局阶段；1E 技能沉淀是阶段四技能系统生态化的前置，先后关系而非重复。

## 现行真值

CLAUDE.md §3 目录结构（harness 五环节现行落位）、§4 架构约定（graph→loop→harness 分层、错误通道分域、装配收敛 runtime.ts）、§11 前缀缓存（buildMessages 单点、上下文装配纪律）。
