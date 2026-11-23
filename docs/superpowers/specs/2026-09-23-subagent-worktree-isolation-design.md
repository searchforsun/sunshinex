# 子代理 Worktree 隔离（程序化）设计规格

日期：2026-09-23 · 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md §5.3/§5.5 isolation: worktree 口径与 `agents add --isolation=worktree`；src/harness/subagent.ts 建树/settleSubagentTree + security/chain.ts withRoot 隔离判界在座；原状态行留档：「状态：已裁决待实施」） · 对标基线：Claude Code sub-agents `isolation: worktree`（含 v2.1.203+ 执行面强制口径）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付子代理程序化 Worktree 隔离：子代理经 spawn 入参或 agent.md frontmatter 声明即获得独立仓库副本，多子代理并行写码互不踩踏（对标 Claude Code sub-agents isolation 能力）。
- 核心立场「隔离是机制、模型面零接触」：建树/判界/收口全部由程序完成，子代理工具面恒无 worktree 工具（既有工具面收敛裁决不变、与本特性正交叠加）；声明优先级 spawn 入参 > frontmatter。
- 关键取舍「从当前 HEAD 分叉而非默认分支」：子任务基于父会话当前工作状态（含未提交成果），而非干净基线。
- 错误语义分级：非 git 仓/缺项目根静默降级为主工作区执行（隔离是增强非承诺，零链行零报错）；是仓但建树失败 fail-bounded 补丁行回链、父任务不炸；收口三出口统一——干净树自动删除含分支零痕迹，脏树保留并附路径供人接管检查。
- 执行面强制 fail-closed：隔离子链工作目录由程序锚定，命令文本三查（git 指针参数、环境赋值、cd 越树一律拒绝，不可验证即拒绝）；未声明隔离的链零介入、行为逐字节不变；主会话经 --worktree 启动时全部子代理天然在树内。

## 现行真值

MANUAL.md §5.5 Worktree 隔离（声明通道与树生命周期现行口径）、§5.3 子智能体（spawn 隔离声明）；CLAUDE.md §3 目录结构（src/harness/worktree.ts 单点模块现行落位）。
