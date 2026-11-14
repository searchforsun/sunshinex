# Sunx P1（编排会话原型）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `kind='sunx'` 的编排专职会话：装配期分叉出总章程提示词 + 分派工具白名单面；模型经 `dispatch_task` 后台派发 fork 子智能体、收轮后被既有 bg-wake 唤醒接续；GUI 可创建（姓名/工作目录/品格）与对话。普通会话零行为变化。

**Architecture:** Sunx 不是新引擎——复用 SessionRuntime 全套器官（单 run 锁/journal/挂起表/steer/WakeController）。装配分叉三处：①`stableSegmentOf` 按 kind 分支出 Sunx 总章程（稳定段，跨实例字节一致）；②实例品格走会话级冻结层（SUNSHINE.md 同区，出生定版；修改=尾追替代行）；③工具面 = `derive({only})` 白名单（分派件在 Harness 装配期按 kind 注册，普通会话永不见）。派发通道 = 既有 `SubagentRunner.spawnBackground`（唤醒 hint/receipted/delegation 事件全自动）；监视 = `task_wait` 的窥视变体 `task_status`。

**Tech Stack:** TypeScript（node:test 根包 + vitest GUI）、React 18（GUI）、JSONL 会话档（ctx-snap 快照/旁车 meta）。

**Spec:** `docs/superpowers/specs/2026-11-14-sunx-orchestrator-design.md`（§4/§5/§6/§17 为准；矛盾处以 spec 为准）。
**前置（已落地）:** bg-wake 全链（`src/session/wake.ts` WakeController、`serve/session.ts:209-236/1068-1116/1283-1286` 宿主胶水、`tasks.wakeHint` 分派提示、`receiptBody` 回执单点）——本计划零唤醒机制新增，只消费。

## Global Constraints

- **普通会话零变化（最高约束）**：主链工具清单逐字节不变（`builtin.schema.test.ts:77` bareNames 基线延伸守护）；`stableSegmentOf` 非 sunx 路径输出与现状逐字节相同；spawn/团队八件套/board 工具**描述一字不改**。
- **新工具只进 sunx 面**：`dispatch_task`/`task_status` 仅在 `opts.kind==='sunx'` 时注册进 Harness 注册表；普通会话 face 与注册表都不含它们。fork 子面（`deriveChildRegistry`）必须剔除这两个编排件（防子生孙/自派发）。
- **白名单面**：sunx face = `derive({only})`，后续新增内置工具默认不进 sunx 面。P1 面 = `dispatch_task / task_status / task_stop / ask_question / todo_write / skill / report_artifacts`（不含 `get_agent_team_board`——板通道 P2 才有消费者，届时随行进面；对 spec §6.2 的这一收窄在 Task 7 spec 收口时回写）。
- **提示词恒英文**：总章程/工具描述/缺省模板等我方文案英文单语；实例品格是用户自撰物料**原样直存**（任意语言，目录注册制先例）。品格留空 = 仅系统总章程（不注入空层）。
- **前缀纪律**：总章程进稳定段（跨实例共享）；品格进会话级冻结层并随 ctx-snap 快照导出/回种（恢复逐字节稳定）；品格修改 = 尾追替代行（后到者优先），前置段永不出现在场重写。
- **显示层与提示词层分离**：姓名落 `meta.title`（既有自定义会话名字段，侧栏/悬浮卡/`journalDisplayTitle` 全链既有显示面自动生效）；改名只写 meta，模型面出生名不重写。
- 每批完成即提交（conventional commits，中文说明，风格随 `git log`）；全量门禁 = `pnpm test`（根包）+ `pnpm selfcheck` + `pnpm --dir gui test`，最后一批加 `pnpm --dir gui run test:e2e`。
- 定向跑测命令（根包）：先 `pnpm exec tsc -p tsconfig.json`，再 `node --require scripts/test-env.cjs --test dist/<路径>.test.js`。
- GUI 铁律全套适用：`data-tip` 禁原生 title、`--radius-*` 弧度、图标钮 24px 命中盒/14px 下限、跳转瞬跳无 flash。

---

### Task 1: kinds 数据面——类型、Harness/Kernel 装配接缝、旁车 meta 字段

**Files:**
- Modify: `src/types.ts`（`SessionKind`）
- Modify: `src/harness/index.ts`（`HarnessOptions` 增 `kind?: SessionKind`、`charter?: string`）
- Modify: `src/session/runtime.ts`（`KernelRuntimeOpts` 增 `kind?`、`charter?`）
- Modify: `src/tui/session-journal.ts`（`SessionSidecarMeta` 增 `kind?: string`、`charterRev?: number`；读写透传）
- Test: `src/tui/session-journal` 既有 meta 测试套件追加用例

**Interfaces:**
- Produces: `type SessionKind = 'standard' | 'sunx'`（`src/types.ts` 登记口径；缺席 = standard，不落档）。
- Produces: meta 旁车 `kind`（出生写一次，不改档）与 `charterRev`（品格替代时 +1）。

- [ ] **Step 1: 失败测试（meta 往返）**

```ts
// 追加到既有 meta 读写测试（session-journal 套件内，形态随既有用例）
test('sidecar meta 携带 kind/charterRev 读写往返；缺省缺席不落键', () => {
  writeSessionMeta(dataDir, jid, { kind: 'sunx', charterRev: 2, title: '构建管家' });
  const m = readSessionMeta(dataDir, jid);
  assert.equal(m.kind, 'sunx');
  assert.equal(m.charterRev, 2);
  // 旧档/普通会话：无 kind 键
  assert.equal(readSessionMeta(dataDir, otherJid).kind, undefined);
});
```

- [ ] **Step 2: 类型与接缝落地**——`SessionKind` 入 `src/types.ts`；`HarnessOptions.kind/charter`、`KernelRuntimeOpts.kind/charter` 两接缝只声明（消费在 Task 2/3/4）；meta 字段随既有 `SessionSidecarMeta` 读写面透传。
- [ ] **Step 3: 定向跑测 + 提交**（`test(harness): sunx kinds 数据面——类型/装配接缝/旁车 meta`）

---

### Task 2: 提示词面——总章程稳定段分支 + 实例品格冻结层（ctx-snap 往返）

**Files:**
- Modify: `src/harness/prompts/shared.ts`（`SUNX_*` 常量单点 + `stableSegmentOf` opts 增 `kind?`）
- Modify: `src/harness/index.ts`（kind 透传至稳定段装配）
- Modify: `src/harness/context/`（loader 或 ContextManager：`charter` 第三层——全局 → 项目 → 品格；`SnapshotSig`/快照导出/`restoreSnapshot` 随行）
- Test: `src/harness/prompts/`、`src/harness/context/` 既有套件追加

**Interfaces:**
- Produces: `stableSegmentOf({ kind: 'sunx' })` = 既有共享行 + Sunx 身份行（替换 `IDENTITY_LINE` 槽位，单点替换零双份）+ 编排章程行组（职责/白名单面/收轮纪律/唤醒语义/连续上限告知/分解上限指引——常量收 `prompts/shared.ts`，英文单语）。
- Produces: ContextManager 接受 `charter?: string`（缺席 = 无此层）；快照导出含 charter（`ctx-snap` 行随档），`restoreSnapshot` 回种逐字节稳定。
- 不变量：`kind !== 'sunx'` 时 `stableSegmentOf` 输出与改动前**逐字节相同**（本任务核心回归锚）。

- [ ] **Step 1: 失败测试（稳定段双态 + 快照往返）**

```ts
test('stableSegmentOf: sunx 含编排章程与 Sunx 身份行；standard 输出与基线逐字节相同', () => {
  const base = stableSegmentOf({ contextRoot: '/r' });
  const sunx = stableSegmentOf({ contextRoot: '/r', kind: 'sunx' });
  assert.ok(sunx.includes('Sunx orchestrator'));
  assert.ok(sunx.includes(SUNX_WAKE_LINE)); // 唤醒语义告知行（常量单点）
  assert.equal(base, goldenBaseline); // golden = 改动前同参输出快照（测试内字面量钉死）
});

test('charter 冻结层：构造注入 → 快照导出含 charter → restore 回种逐字节恒等；缺席无层', () => {
  const cm = new ContextManager(/* 同既有构造，opts.charter: 'Charter v1 ...' */);
  const snap = cm.snapshotExport();
  assert.ok(snap.charter === 'Charter v1 ...');
  // restore 后 buildMessages 首帧含 charter 原文（字节级）
});
```

- [ ] **Step 2: 落地**——章程文案按 spec §17.1 分层（稳定段=系统总章程；charter=会话冻结层，SUNSHINE.md 之后）；kind 自 Harness 透传到稳定段装配点（`Harness.stableSegment` 与 loop 内 Reactor 同源消费，禁第二处拼装）。
- [ ] **Step 3: 定向跑测 + 提交**（`feat(harness): sunx 提示词面——总章程稳定段分支+品格冻结层`）

---

### Task 3: 工具面——dispatch_task / task_status 工厂 + 白名单装配

**Files:**
- Modify: `src/harness/subagent.ts`（`makeDispatchTool(runner)` 与 `makeSpawnTool` 同位；`spawnBackground` 增 `opts?: { tier?: ModelTier }`——预算合并 `{...budget, tier}`）
- Modify: `src/harness/tools/task-wait.ts`（`makeTaskStatusTool(tasks)`——窥视变体，复用 `waitMixed/formatReceipt/receiptBody`）
- Modify: `src/harness/index.ts`（kind==='sunx' 时注册两件 + `SUNX_FACE_TOOLS` 白名单常量导出）
- Modify: `src/harness/subagent.ts` `deriveChildRegistry`（fork 子面剔除 `dispatch_task`/`task_status`）
- Modify: `src/session/runtime.ts`（createKernelRuntime：kind==='sunx' 时 `loopDeps.registry = harness.tools.derive({ only: SUNX_FACE_TOOLS })`；`setToolDisplayMeta(face.displayMeta())`）
- Test: `src/harness/subagent.test.ts`、`src/harness/tools/` 既有套件追加

**Interfaces:**
- `dispatch_task` schema（§6.3 + R3）：`spec`(必填,自包含简报含验收) / `agent_id|null` / `label|null` / `tier|null` / `isolation|null('worktree')`。executor：`validateSpawnInput` → `spawnBackground(input, { tier })` → 回执 `task <id> started (output: <path>)<wakeHint>`。委派事件（kind=background-task 携 taskId）由 `runSubagent` 既有发射面自动承载。
- `task_status` schema：`taskIds`(string[]|null；null=全部 running)。恒窥视（`timeoutSeconds` 固定 0），回执头 = `status peek (non-blocking)`；终态行即置 `receipted`（与 task_wait 窥视同口径——窥视即消费，唤醒不再重复）；kinds = exec+subagent。
- `SUNX_FACE_TOOLS = ['dispatch_task','task_status','task_stop','ask_question','todo_write','skill','report_artifacts']`（常量单点，测试与装配同源）。
- fork 子面（单一派生口径——spawn tools 口已封闭，`SubagentSpawnInput.tools` 已删）：剔除族加 `dispatch_task`/`task_status`（防子生孙/自派发）；**路由版 ask_question 保持自动**——`deps.ask` 在场（daemon/TUI）时 Sunx 派发的子智能体可中途问人（askedBy=子标签直通主对话挂起卡，`subagent.ts:292/351-366` 既有），本计划零新增，仅加剔除族回归锚。
- 不变量①：非 sunx 装配注册表**不含** dispatch_task/task_status（普通 face 基线守护）。不变量②：sunx fork 子面不含这两件。

- [ ] **Step 1: 失败测试（四面覆盖）**

```ts
test('sunx kind 装配：注册表含 dispatch/task_status；普通 kind 不含（主链基线不变）', () => { /* 双装配对比 face 名单 */ });
test('sunx face 白名单精确集合：恰为 SUNX_FACE_TOOLS，derive({only}) 单点产出', () => { /* set equality */ });
test('dispatch_task executor：调 spawnBackground 带 tier 覆盖；回执含 taskId 与 wakeHint；双缺 spec 报 INVALID_ARG', async () => { /* stub runner */ });
test('task_status：终态窥视回执含 conclusion 且置 receipted（后续唤醒不再通知）；running 行显 status peek', async () => { /* submit+finish 驱动 */ });
test('fork 子面剔除：deriveChildRegistry 派生面无 dispatch_task/task_status', () => { /* 子生孙防线 */ });
```

- [ ] **Step 2: 落地**——工厂文案英文单语；`dispatch_task` 描述内嵌「分派即返回/收轮等唤醒」语义（不依赖运行期 hint 也能成立）；`task_stop` 白名单直取既有注册件。
- [ ] **Step 3: 定向跑测 + 提交**（`feat(harness): sunx 工具面——dispatch_task/task_status/白名单装配`）

---

### Task 4: serve 装配与端点——kind 会话生命周期 + charter 编辑

**Files:**
- Modify: `src/serve/session.ts`（`SessionRuntimeOpts` 增 `kind?/name?/charter?`；字段存会话级、`assemble()`/`reset 换铸`透传（mode 切换换铸不丢）；`submitWake`/唤醒胶水零改动自动生效）
- Modify: `src/serve/session-lifecycle.ts`（`createSessionIn` opts 增 `kind?/name?/charter?`；出生 mint 时 meta 落 `kind/title(name)/charterRev:1`）
- Modify: `src/serve/session-handlers.ts`（POST /session/new 增三参；`POST /session/:id/charter` {text} → `appendChain` 尾追替代行（`[charter v<n+1>] …以本行为准`）+ meta.charterRev 递增）
- Modify: `src/serve/sessions-list-handlers.ts`（rows 透出 `kind`）
- Modify: `gui/src/connection.ts`/`connection-types.ts`（`newSession` 增 kind/name/charter 入参；`SessionRow.kind`）
- Test: `src/serve/daemon.contract.test.ts`、`src/serve/session-handlers.test.ts`、`gui/src/connection.test.ts` 追加

**Interfaces:**
- `POST /session/new` body 增 `kind?: 'sunx'; name?: string; charter?: string`（kind 缺席=standard 路径零变化）。
- charter 编辑：任意时刻可调（append-only 链行安全）；返回新 rev；空文本 = 拒（INVALID_ARG）。
- 姓名只写 `meta.title`（G14.16 既有显示链全自动：侧栏/悬浮卡/列表题）。

- [ ] **Step 1: 失败测试（daemon 合同）**

```ts
test('new kind=sunx：创建→meta 落 kind/title/charterRev=1；/sessions 行透出 kind', async () => { /* daemon 套件形态 */ });
test('charter 编辑：尾追替代行入链（模型面可见）+ charterRev 递增；空文本 4xx；kind 缺席会话拒绝', async () => { /* */ });
test('setMode 换铸后 kind/charter 存活：换新运行时 face 仍为白名单、稳定段仍含章程', async () => { /* reset 语义 */ });
```

- [ ] **Step 2: 落地**——mode/setMode 换铸路径透传（`assemble()` 单点收口）；wake 接缝（`wake: { onFinished, hint: true }`）对 sunx 零改动继承。
- [ ] **Step 3: 定向跑测 + 提交**（`feat(serve): sunx 会话装配——kind 生命周期/charter 编辑/sessions kind 透出`）

---

### Task 5: Sunx 唤醒闭环端到端（消费 bg-wake，零新机制）

**Files:**
- Test: 既有 bg-wake 宿主集成测试套件追加（bg-wake plan Task 4/7 落点处；scripted 适配器驱动模型出牌）

**场景剧本（断言全链）：**
- [ ] **Step 1: 失败测试——闭环**：sunx 会话 submit → scripted 模型调 `dispatch_task`（2 个并行派发）→ 回执含 taskId+WAKE_HINT → 轮收束 idle → 驱动两任务先后 `finish` → 合批后单条唤醒轮（`<task-notification>` notice + run 行配对）→ scripted 模型收尾回复。断言：转录序 `wake-notice → run`；无 user 气泡帧；连续唤醒计数推进。
- [ ] **Step 2: 失败测试——窥视消费与 steer 优先**：唤醒前模型以 `task_status` 窥视终态任务 → 该任务不再唤醒；唤醒轮在途时用户 steer 排队 → 用户轮先跑、唤醒 pending 留存后补发（既有裁定回归锚）。另加一条：**子任务路由 ask**——派发的子智能体调 ask_question → 主对话挂起卡（askedBy=子标签归因）→ 回答后子任务续跑（`deps.ask` 路由既有能力在 Sunx 派发路径的回归锚）。
- [ ] **Step 3: 失败测试——面隔离**：同一 scripted 轨迹跑普通会话 → 工具面无 dispatch_task（模型无法派发，轨迹失败于工具不存在）——面越界守护。
- [ ] **Step 4: 定向跑测 + 提交**（`test(serve): sunx 唤醒闭环 e2e——派发/合批唤醒/窥视消费/面隔离`）

---

### Task 6: GUI 创建入口——「新建 Sunx」同级钮 + 创建弹窗（2026-11-15 用户裁定：与「新对话」同级、独立弹窗；**欢迎页 composer 零改动**）

**Files:**
- Modify: `gui/src/sidebar/project-menu-recents.tsx`（头部既有「新对话」钮旁新增**同级**「新建 Sunx」钮——同款样式槽/data-tip `t('New Sunx','新建 Sunx')`；点击开弹窗）
- New: `gui/src/welcome/NewSunxDialog.tsx`（+ 测试）——创建弹窗三元组：**姓名**（必填，空禁提交）/ **工作目录**（复用既有 dirpicker 面，缺省=当前默认工作区锚）/ **品格**（文本域，占位建议文案双语 `t()`，留空=仅总章程）；提交 `conn.newSession(target, undefined, undefined, undefined, { kind:'sunx', name, charter })` → 成功后走既有 openSession 链路打开该会话；关闭/ESC/点外关（`usePopOutsideClose` 先例）
- Modify: `gui/src/connection.ts`（`newSession` 增第 5 参 opts 透传）、`connection-types.ts`（`SessionRow.kind`）
- Modify: 侧栏会话行（kind==='sunx' 标题旁小徽标——图标钮/字号铁律适用；SUNX 分组聚合**不在本任务**，P2）
- Test: `gui/src/welcome/NewSunxDialog.test.tsx`、`gui/src/connection.test.ts` 追加；GUI typecheck

**Interfaces:**
- 弹窗载荷：`{ kind:'sunx', name, charter? }`（name 必填校验）；普通新对话路径载荷无 kind 字段（回归锚）。
- P2 的 SUNX 组「+」与总览页入口卡复用同一弹窗组件（单点）。

- [ ] **Step 1: 失败测试（组件）**：弹窗开合（钮点击/ESC/点外）；校验（空名禁提交、charter 可空）；提交载荷字段断言；成功后 openSession 调用断言；普通新对话路径回归（payload 无 kind）。
- [ ] **Step 2: 落地 + typecheck + 定向跑测 + 提交**（`feat(gui): 新建 Sunx 同级入口+创建弹窗——姓名/目录/品格三元组`）

---

### Task 7: spec 收口 + 全量回归

**Files:**
- Modify: `docs/superpowers/specs/2026-11-14-sunx-orchestrator-design.md`（§6.2 P1 face 实况回写：不含 get_agent_team_board、含 report_artifacts；§12 P1 交付判据勾稽）
- Modify: `MANUAL-GUI.md`（Sunx 创建入口一节；charter 编辑端点说明）
- [ ] **Step 1:** 文档回写（face 实况、charter 尾追语义、姓名=meta.title 口径）。
- [ ] **Step 2:** 全量门禁：`pnpm test` + `pnpm selfcheck` + `pnpm --dir gui test` + `pnpm --dir gui run test:e2e`；主链 face 基线用例（Task 3）与 bg-wake 既有用例全绿复核。
- [ ] **Step 3:** 提交（`docs(spec): sunx P1 收口——face 实况回写+手册`）。

---

## 验收对照（spec §13 P1 场景）

| 场景 | 落点 |
|---|---|
| 一句诉求 → 分解（todo 批次）→ 并行 dispatch → 收轮 → 唤醒轮接续 → 汇总交付 | Task 5 闭环剧本 |
| 子任务失败唤醒 → task_status 窥视日志尾 → 重派/问询 | Task 5 Step 2 + 挂起表既有 |
| 用户插话 steer 优先 | Task 5 Step 2 |
| GUI 关窗照跑/重开恢复 | bg-wake 既有 + ctx-snap charter 回种（Task 2） |
| 普通会话零变化 | Task 3 不变量① + Task 2 基线字节测试 |

## P2 预告（不在本计划）

GUI SUNX 分组与总览页（meta.kind 过滤 + 单例 `sunx` 页签 + 徽标聚合）、板任务通道（target='team' + get_agent_team_board 进面 + 能力自举 R6）、schedule_wakeup/task（TimerRegistry + `wake-schedule` 行 + attach 重布防）、挂起持久化、恢复唤醒轮（R9）、charter 编辑 GUI 面（P1 已有端点）、人格模板目录 `.sunshinex/sunx/{id}/sunx.md`。
