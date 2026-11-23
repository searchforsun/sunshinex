# Worktree 隔离设计规格（对标 Claude Code worktree 三入口）

日期：2026-09-20
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：活文档 MANUAL.md:73「--worktree 在隔离 git worktree 内启动（裸旗标自动命名；干净树随会话自动清理，脏树保留待处置，见 5.5）」与 §270 数据目录 worktrees/、CLAUDE.md §97「worktree.ts # git worktree 单点模块」/§132 内置工具含 worktree、ROADMAP §113 [x] 本特性线，代码在座——src/harness/worktree.ts、src/cli/worktree-launch.ts 接 run-loop.ts 与 tui/entry.ts 双入口、src/harness/subagent.ts frontmatter isolation: worktree；原状态行留档：「状态：设计定稿（两项裁决经问卷用户拍板：入口范围=B 三入口全做；清理语义=A 干净自动删、有改动保留）」）
关联线：docs/superpowers/specs/2026-09-20-session-rewind-fork-design.md（正交，见 §4-D8）、2026-09-14-subagent-design.md（frontmatter 扩展见 §9）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 把 git worktree 作为文件系统级隔离基建引入（此前文件维度零隔离：并行子代理/多会话共享同一工作区目录是真实冲突源），三入口全做（问卷裁决）：`--worktree` 启动旗标（裸旗标自动命名）、会话内 `worktree` 工具（create/exit/list）、子代理 `isolation: worktree`（frontmatter + spawn 入参双通道，入参优先）。
- 定位裁决：隔离基建非 git 替代——只跟踪自身创建的 worktree、不干预用户手工树、不跟踪 exec 副作用（与会话回退/分叉线同口径、两线正交）。
- 关键取舍「落位数据目录」：树落 `<dataDir>/worktrees/<name>/`（不入库、不污染项目树、天然避开感知扫描与安全链判界联动），分支 `worktree-<name>` 从当前 HEAD 分叉（个人本机语义：并行线从当前工作现场分叉，非 fresh）。
- 启动旗标最小侵入：入口层把 root 替换为 worktree 路径，装配链（安全链/上下文/工具/fork）零改动全量继承；会话内切换以工具观察行+尾追说明行承载、稳定段工作目录事实行不重写——前缀缓存零新增动态面。
- 清理语义（问卷裁决 A）：干净树随会话自动清理（含分支），脏树保留并登记供 list 与后续处置；CLI 非交互路径一律保留。
- 隔离强制收敛既有安全链：活动 root 判界先行（写面与 exec cwd 受限、读面恒开放以供对比审查）；不新造命令形态审查器，强度差异登记为有意取舍；非 git 仓库 fail-fast，子代理建树失败 fail-bounded 不炸父任务。

## 现行真值

MANUAL.md §5.5 Worktree 隔离（三入口与生命周期现行口径）；CLAUDE.md §3 目录结构（src/harness/worktree.ts 单点、内置工具 worktree）；CLAUDE.md §14 平台兼容性目标（worktree.execGit 平台分支登记例外）。
