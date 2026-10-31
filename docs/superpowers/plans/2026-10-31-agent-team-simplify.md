# 智能体团队简化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将任务板收敛为「Team 聚合 + 五态任务机 + task_stop/task_wait + retryOf DAG + 队内消息进上下文/转录」，GUI 一队一卡、点色停钮、无审批无文字状态徽标。

**Architecture:** 单物理 TaskBoard 事件流保留；新增 Team 注册表（`teamId`/`name`）；`BoardTask` 强制 `teamId`，可选 `retryOf`；状态机砍到五态并代码门禁；`task_stop` 统一终止 pending/running→cancelled；装载自愈非终态→cancelled；消息沿用 inbox + drain 尾追，收件白名单收紧到同队；GUI 按 `teamId` 分卡并接 daemon 停接口。

**Tech Stack:** TypeScript strict、node:test、vitest（gui）、现有 React GUI / daemon HTTP+WS。无新运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-31-agent-team-simplify-design.md`

## Global Constraints

- **禁止兼容**：删除 `claimed`/`in-review`/`done`/`gated`/`review_task`/gate 事件与用户气泡队头；不做旧态双读或别名映射。
- 提示词与工具 description **恒英文**；GUI 外观文案走 `t(en,zh)`。
- 状态迁移唯一门禁：`transitionLegal` + 协调器 `requireTransition`（非法必须明确报错，禁静默吞）。
- 消息进上下文只 **尾追**，不改前置段（前缀缓存纪律）。
- 验证：触及主仓则 `pnpm build` + 相关 `node --test`；触及 GUI 则 `pnpm --dir gui run typecheck` + 相关 vitest；收尾 `pnpm selfcheck`。
- 用户规则：不自行点测 GUI 业务功能，只给测试步骤。

## Review Focus

1. **装载后盲等**：重启后若仍有 `pending`/`running`，`task_wait` 会飞——自愈必须两者皆 `cancelled`，且 wait 测永等不发生。
2. **停与失败混淆**：进程内执行异常必须 `failed`（红）；`task_stop`/重启必须 `cancelled`（黄）——回写路径不得把 abort 写成 failed。
3. **retryOf 误挡派发**：`dependsOn` 仍要上游 `success`；`retryOf` 不得进入 `dispatchable` 依赖检查。
4. **跨队投递/绑任务**：缺 `teamId`、跨队 `dependsOn`/`retryOf`/`send_message` 必须明确 INVALID_ARG。
5. **GUI 停钮与模型同链**：hover 停必须打到与 `task_stop` 同一板终止语义，不能只 interrupt 会话。

## File Map

| 文件 | 职责 |
|------|------|
| `src/taskboard/model.ts` | 五态、`LEGAL`、`BoardTask.teamId`/`retryOf`、删 gate、`recoverOnLoad`、`dispatchable`（deps=success） |
| `src/taskboard/team.ts`（新建） | Team 注册：`create`/`get`/`list`；持久化与板同根或邻接 |
| `src/taskboard/board.ts` | 创建绑队、派发→running、回写 success/failed、`stopTask`→cancelled、自愈、删 review/gate |
| `src/harness/tools/task-stop.ts` | pending|running→板 `stopTask`；台账 abort |
| `src/harness/tools/task-wait.ts` | 终态 success\|failed\|cancelled；文案对齐重启=cancelled |
| `src/harness/tools/taskboard-tools.ts` | 加 `create_team`；`create_task` 要 teamId/retryOf；删 review_task 与 gate；update 去 gate/cancel（cancel 归 task_stop） |
| `src/harness/index.ts` | `create_teammate` 要 teamId；装配 Team |
| `src/taskboard/message-tools.ts` + teammate drain | 同队白名单；位点持久化 |
| `src/serve/daemon.ts` + session-handlers | `POST .../board/stop` |
| `gui/src/tabs/TaskBoardTab.tsx` / `TaskDag.tsx` / `app.css` | 队卡、点色、停钮、retry 边 |
| `gui/src/tabs/AgentTranscriptTab.tsx`（及气泡组件） | 消息来源名 + 跳转 |

---

### Task 1: 域模型五态 + teamId/retryOf + 自愈

**Files:**
- Modify: `src/taskboard/model.ts`
- Modify: `src/taskboard/model.test.ts`
- Modify: `src/types.ts`（若再导出 TaskStatus）

**Interfaces:**
- Consumes: 无
- Produces:
  - `type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'`
  - `BoardTask`: 必有 `teamId: string`；可选 `retryOf?: string`；删除 `gated`
  - `BoardEvent`：`task-created` 含 `teamId` 与可选 `retryOf`；删除 `gate-set`/`gate-resolved`
  - `LEGAL`: pending→[running,cancelled]; running→[success,failed,cancelled]; 终态→[]
  - `dispatchable`: pending 且 dependsOn 全 `success`（忽略 retryOf）
  - `recoverOnLoad`: 凡 `pending`|`running` → 内存态改为 `cancelled`，`recovered` 列出 id
  - `transitionError(from, to): string` 或由调用方拼：`cannot transition ${id} from ${from} to ${to}; allowed: ...`

- [ ] **Step 1: 重写失败测试（整文件对齐新态）**

`model.test.ts` 核心断言改为：

```ts
test('transitionLegal:五态闭集', () => {
  assert.ok(transitionLegal('pending', 'running'));
  assert.ok(transitionLegal('pending', 'cancelled'));
  assert.ok(transitionLegal('running', 'success'));
  assert.ok(transitionLegal('running', 'failed'));
  assert.ok(transitionLegal('running', 'cancelled'));
  assert.ok(!transitionLegal('success', 'pending'));
  assert.ok(!transitionLegal('pending', 'success'));
  assert.ok(!transitionLegal('failed', 'running'));
});

test('dispatchable:dependsOn 须 success；retryOf 不挡派发', () => {
  let s = emptyBoard();
  s = applyBoardEvent(s, { t: 'task-created', taskId: 'a', title: 'A', spec: 'a', dependsOn: [], teamId: 'tm1', ts: 1 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 'a', from: 'pending', to: 'running', ts: 2 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 'a', from: 'running', to: 'failed', ts: 3 });
  s = applyBoardEvent(s, {
    t: 'task-created', taskId: 'a2', title: 'A', spec: 'a', dependsOn: [], teamId: 'tm1', retryOf: 'a', ts: 4,
  });
  assert.deepEqual(dispatchable(s).map((t) => t.id), ['a2'], 'retryOf 失败前驱仍可派发');
});

test('recoverOnLoad:pending+running→cancelled；终态不动', () => {
  let s = emptyBoard();
  s = applyBoardEvent(s, { t: 'task-created', taskId: 'p', title: 'P', spec: 'p', dependsOn: [], teamId: 'tm1', ts: 1 });
  s = applyBoardEvent(s, { t: 'task-created', taskId: 'r', title: 'R', spec: 'r', dependsOn: [], teamId: 'tm1', ts: 1 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 'r', from: 'pending', to: 'running', ts: 2 });
  s = applyBoardEvent(s, { t: 'task-created', taskId: 'ok', title: 'OK', spec: 'ok', dependsOn: [], teamId: 'tm1', ts: 1 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 'ok', from: 'pending', to: 'running', ts: 2 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 'ok', from: 'running', to: 'success', ts: 3 });
  const r = recoverOnLoad(s);
  assert.equal(r.state.tasks['p']!.status, 'cancelled');
  assert.equal(r.state.tasks['r']!.status, 'cancelled');
  assert.equal(r.state.tasks['ok']!.status, 'success');
  assert.ok(r.recovered.includes('p') && r.recovered.includes('r'));
});
```

- [ ] **Step 2: 跑测确认失败（旧态符号）**

Run: `node --import tsx --test src/taskboard/model.test.ts`（或以仓库惯用 `pnpm test` 过滤；实现时用 `scripts/run-tests.js` 同口径编译后再 `node --test dist/...`）

Expected: FAIL（仍为 claimed/done 等）

- [ ] **Step 3: 改 `model.ts` 至测试通过；删除 gate 相关类型与分支**

- [ ] **Step 4: 再跑 model 测试 PASS**

- [ ] **Step 5: Commit**

```bash
git add src/taskboard/model.ts src/taskboard/model.test.ts src/types.ts
git commit -m "refactor(taskboard): 五态任务机 + teamId/retryOf + 重启自愈 cancelled"
```

---

### Task 2: Team 注册表

**Files:**
- Create: `src/taskboard/team-registry.ts`（或 `team.ts`，与 `teammate.ts` 的 TeamRegistry 区分命名：`AgentTeamStore` / `createAgentTeam`）
- Create: `src/taskboard/team-registry.test.ts`
- Modify: `src/taskboard/store.ts`（团队清单落盘，与 events 同 `teams/` 根）

**Interfaces:**
- Consumes: store 路径约定
- Produces:
  - `interface AgentTeam { teamId: string; name: string; createdAt: number }`
  - `class AgentTeamRegistry { create(name: string): Result<AgentTeam>; get(id: string): AgentTeam | undefined; list(): AgentTeam[]; }`
  - `teamId` 生成：`team-<slug(name)>-<4rand>`（对齐 task id 方言）
  - 空 name → `INVALID_ARG` 明确文案

- [ ] **Step 1: 失败测试**

```ts
test('create:生成 teamId 并可读；空名拒绝', () => {
  const reg = new AgentTeamRegistry(memStore);
  const r = reg.create('Alpha');
  assert.ok(r.ok);
  assert.match(r.value.teamId, /^team-/);
  assert.equal(reg.get(r.value.teamId)?.name, 'Alpha');
  assert.equal(reg.create('').ok, false);
});
```

- [ ] **Step 2: 实现最小注册表 + 落盘**

- [ ] **Step 3: 测试 PASS + Commit**

```bash
git commit -m "feat(taskboard): AgentTeam 注册表 create/get/list"
```

---

### Task 3: TaskBoard 协调器对齐五态与 stopTask

**Files:**
- Modify: `src/taskboard/board.ts`
- Modify: `src/taskboard/board` 相关 `*.test.ts`、`mirror.test.ts`、`crash-fixture` 等

**Interfaces:**
- Consumes: Task 1 模型、Task 2 `AgentTeamRegistry`
- Produces:
  - `create({ teamId, title, spec, dependsOn?, assignee?, executor?, retryOf? })` — 校验队存在；`retryOf` 同队且前驱终态
  - 派发：`pending → running`（原 claimed）
  - `finishExecution`: `running → success|failed`（成功不再 in-review）
  - `stopTask(taskId): Result<void>` — pending|running → cancelled；终态明确错误或幂等（与 spec：终态幂等回执——工具层幂等，板层对终态可 `ok` 幂等）
  - `init` 自愈：对 `recoverOnLoad` 每个 id append `status-changed` → cancelled（from 为装载前态）
  - 删除：`review`、`gate`、对外 `cancel`（或 `cancel` 变为 `stopTask` 别名后删工具入口）

- [ ] **Step 1: 板测——stopTask 与 finishExecution**

```ts
test('stopTask:pending 与 running → cancelled', async () => {
  // 建队+create 两任务；其一 mark running；分别 stopTask；断言 cancelled
});
test('finishExecution:ok→success；error→failed', () => { /* ... */ });
test('init:打开态自愈为 cancelled 事件落盘', () => { /* ... */ });
```

- [ ] **Step 2: 实现；全量替换 board 内 claimed/in-review/done/gated 字符串**

- [ ] **Step 3: 相关 board 测试 PASS + Commit**

```bash
git commit -m "refactor(taskboard): 协调器五态回写与 stopTask/自愈"
```

---

### Task 4: task_stop / task_wait

**Files:**
- Modify: `src/harness/tools/task-stop.ts`、`task-stop.test.ts`
- Modify: `src/harness/tools/task-wait.ts`、`task-wait.test.ts`
- Modify: `src/harness/index.ts`（把 board 注入 stop 工具若需要）

**Interfaces:**
- Consumes: `board.stopTask`、`TaskRegistry`、可选 `TeamRegistry`（teammate 按名打断）
- Produces:
  - `task_stop`：解析板 id → 若板任务 pending/running 则 `stopTask` +（running 时）ledger.stop；纯台账任务保持 stopped
  - `task_wait`：板终态集合改为 `success|failed|cancelled`；重启文案改为 cancelled（不再说 restart→failed）

- [ ] **Step 1: 失败测试**

```ts
test('task_stop 板 pending → cancelled', async () => { /* 建板任务后 stop，断言板态 */ });
test('task_wait 见 cancelled 立即收口', async () => { /* ... */ });
```

- [ ] **Step 2: 实现使 abort 回写走 cancelled（finishExecution 需区分 abort vs 真失败——见下）**

**关键实现点：** `finishExecution` 增加原因：`{ ok: true } | { ok: false, terminal: 'failed' | 'cancelled' }`。`ledger.stop`/abort 路径传 `cancelled`；异常传 `failed`。

- [ ] **Step 3: PASS + Commit**

```bash
git commit -m "feat(harness): task_stop 覆盖 pending+running→cancelled；task_wait 终态对齐"
```

---

### Task 5: 工具面 create_team / 去审批 / 绑队

**Files:**
- Modify: `src/harness/tools/taskboard-tools.ts` 及测试
- Modify: `src/harness/index.ts`（`create_teammate` 增加 `teamId`；注册 `create_team`）
- Modify: `TASKBOARD_TOOL_NAMES` / `FORK_EXCLUDED_TOOLS` / `builtin.schema.test.ts` / `fork-face.test.ts`
- Modify: e2e：`taskboard.e2e.test.ts`、`daemon.contract.test.ts`、`session.test.ts` 等所有 create_task 入参

**Interfaces:**
- Produces 工具：
  - `create_team({ name })`
  - `create_task({ teamId, title, spec, dependsOn, assignee, executor, retryOf })` — **删除 gated**
  - `update_task`：仅 `assign` | `depend`（删除 gate/cancel；取消走 task_stop）
  - **删除** `review_task`
  - `create_teammate({ teamId, name, prompt|agent_id })`

- [ ] **Step 1: schema/常量测试先改期望（无 review_task；create_task required 含 teamId）**

- [ ] **Step 2: 实现工具与装配；扫编译错误**

- [ ] **Step 3: `pnpm build` + 相关 test PASS + Commit**

```bash
git commit -m "feat(harness): create_team；任务/成员强制 teamId；删除 review/gate"
```

---

### Task 6: 队内消息 + 位点持久化

**Files:**
- Modify: `src/taskboard/message-tools.ts`、`message-tools.test.ts`
- Modify: `src/taskboard/teammate.ts`（drain；cursor 持久化）
- Modify: `src/harness/message.e2e.test.ts`

**Interfaces:**
- `knownRecipients`：同 `teamId` 存活成员（+ lead 规则保持）
- 跨队 to → `cannot send_message across teams`
- cursor：写入队友会话快照或 `<teams>/inbox-cursors.json`；重启不重复灌链

- [ ] **Step 1: 测试跨队拒绝；同队投递 drain 进链**

- [ ] **Step 2: 实现 + PASS + Commit**

```bash
git commit -m "feat(taskboard): send_message 队内白名单与 inbox 位点持久化"
```

---

### Task 7: daemon 板停 + 投影

**Files:**
- Modify: `src/serve/daemon.ts`、`session-handlers.ts`
- Modify: `src/serve/daemon.board.test.ts`（扩展 stop）
- Modify: GUI 连接层（`conn.boardStop` 或等价）

**Interfaces:**
- `POST /session/:id/board/stop` body `{ taskId: string }` → `board.stopTask` + 若 running 则台账 stop
- 快照 `board.tasks[].status` 为五态；带 `teamId`/`retryOf`；快照含 `teams: AgentTeam[]`

- [ ] **Step 1: daemon 测试 stop pending/running**

- [ ] **Step 2: 实现 + PASS + Commit**

```bash
git commit -m "feat(serve): POST board/stop 与五态/Team 投影"
```

---

### Task 8: GUI 队卡 / 点色 / 停钮 / DAG 重试边

**Files:**
- Modify: `gui/src/tabs/TaskBoardTab.tsx`、测试
- Modify: `gui/src/tabs/TaskDag.tsx`、`TaskDag.test.tsx`
- Modify: `gui/src/app.css`（黄点 cancelled；修 running 转圈 class；删文字徽标样式依赖）
- Modify: App 注入 `onStopTask`、按 team 分组（替换 `groupTasks`/`turnGoal`）

**行为：**
- 按 `teamId` 分卡；卡头 = team.name
- 删文字状态徽标与 Approve/Deny
- pending/running hover 显示 Stop → `onStopTask(taskId)`
- DAG：dependsOn 实线；retryOf 虚线/「重试」；节点同点色与停钮

- [ ] **Step 1: vitest——队名卡头、无失败文字徽标、cancelled 划线 class、retry 边存在**

- [ ] **Step 2: 实现 UI**

- [ ] **Step 3: `pnpm --dir gui run typecheck` + 相关 vitest PASS + Commit**

```bash
git commit -m "feat(gui): 队卡五态点色、hover 停、retryOf DAG"
```

**手动验证步骤（不代点）：**
1. 建队并建任务，确认卡头为队名。
2. 运行中任务 hover 见停，点后黄点+划线。
3. 失败任务红点；对失败任务再 create 带 retryOf，DAG 见重试边。

---

### Task 9: 转录消息气泡来源名 + 跳转

**Files:**
- Modify: `gui/src/tabs/AgentTranscriptTab.tsx` 与消息/气泡渲染路径
- Modify: 相关 vitest
- 确认 `agent-message` 事件投影含 `from` / `teamId`

**行为：**
- 消息气泡显示来源智能体名
- 点击打开该来源 agent 转录页（复用 `onOpenAgent`）

- [ ] **Step 1: 组件测——气泡含 from 名；点击回调参数**

- [ ] **Step 2: 实现 + PASS + Commit**

```bash
git commit -m "feat(gui): 转录消息气泡来源智能体名与跳转"
```

---

### Task 10: 全仓扫尾与自检

**Files:** 一切仍引用 `claimed`/`in-review`/`done`/`gated`/`review_task`/`turnGoal` 队头的测试与文案

- [ ] **Step 1: `rg` 扫旧状态名与 review_task；清零产品路径（测试夹具同步）**

- [ ] **Step 2: `pnpm build` && 主仓相关 test && `pnpm --dir gui run test`（或分层）&& `pnpm selfcheck`**

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: 扫除旧板态/审批残留并对齐 selfcheck"
```

---

## Spec coverage checklist

| Spec 节 | Task |
|---------|------|
| §1 五态/LEGAL/门禁 | 1, 3 |
| §1 task_stop/wait/自愈 | 3, 4, 7 |
| §2 Team/绑队 | 2, 5 |
| §3 retryOf/DAG | 1, 3, 5, 8 |
| §4 消息 | 6, 9 |
| §5 GUI | 8, 9 |
| 禁止兼容/扫尾 | 5, 10 |

## Placeholder / 一致性自检

- 终态名统一 `success`（非 done）、执行中统一 `running`（非 claimed）。
- 重启与 task_stop → `cancelled`；仅执行异常 → `failed`。
- `retryOf` 不进 `dependsOn` 派发条件。
