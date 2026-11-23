# 子 agent 执行单元（SubagentRunner + spawn 双入口）设计

- 日期：2026-09-14
- 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md §5.3「子智能体（spawn）」现行口径 + CLAUDE.md §3 subagent.ts 条目；src/harness/subagent.ts（SubagentRunner：fork 组装/回写/预算/并发护栏）与 spawn 工具面在座；原状态行留档：「- 状态：设计已评审定稿（六节呈现 + 调用语义修订经用户确认）」）
- 上游规格：`docs/superpowers/specs/2026-09-14-context-fork-design.md`（fork 语义 §5——本设计是其「子 agent」落地的专项设计）
- 上游计划：`docs/superpowers/plans/2026-09-14-context-fork.md`（Task 2 reactor 双作用域为本设计前置；Task 4 graph fork 化由本设计吸收）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- fork 执行单元基座单一权威：spawn 工具与 graph 角色节点双入口共用同一套「解析→fork 组装→执行→回写→护栏」逻辑，消灭双份拼装漂移（否决「薄调用方各自组装」备选）。
- 三定义形态同批交付：目录注册制（agents/{id}/agent.md，装配期一次性加载 fail-fast）+ 预设四角色 + 内联临时 prompt；agent_id 未命中报错，不静默回退。
- 执行边界缺省收窄：子代理工具面剔除 spawn（深度 1 层），显式 tools 可收窄或放开、含 spawn 即显式允许二层——每层都须显式，无静默递归。
- 调用语义 v1 恒同步 + 同轮批量并行：子代理终稿即该轮工具观察，零协议新增嵌入既有闭环；background 两段式仅登记预留语义（v1 报 NOT_SUPPORTED，禁静默降级），接口不封死后批开通。
- fork 私有性落地：私有步骤零主链污染，终态恰好一行结论/补丁行（子代理失败不炸父任务，父模型自行决策续跑/换路/重派）；fork 内压缩只折叠私有段不触主链基座，并发同层共享同一基线前缀。
- 关键取舍：预算 = 父剩余换算挂同一账本、不暴露预算入参（YAGNI）；同层并发上限 4、超限拒绝不排队；否决「子代理共享父 ContextManager 全量回写主链」（fork 私有性红线）与子代理独立模型档位协商（tier 继承父级）。

## 现行真值

现行子代理面见 CLAUDE.md §3 目录结构（harness/subagent.ts 与 .sunshinex/agents/ 注册目录落位）、MANUAL.md 5.3 子智能体（spawn）（运行形态、预算护栏与追加续跑现行口径）。
