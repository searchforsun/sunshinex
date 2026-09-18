# 记忆体系对齐 Claude Code 形态 · 续跑编排计划（M3 收口 → M4–M8 → 终局）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 执行本编排。任务正文（红灯测试、实现代码、门禁命令、提交信息）一律取自 `docs/superpowers/plans/2026-09-18-memory-cc-alignment.md` 与 `.superpowers/sdd/2026-09-18-memory-cc-alignment/task-{4..8}-brief.md`——本文件只编排「何时派发、BASE 取哪、口径要不要改、验收与账目」。

**Goal:** 在既有 8 任务 TDD 计划的执行中途接手——先收口 M3（含两处遗留裁决），再按序派发 M4–M8，最后做全分支终局审查与工作区收口。

**Architecture:** 编排层不写业务代码。每个任务＝记录 BASE → 派发实现者（brief 为唯一需求源）→ 生成审查包 → 派发任务审查者（规格符合性 + 代码质量）→ 修复轮（≤5，重派而非自修）→ 回填 ledger。任务之间的口径漂移（M2 的 SUNSHINE.md 摘除引起）在派发对应任务前先从 brief 修掉，避免实现者按过期文本施工。

**Tech Stack:** TypeScript（Node 内置 `node:test`）、git worktree（`/workspace/wt-59f36a81fc`，分支 `dev1`）、SDD ledger 目录 `.superpowers/sdd/2026-09-18-memory-cc-alignment/`。

## Global Constraints

（逐字取自实施计划的 Global Constraints，对每个任务生效）

- **不新增任何工具**（规范 N2 / 规格 §4.4）：工具面零变化——会中自写复用既有 `write`，可见性复用链尾说明行；实施后 `selfcheck` 工具清单须与实施前逐字节一致。
- **前缀缓存第一要义 + 动态改动尾追**（规范 N1）：会话运行期对 SUNSHINE.md／技能清单／记忆索引的任何变更只走**链尾说明行**；禁止改写 `contextSnapshot`、禁止就地改写历史行、禁止提前重建快照。快照重写仍只在四刷新点（构造 / `reloadContext` / `resetSession` / 压缩成功非 replay）。
- **冻结语义**：会中自写的记忆不在本会话进入索引；模型需要就用 `read` 直接读记录文件（数据目录只读放行已存在，开关与只读放行**无关**）。
- 全部用户可见文案走 `t(en, zh)`、模型可见文案走 `pick(en, zh)`，双语字面量就地成对（零词典文件）；禁止模块级 `t()`/`pick()` 冻结。
- 旁路纪律：记忆层任何失败（写入/校验/索引/容量）一律降级为工具侧可读错误或静默吞错，**任务收口永不因记忆失败而失败**。
- 测试卫生：数据目录断言统一走 `resolveDataDir(root)`；用例内重定向 `SUNSHINEX_DATA_DIR`（或 `HOME`+`USERPROFILE` 双变量），禁止断言真实家目录。
- TDD 纪律：每任务先红灯后实现；**单文件单编辑串行**（`context/index.ts`、`reactor.ts`、`session.ts` 有并行编辑竞态两次先例）；提交前定向套件绿。
- 闸门纪律：测试通过判据用「fail 0 / pass N」硬断言，禁用 `grep` 命中作通过判据。
- 平台约束（CLAUDE.md §14）：路径一律 `path.join` / `path.resolve` / `path.relative`，禁手拼分隔符。
- 测试用例纪律：以「断言面清单」列出的用例（M4 六拒绝分支／超限／近满、M7 scope 收窄与主链零污染、M8 settle 返回与 toggle）必须逐条写成真断言，禁止提交空体用例；提交前 `grep -c "() => {}" <改动测试文件>` 必须为 0。

---

## §0 接手现场快照（2026-09-18 取证，勿凭记忆覆盖）

| 项 | 实测值 | 取证命令 |
| --- | --- | --- |
| 工作区 | `/workspace/wt-59f36a81fc`，分支 `dev1` | `git branch --show-current` |
| 分支基点 | `main` = `4f463cc`（init） | `git merge-base main HEAD` |
| HEAD | `612c537` | `git log --oneline -1` |
| 工作区状态 | 干净（唯一残件见下） | `git status --short` |
| 全量套件 | **791 通过 / 0 失败 / 30s** | `npx tsc -p tsconfig.json && node scripts/run-tests.js` |
| selfcheck | OK；`tools : exec, read, skill, write, grep, glob, webfetch, websearch, kb_search, spawn`（10 项）；`skills : 21`；`learned : 19` | `node dist/cli/index.js selfcheck` |
| 未跟踪残件 | `src/tui/session/**`（2 文件，2026-09-17 前一份计划遗留，已被 `tsconfig.json` 的 `exclude: ["src/tui/session"]` 排除，不参与构建与测试） | `git status --porcelain`、`grep exclude tsconfig.json` |

**本计划提交序列（BASE 起点 `f030c45`）**

```
612c537 fix(perception): SCAN_SKIP_DIRS 补 .corepack-home（双源漂移锚点，基线既有红）
231b727 fix(security): M3 审前修复——数据目录 realpath 归一 + datadir 陈旧断言随规格更新
1c9646b feat(security): M3 记忆写窄口——isMemoryPath 分类器单点 + write 窄口 + withMemoryScope
d103fbe refactor(config): M2 修订轮 2——摘除 SUNSHINE.md 配置层        ← M2 收口
ce9a39f docs(spec+plan): 控制面改 env > 缺省两层
40ae799 fix(memory): M2 修订——evictOldest 下界夹紧 + 配置分支断言
ba3378e feat(config): M2 控制面三层解析 + learned 上限配置驱动
9a585d3 fix(memory): M1 修订——slug 校验收口                    ← M1 收口
f030c45 docs(plan): 记忆对齐 CC 形态实施计划
```

**环境差异（影响门禁命令，必须换写法）**：沙箱内 **`pnpm` 不存在**。计划原文所有 `pnpm build` / `pnpm test` / `pnpm selfcheck` 一律等价替换为：

```
npx tsc -p tsconfig.json        # = pnpm build
node scripts/run-tests.js       # = pnpm test（自钉 SUNSHINEX_DATA_DIR=.data-test 并自清）
node dist/cli/index.js selfcheck  # = pnpm selfcheck
```

**SDD 脚本缺失**：`/skills/subagent-driven-development/` 只有 `SKILL.md`，`scripts/sdd-workspace` / `task-brief` / `review-package` 不可用。替代做法（已在本计划各步骤内固化）：workspace 与 ledger 已存在（勿重建）；brief 已存在（勿重生成）；**审查包一律手工生成**：

```
cd /workspace/wt-59f36a81fc
PKG=.superpowers/sdd/2026-09-18-memory-cc-alignment/task-N-review-package[-K].md
{ echo "# review package task-N  BASE..HEAD"; git log --oneline BASE..HEAD; echo; git diff --stat BASE..HEAD; echo; git diff -U10 BASE..HEAD; } > "$PKG"
```

---

## §1 M3 收口（d103fbe..612c537）

### 1.1 三处审前修正的落点对照（已落盘，只需审查确认）

| 关注点（1c9646b 自带） | 处置 commit | 落点 | 状态 |
| --- | --- | --- | --- |
| ① `chain.datadir.test.ts`「Write 数据目录仍拒绝」是旧语义断言（目标恰为 `<dataDir>/memory/x.md`，即 M3 新开窄口） | `231b727` | 该文件 helper 第三参改传 `tmp`（真数据目录）；写面用例改为断言非记忆子树（`skills/`、`runs/`）仍拒；另补数据目录根文件 Read 放行用例（覆盖不缩水） | ✅ 已落盘 |
| ② `memoryWriteAllowed` 未对 dataDir 做 realpath 归一（数据目录含符号链接段时误拒合法写入） | `231b727` | 新增 `private dataDirReal()` 单点（存在段逐级 `realpathSync`，新建段字面拼接，失败按字面兜底），`underDataDir` 与 `memoryWriteAllowed` 共用；新增 `chain.memorywrite.test.ts`「dataDir 经符号链接传入」用例（win32 跳过） | ✅ 已落盘 |
| ③ `.corepack-home` 基线既有红（`.gitignore` 已有条目、`SCAN_SKIP_DIRS` 未同步 → 绑定测试红） | `612c537` | `SCAN_SKIP_DIRS` 补 `.corepack-home`（独立微提交，与 M3 解耦） | ✅ 已落盘 |

### 1.2 遗留两点：收口前必须请人类裁决（不得由控制器自行判定）

- [ ] **Step 1: 生成 M3 审查包**

```
PKG=.superpowers/sdd/2026-09-18-memory-cc-alignment/task-3-review-package-2.md
{ echo "# review package task-3 (含审前修复一并与审)  d103fbe..612c537"; git log --oneline d103fbe..612c537; echo; git diff --stat d103fbe..612c537; echo; git diff -U10 d103fbe..612c537; } > "$PKG"
```

- [ ] **Step 2: 派发 M3 任务审查者**（三份输入：`task-3-brief.md`、`task-3-report.md`、上一步 PKG 路径 + §Global Constraints 逐字块）。

审查范围要点（作为约束块给出，勿预判结论）：写窄口只在 `<dataDir>/memory/**` 且总开关联动；`isMemoryPath` 为唯一分类单点（安全链与写入接缝共用，零 IO）；`withMemoryScope` 派生克隆、原实例零突变；判定一律作用于 realpath 归一后的真实路径；**M3 只做判界，不落盘、不新增工具**；`Read/Grep` 的 D6 只读放行不受总开关影响。要求报告**规格符合性**与**代码质量**两个裁决 + 「⚠️ 无法从 diff 判定」条目。

- [ ] **Step 3: 向人类提出两项遗留裁决**（一次问完，每项附规格/计划原文）

| # | 事项 | 现状与原文 | 待裁决 |
| --- | --- | --- | --- |
| A | `isMemoryPath(..., scope='main')` 语义 | 现实现：`scope === undefined ? 'main' : null`——显式传 `'main'` 等价于对主目录全拒。`paths.ts` 头注释写「scope 给出即收窄（子代理 fork 只可写自身 agents/<id>/）」，即 `'main'` 不在设计意图内作收窄参数；实测无调用方走该路径（M4 只接 `safety.memoryScope`，M7 只派生 `agents/<id>`） | 取值：(a) 维持现状，在 M4 brief 里显式写明「`scope` 仅接 `undefined | agents/<id>`，勿传 `'main'`」；(b) 改语义为 `'main'` 放行主目录（= 显式版默认），补 paths 用例 |
| B | `dataDirReal()` 与 `rootReal` 是否抽公共单点 | `231b727` 让 `underDataDir` 与 `memoryWriteAllowed` 共用 `dataDirReal()`（消除写/读口径漂移），但 `rootReal` 归一逻辑仍是独立实现（构造期算一次）。两者策略同源、调用时机不同（`rootReal` 构造期、`dataDirReal` 运行期惰性，以兼容 `SUNSHINEX_DATA_DIR` 运行期重定向的测试范式） | 取值：(a) 维持两处（各自惰性/构造语义不同，注释已交叉指向）；(b) 抽 `static realpathWithFallback(p)` 纯函数给两处共用，M3 收口前补一次微提交 |

> 两项都属「计划/规格文本与实现细节的取舍」，按 SDD 纪律必须由人类裁决；不得由控制器或审查者单方判定后继续。

- [ ] **Step 4: 修复轮（仅当审查报规格 ❌ / Critical / Important，或 Step 3 裁决要求改代码）**

BASE_FIX = 审查所见的 HEAD；修复完成后：

```
PKG=.superpowers/sdd/2026-09-18-memory-cc-alignment/task-3-rereview-1-package.md
{ echo "# re-review package task-3  $(git rev-parse --short BASE_FIX)..HEAD"; git log --oneline BASE_FIX..HEAD; echo; git diff -U10 BASE_FIX..HEAD; } > "$PKG"
```

派发**范围化重审**（只裁决原发现 ADDRESSED / NOT ADDRESSED + 修复 diff 内的新破坏；越界观察进 ledger 作 deferred minor，不进循环）。修复轮上限 5；控制器**不得自修**。

- [ ] **Step 5: 回填 ledger 并收口**（追加到 `.superpowers/sdd/2026-09-18-memory-cc-alignment/progress.md`）

```
Task 3: pre-review fix — ①datadir 陈旧断言随规格更新 ②dataDir realpath 归一 ③corepack 锚点独立微提交（commits 1c9646b..612c537）
Task 3: 遗留裁决 A — <用户裁决结论>
Task 3: 遗留裁决 B — <用户裁决结论>
Task 3: complete (commits d103fbe..<M3 最终 head7>, review clean)
```

删除 ledger 里已被修正的两条「concern 裁决」草稿行（`Task 3: pre-review fix dispatch` 之后的内容按上述三行替换），避免歧义重复。

- [ ] **Step 6: 门禁复核（收口硬证据）**

```
npx tsc -p tsconfig.json && node scripts/run-tests.js 2>&1 | tail -8
```

Expected: `# fail 0`、`# pass <N>`（≥791）；`node dist/cli/index.js selfcheck` 的 tools 行逐字节不变。

---

## §2 口径漂移修正（派发 M4 之前一次性做完，单独提交）

M2 修订轮 2（`d103fbe`）摘除了 SUNSHINE.md 配置层，但两份 brief 与两处文档仍留旧口径。**实现者只读 brief**，若不止损会照旧口径施工（产出「持久化请改 SUNSHINE.md ## 记忆」这类已废弃文案与错误的调用签名）。

- [ ] **Step 1: 修 brief 旧签名（M5）** — `.superpowers/sdd/2026-09-18-memory-cc-alignment/task-5-brief.md`

| 行 | 旧 | 新 |
| --- | --- | --- |
| 61 | `if (!resolveMemoryConfig(this.rootPath).autoMemory) return [];` | `if (!resolveMemoryConfig().autoMemory) return [];` |
| 84 | 顶部补 `import { resolveMemoryConfig } from '../../config/memory-config';` | 同上（路径正确，仅确认存在 `src/config/memory-config.ts`，实际签名 `resolveMemoryConfig(env?: NodeJS.ProcessEnv)`） |

- [ ] **Step 2: 修 brief 旧签名与废弃文案（M8）** — `.superpowers/sdd/2026-09-18-memory-cc-alignment/task-8-brief.md`

四处 `resolveMemoryConfig(base)` → `resolveMemoryConfig()`（L71、L74、L79 及同段其余调用）；L99–L100 的 `/memory on|off` 回执文案由「持久化请改 SUNSHINE.md「## 记忆」区」改为**环境变量口径**（SUNSHINE.md 已不承载配置）：

```ts
this.pushMsg('system', t(
  `Persistent memory ${sub} for this session (persist with the SUNSHINEX_AUTO_MEMORY env var)`,
  `本会话持久记忆已${sub === 'on' ? '开启' : '关闭'}（持久化请设环境变量 SUNSHINEX_AUTO_MEMORY）`,
));
```

- [ ] **Step 3: 修文档残留（并入 M8 文档同步范围）**

| 文件 | 行 | 旧 | 新 |
| --- | --- | --- | --- |
| `docs/superpowers/plans/2026-09-18-memory-cc-alignment.md` | 1379–1380 | 同上「SUNSHINE.md「## 记忆」区」文案块 | 同上 env 口径 |
| `docs/superpowers/plans/2026-09-18-memory-cc-alignment.md` | 7 | Architecture 里「`config/memory-config.ts`（三层参数解析单点）」 | 「（env + 缺省两层解析单点）」 |
| `docs/superpowers/specs/2026-09-18-memory-cc-alignment-design.md` | 231 | 落点表「三层参数解析单点 + fail-fast」 | 「env + 缺省解析单点 + fail-fast」 |

> 规格 §2 决策表 D6 行的「三层」是**当时问卷收束记录**，§7（L125）已写明用户裁决反转——保留原记录、不再改动（避免篡改裁决留痕）。

- [ ] **Step 4: 提交（仅 docs 两文件）**

```
git add docs/superpowers/plans/2026-09-18-memory-cc-alignment.md docs/superpowers/specs/2026-09-18-memory-cc-alignment-design.md
git commit -m "docs(spec+plan): 收尾口径止损——残留「SUNSHINE.md 配置层 / 三层解析」改 env + 缺省两层，/memory 持久化指向 SUNSHINEX_AUTO_MEMORY"
```

> **已实测**：`.gitignore:9` 为 `.superpowers/`，brief 文件**不在版本控制内**——Step 1/2 的 brief 修改**不会**进 `git status`，也不提交（改动生效于磁盘，实现者读的就是磁盘文件）。因此两件事必须做：①改动后立刻 `grep -n "resolveMemoryConfig(" .superpowers/sdd/2026-09-18-memory-cc-alignment/task-{5,8}-brief.md` 复核无 `(this.rootPath)` / `(base)` 残留；②这两份 brief 的修正内容在派发 M5/M8 时**同时**作为「我对 brief 歧义的裁决」写进 dispatch prompt（§3.2/§3.5 已列），形成双保险。

---

## §3 M4–M8 逐任务派发编排

> 通用纪律（每个任务都适用）：①派发前记 BASE＝`git rev-parse HEAD`；②brief 是**唯一需求源**，dispatch 只给「本任务在项目中的位置 + brief 路径 + 前序任务接口/决策 + 我对 brief 歧义的裁决 + 报告文件路径与契约」；③**禁止并行派发实现者**；④`context/index.ts`、`reactor.ts`、`session.ts`、`builtin.ts` 单文件单编辑串行；⑤修复轮 1–3 重派原实现者（本 harness 无法续发消息给存活子代理 → 带 brief 路径 + 报告文件路径 + 发现清单重派新实现者），4–5 轮换更强模型的新实现者；⑥审查者与实现者都不许由控制器代跑；⑦每任务结束后回填 ledger。

### §3.1 M4 记忆写入接缝 + `write` 委派

- **BASE**：M3 收口后的 HEAD（记作 `<R3>`）
- **Brief / 报告**：`.superpowers/sdd/2026-09-18-memory-cc-alignment/task-4-brief.md` → `task-4-report.md`
- **白名单**：`src/harness/memory/writer.ts`（新）、`src/harness/memory/writer.test.ts`（新）、`src/harness/tools/builtin.ts`、`src/harness/tools/builtin.memorywrite.test.ts`（新）、`src/harness/index.ts`
- **跨任务接口（dispatch 必带，brief 已知但实现者需对齐）**：
  - `MemoryStore(root, { subdir? })`（M1，`store.ts:121`）；`MemoryStore.put({slug,type,description,body,created?,modified?}): Result<MemoryRecord>`
  - `resolveMemoryConfig(env?: NodeJS.ProcessEnv)`（M2，**无 root 参**）
  - `isMemoryPath(dataDir, absPath, scope?): 'main' | \`agents/${string}\` | null`、`MemoryScope`（M3，`src/harness/memory/paths.ts`）
  - `SafetyChain.memoryScope`、`SafetyChain.withMemoryScope(scope)`（M3）
  - `Result` 来自 `src/result.ts`（`ok` / `fail`）
- **裁决补充（写进 dispatch）**：接缝**只接** `safety.memoryScope`（`undefined | agents/<id>`），**禁止传 `'main'`**（M3 遗留裁决 A 的落地口径；取 (b) 时同步改为显式放行主目录）。
- **硬门禁**：`npx tsc -p tsconfig.json && node --test dist/harness/memory/writer.test.js dist/harness/tools/builtin.memorywrite.test.js dist/harness/tools/stability.test.js 2>&1 | tail -6` → PASS；`node dist/cli/index.js selfcheck` 的 **tools 行逐字节不变**（规范 N2 硬校验：`exec, read, skill, write, grep, glob, webfetch, websearch, kb_search, spawn`）。
- **红灯证据要求**：六拒绝分支（越界/非 memory 子树/索引名 `MEMORY.md`/非法 slug/超限/近满）逐条真断言；报告中给出「用例名 → 断言计数」清单。
- **ledger 行**：`Task 4: dispatch implementer (BASE <R3>)` → `Task 4: implementer DONE (<c7>)` → `Task 4: complete (commits <R3>..<c7>, review clean)`

### §3.2 M5 常驻记忆引导条目（空集也注入）+ 装载开关联动

- **BASE**：M4 收口后的 HEAD（`<R4>`）
- **Brief / 报告**：`task-5-brief.md` → `task-5-report.md`（**派发前已按 §2 Step 1 修正**）
- **白名单**：`src/harness/context/index.ts`（**单文件单编辑**）、`src/harness/context/index.memory.test.ts`
- **既有断言口径同步**（brief 已声明必须做）：`index.memory.test.ts` 里「无记忆零条目零开销」用例按新语义改写为「空集也注入引导条目」；改写要在报告里列出被改写用例名与新旧断言的对应。
- **跨任务接口**：`resolveMemoryConfig()`（无参）；`resolveDataDir(root)`（`src/config/data-dir.ts`）。
- **硬门禁**：`npx tsc -p tsconfig.json && node --test dist/harness/context/index.memory.test.js dist/harness/context/assemble.test.js dist/harness/reactor.prefix.test.js 2>&1 | tail -6` → PASS（**相邻帧前缀逐字节稳定用例必须绿**）。
- **风险提示（写进 dispatch）**：引导条目属会话常量，内容须逐字节稳定（目录为常量、索引仅在刷新点变）；`autoMemory: off` → 零条目；**禁止**在条目里引入每次装配变化的字段（时间戳/计数器）。

### §3.3 M6 SUNSHINE.md 漂移检测 + 指令行单点

- **BASE**：M5 收口后的 HEAD（`<R5>`）
- **Brief / 报告**：`task-6-brief.md` → `task-6-report.md`
- **白名单**：`src/harness/context/loader.ts`、`src/harness/context/index.ts`、`src/harness/context/index.drift.test.ts`（新）、`src/tui/session.ts`、`src/cli/commands/run-loop.ts`、`src/cli/commands/run-pipeline.ts`
- **修正提示（写进 dispatch，brief 未含）**：①`skillIds()` 用的 `loadSkills` 须从技能加载模块**显式 import**（brief 只给函数体）；②`loader` 内部 root 字段名以现有 `ContextLoader` 为准（brief 写 `this.root`），提交前用 `grep -n "constructor" src/harness/context/loader.ts` 对齐；③`src/tui/session.ts` 是并行编辑高风险文件，四处调用点**逐处串行**替换。
- **行号漂移提示**：brief 给的 `session.ts:374,524`、`run-loop.ts:20`、`run-pipeline.ts:52` 系 `f030c45` 时点行号，M1–M5 已改过多文件——实现者须**按代码模式定位**（`appendChain([{ action: 'task', observation: … }])`），不得按行号硬切。
- **硬门禁（跨层回归必绿，逐条列出）**：
  `npx tsc -p tsconfig.json && node --test dist/harness/context/index.drift.test.js dist/harness/reactor.prefix.test.js dist/harness/subagent.test.js dist/graph/agents.test.js dist/tui/session.plan.test.js 2>&1 | tail -8`
  - `subagent.test.ts`「Runner fork 组装：子首帧 = 主链严格前缀 + 尾追」
  - `graph/agents.test.ts`「fork 首帧 = 主链末帧严格前缀 + 尾追」
  - `reactor.prefix.test.ts`「相邻步严格前缀连续」
  - `session.plan.test.ts` 相邻步严格逐字节前缀
  - `index.drift.test.js`：变更后 `contextSnapshot` 首条字节不变

### §3.4 M7 子代理自有记忆（独立目录 + fork 私有尾块 + scope 收窄）

- **BASE**：M6 收口后的 HEAD（`<R6>`）
- **Brief / 报告**：`task-7-brief.md` → `task-7-report.md`
- **白名单**：`src/harness/subagent.ts`、`src/harness/index.ts`、`src/harness/subagent.memory.test.ts`（新）
- **跨任务接口**：`MemoryStore(root, { subdir: 'agents/<id>' })`（M1）；`SafetyChain.withMemoryScope('agents/<id>')`（M3，派生克隆、原实例零突变）；`MemoryScope`（M3）。
- **brief 缺口提示（写进 dispatch）**：brief 的 Step 1 只给用例名清单（「未声明 memory 的 agent → 无记忆行、无目录」等四条），**必须逐条写成真断言**（测试用例纪律），并在报告中给「用例名 → 断言」对照；禁止 `test('...', () => {})`。
- **硬门禁**：`npx tsc -p tsconfig.json && node --test dist/harness/subagent.memory.test.js dist/harness/subagent.test.js dist/graph/agents.test.js dist/harness/security/chain.memorywrite.test.js 2>&1 | tail -8` → PASS；主链 `chainView()` 在子代理记忆注入前后**零新增 `memory` 行**（字节一致）。

### §3.5 M8 会话内可见性 + 文档同步（末任务）

- **BASE**：M7 收口后的 HEAD（`<R7>`）
- **Brief / 报告**：`task-8-brief.md` → `task-8-report.md`（**派发前已按 §2 Step 2 修正**）
- **白名单**：`src/harness/memory/extractor.ts`、`src/harness/reactor.ts`、`src/types.ts`、`src/harness/index.ts`、`src/tui/session.ts`、`src/harness/reactor.notice.test.ts`（新）、`src/tui/session.memory-toggle.test.ts`（新）、`TUI-MANUAL.md`、`README.md`
- **跨任务接口**：`settleMemory(...)` 返回 `Promise<string[]>`（新增 slug）；`ReactorDeps.settle?` / `ReactorDeps.settleMemory?` 现为 `Promise<void>`，本任务改为可返回 `string | undefined`（`reactor.ts:59,61,305–315`）；`SessionEventType`（`src/types.ts:178`）增 `'notice'`；payload `{ source: 'memory' | 'skills' | 'sunshine-md', text }`。
- **修正提示（写进 dispatch）**：`/memory on|off` 的持久化文案走 §2 Step 2 的 env 口径（**不得**再指向 SUNSHINE.md `## 记忆`）；`session.memory-toggle.test.ts` 的断言随之锚定 env 文案。
- **文档同步必含**：README 记忆控制面**三个 env 键**（`SUNSHINEX_AUTO_MEMORY` / `SUNSHINEX_LEARNED_SKILLS` / `SUNSHINEX_LEARNED_SKILL_LIMIT`，非法值装配期 fail-fast）；TUI-MANUAL `/memory` 子命令 + 动态改动尾追口径（变更只走链尾说明行、快照只在四刷新点重建）。
- **硬门禁（末任务全量）**：

```
npx tsc -p tsconfig.json && node scripts/run-tests.js 2>&1 | tail -8 && node dist/cli/index.js selfcheck 2>&1 | tail -14
```

Expected：tsc 零报错；`# fail 0`；selfcheck OK——tools 行 10 项逐字节不变、`skills : 21`、`rules : 3`。

- **旁路纪律断言面**（brief 已列，须真断言）：`settle` 返回说明行 → 链尾追加 `action:'notice'` 行 + 发 notice 事件；`settle` 抛错 → 链路照常收口、无 notice 行倒灌失败；`settle` 返回 undefined → 零追加零噪音。

---

## §4 终局（全部任务收口后）

- [ ] **Step 1: 终局全分支审查包**（MERGE_BASE＝`main` 的 merge-base ＝ `4f463cc`）

```
PKG=.superpowers/sdd/2026-09-18-memory-cc-alignment/final-review-package.md
{ echo "# final whole-branch review  $(git merge-base main HEAD)..HEAD"; git log --oneline $(git merge-base main HEAD)..HEAD; echo; git diff --stat $(git merge-base main HEAD)..HEAD; echo; git diff -U10 $(git merge-base main HEAD)..HEAD; } > "$PKG"
```

- [ ] **Step 2: 派发终局审查者**（最强模型；code-review 口径：规格覆盖 / 前缀第一要义 / 工具面零变化 / 旁路纪律 / 测试卫生），并**把 ledger 里全部 `minor (deferred)` 与 `parked` 行交给它三角定级**（哪些必须合并前修）。派发前 `grep -n "deferred\|parked" .superpowers/sdd/2026-09-18-memory-cc-alignment/progress.md` 取清单。
- [ ] **Step 3: 终局修复波（若有发现）**：**一次**派发单一修复实现者携带完整发现清单（禁止一发现一派发）；随后**恰好一次**范围化重审；残余发现按 breaker 规则裁决（park 带裁决 / 承重则 STOP 上报）。**无第二波修复**。
- [ ] **Step 4: 残件处置（需用户确认）**

`src/tui/session/**` 两文件（2026-09-17 计划遗留、`tsconfig.json` 已 exclude、未跟踪、与"任务5 focus-observe"旧计划同名且已被跟踪的 `src/tui/session.task5.test.ts` 覆盖）：

```
git check-ignore -v src/tui/session || echo "未忽略：需用户裁决（删除 / 保留 / 提交）"
```

默认建议：**删除**（陈旧重复用例，误留会误导后续任务把它当作未完成工作）。因涉及删除用户工作区文件，须经用户确认后再执行。

- [ ] **Step 5: 门禁终检 + 收口**

```
npx tsc -p tsconfig.json && node scripts/run-tests.js 2>&1 | tail -8 && node dist/cli/index.js selfcheck 2>&1 | tail -14
git status --short   # 期望：干净
```

- [ ] **Step 6: 删除本计划 SDD workspace**（`rm -rf .superpowers/sdd/2026-09-18-memory-cc-alignment/`）——git 历史即记录；**同级目录属其它计划，勿动**。
- [ ] **Step 7: 收束分支**：走 superpowers:finishing-a-development-branch（`dev1` → 合并/PR 决策交用户）。

---

## §5 编排自审记录

- **规格覆盖**：M3 收口覆盖规格 §4.1/§4.2（分类器 + 写窄口 + scope 收窄）与 D6 只读放行；M4 → §4.3/§6/§13；M5 → §3/§6；M6 → §9.2/§9.3/§9.1；M7 → §8；M8 → §9.4/§10/§7 会话内覆盖 + 文档。规格 §5/§11/§12 由各任务门禁回归项覆盖。
- **场次事实核对**：BASE 序列、HEAD `612c537`、791/791、selfcheck 10 工具/21 技能均实测取证（§0），非记忆推断。
- **命令可执行性**：全部门禁命令已在沙箱跑通等价形态（`pnpm` 不存在 → 已替换为 `npx tsc` / `node scripts/run-tests.js` / `node dist/cli/index.js selfcheck`）。
- **派发纪律核对**：每任务含 BASE、白名单、门禁命令与 Expected、报告契约、ledger 行；无并行实现者；修复轮重派而非自修；终局仅一波修复。
- **占位扫描**：无 TBD/TODO；brief 侧缺口（M7 用例名清单、M6 import 与行号漂移、M8 废弃文案）均已在 §3 给出具体处置文本，且不代替 brief 作为需求源。
