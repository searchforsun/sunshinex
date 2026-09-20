# Worktree 隔离设计规格（对标 Claude Code worktree 三入口）

日期：2026-09-20
状态：设计定稿（两项裁决经问卷用户拍板：入口范围=B 三入口全做；清理语义=A 干净自动删、有改动保留）
关联线：docs/superpowers/specs/2026-09-20-session-rewind-fork-design.md（正交，见 §4-D8）、2026-09-14-subagent-design.md（frontmatter 扩展见 §9）

## 1. 背景与目标

SunshineX 已有子代理并行 fork（上下文隔离、并发上限 4、结论行回写）与会话 rewind/fork（历史维度分叉，设计定稿），但**文件维度没有任何隔离**：主链、并行子代理、多会话全部共享同一工作区目录。并发写同一文件、并行跑全量测试（`.data-test`/`dist` 竞态先例已实际发生）、同 checkout 抢 git index.lock，都是真实冲突源。

本特性线把 **git worktree 作为文件系统级隔离基建**引入，对标 Claude Code 已交付的 worktree 能力（启动旗标 / 会话内工具 / 子代理 frontmatter / 桌面选项四层，本线做前三层），服务三类场景：

1. **并行写型子代理**：多个子代理各自落盘改代码，互不覆盖；
2. **多会话/后台长任务**：同一仓库同时跑多条任务线，互不踩工作区；
3. **风险操作隔离**：试验性改动在隔离 checkout 里进行，主工作区保持稳定。

定位边界：worktree 是**隔离基建**，不是 git 的替代——不跟踪 exec 副作用，不承担版本管理（与 rewind/fork 线的 D6 同口径）。

## 2. 对标调研结论（2026-09-20 核实）

| 维度 | Claude Code | Codex | 本方案取舍 |
|------|------------|-------|-----------|
| 启动入口 | `claude --worktree <name>`（`-w`），在 `.claude/worktrees/<name>/` 建分支 `worktree-<name>`；省略名自动生成；同名复用 | 本地 CLI 无（仓库 docs 与 TUI 源码均无）；Desktop/Remote 有托管 worktree（`~/.codex/worktrees/`、`git-worktree-root` 配置） | 采纳旗标入口；位置改落数据目录（§6-D3）；v1 撞名报错不复用 |
| 会话内 | `EnterWorktree` / `ExitWorktree` 原生工具，对话触发；移出 worktrees 范围须审批 | 无 | 采纳：单一 `worktree` 工具（create/exit/list 三动作） |
| 子代理 | agent.md frontmatter `isolation: worktree`，或口头要求；结束后无改动自动删、有改动保留待清扫 | 无 | 采纳：frontmatter + spawn 入参双通道 |
| 隔离强制 | 进 worktree 后封锁一切触及主 checkout 的编辑/命令（cwd 校验、`git -C`/重定向拦截、不可验证命令形态拒绝） | 容器级隔离 | 采纳方向，强度收敛到既有安全链（§11）：root 判界天然封顶，不新造命令形态审查器 |
| 清理 | 干净自动删、有改动弹窗保留；后台清扫 + `git worktree lock` 防并发误删 | `worktree-keep-count` 保留数策略 | 采纳 A 语义（问卷裁决）；清扫登记 v2 |
| 依赖/配置 | `.worktreeinclude` 把 gitignored 文件（.env 等）拷入新 worktree | — | v1 固定拷贝 `.env` 与 `.sunshinex/settings.json`（存在才拷），通配清单登记 v2 |

平台侧先例：本助手运行环境本身即以 worktree 形态派发会话 checkout（`git-dir` 与 `git-common-dir` 分离），`using-git-worktrees` 技能已内置「先检测已隔离 → 原生工具 → git 回退」协议——产品内建原生工具后，该技能的 Step 1a 路径自动命中，检测协议（Step 0）由本线收编为代码。

## 3. 范围

**做**：worktree 生命周期单点模块（检测/创建/删除/登记）、`--worktree` 启动旗标（tui/run 两入口）、`worktree` 模型工具（create/exit/list）、子代理 `isolation: worktree`（frontmatter + spawn 入参）、隔离强制（安全链接线）、退出清理与登记表、三类文档同步。

**不做**：见 §13（YAGNI 清单）。

## 4. 关键裁决

| # | 裁决 | 依据 |
|---|------|------|
| D1 | 定位=文件系统级隔离基建，非 git 替代；只跟踪自身创建的 worktree，不干预用户手工 worktree | 与 rewind/fork D6 同口径 |
| D2 | 三入口全做（问卷裁决 B）：启动旗标 / 会话内 `worktree` 工具 / 子代理 isolation；工具清单 +1 = 一次全量前缀断点，属 §5 纪律内、经用户裁决即论据 | 用户裁决 |
| D3 | worktree 位置=`<dataDir>/worktrees/<name>/`（数据目录，不入库、不污染项目树、天然避开感知扫描）；分支名=`worktree-<name>`（子代理=`worktree-subagent-<label>-<4位随机>`） | 对标 CC `.claude/worktrees/` 但落本仓数据区惯例（对标 `~/.claude/projects/<slug>/` 形态） |
| D4 | baseRef 缺省=当前 HEAD（个人开发者本机语义：并行线从当前工作现场分叉）；缺省从 origin/HEAD fresh 分叉不做（登记 v2 配置 `worktree.baseRef`） | CC 缺省 fresh 面向云端协作仓库；本仓用户形态为个人本机 |
| D5 | 启动旗标语义=**入口层解析后把 root 替换为 worktree 路径**，其余装配链路（buildDeps/安全链/上下文/工具）零改动全量继承——最小侵入 | `buildDeps(root, flags)` 单点已核实；root 是全链路唯一根事实 |
| D6 | 会话内 `worktree` 工具：`{action:'create'\|'exit'\|'list', name?}`；create 切换活动 root（Harness 单点），exit 回主工作区；切换经工具观察行尾追进链（append-only），**不重写稳定段工作目录事实行**（前缀纪律：工作目录行=会话启动时 root，恒定） | 前缀缓存第一要义；CC 同样以观察承载状态 |
| D7 | 工具类别登记 ToolCategory 新类 `worktree`：单发独占（改全局活动 root，禁入并行批）、免审批（对标 spawn 免审批先例；deny 规则仍先行） | spawn 先例；活动 root 切换不构成破坏性副作用（产物全在数据目录） |
| D8 | 与 rewind/fork 线正交：journal 影子快照与 pre-image 按会话活动 root 记相对路径，worktree 会话照常工作；branchFrom 分档不继承 worktree 状态（只复制 journal 前缀） | 两线数据面无交集，登记边界即可 |
| D9 | 子代理 isolation 双通道：agent.md frontmatter `isolation: worktree` + spawn 入参 `isolation?: 'worktree'`（入参优先）；派生 worktree 生命周期跟随该次 spawn | 对标 CC；内联临时子代理同样可用（经入参） |
| D10 | 清理语义（问卷裁决 A）：本会话/本 spawn 创建的 worktree，收口时 `git status --porcelain` 为空 → 自动 remove（含分支）；有改动 → 保留并登记 `<dataDir>/worktrees/registry.json` 供 `list` 与后续处置；CLI run 非交互路径一律保留+登记（对标 CC `-p` 语义） | 用户裁决 |

## 5. 现状基本条件（已核实）

- 全仓 `src/` 零 worktree 现状（grep 证实），从零新建、无迁移负担。
- `buildDeps(root, flags)`（src/runtime.ts）是 CLI/TUI 共用装配根，root 为唯一根事实——D5 的 root 替换方案成立。
- `parseAgentFrontmatter`（subagent.ts）为简易 key: value 解析器，加 `isolation` 字段属既有形态扩展。
- 安全链 `resolveSafe` 以 root 子树判界、`underDataDir` 对数据目录只读放行（chain.datadir.test.ts）——worktree 落数据目录下时，读面天然放行、写面判界需补「活动 root 判定先行」一处边界口径（见 §11），无需新机制面。
- `SCAN_SKIP_DIRS`（perception.ts）与仓库 `.gitignore` 有绑定锚点测试——worktree 落数据目录，项目树零新增忽略项（锚点不动）。
- 会话内切换活动 root 后，fork 子代理、LoopDeps、ReactorDeps 均从 Harness 取 root——单点切换全链路生效（装配方向已核实）。
- 回退链兜底：无原生工具时 `using-git-worktrees` 技能仍可 `git worktree add` 手工隔离——本线上线后技能走原生路径（Step 1a），消灭 phantom state。

## 6. 数据面

### 6.1 布局

```text
<dataDir>/
  worktrees/
    <name>/                    # 一棵 worktree = 一个完整 checkout（共享主仓 .git 对象库）
    registry.json              # 登记表：[{ name, path, branch, sessionId, createdAt, keptReason? }]
```

- `<name>` 合法形态：`/^[a-z0-9][a-z0-9-]{0,63}$/`（目录名与分支名安全字符集，非法即 INVALID_ARG）。
- 分支：`worktree-<name>`，从创建时主仓 HEAD 分叉；worktree 删除时分支一并删除（有改动保留时分支随 worktree 同存）。
- 主仓自身永远不会被本机制删除或改动分支——本线只管理自建 worktree。

### 6.2 git 调用纪律

git 命令（`rev-parse` / `worktree add` / `worktree remove` / `status --porcelain` / `branch -D`）收敛在 worktree 单点模块内，经 `node:child_process` 参数数组调用（无 shell 拼接、无注入面、带超时），同 perception 的 Git 感知先例；命令失败返回 `Result.fail`（错误码 WORKTREE_*），不抛裸异常穿引擎。

### 6.3 依赖与配置落位

- 新 worktree **不自动安装依赖**（观察行提示 `node_modules` 未就绪，安装由模型/用户按需执行）；对标 CC 同样不自动装。
- 创建时固定拷贝 `.env` 与 `.sunshinex/settings.json`（存在才拷、覆盖语义、拷贝结果在观察行如实回执）——这两者是运行时装配读的本地配置，缺了会导致 worktree 内行为静默漂移。

## 7. 入口一：`--worktree` 启动旗标

- 形态：`sunshinex tui <dir> --worktree[=name]`、`sunshinex run <dir> --goal=... --worktree[=name]`；省略 `=name` 自动生成（`wt-` + 4 位随机，对标 CC 自动命名）。
- 解析时机=入口层（tui entry.ts / run-loop.ts）：先 `path.resolve(dir)`，再经 worktree 单点创建，**把返回的 worktree 路径作为 root** 传入 SessionController / buildDeps——装配链路（安全链、上下文、工具、fork）零改动全量继承（D5）。
- 失败语义 fail-fast：目录非 git 仓库 → 报错退出（提示 --worktree 不可用）；名称非法/撞名 → 报错退出；创建成功后 banner 与上下文工作目录事实行均为 worktree 路径（root 事实自会话构造起恒定，前缀纪律天然满足）。
- `--continue` 与 `--worktree` v1 互斥（同用报错并提示）：恢复会话的活动 root 属会话自身事实，跨旗标拼接产生歧义；放宽登记 v2。

## 8. 入口二：`worktree` 模型工具

- 工具名 `worktree`；入参 `{ action: 'create' | 'exit' | 'list', name?: string }`；description 恒英文单语（CLAUDE.md §15 语言规范）。
- create：主仓 HEAD 分叉建树并**切换活动 root**（Harness 单点），同名已存在报 WORKTREE_EXISTS（v1 不复用；CC 的同名重开语义登记 v2）；exit：回主工作区，当前不在 worktree 中报 WORKTREE_NOT_ACTIVE；list：观察行输出登记表摘要（name / branch / dirty）。
- 切换回执=工具观察行 + 会话链尾追一行说明（`working directory switched to <path> on branch worktree-<name>`）——append-only，**稳定段工作目录事实行不重写**（D6，前缀纪律）。
- 类别与并行语义：ToolCategory 新类 `worktree`（D7），单发独占、免审批（对标 spawn 先例，deny 规则仍先行）。
- plan 模式拦截：create/exit 切换工作区属写类副作用，plan 轮（guard 只读闸门）下整体禁用（报错提示退出 plan 后使用）；list 属只读放行。

## 9. 入口三：子代理 `isolation: worktree`

- 双通道：agent.md frontmatter `isolation: worktree`（`parseAgentFrontmatter` 加字段）与 spawn 入参 `isolation?: 'worktree'`（入参优先，内联临时子代理同样可用）。
- Runner 执行序：fork 组装前创建专属 worktree（label 先按 §6.1 安全字符集净化、非法字符折叠为 `-`，分支与目录名 `worktree-subagent-<净化label>-<4位随机>`，随机尾防并行撞名）→ 子 Reactor root 指向该路径（Runner 已持 root 装配点，单点替换）→ 结论行回写主链口径不变；有改动保留时结论行附 worktree 路径（主链模型可后续 `read` 跟进）。
- 清理跟随 spawn 收口：`status --porcelain` 空 → 自动 remove（含分支）；有改动 → 保留 + 登记（D10）。
- 失败边界：创建失败 = 该子代理 fail-bounded（结论行回失败补丁行），不炸父任务；并行批内多个 isolation 子代理各自独立树。

## 10. 生命周期与清理

- 创建来源三类：旗标（会话级）、工具 create（会话级）、spawn（spawn 级）——全部登记 registry.json：`{ name, path, branch, sessionId, createdAt, keptReason? }`；移除成功即删条目。
- 会话级清理时机=TUI 正常退出（沿三 flush 点的 finally 语义）：逐个检查本会话创建的 worktree，porcelain 空 → 自动删；有改动 → 保留并写 keptReason（如 `dirty: 3 files`）。
- CLI run / pipeline 路径：一律保留 + 登记（非交互无从询问，对标 CC `-p` 语义），收口回执列出保留项路径。
- 不做后台清扫与 `git worktree lock`（登记 v2）；双会话并发写 registry.json 属单用户本机边缘场景，v1 接受并登记（§15）。

## 11. 隔离强制（安全链接线）

worktree 会话（旗标或工具 create 进入）中，活动 root 之外的项目路径写入被既有安全链天然拒绝——`resolveSafe` 以 root 子树判界，worktree 路径在 root 外即拒。需补两处边界语义：

- **数据目录读写放行不变**：`underDataDir` 既有语义（数据目录内 read/write 由专属工具承载）——worktree 自身就在 `<dataDir>/worktrees/` 下，其文件编辑经 write 工具时按「活动 root 判界」放行（工作树路径 ⊂ 数据目录，但编辑语义属项目代码，走 write 通道时以活动 root 为界判定，不误入数据目录只读规则）。实现口径：chain 判界顺序=活动 root 判定先行，命中即按项目路径语义放行；未命中再走 underDataDir 只读判定。
- **读面恒开放**：read/grep/glob 对主工作区与 worktree 均可读（对比审查需要），root 判界只约束写面与 exec cwd——exec 的 cwd 锚定活动 root（既有 ProcessSandbox 单点），`git -C <主工作区>` 类越界写操作由 git 命令自身的 root 判界拒绝（目标路径在活动 root 外即 INVALID_ARG 级拒绝）。
- 不新造 CC 的「命令形态不可验证即拒绝」审查器：本仓安全链三态（deny/ask/allow）+ root 判界已构成闭环，登记强度差异为有意取舍（§15）。

## 12. 前缀缓存影响面（第一要义对照）

- 启动旗标路径：root 事实在会话构造前确定，工作目录事实行自首帧起就是 worktree 路径并整场恒定——**零新增动态面**。
- 会话内 create/exit：切换以观察行 + 尾追说明行承载（append-only），稳定段（含工作目录事实行）逐字节不动；相邻帧首个差异点落尾部——符合动态改动尾追纪律。
- 工具清单 +1（`worktree`）：装配期冻结、按名排序落位，属一次性全量前缀断点（§5 纪律内，D2 已裁决）；工具 description 英文单语。
- 子代理 isolation：fork 首帧 seed=主链快照 + 角色行/任务行，worktree 路径出现在角色/任务行或子代理私有上下文，不回写主链——fork 首帧严格前缀连续不变量保持。
- 强制回归项：①会话中 create→exit 全程相邻帧前缀逐字节稳定（差异只落尾追行）②旗标会话首帧工作目录行=worktree 路径且整场不变③fork 首帧连续钉子沿用。

## 13. 登记不做（YAGNI）

- `worktree.baseRef` 配置（fresh 分叉）、同名 worktree 复用/重开、`.worktreeinclude` 通配清单、后台清扫（cleanupPeriodDays 式）+ `git worktree lock`、`ExitWorktree` 拆分独立工具（三动作合一已够）、桌面端/多入口 UI（GUI 线立项时承接）、registry 跨会话自动 GC、非 git 仓库的隔离替代（WorktreeCreate/Replace hook 式机制）。

## 14. 落点表

| 层 | 文件 | 动作 |
|---|------|------|
| 单点模块 | `src/harness/worktree.ts`（新增） | 检测/创建/删除/登记/porcelain 检查，git 调用参数数组+超时，Result 通道，错误码 WORKTREE_* |
| 装配 | `src/runtime.ts`、`src/tui/session.ts` | Harness 增活动 root 状态与切换接缝；buildDeps 透传 |
| 入口一 | `src/tui/entry.ts`、`src/cli/commands/run-loop.ts`、`src/cli/index.ts`（USAGE） | `--worktree[=name]` 解析、root 替换、`--continue` 互斥守卫 |
| 入口二 | `src/types.ts`（ToolCategory）、`src/harness/tools/builtin.ts`、`src/harness/tools.ts`、`src/tui/tool-verbs.ts` | `worktree` 工具注册、新类别单发独占、动词映射 |
| 入口三 | `src/harness/subagent.ts`、`src/types.ts`（SubagentSpawnInput） | frontmatter `isolation` 字段 + spawn 入参、Runner root 替换与收口清理 |
| 安全 | `src/harness/security/chain.ts` | 活动 root 判界先行口径（§11） |
| 感知 | 无改动 | worktree 在数据目录，项目树与 SCAN_SKIP_DIRS 锚点零变化 |
| 文档 | `README.md`、`TUI-MANUAL.md`、`CLAUDE.md §3`（目录树 worktree.ts 一行） | 三入口用法与清理语义 |

## 15. 边界自答与验收矩阵

- Q：为什么落数据目录而非项目内 `.worktrees/`？——项目内落树需 .gitignore + 感知跳过 + 安全链判界三处联动，且污染用户项目树；数据目录天然避开全部三者（对标 `~/.claude/projects/` 数据区惯例），CC 落 `.claude/worktrees/` 是其数据目录在项目内的形态差异，语义同构。
- Q：主工作区与 worktree 会话同时跑会不会冲突？——会各自持有独立活动 root 与独立 index，git 对象库共享只读无锁竞争；同仓 push 竞争属用户 git 工作流范畴，不在本线。
- Q：registry.json 并发写？——单用户本机边缘场景，v1 接受最后写者胜；登记 v2 可加文件锁。
- Q：worktree 里跑 `pnpm test` 的 `.data-test`？——每 worktree 有独立 `.data-test`（项目内相对路径），互不干扰；依赖未装时测试自然失败，观察行已在创建时提示。

验收矩阵：

1. 旗标：`--worktree` 后 SessionController root=worktree 路径，banner/上下文事实行一致；非 git 目录 fail-fast。
2. 工具：create/exit/list 全路径 + 非法名/撞名/未激活三错误码；切换后 write 落 worktree、主工作区零改动。
3. 子代理：frontmatter 与入参两通道均生效；入参优先；有改动保留时结论行带路径。
4. 清理：porcelain 空自动删（含分支）、有改动保留+登记+keptReason；CLI run 路径恒保留。
5. 强制隔离：worktree 会话中写主工作区路径被拒；读主工作区放行。
6. 前缀：§12 三条回归钉子全绿；`pnpm build` + 全量测试 + `pnpm selfcheck` 三门禁。
