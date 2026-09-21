# Worktree 隔离工作区 · 实施计划

- 日期：2026-09-20
- 规格锚点：`docs/superpowers/specs/2026-09-20-worktree-isolation-design.md`（提交 7b33c20 在史，用户「开始」批准；含同日 .env 勘误两处——拷贝面仅 `.sunshinex/settings.json`）
- 执行方式：待用户裁定（会话内联 TDD / 子代理驱动，呈现计划时问卷，沿 fork/子代理/goal 三先例）
- 提交策略：本会话停手承诺延续——实施期改动**全部留工作区不提交**，提交时机与方式由用户裁定（§5）
- 基线：工作区多线 WIP 在飞（askquestion 选择器线 T2、envelope 迁移 T4、rewind/fork T2）；本线 T1/T2 落点低重叠，T3–T5 与 askquestion 线在 `types.ts`/`tools/builtin.ts`/`reactor.ts` 高重叠，协调策略见 §3

## 0. 全局约束（贯穿全部任务）

1. **TDD 纪律**：每任务先红灯（新语义断言在场并失败）后绿灯；红灯必须真实运行过，闸门一律 fail 0 硬断言（T4-6 事故先例，禁 grep 命中数当闸门）。
2. **门禁三件套**：`pnpm build`（tsc strict 零报错）+ 全量测试（fail 0）+ `selfcheck`；T6 收口复验一次全量。
3. **单文件单编辑**：同一文件同轮不并发两次编辑（structured_output / fork / envelope 三写入竞态先例）。
4. **测试卫生**：临时目录 `fs.mkdtempSync`；涉及家目录断言 HOME + USERPROFILE 双变量重定向（win32 data-dir 三失败先例）；git 集成用例在临时仓（`git init` 真仓）内跑，不触用户真实仓。
5. **git 调用纪律（产品代码）**：本线全部 git 命令收敛 `worktree.ts` 单点——`spawnSync('git', args, { cwd, timeout })` 参数数组、无 shell 拼接、失败返回 `Result.fail`（错误码 `WORKTREE_*`），沿 perception Git 感知先例。
6. **沙箱 git 停手**：实施期助手侧零 `git add/commit`，改动留工作区待用户处置（§5）。
7. **语义纪律**：提示词面零新增动态面；工具 description 恒英文单语（CLAUDE.md §15 有无写链判据）；观察回执英文单语；前缀回归钉子随 T6 落地。

## 1. 现场核实项（T1 编码前钉死，禁止臆造）

计划期未 100% 钉死的六处现行事实，T1 第一个动作即核实并把结论登记进 `worktree.ts` 模块头注释：

1. `security/sandbox.ts` 执行 cwd 来源——决定 exec 锚定活动 root 的改动点。
2. `builtinTools` 第 2 参 `root` 的实际消费点（glob/grep 缺省根？）——决定活动 root 切换是否需触碰工具注册面（目标：不需要，路径锚定全在 SafetyChain 注入的 safePath）。
3. `cli/index.ts` flag 解析器对「裸 flag」与「flag=value」的现行形态（`--continue` 裸 flag、`--tier=` 值形态两先例）。
4. `security/chain.ts` 工具名形态（`'Write'` 大写先例）与读类工具精确名单——读面恒开放的枚举依据。
5. `security/guard.ts` spawn 免审批分支与 plan 只读闸门现行行——worktree 分支沿同款落点。
6. `reactor.ts` 并行闸门现行判定行（exec 单发独占判定）——worktree 与 exec 同列。

## 2. 任务拆分（6 任务 TDD 循环）

> 落点一律写「文件+符号」形态：并发线在飞、行号会漂，实施时以现行字节为准。

### T1 — worktree 单点模块

落点：新增 `src/harness/worktree.ts`、新增 `src/harness/worktree.test.ts`。

**红灯用例（worktree.test.ts，临时 git 仓内集成测试）**：

1. `createWorktree`：合法名（`/^[a-z0-9][a-z0-9-]{0,63}$/`）在 `<dataDir>/worktrees/<name>/` 建树、分支 `worktree-<name>` 从当前 HEAD 分叉；建树后 `detectIsolation` 为 true（git-dir ≠ common-dir）。
2. 错误码矩阵：撞名已存在 → `WORKTREE_EXISTS`；非法名（大写/`..`/空/超长）→ `WORKTREE_INVALID_NAME`；root 非 git 仓 → `WORKTREE_NOT_A_REPO`；git 命令失败 → `WORKTREE_GIT_FAIL`（message 附 stderr 截断）。
3. `detectIsolation`：主仓 false；worktree 内 true；superproject 非空（submodule）按普通仓处理（Step 0 护栏）。
4. `removeWorktree`：porcelain 空 → 删树含分支 + registry 移除条目，返回 `removed`；porcelain 非空 → 保留 + registry 写 `keptReason`，返回 `kept-dirty`。
5. registry 读写：字段 `{ name, path, branch, sessionId?, createdAt, keptReason? }`；文件缺失/损坏 JSON 容错（重建为空表，不抛）。
6. `slugifyLabel`：非法字符折叠 `-`、连续折叠归一、总长截断为随机尾留位。

**绿灯实现要点**：导出面 `isValidWorktreeName` / `slugifyLabel` / `worktreesRoot(dataDir)` / `detectIsolation(root)` / `createWorktree` / `removeWorktree` / `readRegistry(dataDir)` / `isDirty(path)`；git 调用收敛 `execGit` 单点；零新依赖；§1 核实结论登记模块头。

### T2 — 安全链活动 root + Harness 接缝

落点：`src/harness/security/chain.ts`（活动根判定）、`src/harness/index.ts`（`activeRoot` 状态 + `enterWorktree`/`exitWorktree`/`cleanupWorktrees` 接缝）、`src/harness/subagent.ts`（deps 增可选 `rootProvider`，派生 fork root 取活动值）、`chain.test.ts` / `harness 装配测试` 扩展。

**红灯用例**：

1. `chain.enterWorktree(p)` 后：写类工具目标 ⊆ 活动根 → 放行且 `safePath` 锚活动根；目标 ⊆ 主根 → 拒（界外语义，回执提及 worktree 会话）；`exitWorktree()` 后恢复原判定。
2. 读面恒开放：活动根在场时，读类工具对主根与活动根**均可读**（规格 §11 对比审查语义）；活动根缺省时行为与今日逐字节一致。
3. 记忆写窄口先于活动根判定（2026-09-18 审查裁决序保持）：activeRoot 在场不改变记忆路径定性。
4. `Harness.enterWorktree/exitWorktree`：`safety/context/runner` 引用不重建即生效；fork 子 Reactor 的工作目录事实=活动根（经 `rootProvider`）。
5. `cleanupWorktrees()`：仅清理本实例创建的树（porcelain 空 → 删；脏 → 留 + keptReason）。

**绿灯实现要点**：SafetyChain 增私有可变 `activeRootReal: string | null`（构造期 `rootReal` 主基准不动，切换时防御性 realpath 沿构造先例）；判定序 = 记忆窄口 → 活动根命中放行 → 活动根在场时主根写类拒 → 既有 root 语义；Harness 增 `activeRoot` 只读访问器与三方法；Runner 内 fork root 取 `deps.rootProvider?.() ?? deps.root`。

### T3 — 启动旗标 `--worktree`

落点：`src/cli/index.ts`（flag 解析 + USAGE）、`src/cli/commands/run-loop.ts`（run 入口）、`src/tui/entry.ts`（tui 入口）。

**红灯用例**：

1. `--worktree=<name>`：装配前创建（或撞名报错 fail-fast），root 替换为 worktree 路径——banner 与上下文工作目录事实行均为该路径，整场恒定。
2. 裸 `--worktree`：自动生成 `wt-` + 4 位随机名。
3. 非 git 目录：fail-fast 报错含 `WORKTREE_NOT_A_REPO` 语义，不进装配（run 与 tui 两入口同口径）。
4. `--continue` 与 `--worktree` 同用：报错互斥并提示（规格 §7）。
5. USAGE 增 `--worktree[=<name>]` 行。

**绿灯实现要点**：入口层解析（`path.resolve(dir)` 之后）→ `createWorktree` → **root 替换为返回路径** → 既有装配链（buildDeps/SessionController/SafetyChain/ContextManager）零改动全量继承（规格 D5）；自动名生成放 `worktree.ts` 单点。

### T4 — `worktree` 模型工具

落点：`src/types.ts`（`ToolCategory` 联合追加 `'worktree'`）、`src/harness/tools/builtin.ts`（注册；现签名 10 可选参，追加第 11 参 seam 沿 `memoryWrite`/`ask` 先例形态）、`src/harness/tools.ts`（并行闸门：worktree 与 exec 同列单发独占）、`src/tui/tool-verbs.ts`（`worktree: 'WORKTREE'` + TARGET_FIELD `name`）、`src/harness/security/guard.ts`（免审批分支 + plan 拦截，沿 spawn 分支落点）。

**红灯用例**：

1. 装配后工具清单含 `worktree`、按名排序落位、description 恒英文单语。
2. `create`：观察回执含路径与分支名；随后 write 相对路径落 worktree（端到端活动根生效）；`exit` 后回主根；未激活 `exit` 报 `WORKTREE_NOT_ACTIVE`。
3. `list`：输出登记表摘要（name/branch/dirty）。
4. 并行闸门：worktree 与 exec 同批被拒（单发独占，文案同款口径）。
5. plan 模式：`create`/`exit` 拒绝、`list` 放行（规格 §8 拦截口径）。
6. manual 模式：worktree 全动作免审批（deny 规则仍先行）。

**绿灯实现要点**：工具内调用 Harness 三方法（create/exit/list→registry 摘要）；plan 拦截与免审批收敛 guard 单点；工具清单 +1 = 一次全量前缀断点（规格 D2 已裁决即论据）。

### T5 — 子代理 `isolation: worktree`

落点：`src/types.ts`（SubagentSpawnInput 增 `isolation?: 'worktree'`）、`src/harness/subagent.ts`（frontmatter 解析增 `isolation` 键 + Runner 派生路径与收口清理）、`subagent.test.ts` 独立文件。

**红灯用例**：

1. frontmatter `isolation: worktree` → fork 前建专属树（名 `subagent-<净化label>-<4位随机>`，分支同 §6.1 统一规则），子 Reactor 工作目录事实=worktree。
2. spawn 入参 `isolation` 优先于 frontmatter。
3. 收口：porcelain 空 → 自动删（含分支）；有改动 → 保留 + registry `keptReason` + 结论行附 worktree 路径。
4. 建树失败 → 该子代理 fail-bounded 失败补丁行，父任务不炸；并行批多个 isolation 子代理互不撞名。
5. 回归钉：未声明 isolation 的 spawn 行为零变化。

### T6 — 文档同步 + 回归钉子 + 门禁收口

落点：`TUI-MANUAL.md`、`README.md`、`CLAUDE.md` §3 目录树一行（`worktree.ts` 单点注记）。**CLAUDE.md 为并发热点**（claude_md_rewrite 线未提交 WIP 在飞）：编辑前重读现行字节、按 hunk 只挑本线行。

**回归钉子（规格 §12 三条强制项）**：

1. 旗标会话首帧工作目录事实行=worktree 路径且整场逐字节不变。
2. 会话内 create→exit 全程相邻帧前缀逐字节稳定（差异只落尾追观察/说明行）。
3. fork 首帧连续钉子沿用全绿；动态面盘点——`worktree.ts` 零 `new Date`/`toISOString` 进提示词面（registry `createdAt` 属数据面文件、允许）。

**收口门禁**：`pnpm build` + 全量 fail 0 + `selfcheck`；验收矩阵 §5 六条逐条勾验。

## 3. 并发线协调（askquestion 线在飞，T4 落点高重叠）

`types.ts`（ToolCategory）、`tools/builtin.ts`、`reactor.ts` 并行闸门与 askquestion 线 T2 重叠。纪律：每任务开工前重读目标文件现行字节、按 hunk 只挑本线改动、本线测试放独立文件（`worktree.test.ts`/`subagent.test.ts` 追加用例或独立 `worktree-*.test.ts`）防竞态；T4 开工时若 'ask' 类已并联合则 'worktree' 顺延追加，若未落则按现行字节独立追加、零触碰其改动。

## 4. 执行方式与提交策略（呈现计划时问卷裁定）

- 执行方式：A=会话内联 TDD（goal/子代理/goal 计划三先例缺省形态）；B=子代理驱动 SDD（tui_subagent_expand 线先例：每任务独立子代理 + 主代理逐 hunk 核验）。
- 提交策略：A=全程不提交，T6 收口后由用户统一处置（本线停手承诺延续）；B=恢复助手侧单点提交——计划文件即时入库 + 每任务收口「临时索引+commit-tree+竞态护栏」单文件提交，零卷入他线。

## 5. 验收矩阵（对应规格 §15 六条）

1. 旗标：`--worktree` 后 root=worktree 路径，banner/上下文事实行一致；非 git 目录 fail-fast。
2. 工具：create/exit/list 全路径 + 五错误码（EXISTS/INVALID_NAME/NOT_ACTIVE/NOT_A_REPO/GIT_FAIL）；切换后 write 落 worktree、主工作区零改动。
3. 子代理：frontmatter 与入参两通道生效、入参优先；有改动保留时结论行带路径。
4. 清理：porcelain 空自动删（含分支）；有改动保留 + keptReason；CLI run 路径恒保留。
5. 强制隔离：worktree 会话中写主工作区被拒、读主工作区放行、exit 后判定还原。
6. 前缀：三条回归钉子全绿 + 三门禁（build/全量 fail 0/selfcheck）。

## 6. 偏差登记预留

实施期与规格/计划的偏差就地登记本节（沿 goal 线「计划偏差 N 处登记」先例），收口时汇总呈现；规格级分歧（如活动根判定序需偏离 §11 口径）先登记再实施、不静默变更。
