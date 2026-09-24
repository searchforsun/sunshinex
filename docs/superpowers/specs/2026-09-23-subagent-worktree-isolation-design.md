# 子代理 Worktree 隔离（程序化）设计规格

日期：2026-09-23 · 状态：已裁决待实施 · 对标基线：Claude Code sub-agents `isolation: worktree`（含 v2.1.203+ 执行面强制口径）

## 1. 背景与目标

子代理并发执行写代码类子任务时，各自在同一工作区落盘会互相踩踏。解法是对标 Claude Code：子代理可声明获得一份独立仓库副本（临时 git worktree），fork 前程序建树、口程序管理，实现多子代理并行互不冲突。

核心立场：**隔离是 harness 机制，模型面零接触**——模型只能通过 spawn 入参或 agent.md frontmatter「声明」隔离，建树/判界/收口全部由程序完成；子代理工具面恒无 worktree 工具（既有裁决 `subagent_tool_face_narrowing` 不变，与本特性正交叠加）。

## 2. 核心决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | 程序化建树 | fork 前由 `SubagentRunner` 创建专属树并切换子链根；模型不调用任何建树工具 |
| D2 | 双通道声明 | spawn 入参 `isolation: 'worktree'`（优先）＞ agent.md frontmatter `isolation: worktree`；内联临时子代理走入参通道 |
| D3 | 无 Git 静默兜底 | 工作区非 git 仓（或缺项目根）→ 隔离声明静默降级为主工作区执行，零链行、零报错；仅「是 git 仓但建树失败」保留 fail-bounded 补丁行回链 |
| D4 | 收口语义 | 子代理三出口（完成/未完成/异常）统一收口：树内干净（`isDirty` 口径，`.sunshinex/` 不计）→ 自动删树含分支、零链行；有改动 → 保留 + 补丁行附树路径（供人接管检查） |
| D5 | 分叉基线 | 树从**当前 HEAD** 分叉（非默认分支）——子任务基于父会话当前工作状态，含未提交成果 |
| D6 | 执行面强制 | 隔离子链的 exec 三道判界（§5），程序侧 fail-closed；未声明隔离的子代理零影响 |

## 3. 组件与数据流

```text
spawn 入参 / agent.md frontmatter
        │ 声明 isolation: worktree
        ▼
SubagentRunner.runSubagent
        │ ① 前置探测：root 缺失或 isRepo(root)=false → 静默置 iso=undefined（D3）
        │ ② 建树：subagentTreeName(label) → createWorktree(root, dataDir, name)（D1，从 HEAD 分叉）
        │ ③ fork：SafetyChain.withRoot(tree) 换根克隆（带 isolation 标记）→ 子 Reactor root=树
        ▼
子代理执行（exec cwd 天然锚树；git 重定向/越树 cwd 被判界单点拒绝，D6）
        ▼
收口 settleSubagentTree：isDirty(tree)？删树 ： 保留+note（D4，三出口统一）
```

## 4. 声明面

- `SubagentSpawnInput.isolation?: 'worktree'`（`src/types.ts`）；spawn 工具 JSON Schema 同步声明（strict 口径：`isolation` 以 `["string","null"]` 联合进 `required`，枚举 `["worktree", null]`）
- agent.md frontmatter 新增 `isolation: worktree` 键（`parseAgentFrontmatter` 解析；缺省无）
- 判定优先级：入参 > frontmatter；未声明 → 无隔离
- spawn 输入面校验：`isolation` 仅接受 `'worktree'` 或缺省，其他值 `INVALID_ARG` fail-fast（与 tools 未知名同风格）

## 5. 执行面强制（判界单点）

换根克隆恢复 `SafetyChain.withRoot(root)`，克隆携带 `isolatedRoot` 标记；`src/paths.ts` 的 `isWithin` 为唯一判界函数。exec 工具入参无模型侧 `cwd`——工作目录恒由程序锚定（`chain.execCwd()`，隔离子链即锚树）；越树通道只剩命令文本本身，据此对隔离子链的命令文本做三查（任一命中越树/不可验证 → 拒绝执行、观察回填失败原因）：

| 检查 | 规则 |
|------|------|
| ① 工作目录锚定 | 程序侧既有机制：隔离子链 `execCwd()` 锚树（`withRoot` 换根克隆承担，零新增代码），模型无从指定执行目录 |
| ② git 指针参数 | 命令 token 中出现 `--git-dir=` / `--work-tree=` / `-C <path>` / `core.worktree=` 时，路径必须 `isWithin(树)`，越树拒绝 |
| ③ 环境赋值与 cd | 形如 `GIT_DIR=…` / `GIT_WORK_TREE=…` 前缀 token 及 `cd <path>`（`&&` 链内）的路径必须 `isWithin(树)`；**无法从命令文本确认 git 留在树内时一律拒绝**（fail-closed，CC「不可验证即拒绝」口径） |

- 未隔离链（主链、普通子代理）：三查零介入，行为与现状逐字节一致
- 传导规则：主会话经 `--worktree` 启动时，forkRoot 已锚树，全部子代理（含未声明隔离的）天然在树内执行——与 CC 传导口径等价，无需额外代码

## 6. 错误通道

- 非仓/缺根静默兜底（D3）：不进链、不报错——隔离是增强非承诺，工作区形态不支持时静默降级是唯一正确语义
- 是仓但建树失败（`WORKTREE_*` 非 NOT_A_REPO）：补丁行 `[<label>] isolation failed (<code>)` 回链，该子代理不执行，父任务不炸（fail-bounded）
- 判界拒绝：走既有 exec 观察回填通道（exitCode 非 0 形态，message 说明拒绝原因），模型可自纠
- 收口保留（脏树）：补丁行 `[<label>] worktree kept for inspection: <tree>` 回链；收口自身失败（登记缺失/已清）逐项容忍，尽力而为

## 7. 文件面

| 文件 | 改动 |
|------|------|
| `src/types.ts` | `SubagentSpawnInput.isolation` 字段 |
| `src/harness/worktree.ts` | 恢复 `subagentTreeName()`；`isRepo` 导出（供 D3 前置探测） |
| `src/harness/security/chain.ts` | 恢复 `withRoot()` + `isolatedRoot` 标记；exec 判界三查收口于本单点 |
| `src/harness/subagent.ts` | 声明面解析、前置探测、建树、fork 换根、`settleSubagentTree` 三出口收口 |
| `src/harness/tools/builtin.ts` | spawn 工具 schema 增 `isolation` |
| `src/harness/worktree-isolation.test.ts` | 重建用例（§8） |
| MANUAL.md / README.md | 活文档同步（入口表行、子代理节、快速上手注释） |

历史 specs/plans 存档保留原貌，零回改；正文零存在史（不复述删除/重引入过程，只写现行设计）。

## 8. 测试计划

1. frontmatter 声明 → 建树、子 Reactor root=树、exec 输出锚树、干净树自动删且零 note 行
2. 入参通道同 1；入参优先于 frontmatter（frontmatter 声明 + 入参缺省 → 仍隔离；两通道均无 → 不建树）
3. 脏树保留 + note 行含树路径
4. 无 Git 仓 → 静默兜底：不建树、零 note 行、子代理主工作区正常执行返回
5. 缺项目根 → 同 4
6. 建树失败（非 NOT_A_REPO）→ note 行 + INCOMPLETE，父任务不炸
7. 判界：`cd <树外> && git status` 拒绝；`--git-dir=<主仓>` 拒绝；`GIT_DIR=…` 前缀拒绝；运行期拼装的不可验证 git 命令拒绝；树内 git 命令正常执行
8. 未隔离子代理 exec 行为与现状一致（回归锚）
9. spawn schema：`isolation` 非法值 INVALID_ARG fail-fast

## 9. 不做范围（YAGNI）

- 树从默认分支分叉的选项（CC 缺省行为）——D5 已裁决从 HEAD
- 并发隔离子代理的树数量上限/配额——沿用 spawn 既有并发护栏
- PowerShell 专属检查差异——平台分支收敛在 `ProcessSandbox` 单点，判界逻辑 shell 无关
- 隔离子代理的树内 `.sunshinex/` 记忆写放大——记忆 scope 语义不变（树路径只影响 exec cwd 与文件判界）
