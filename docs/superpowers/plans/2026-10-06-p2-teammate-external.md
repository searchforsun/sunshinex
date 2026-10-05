# P2 Teammate 长驻 + 外部执行体 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付长驻 teammate(独立上下文 + 自主 claim)、外部 CLI 执行体(claude code stream-json)、Ctrl+T 任务视图(含 gate 行内审批)、模板宏化与 team 预算帽,消化 P1 终审遗留小项。

**Architecture:** Teammate = 独立 ContextManager + 逐任务 Reactor(共享 model/safety/派生工具面)+ MemoryPipeline 式单飞 claim 循环;其执行事件以 `payload.subagent` 打标复用既有 ChildPanel 通道。**派发路由退化语义**:无 teammate 在场 = P1 fork 顶替原样;teammate 在场时未指派 unlocked 任务留给 claim、指派任务派给对应 teammate。外部执行体经 `ProcessSandbox.execBackground` 拉起(stream-json 逐行翻译),黑盒降级只有起止与结论。Ctrl+T 仿 Ctrl+B 模态,gate 审批走既有 askUser 问题卡。

**Tech Stack:** TypeScript (tsc strict)、node:test、ink、无新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md`(§4.2/§4.3 Role 与 Executor、§5.3/§5.6 护栏与预算、§6 L1 结构共享、§8 外部执行体、§10.3 Ctrl+T、§12.1 模板宏化、§13 P2)。

## Global Constraints

- tsc strict 零报错;`pnpm test` 0 败(2 既有 win32 跳过容忍)——**全量门禁仅在 T9 由控制器后台执行**(子代理看门狗 600s 限制,逐任务只跑聚焦测试,单条命令预期 ≤8min)。
- 不破坏 P0/P1 既有行为;受保护测试零改动(T7 若需协议补齐,仅限明确列出的文件)。
- 事件 payload 结构化禁 ANSI;新词汇沿用 P0 立的协议面。
- 平台进程形态只允许出现在 sandbox.ts(CLAUDE.md §14)——外部执行体经 `ProcessSandbox.execBackground/killBackground`(McpHost 直起子进程是另一先例,本计划不采用)。
- 模拟型依赖:teammate Reactor 不传 `deps.runner`(两 Reactor 共用 runner 会互相覆盖 attachParent,reactor.ts:199-207)。
- 注释中文决策风格;模型面观察文案英文(P1 遗留修正)。
- 行号锚以语义锚优先。

## Rulings(计划级,执行不重议)

1. **agent-message(L2)移出 P2**——spec 标注「可选最后加」;文件 inbox + 回合边界投递独立成项,随 P3 前置或 P2.5。spec 回写记一笔。
2. **teammate 创建入口** = spawn 工具入参 `mode: 'team'`(nullable enum,同 isolation 形态)+ agent.md frontmatter `executor: internal-team` 声明(解析点 subagent.ts parseAgentFrontmatter);两者任一命中即建 teammate 而非一次性 fork。
3. **派发路由**:executeOne 前置检查——`assignee` 命中活 teammate → `teammate.runTask(task)`;未指派且 TeamRegistry 有活者 → 本轮跳过等 claim;无活者 → P1 fork 路径原样(退化语义,既有测试零改动保绿)。
4. **teammate 事件通道**:其 Reactor 的 onEvent 包一层打 `payload.subagent = name`,复用 ChildPanel/Inspector;任务执行的 delegation-started/ended 由 teammate 发(与 P1 executeOne 同形,label `task-tN`、kind 'subagent')。
5. **外部执行体任务级路由**:`executorHint: 'external-cli'` 的任务派给 ExternalCliExecutor(黑盒:delegation started/ended + 结论,无中间转录);DelegationKind 扩 `'external-cli'`。
6. **gate 行内审批**走既有 `ctrl.askUser` 问题卡(AskUserRequest 通道,与工具审批管线独立),答案映射 `board.review(taskId,{approved})`。
7. **teammate 数量帽** `MAX_TEAMMATES = 4`(TeamRegistry 常量);**team token 帽** `SUNSHINEX_TEAM_TOKEN_CAP`(termination-config 先例形态,缺省不设——预算是兜底不是限制,同 subagent 口径)。
8. **模板宏化**:新增纯函数 `templateToTaskSpecs`(节点元数据 → 任务集);pipeline CLI 走 board 路径(展开 → create → 等收口 → gate 审批映射 review);selfcheck 消费面 `.name/.nodes/.engine` 不动(零迁移)。
9. **teammate 上下文** = 每 teammate 一个 `new ContextManager(root, store)`(独立链,不入会话 journal;可见性全靠事件面)。

---

### Task 1: P1 遗留消化(executorHint / create-gated / 事件补齐 / 观察英文化)

**Files:**
- Modify: `src/taskboard/model.ts`(BoardTask.executorHint + 事件变体扩展)
- Modify: `src/taskboard/board.ts`(create 入参 gated/executor + setDependency/assign 发事件 + summaryLines 英文 + finishExecution 抽取[本任务只做抽取不改行为])
- Modify: `src/harness/tools/taskboard-tools.ts`(create_task/gate_task 入参与描述更新)
- Modify: `src/tui/session.ts` boardEventFrom(新增两事件翻译)
- Test: `src/taskboard/model.test.ts`、`src/taskboard/board.test.ts`、`src/taskboard/mirror.test.ts` 各扩展用例

**Interfaces:**
- Consumes: P1 全部(taskboard 栈)
- Produces(T2-T8 依赖):
  - `BoardTask.executorHint?: 'internal' | 'external-cli'`(model.ts)
  - `BoardEvent` 新变体:`{ t: 'dependency-added' ... }` 已有;新增 `{ t: 'gate-set-at-create'; taskId: string; ts: number }` 不引入——**裁定:create 的 gated 经既有 gate-set 事件表达**(create 时若 gated,先 task-created 再 gate-set 两事件);`set_dependency`/`assign` 的 UI 通知用既有 SessionEvent 面**新增两型**:`'task-dep-added' {taskId, dependsOn}`、`'task-assigned' {taskId, assignee}`(types.ts SessionEventType 追加;board.emit,boardEventFrom 翻译为 dependency-added/assigned)
  - `TaskBoard.create(input): Result<{taskId}>` 入参扩 `{ ..., gated?: boolean, executor?: 'internal' | 'external-cli' }`
  - `TaskBoard.finishExecution(taskId: string, r: { ok: boolean; reply?: string; tokens?: number }): void`——从 executeOne 抽出的共享回写单点(claimed→in-review/failed + 事件 + artifact + finish + blocked 下游),T2 teammate 路径复用
  - `summaryLines()` 输出改英文:`t1 [in-review] A (needs t2)` / gated 标 `[gated]`

- [ ] **Step 1: 失败测试**——model.test.ts 加:executorHint 随 task-created 事件入板(BoardEvent task-created 变体加 `executorHint?`);board.test.ts 加:(a) `create({...,gated:true})` 产出 task-created + gate-set 两事件且任务 gated 不派发;(b) `create({...,executor:'external-cli'})` 后 snapshot().tasks[t].executorHint === 'external-cli';(c) setDependency/assign 各自发出 task-dep-added/task-assigned SessionEvent(载荷核字段);(d) summaryLines 无中文(断言 `!/\(等 /` 且含 `needs`/`[gated]`);(e) finishExecution 手工路径:claimed 任务经 finishExecution(ok) → in-review + 事件 + ledger finish(fake registry 计数)。mirror.test.ts 事件脚本加 setDependency/assign 两步,断言镜像仍 deepEqual。
- [ ] **Step 2: 跑测确认失败** `pnpm build && node --test dist/taskboard/model.test.js dist/taskboard/board.test.js dist/taskboard/mirror.test.js`
- [ ] **Step 3: 实现**——按 Interfaces 逐条:types.ts 联合追加 `'task-dep-added' | 'task-assigned'`;model.ts BoardTask/BoardEvent(task-created 加 executorHint?)/applyBoardEvent 分支;board.ts create 扩参(gated → 追加 gate-set 事件+emit gate-waiting)、setDependency/assign 尾部 emit、summaryLines 英文、executeOne 的回写段抽为 `finishExecution`(executeOne 调它,行为零变化);tools 的 create_task parameters 加 `gated`/`executor`(nullable enum),description 补一句 gated-at-create 用法(替代借边建门的 workaround 文案);session.ts boardEventFrom 加两翻译分支。
- [ ] **Step 4: 跑测通过 + 回归** 上命令 + `node --test dist/harness/tools/taskboard-tools.test.js dist/tui/session.board.test.js`
- [ ] **Step 5: 提交** `feat(taskboard): P1 遗留消化——executorHint/建即 gated/set_dependency·assign 事件(task-dep-added·task-assigned 新型)/summaryLines 英文化/finishExecution 回写单点抽取`

---

### Task 2: Teammate 核心(独立上下文 + claim 循环 + 派发路由)

**Files:**
- Create: `src/taskboard/teammate.ts`
- Modify: `src/taskboard/board.ts`(TaskBoardDeps.team? + claim() + 路由)
- Test: `src/taskboard/teammate.test.ts`

**Interfaces:**
- Consumes: Task 1(finishExecution)、Reactor/ContextManager/ToolRegistry(harness)
- Produces(T3-T5、T8 依赖):
  - `class TeamRegistry { register(t: Teammate): Result<void>(帽 MAX_TEAMMATES=4,INVALID_ARG 超额); get(name): Teammate | undefined; hasAlive(): boolean; stop(name): void; stopAll(): void; aliveNames(): string[] }`
  - `class Teammate { readonly name: string; constructor(opts: { name: string; framing: string; deps: { safety; model; registry: ToolRegistry; root: string; store: StorageAdapter; board: TaskBoard; onEvent?: (e: SessionEvent) => void; taskTimeoutMs?: number } }); kick(): void; stop(): void; isBusy(): boolean; runTask(task: BoardTask): Promise<void>(board 指派路径入口,置 busy、跑完回写、再 kick claim) }`
  - `TaskBoard.claim(assignee: string): BoardTask | undefined`(原子取首个 dispatchable 未指派任务:pending→claimed 事件化;无则 undefined)
  - `TaskBoardDeps.team?: TeamRegistry`;executeOne 路由:assignee 命中活 teammate → `void tm.runTask(task)` 后返回(不 await 整批——runTask 自含回写与续 claim);未指派且 team?.hasAlive() → return(留 claim);否则 P1 fork 路径
  - Teammate 内部:own `ContextManager`;per-task `new Reactor({ registry: 子面[T3 完成前先传派生空面], safety, context: own, model, root, onEvent: 打标包装 })`;`scope:'fork'` + seedHistory = role 行 + 板摘要行 + task 行(由 own context 预置 chain 构造——实现按 subagent.ts:424-439 子 Reactor 形态,seed 经 ReactorOpts.seedHistory);claim 循环 = MemoryPipeline 单飞形态(`claiming` 闩 + kick + `while` 取 `board.claim(name)`);每任务 `run` 完调 `board.finishExecution`(含 delegation-started/ended 由 Teammate 自发,kind 'subagent'、label `task-tN`)

- [ ] **Step 1: 失败测试** `src/taskboard/teammate.test.ts`:
```ts
// 装配:真 TaskBoard(fake runner 兜底路径)+ 真 Teammate(fake model:ScriptedAdapter 无限 done 回复——
// 用自增计数 fake ModelAdapter:chat() 恒返回 Promise.resolve({ done:true, reply:`done ${n++}` }) 最小桩,现场对齐 ModelAdapter.chat 签名)
test('teammate 自主 claim:建 2 任务未指派,teammate 串行消化,回写 in-review', async () => {
  // board.create×2(无 assignee);teammate.kick();等两任务 in-review(轮询快照 ≤2s)
  // 断言:fake fork runner 零调用(未走 P1 路径);delegation 事件 4 条(started/ended×2,kind subagent,label task-t1/t2)
});
test('派发路由:assignee 命中 teammate → runTask;无活 teammate → fork 退化', async () => {
  // ① 无 team 注册:create 未指派 → P1 fork(fake runner 被调)
  // ② 注册 teammate 后 create assignee:'w1' → runTask 路径(fake runner 零调用,w1 busy→in-review)
});
test('帽与停stop:第 5 个 teammate 拒;stop 后 hasAlive=false,未指派任务回退 fork 路径', async () => { ... });
```
- [ ] **Step 2: 确认失败**(Cannot find module './teammate')
- [ ] **Step 3: 实现** teammate.ts + board.ts 路由/claim。要点:Teammate.runTask 与 claim 循环共用私有 `execute(task)`;stop = AbortController abort + 循环自然退出(busy 任务跑完不续 claim);runTask 指派路径同样走 execute;`own context` 的链构造:首任务前 appendChain role 行 + 每任务前 appendChain task 行(独立链,零主链污染)。
- [ ] **Step 4: 跑测 + 回归** `node --test dist/taskboard/teammate.test.js dist/taskboard/board.test.js dist/taskboard/crash.test.js`(崩溃用例不涉 team,退化语义必须仍绿)
- [ ] **Step 5: 提交** `feat(taskboard): Teammate 长驻执行体——独立 ContextManager + 逐任务 fork-scope Reactor(事件打标复用 ChildPanel 通道)+ 单飞 claim 循环 + 派发路由退化语义(无活 teammate=P1 原样);TeamRegistry 帽 4`

---

### Task 3: teammate 工具面 + L1 注入 + 创建入口(spawn mode:'team' / frontmatter executor)

**Files:**
- Create: `src/taskboard/teammate-tools.ts`(get_board/get_task 只读工具)
- Modify: `src/harness/subagent.ts`(SubagentSpawnInput.mode?、parseAgentFrontmatter 解析 executor、makeSpawnTool 分流、deriveChildRegistry 不变[五件套仍剔,get_board/get_task 不在主链面])
- Modify: `src/harness/index.ts`(TeamRegistry 装配 + spawn 分流接线 + teammate 构造件)
- Test: `src/harness/teammate-spawn.test.ts`

**Interfaces:**
- Consumes: Task 2 Teammate/TeamRegistry;taskboard-tools 的 board 实例
- Produces:
  - `SubagentSpawnInput.mode?: 'team'`(types.ts);spawn executor:`mode === 'team'` 或 role frontmatter `executor === 'internal-team'` → `harness 侧 teamRegistry.register(new Teammate({...}))` 回执 `teammate <name> started (claims unassigned tasks; stop via task_stop <name>)`——**裁定:teammate 登记进 TaskRegistry(kind 'subagent', label=name)以便 task_stop 停**;否则原路径
  - `makeTeammateTools(board): RegisteredTool[]`——`get_board`(无参,回 board.summaryLines().join('\n'))与 `get_task`({taskId},回该任务 spec/status/deps/artifact 摘要),category 'read',只入 teammate 派生面
  - teammate 派生面构造(export 自 teammate.ts 或 teammate-tools.ts):`deriveTeammateRegistry(base: ToolRegistry, board: TaskRegistry→TaskBoard): ToolRegistry` = `base.derive({ exclude: [SPAWN, TODO, 'ask_question', 'worktree', ...TASKBOARD_TOOL_NAMES] })` + register(get_board/get_task)
  - frontmatter:`executor: internal-team | external-cli`(parseAgentFrontmatter 增键,AgentDef.executor?;resolve 返回带上)

- [ ] **Step 1: 失败测试**:spawn envelope `{"tool":"spawn","input":{"prompt":"...","label":"w1","mode":"team"}}` 经真 Harness(dontAsk + 计数 fake model)→ 断言:回执含 `teammate w1 started`;TeamRegistry.aliveNames() 含 w1;主链工具面不含 get_board(`h.tools.get('get_board') === undefined`)而 teammate 派生面含;frontmatter 用例:临时 agents/ee/agent.md 带 `executor: internal-team` → spawn 无 mode 也建 teammate。清理:teardown stopAll。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(index.ts 构造 `this.team = new TeamRegistry()` 于 taskboard 之后并互相接线:TaskBoardDeps.team 注入;spawn 分流在 makeSpawnTool executor 内经新回调 `opts.spawnTeam?: (spec) => Result<string>`——裁定:makeSpawnTool 加可选参 `team?: (input) => Result<{ name }>` 避免反向 import Teammate)
- [ ] **Step 4: 跑测 + 回归** `node --test dist/harness/teammate-spawn.test.js dist/harness/subagent.spawn.test.js dist/taskboard/teammate.test.js`
- [ ] **Step 5: 提交** `feat(harness): teammate 创建入口——spawn mode:'team' 与 frontmatter executor:internal-team 双通道;teammate 只读板工具 get_board/get_task(L1 拉详情);task_stop 可停;主链面零污染`

---

### Task 4: team 预算帽

**Files:**
- Modify: `src/config/termination-config.ts`(`teamTokenCapEnv(): number | undefined`,env `SUNSHINEX_TEAM_TOKEN_CAP`)
- Modify: `src/taskboard/board.ts`(tokensUsedTeam 累计自 finishExecution 的 tokens;drain 前置检查:超帽 → 不派发新批,记一次 notice 事件 `task-status-changed` 不发——**裁定:发一条 `task-blocked` {taskId:'*',blockedBy:['team-token-cap']} 语义过载,改为不发明:summaryLines 尾行附 `team budget exhausted (X/Y)` 供工具观察;drain 直接 break**,注释引 spec §5.6)
- Test: `src/taskboard/board.test.ts` 扩用例

- [ ] **Step 1: 失败测试**:注入小帽(deps.teamTokenCap = 15,fake runner 每任务 tokens 10)→ 建 3 个无依赖任务 → 仅 1 个执行,其余 pending;summaryLines 含 `team budget exhausted`;帽拆除(undefined)后 kick 恢复派发。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(TaskBoardDeps.teamTokenCap?: number;构造期经 teamTokenCapEnv() 缺省注入于 harness 装配处 index.ts)
- [ ] **Step 4: 跑测** board.test + teammate.test(帽与 teammate 共存:teammate claim 也过帽——claim() 前置同检,超帽返回 undefined)
- [ ] **Step 5: 提交** `feat(taskboard): team 预算帽——SUNSHINEX_TEAM_TOKEN_CAP(缺省不设);drain/claim 双前置检查,超帽留 pending 不失败;板摘要尾行透出用量`

---

### Task 5: ExternalCliExecutor(claude code stream-json)

**Files:**
- Create: `src/taskboard/executors/external-cli.ts`
- Modify: `src/delegation/projection.ts`(DelegationKind 加 `'external-cli'`)
- Modify: `src/taskboard/board.ts`(executeOne 路由:`task.executorHint === 'external-cli'` 且 deps.externalExecutor 在场 → 走注入口;**分层口径:TaskBoardDeps.externalExecutor?: { run(task: {id;title;spec}, budget: {deadlineAt}): Promise<{ok;reply;tokens}> }**——board 只依赖此最小接口,真 ExternalCliExecutor 由 harness/index.ts 装配注入[与 T8 的注入口同一处,生产接线在本任务完成])
- Test: `src/taskboard/executors/external-cli.test.ts`

**Interfaces:**
- Consumes: `Executor`(src/taskboard/executor.ts,P1 定型)、ProcessSandbox.execBackground/killBackground、TaskBoard.finishExecution
- Produces:
  - `class ExternalCliExecutor implements Executor`——`constructor(deps: { sandbox: ProcessSandbox; registry: TaskRegistry; onEvent?: (e: SessionEvent) => void; command?: string(缺省 'claude'); env?: Record<string,string> })`;`capabilities()` 返回 `{ contextSource:'independent', tools:[], stopGranularity:'process', budgetModel:'deadline-coarse' }`;`run(task: { id; title; spec }, budget: { deadlineAt: number }): Promise<{ ok: boolean; reply: string; tokens: number }>`——内部:`registry.submit({kind:'exec', label:'external-'+task.id})` 登账;`sandbox.execBackground('<command> -p <spec-shell-escaped> --output-format stream-json', { onData: 增量行缓冲→JSON.parse→翻译, onExit })`;翻译表:assistant 文本段→`token` 事件(打 `payload.subagent='external-'+task.id`)、tool_use→`tool-call`、result 行→结论缓存(usage 入 tokens);超时(deadline)→`killBackground(pid)` + failed;spawn 失败(CLI 不在)→ failed + note 'external executor unavailable'
  - board.executeOne 路由分支:external 任务 emit delegation-started(kind 'external-cli')→ `await executor.run(...)` → finishExecution → delegation-ended;**黑盒降级**:无 onData 翻译产出时 UI 仅见起止(测试断言 tolerated)

- [ ] **Step 1: 失败测试**:fake sandbox(注入构造,方法桩 onData/onExit 手动驱动)+ 预录 stream-json 行(系统行/assistant 文本/result)→ 断言翻译事件序列、结论与 tokens、账本 finish done、kill 路径(deadline 已过 → killBackground 被调 + failed)、CLI 缺失(execBackground throw)降级。再一用例:真 TaskBoard + fake ExternalCli(成功)→ executorHint 任务走 external 分支(kind 'external-cli' 的 delegation 对)。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(spec 经 shell 单引号转义;行缓冲跨 chunk 拼接;windows shell 决议交 sandbox.resolveShell 既有链)
- [ ] **Step 4: 跑测 + 回归** `node --test dist/taskboard/executors/external-cli.test.js dist/delegation/projection.test.js dist/taskboard/board.test.js`
- [ ] **Step 5: 提交** `feat(taskboard): ExternalCliExecutor——claude code stream-json 适配(经 sandbox.execBackground 分层),黑盒降级,kind 'external-cli' 入投影;任务级 executorHint 路由`

---

### Task 6: 模板宏化

**Files:**
- Modify: `src/graph/templates.ts`(节点元数据导出:`templateToTaskSpecs(goal, opts): Array<{ id: string; title: string; spec: string; dependsOn: string[]; gated?: boolean; role?: AgentRole }>`——五节点映射:planner/developer/reviewer=role 任务、test-verify=loop 任务(spec 注明 test-loop 语义)、delivery-gate=gated 任务;softwarePipelineTemplate 原样保留[selfcheck 零迁移])
- Modify: `src/cli/commands/run-pipeline.ts`(board 路径:**裁定:`runtime.ts buildDeps` 增补 `taskboard: h.taskboard` 透传字段**,run-pipeline 经 deps.taskboard 消费)→ templateToTaskSpecs → **两段装配:create 逐个(收集模板节点名→board taskId 映射,模板节点名入 title 前缀)→ 依赖边经 `setDependency(idMap[模板id], idMap[依赖])` 补齐** → `await board.settle(timeoutMs)`[新方法:轮询快照至无 pending/claimed 或超时,100ms 间隔——waitUntilSettled 先例]→ paused 语义 = 存在 gated 任务 → readline 审批循环映射 `review(id,{approved})` → 再 settle → 汇总回执含每任务 status/conclusion 摘要)
- Modify: `src/taskboard/board.ts`(+ `settle(timeoutMs): Promise<TaskBoardState>`)
- Test: `src/graph/templates.test.ts` 扩 + `src/cli/run-pipeline.macro.test.ts`(新——不拉真 CLI 入口,直测 templateToTaskSpecs 输出五任务与依赖边/gated;board.settle 单测入 board.test)

- [ ] **Step 1: 失败测试** → **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑测 + 回归**(selfcheck 不改:`pnpm selfcheck` 输出仍含 `software-pipeline template ready`)
- [ ] **Step 5: 提交** `feat(graph): 模板宏化——templateToTaskSpecs 纯函数(五节点→任务集,gate→gated 任务);pipeline CLI 走 TaskBoard 统一调度(审批映射 review);softwarePipelineTemplate 与 selfcheck 消费面零迁移`

---

### Task 7: Ctrl+T 任务视图 + gate 行内审批

**Files:**
- Create: `src/tui/components/BoardList.tsx`(行:`t1 [in-review] A  ← t2` / gated 高亮;每页 8 行,仿 BrowseList)
- Create: `src/tui/components/use-board-keys.ts`(模态键分发:↑↓/回环、Esc 退、Enter=gate 审批[gated 行] / 其余行无操作、G 刷新;仿 use-browse-keys)
- Modify: `src/tui/components/App.tsx`(boardMode 状态 + Ctrl+T 进入[判定序插在 browse 之后]+ 渲染分支[动态区让位同 browse]+ gate 审批接 `controller.askUser({question:`approve gate on ${id}?`,options:[approve/deny]})` → `controller.runtime.harness.taskboard.review(id,{approved})`)
- Test: `src/tui/components/BoardList.test.tsx` + `src/tui/components/App.board.test.tsx`

- [ ] **Step 1: 失败测试**:BoardList 渲染(状态/deps/gated 标);App 集成:喂 task 事件 → Ctrl+T → 帧含 `t1 [pending]` → Enter 于 gated 行 → 问题卡出现 → 选 approve → `review` 生效(board 投影 gate-resolved 后状态恢复 pending 且后续可派发——经 onEventForTest 喂 gate-resolved 断言帧更新)。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(askUser 在 TUI 测试里经 onAskUser 桩或直接调用注入;App 键判定序注释更新)
- [ ] **Step 4: 跑测 + 回归** `node --test dist/tui/components/BoardList.test.js dist/tui/components/App.board.test.js dist/tui/components/App.spawn-browse.test.js dist/tui/session.board.test.js`
- [ ] **Step 5: 提交** `feat(tui): Ctrl+T 任务视图——三态行/依赖箭头/gated 高亮;gate 行内审批经 askUser 问题卡映射 review(spec §10.3;DAG 图留 GUI)`

---

### Task 8: e2e 验收(3 teammate × 6+ 任务 + 帽排队 + 外部同现)

**Files:**
- Test: `src/harness/team.e2e.test.ts`(新,零产品码)

- [ ] **Step 1: 测试**(ScriptedAdapter 无限 done 桩不可用——teammate 各自独立 context 各自消费:用**计数 fake ModelAdapter**(每 chat 返回 done+reply`ok n`)注入 harness opts.model,三 teammate 共享该 adapter,任务卡片消费天然串行):真 Harness → spawn×3(mode:'team',label w1-w3)→ create 7 任务(t2/t3 依赖 t1;t7 executorHint 不设[内部一致])→ task_wait(null) 轮询至全部 in-review → review×7 → 断言:全部 done;每 teammate 至少 1 任务(busy 均分不强求,断言 w1∪w2∪w3 覆盖全部 7 个 delegation-started 的 label);帽用例:teamTokenCap 注入小值 → 部分 pending + `team budget exhausted` 在 summaryLines;外部同现:fake ExternalCli 经 board 注入(deps.externalExecutor 桩——裁定:TaskBoardDeps.externalExecutor?: { run(...) } 注入口,生产装配 ExternalCliExecutor,harness/index.ts 接线)→ executorHint:'external-cli' 任务其 delegation 事件 kind 'external-cli' 且面板行与其他任务同现(事件断言)。清理:team.stopAll + stopAllTasks。
- [ ] **Step 2: 跑测**(超 8min 风险低:假模型毫秒级)→ **Step 3: 提交** `test(harness): P2 e2e——3 teammate 消化 7 任务(依赖序/claim 分担/review 闭环)+ team 帽排队 + external executor 同现(kind 'external-cli')`
- [ ] **Step 4: 若产品缺陷暴露回对应任务修(报告记录)**

---

### Task 9: 全量回归 + spec 回写(控制器执行)

- [ ] `pnpm test` 后台跑(0 败/2 既有跳过);`pnpm selfcheck`;spec §13 P2 落地记录(含 agent-message 移出裁定与去向)+ §11 补 executorHint/kind 扩员注记;提交 `docs(spec): P2 执行回写`。
