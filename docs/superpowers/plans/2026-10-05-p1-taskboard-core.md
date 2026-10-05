# P1 TaskBoard 核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付多 Agent 编排子系统的任务板核心:Task 域模型 + teams 目录 event sourcing + 依赖调度 + lead 工具五件套 + harness 强制状态回写 + kill -9 崩溃恢复,TUI 收敛为投影单源。

**Architecture:** 三层纯件先行(模型/存储/协调器,全部可独立单测),再接执行接线(runner 派发 + 台账 + 强制回写)与工具面(五件套,lead-only),最后 TUI 收敛与崩溃注入。**派发机制**:TaskBoard 批量并行 drain(GraphEngine allSettled 先例)——dispatchable 任务经 `registry.submit` 登账本后 `await runner.runSubagent`(fork 顶替 teammate),完成即强制回写 claimed→in-review/failed;**唤醒复用既有 `task_wait(null)` 拉模式**,不新造推信道。**持久化**:`<dataDir>/teams/main/` event sourcing——events.jsonl 为真相源(append-only),board.json 原子快照(P1 写不读,重放为载入路径)。

**Tech Stack:** TypeScript (tsc strict)、node:test + assert/strict、无新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md`(§4.1 域模型、§5 调度、§7 持久化与恢复、§11 事件面、§13 P1;本计划执行其 P1 段)。

## Global Constraints

- tsc strict 零报错;`pnpm test` 0 败(2 既有 win32 符号链接跳过容忍);`pnpm selfcheck` OK。
- teams 目录 = `path.join(resolveDataDir(root), 'teams', 'main')`,**不进工作区**;子目录自行 mkdir(data-dir.ts:38 既有约定)。
- 事件 payload 结构化,禁 ANSI/预渲染字符串;`task-*`/`gate-*` 载荷口径以 Task 3 Produces 为准。
- 依赖方向:`src/taskboard/*` → harness(SubagentRunner/TaskRegistry/types),不得反向;工具定义参照 `src/harness/tools/task-wait.ts` 形态。
- **不改 P0 既有行为**;受保护测试编辑仅限 Task 7 明确列出的协议补齐文件(`App.spawn-browse.test.tsx`、`App.inspect.test.tsx`),其余测试文件零改动。
- 任务 id 方言:`t<seq>`(seq 从 1 单调);`create` 限流 `maxOpenTasks = 64`(未终态计数,超出 INVALID_ARG)。
- 注释密度与命名跟随仓库现状(中文决策注释,注明规格出处)。
- 行号锚以语义锚优先(邻接语句/函数名),实现时现场核对。

## Rulings(计划级裁定,执行不再重议)

1. **派发**:批量并行 drain + 台登记账 + await runSubagent + 完成即强制回写;lead 唤醒 = 既有 `task_wait(null)`(等待全部 running 台账任务)。不引入推送唤醒。
2. **team-id**:每工作区单隐式 team `main`,首写惰性建档;`init()` 只恢复不 kick(旧任务不随会话启动自动执行)。
3. **gate**:P1 语义 = `gate_task` 置 gated(派发跳过、发 gate-waiting)→ `review_task(approved)` 解锁(发 gate-resolved、恢复派发);人机回路经 chat 叙述,行内审批卡/Ctrl+T 属 P2(spec §10.3)。
4. **blocked 为派生态不落存储**(上游 failed/cancelled 的 pending 下游);`cancelled` 状态机合法但 P1 无工具入口(P2 看板操作)。
5. **快照写不读**:board.json 每次 append 后原子写(tmp+rename,FileStore 先例);P1 载入走 events.jsonl 全量重放,快照读取优化 P2。
6. **恢复回池自愈**:init 时 claimed 无终态 → append `status-changed(claimed→pending, note recovered)` 事件再入内存(事件流自洽,§7.4)。
7. **inbox/executor**:接口定型 + MemoryInbox;文件 inbox 随 P2 agent-message 落地。
8. **assign**:P1 记账(P2 执行体路由消费),不门控派发(P1 无 teammate,派发只看依赖)。
9. **模板宏化排 P2 中段**(spec §13 空隙裁定,Task 9 回写一句进 spec)。
10. **TUI 单源收敛**含受保护测试协议补齐(合成流补 delegation 事件,规则见 Task 7)。

---

### Task 1: Task 域模型纯件(src/taskboard/model.ts)

**Files:**
- Create: `src/taskboard/model.ts`
- Test: `src/taskboard/model.test.ts`

**Interfaces:**
- Consumes: 无(叶子纯件)
- Produces(Task 2/3/7/8 依赖):
  - `type TaskStatus = 'pending' | 'claimed' | 'in-review' | 'done' | 'failed' | 'cancelled'`
  - `interface BoardTask { id: string; title: string; spec: string; status: TaskStatus; dependsOn: string[]; assignee?: string; gated?: boolean; createdAt: number; updatedAt: number; artifact?: { conclusion?: string; tokens?: number; durationMs?: number } }`
  - `interface TaskBoardState { tasks: Record<string, BoardTask>; seq: number }`
  - `type BoardEvent = { t: 'task-created'; taskId: string; title: string; spec: string; dependsOn: string[]; ts: number } | { t: 'dependency-added'; taskId: string; dependsOn: string; ts: number } | { t: 'assigned'; taskId: string; assignee: string; ts: number } | { t: 'status-changed'; taskId: string; from: TaskStatus; to: TaskStatus; ts: number; note?: string; conclusion?: string; tokens?: number; durationMs?: number } | { t: 'gate-set'; taskId: string; note?: string; ts: number } | { t: 'gate-resolved'; taskId: string; approved: boolean; ts: number }`
  - `function emptyBoard(): TaskBoardState`
  - `function applyBoardEvent(state: TaskBoardState, ev: BoardEvent): TaskBoardState`(纯 reducer,非法 taskId 原引用返回)
  - `function transitionLegal(from: TaskStatus, to: TaskStatus): boolean`
  - `function derivedBlocked(state: TaskBoardState, taskId: string): boolean`(pending 且 deps 含 failed/cancelled)
  - `function dispatchable(state: TaskBoardState): BoardTask[]`(pending && !gated && deps 全 done,创建序)
  - `function hasCycle(tasks: Array<{ id: string; dependsOn: string[] }>): string[] | null`(Kahn,环成员清单或 null)
  - `function recoverOnLoad(state: TaskBoardState): { state: TaskBoardState; recovered: string[] }`(claimed→pending,返回恢复 id 清单)

- [ ] **Step 1: 写失败测试**

创建 `src/taskboard/model.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBoardEvent, BoardEvent, dispatchable, emptyBoard, hasCycle,
  recoverOnLoad, transitionLegal, derivedBlocked,
} from './model';

const created = (id: string, deps: string[] = []): BoardEvent =>
  ({ t: 'task-created', taskId: id, title: `T ${id}`, spec: `do ${id}`, dependsOn: deps, ts: 1 });

test('applyBoardEvent:created 建条、status-changed 迁移与 artifact 并入、未知 taskId 原引用', () => {
  let s = emptyBoard();
  s = applyBoardEvent(s, created('t1'));
  s = applyBoardEvent(s, created('t2', ['t1']));
  assert.equal(s.seq, 2);
  assert.equal(s.tasks['t1']!.status, 'pending');
  const before = s;
  assert.equal(applyBoardEvent(s, { t: 'assigned', taskId: 'tX', assignee: 'a', ts: 2 }), before, '未知 id 原引用');
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't1', from: 'pending', to: 'claimed', ts: 3 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't1', from: 'claimed', to: 'in-review', ts: 4, conclusion: 'done A', tokens: 42, durationMs: 900 });
  assert.equal(s.tasks['t1']!.status, 'in-review');
  assert.deepEqual(s.tasks['t1']!.artifact, { conclusion: 'done A', tokens: 42, durationMs: 900 });
});

test('transitionLegal:合法迁移表', () => {
  assert.ok(transitionLegal('pending', 'claimed'));
  assert.ok(transitionLegal('claimed', 'pending'), '恢复回池合法');
  assert.ok(transitionLegal('claimed', 'in-review'));
  assert.ok(transitionLegal('in-review', 'done'));
  assert.ok(transitionLegal('in-review', 'failed'));
  assert.ok(transitionLegal('pending', 'cancelled'));
  assert.ok(!transitionLegal('done', 'pending'));
  assert.ok(!transitionLegal('pending', 'done'), '不可跳过执行直达终态');
  assert.ok(!transitionLegal('failed', 'claimed'));
});

test('dispatchable/derivedBlocked:依赖门控与失败传播', () => {
  let s = emptyBoard();
  s = applyBoardEvent(s, created('t1'));
  s = applyBoardEvent(s, created('t2', ['t1']));
  s = applyBoardEvent(s, created('t3', ['t2']));
  assert.deepEqual(dispatchable(s).map((t) => t.id), ['t1'], '仅无依赖者可派发');
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't1', from: 'pending', to: 'claimed', ts: 2 });
  assert.deepEqual(dispatchable(s), [], 'claimed 不重复派发');
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't1', from: 'claimed', to: 'in-review', ts: 3 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't1', from: 'in-review', to: 'done', ts: 4 });
  assert.deepEqual(dispatchable(s).map((t) => t.id), ['t2'], '上游 done 解锁下游');
  s = applyBoardEvent(s, { t: 'gate-set', taskId: 't2', ts: 5 });
  assert.deepEqual(dispatchable(s), [], 'gated 跳过');
  s = applyBoardEvent(s, { t: 'gate-resolved', taskId: 't2', approved: true, ts: 6 });
  assert.deepEqual(dispatchable(s).map((t) => t.id), ['t2']);
  // 失败传播:t2 failed → t3 派生 blocked(不自动 skip,等 lead 裁决)
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't2', from: 'pending', to: 'claimed', ts: 7 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't2', from: 'claimed', to: 'failed', ts: 8 });
  assert.ok(derivedBlocked(s, 't3'), '上游 failed → 下游派生 blocked');
  assert.deepEqual(dispatchable(s), [], 'blocked 不派发');
});

test('hasCycle:加边成环检出并给成员', () => {
  const tasks = [
    { id: 't1', dependsOn: ['t3'] },
    { id: 't2', dependsOn: ['t1'] },
    { id: 't3', dependsOn: ['t2'] },
    { id: 't4', dependsOn: ['t1'] },
  ];
  const cycle = hasCycle(tasks);
  assert.ok(cycle !== null);
  assert.ok(['t1', 't2', 't3'].every((id) => cycle!.includes(id)), `环成员齐备:${cycle!.join(',')}`);
  assert.equal(hasCycle([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }]), null);
});

test('recoverOnLoad:claimed 回池、其余不动', () => {
  let s = emptyBoard();
  s = applyBoardEvent(s, created('t1'));
  s = applyBoardEvent(s, created('t2'));
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't1', from: 'pending', to: 'claimed', ts: 2 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't2', from: 'pending', to: 'done', ts: 3 });
  const r = recoverOnLoad(s);
  assert.deepEqual(r.recovered, ['t1']);
  assert.equal(r.state.tasks['t1']!.status, 'pending');
  assert.equal(r.state.tasks['t2']!.status, 'done', '终态不动');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/taskboard/model.test.js`
Expected: FAIL——`Cannot find module './model'`。

- [ ] **Step 3: 实现 model.ts**

创建 `src/taskboard/model.ts`(头部中文决策注释:spec §4.1/§7.4/§12.1 器官移植——Kahn 环检测自 graph/engine.ts:50-84 移植):

```ts
/** TaskBoard 域模型纯件(spec 2026-10-04 §4.1):状态机、依赖派生、环检测、事件 reducer。
 *  零 IO 零 harness 依赖——store 重放、TaskBoard 协调器、TUI 投影三方共用同一 reducer(单点防漂移)。
 *  blocked 为派生态不落存储(上游 failed/cancelled 的 pending 下游,不自动迁移——交互场景留人裁决,spec §4.1);
 *  cancelled 状态机合法但 P1 无工具入口(P2 看板操作)。 */

export type TaskStatus = 'pending' | 'claimed' | 'in-review' | 'done' | 'failed' | 'cancelled';

export interface BoardTask {
  id: string;
  title: string;
  /** 自包含任务描述:执行体不看主链也能干(spec §4.1,可替换性前提) */
  spec: string;
  status: TaskStatus;
  dependsOn: string[];
  assignee?: string;
  /** gate 挂起(spec Ruling 3):派发跳过,review_task(approved) 解锁 */
  gated?: boolean;
  createdAt: number;
  updatedAt: number;
  artifact?: { conclusion?: string; tokens?: number; durationMs?: number };
}

export interface TaskBoardState {
  tasks: Record<string, BoardTask>;
  /** 已发放任务计数(id 方言 t<seq> 的单调源) */
  seq: number;
}

export type BoardEvent =
  | { t: 'task-created'; taskId: string; title: string; spec: string; dependsOn: string[]; ts: number }
  | { t: 'dependency-added'; taskId: string; dependsOn: string; ts: number }
  | { t: 'assigned'; taskId: string; assignee: string; ts: number }
  | { t: 'status-changed'; taskId: string; from: TaskStatus; to: TaskStatus; ts: number; note?: string; conclusion?: string; tokens?: number; durationMs?: number }
  | { t: 'gate-set'; taskId: string; note?: string; ts: number }
  | { t: 'gate-resolved'; taskId: string; approved: boolean; ts: number };

/** 合法迁移闭集:pending→claimed/cancelled;claimed→in-review/failed/pending(恢复回池 §7.4);
 *  in-review→done/failed(lead 裁决);终态无出边 */
const LEGAL: Record<TaskStatus, TaskStatus[]> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in-review', 'failed', 'pending'],
  'in-review': ['done', 'failed'],
  done: [],
  failed: [],
  cancelled: [],
};

export function transitionLegal(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL[from].includes(to);
}

export function emptyBoard(): TaskBoardState {
  return { tasks: {}, seq: 0 };
}

/** 事件 reducer(纯):事件流是协调状态的唯一真相源(spec §7.2);未知 taskId 原引用返回(零分配) */
export function applyBoardEvent(state: TaskBoardState, ev: BoardEvent): TaskBoardState {
  switch (ev.t) {
    case 'task-created': {
      if (state.tasks[ev.taskId] !== undefined) return state;
      const task: BoardTask = {
        id: ev.taskId, title: ev.title, spec: ev.spec, status: 'pending',
        dependsOn: [...ev.dependsOn], createdAt: ev.ts, updatedAt: ev.ts,
      };
      return { tasks: { ...state.tasks, [ev.taskId]: task }, seq: Math.max(state.seq, Number(ev.taskId.slice(1)) || 0) };
    }
    case 'dependency-added': {
      const task = state.tasks[ev.taskId];
      if (task === undefined || task.dependsOn.includes(ev.dependsOn)) return state;
      return patch(state, ev.taskId, { dependsOn: [...task.dependsOn, ev.dependsOn], updatedAt: ev.ts });
    }
    case 'assigned': {
      const task = state.tasks[ev.taskId];
      if (task === undefined) return state;
      return patch(state, ev.taskId, { assignee: ev.assignee, updatedAt: ev.ts });
    }
    case 'status-changed': {
      const task = state.tasks[ev.taskId];
      if (task === undefined || !transitionLegal(ev.from, ev.to)) return state;
      const artifact = ev.conclusion !== undefined || ev.tokens !== undefined || ev.durationMs !== undefined
        ? { ...task.artifact, ...(ev.conclusion !== undefined ? { conclusion: ev.conclusion } : {}), ...(ev.tokens !== undefined ? { tokens: ev.tokens } : {}), ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}) }
        : task.artifact;
      return patch(state, ev.taskId, { status: ev.to, updatedAt: ev.ts, ...(artifact !== task.artifact ? { artifact } : {}) });
    }
    case 'gate-set': {
      const task = state.tasks[ev.taskId];
      if (task === undefined) return state;
      return patch(state, ev.taskId, { gated: true, updatedAt: ev.ts });
    }
    case 'gate-resolved': {
      const task = state.tasks[ev.taskId];
      if (task === undefined || ev.approved !== true) return state;
      return patch(state, ev.taskId, { gated: false, updatedAt: ev.ts });
    }
  }
}

function patch(state: TaskBoardState, id: string, fields: Partial<BoardTask>): TaskBoardState {
  const task = state.tasks[id]!;
  return { ...state, tasks: { ...state.tasks, [id]: { ...task, ...fields } } };
}

/** 派生 blocked(§4.1):pending 且任一依赖 failed/cancelled——不自动 skip,等 lead 裁决 */
export function derivedBlocked(state: TaskBoardState, taskId: string): boolean {
  const task = state.tasks[taskId];
  if (task === undefined || task.status !== 'pending') return false;
  return task.dependsOn.some((d) => {
    const dep = state.tasks[d];
    return dep !== undefined && (dep.status === 'failed' || dep.status === 'cancelled');
  });
}

/** 可派发集合:pending && !gated && 依赖全 done(创建序)——blocked/gated/依赖未满者自然出局 */
export function dispatchable(state: TaskBoardState): BoardTask[] {
  return Object.values(state.tasks)
    .filter((t) => t.status === 'pending' && t.gated !== true && t.dependsOn.every((d) => state.tasks[d]?.status === 'done'))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Kahn 环检测(spec §12.1 器官移植,自 graph/engine.ts:50-84 同构):返回环成员清单或 null */
export function hasCycle(tasks: Array<{ id: string; dependsOn: string[] }>): string[] | null {
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, 0);
    dependents.set(t.id, []);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!indeg.has(d)) continue; // 缺失依赖由调用方先校验,此处防御跳过
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
      dependents.get(d)!.push(t.id);
    }
  }
  let frontier = [...indeg.keys()].filter((id) => indeg.get(id) === 0);
  let placed = 0;
  while (frontier.length > 0) {
    placed += frontier.length;
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id)!) {
        indeg.set(dep, (indeg.get(dep) ?? 1) - 1);
        if (indeg.get(dep) === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  if (placed < indeg.size) {
    return [...indeg.keys()].filter((id) => (indeg.get(id) ?? 0) > 0);
  }
  return null;
}

/** 恢复回池(§7.4):claimed 无终态记录 → pending;终态/其余不动。返回恢复清单供协调器 append 自愈事件 */
export function recoverOnLoad(state: TaskBoardState): { state: TaskBoardState; recovered: string[] } {
  const recovered = Object.values(state.tasks).filter((t) => t.status === 'claimed').map((t) => t.id);
  if (recovered.length === 0) return { state, recovered };
  let next = state;
  for (const id of recovered) {
    next = applyBoardEvent(next, { t: 'status-changed', taskId: id, from: 'claimed', to: 'pending', ts: Date.now(), note: 'recovered after restart' });
  }
  return { state: next, recovered };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/taskboard/model.test.js`
Expected: PASS(5 用例)。

- [ ] **Step 5: 提交**

```bash
git add src/taskboard/model.ts src/taskboard/model.test.ts
git commit -m "feat(taskboard): Task 域模型纯件——状态机闭集/依赖派生(blocked 不落存储)/dispatchable 门控/Kahn 环检测自 graph 器官移植/applyBoardEvent 纯 reducer 三方共用(store 重放·协调器·TUI 投影)"
```

---

### Task 2: team 目录 event sourcing(src/taskboard/store.ts)

**Files:**
- Create: `src/taskboard/store.ts`
- Test: `src/taskboard/store.test.ts`

**Interfaces:**
- Consumes: `applyBoardEvent`/`emptyBoard`/`BoardEvent`/`TaskBoardState`(Task 1)
- Produces(Task 3/8 依赖):
  - `class TeamStore { constructor(teamDir: string); append(ev: BoardEvent): void; writeSnapshot(state: TaskBoardState): void; load(): TaskBoardState }`
  - 语义:append = 惰性 mkdir + `appendFileSync(events.jsonl, JSON 行)`;writeSnapshot = tmp+rename 原子写 `board.json`;load = 逐行重放(损坏行跳过),文件缺失返回 `emptyBoard()`

- [ ] **Step 1: 写失败测试**

创建 `src/taskboard/store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TeamStore } from './store';
import { applyBoardEvent, emptyBoard, TaskBoardState } from './model';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('append/load 往返:事件重放与内存 fold 一致;快照文件在', () => {
  const tmp = tmpdir('sunshinex-tb-store-');
  try {
    const store = new TeamStore(path.join(tmp, 'teams', 'main'));
    store.append({ t: 'task-created', taskId: 't1', title: 'A', spec: 'do A', dependsOn: [], ts: 1 });
    store.append({ t: 'task-created', taskId: 't2', title: 'B', spec: 'do B', dependsOn: ['t1'], ts: 2 });
    store.append({ t: 'status-changed', taskId: 't1', from: 'pending', to: 'claimed', ts: 3 });
    let expected = emptyBoard();
    for (const ev of [
      { t: 'task-created' as const, taskId: 't1', title: 'A', spec: 'do A', dependsOn: [] as string[], ts: 1 },
      { t: 'task-created' as const, taskId: 't2', title: 'B', spec: 'do B', dependsOn: ['t1'], ts: 2 },
      { t: 'status-changed' as const, taskId: 't1', from: 'pending' as const, to: 'claimed' as const, ts: 3 },
    ]) expected = applyBoardEvent(expected, ev);
    const loaded = store.load();
    assert.deepEqual(loaded, expected);
    store.writeSnapshot(loaded);
    assert.ok(fs.existsSync(path.join(tmp, 'teams', 'main', 'board.json')), '快照已写');
    assert.ok(!fs.existsSync(path.join(tmp, 'teams', 'main', 'board.json.' + process.pid)), '无 tmp 残留');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('load 容错:尾行截断跳过、中段损坏行跳过、缺文件空板', () => {
  const tmp = tmpdir('sunshinex-tb-store2-');
  try {
    const dir = path.join(tmp, 'teams', 'main');
    const store = new TeamStore(dir);
    assert.deepEqual(store.load(), emptyBoard(), '缺文件空板');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'events.jsonl');
    fs.writeFileSync(p, [
      JSON.stringify({ t: 'task-created', taskId: 't1', title: 'A', spec: 'do A', dependsOn: [], ts: 1 }),
      '{ "t": "task-cr', // 崩溃截断行(无换行)
      JSON.stringify({ t: 'task-created', taskId: 't2', title: 'B', spec: 'do B', dependsOn: [], ts: 2 }),
    ].join('\n'), 'utf8');
    const loaded = store.load();
    assert.equal(loaded.tasks['t1'] !== undefined && loaded.tasks['t2'] !== undefined, true, '完好两行生效');
    assert.equal(loaded.seq, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('load 后可继续 append(恢复写入路径畅通)', () => {
  const tmp = tmpdir('sunshinex-tb-store3-');
  try {
    const dir = path.join(tmp, 'teams', 'main');
    const store = new TeamStore(dir);
    store.append({ t: 'task-created', taskId: 't1', title: 'A', spec: 'do A', dependsOn: [], ts: 1 });
    const s1: TaskBoardState = store.load();
    assert.equal(s1.tasks['t1']!.status, 'pending');
    store.append({ t: 'status-changed', taskId: 't1', from: 'pending', to: 'done', ts: 2 });
    // 经合法链补两步使 done 可达(pending→claimed→done 由 reducer 闭集约束,此处直接验证继续追加生效)
    const s2 = store.load();
    assert.notEqual(s2.tasks['t1']!.updatedAt, s1.tasks['t1']!.updatedAt, '追加已生效');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/taskboard/store.test.js`
Expected: FAIL——`Cannot find module './store'`。

- [ ] **Step 3: 实现 store.ts**

创建 `src/taskboard/store.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { applyBoardEvent, BoardEvent, emptyBoard, TaskBoardState } from './model';

/** team 目录 event sourcing(spec §7.2):events.jsonl 为协调状态唯一真相源(append-only 单行原子),
 *  board.json 为物化快照缓存(tmp+rename 原子写,FileStore 先例)——P1 写不读,载入走全量重放
 *  (Ruling 5;快照读取优化 P2)。损坏行跳过 = Claude Code「单条脏数据卡死收件箱」教训的结构性回避(§7.3)。
 *  目录惰性建档:首写才 mkdir,空 team 零文件。inbox/ 子目录 P1 不建(随 P2 agent-message 落地,Ruling 7)。 */
export class TeamStore {
  private dirMade = false;

  constructor(private readonly teamDir: string) {}

  private eventsPath(): string {
    return path.join(this.teamDir, 'events.jsonl');
  }

  private ensureDir(): void {
    if (this.dirMade) return;
    fs.mkdirSync(this.teamDir, { recursive: true });
    this.dirMade = true;
  }

  append(ev: BoardEvent): void {
    this.ensureDir();
    fs.appendFileSync(this.eventsPath(), JSON.stringify(ev) + '\n', 'utf8');
  }

  writeSnapshot(state: TaskBoardState): void {
    this.ensureDir();
    const target = path.join(this.teamDir, 'board.json');
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, target);
  }

  /** 全量重放载入(P1 真相路径):文件缺失 = 空 team;损坏行(无换行截断/非法 JSON/缺 t 字段)跳过不炸 */
  load(): TaskBoardState {
    let raw: string;
    try {
      raw = fs.readFileSync(this.eventsPath(), 'utf8');
    } catch {
      return emptyBoard();
    }
    let state = emptyBoard();
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let ev: BoardEvent | undefined;
      try {
        const parsed = JSON.parse(line) as BoardEvent;
        if (typeof parsed.t === 'string') ev = parsed;
      } catch {
        ev = undefined; // 崩溃截断行:跳过该行
      }
      if (ev !== undefined) state = applyBoardEvent(state, ev);
    }
    return state;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/taskboard/store.test.js`
Expected: PASS(3 用例)。

- [ ] **Step 5: 提交**

```bash
git add src/taskboard/store.ts src/taskboard/store.test.ts
git commit -m "feat(taskboard): team 目录 event sourcing——events.jsonl append-only 真相源 + board.json 原子快照(P1 写不读) + 损坏行跳过重放载入"
```

---

### Task 3: TaskBoard 协调器(src/taskboard/board.ts)

**Files:**
- Create: `src/taskboard/board.ts`
- Test: `src/taskboard/board.test.ts`

**Interfaces:**
- Consumes: model.ts 全部(Task 1)、`TeamStore`(Task 2)、`SubagentRunner`(src/harness/subagent.ts)、`TaskRegistry`(src/harness/tasks.ts)、`SessionEvent`(src/types.ts)、`reactorMaxStepsEnv`/`subagentTokenCapEnv`(src/config/termination-config.ts)
- Produces(Task 4/5/8 依赖):
  - `class TaskBoard { constructor(deps: TaskBoardDeps); init(): void; create(input: { title: string; spec: string; dependsOn?: string[]; assignee?: string }): Result<{ taskId: string }>; setDependency(taskId: string, dependsOn: string): Result<void>; assign(taskId: string, assignee: string): Result<void>; review(taskId: string, opts: { approved: boolean; note?: string }): Result<void>; gate(taskId: string, note?: string): Result<void>; snapshot(): TaskBoardState; summaryLines(): string[] }`
  - `interface TaskBoardDeps { store: TeamStore; runner: SubagentRunner; registry: TaskRegistry; onEvent?: (e: SessionEvent) => void; now?: () => number; taskTimeoutMs?: number; maxOpenTasks?: number }`
  - SessionEvent 载荷口径(**统一,禁改**):`task-created {taskId,title,dependsOn}` / `task-status-changed {taskId,from,status,note?}` / `task-unlocked {taskId}` / `task-blocked {taskId,blockedBy}` / `gate-waiting {taskId,note?}` / `gate-resolved {taskId,approved}`;text 字段一律省略(纯结构化)

- [ ] **Step 1: 写失败测试**

创建 `src/taskboard/board.test.ts`(fake runner/registry,零模型依赖):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import { SessionEvent } from '../types';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Harness {
  board: TaskBoard;
  events: SessionEvent[];
  calls: string[]; // runner 收到的 taskLine 序(执行顺序断言)
}

function makeBoard(tmp: string, opts?: { failReplies?: string[] }): Harness {
  const events: SessionEvent[] = [];
  const calls: string[] = [];
  const failReplies = opts?.failReplies ?? [];
  const runner = {
    runSubagent: async (_input: unknown, o?: { taskLine?: string }) => {
      const line = o?.taskLine ?? '';
      calls.push(line);
      if (failReplies.includes(line)) return { ok: false as const, error: { code: 'INCOMPLETE', message: 'no finish' } };
      return { ok: true as const, value: { reply: `reply of ${line}`, tokens: 10 } };
    },
  } as unknown as SubagentRunner;
  const registry = { submit: () => ({ id: 'b1', stop: () => {} }), append: () => {}, finish: () => {}, list: () => [], get: () => undefined } as unknown as TaskRegistry;
  const board = new TaskBoard({
    store: new TeamStore(path.join(tmp, 'teams', 'main')),
    runner,
    registry,
    onEvent: (e) => events.push(e),
    now: (() => { let n = 1000; return () => ++n; })(),
  });
  board.init();
  return { board, events, calls };
}

const drain = () => new Promise((r) => setImmediate(r));

test('依赖顺序执行 + harness 强制回写 + 终态事件序', async () => {
  const tmp = tmpdir('sunshinex-tb-board-');
  try {
    const h = makeBoard(tmp);
    const a = h.board.create({ title: 'A', spec: 'do A' });
    const b = h.board.create({ title: 'B', spec: 'do B', dependsOn: ['t1'] });
    assert.ok(a.ok && b.ok);
    await drain();
    assert.deepEqual(h.calls, ['Task t1: A'], 't2 阻塞未派发');
    const s1 = h.board.snapshot();
    assert.equal(s1.tasks['t1']!.status, 'in-review', '强制回写 claimed→in-review(不依赖模型自觉)');
    assert.equal(s1.tasks['t2']!.status, 'pending');
    await h.board.review('t1', { approved: true });
    await drain();
    assert.deepEqual(h.calls, ['Task t1: A', 'Task t2: B'], '上游 done 解锁下游派发');
    await h.board.review('t2', { approved: true });
    const s2 = h.board.snapshot();
    assert.equal(s2.tasks['t1']!.status, 'done');
    assert.equal(s2.tasks['t2']!.status, 'done');
    const seq = h.events.map((e) => e.type).join(',');
    assert.ok(seq.includes('task-created') && seq.includes('task-unlocked') && seq.includes('task-status-changed'), `事件齐备:${seq}`);
    assert.ok(h.events.filter((e) => e.type === 'task-unlocked').length >= 2, '解锁事件至少 t1 与 t2 各一');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('执行失败:强制回写 failed + 下游 task-blocked 不自动 skip', async () => {
  const tmp = tmpdir('sunshinex-tb-board2-');
  try {
    const h = makeBoard(tmp, { failReplies: ['Task t1: A'] });
    h.board.create({ title: 'A', spec: 'do A' });
    h.board.create({ title: 'B', spec: 'do B', dependsOn: ['t1'] });
    await drain();
    const s = h.board.snapshot();
    assert.equal(s.tasks['t1']!.status, 'failed');
    assert.equal(s.tasks['t2']!.status, 'pending', '下游不被自动 skip(§4.1 收紧)');
    const blocked = h.events.find((e) => e.type === 'task-blocked');
    assert.ok(blocked, 'task-blocked 事件已发');
    assert.deepEqual((blocked!.payload as Record<string, unknown>)?.blockedBy, ['t1']);
    // lead 裁决:review(t1, approved=false 已是 failed)——对 failed 任务 review 应报错;改判路径走 in-review
    const r = await h.board.review('t1', { approved: true });
    assert.equal(r.ok, false, 'failed 任务不可 review');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('set_dependency 环检测 fail-fast;gate 挂起与解锁;限流;id 单调', async () => {
  const tmp = tmpdir('sunshinex-tb-board3-');
  try {
    const h = makeBoard(tmp);
    h.board.create({ title: 'A', spec: 'a' });
    h.board.create({ title: 'B', spec: 'b' });
    await drain(); // 两者执行完进 in-review
    const r = h.board.setDependency('t1', 't2');
    assert.ok(r.ok); // t2 尚未 done,加边合法(t1 已 in-review,环视角仍无环)
    const cyc = h.board.setDependency('t2', 't1');
    // t1→t2 与 t2→t1 成环:拒绝
    assert.equal(cyc.ok, false);
    assert.ok(String(cyc.error.message).includes('cycle'), `报错含环提示:${String(cyc.error.message)}`);
    // gate:新任务挂起不派发,approved 解锁
    const g = h.board.create({ title: 'C', spec: 'c' });
    await drain();
    assert.equal(h.board.snapshot().tasks['t3']!.status, 'in-review');
    h.board.review('t3', { approved: true });
    const c = h.board.create({ title: 'D', spec: 'd' });
    assert.ok(c.ok && c.value.taskId === 't4', 'id 单调');
    h.board.gate('t4', 'need human check');
    await drain();
    assert.equal(h.board.snapshot().tasks['t4']!.status, 'pending', 'gated 不派发');
    assert.ok(h.events.some((e) => e.type === 'gate-waiting'));
    await h.board.review('t4', { approved: true });
    assert.ok(h.events.some((e) => e.type === 'gate-resolved'));
    await drain();
    assert.equal(h.board.snapshot().tasks['t4']!.status, 'in-review', '解锁后派发');
    // 限流:maxOpenTasks 默认 64——此时 open = t2(in-review)+t4(in-review)=2,t1/t3 已 done;
    // bulk 62 个后 open=64,'over' 拒建
    for (let i = 0; i < 62; i++) h.board.create({ title: `bulk${i}`, spec: 'x', dependsOn: ['t4'] });
    const over = h.board.create({ title: 'over', spec: 'x', dependsOn: ['t4'] });
    assert.equal(over.ok, false, '超过 64 未终态任务拒建');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('持久化往返:重启 init 恢复板,claimed 无终态回池(自愈事件)', async () => {
  const tmp = tmpdir('sunshinex-tb-board4-');
  try {
    const h1 = makeBoard(tmp);
    h1.board.create({ title: 'A', spec: 'do A' });
    await drain();
    assert.equal(h1.board.snapshot().tasks['t1']!.status, 'in-review');
    // 新协调器同目录:load 恢复(此处无 claimed;另测 claimed 回池走 board 内部——直接构造事件)
    const store2 = new TeamStore(path.join(tmp, 'teams', 'main'));
    store2.append({ t: 'task-created', taskId: 't9', title: 'X', spec: 'x', dependsOn: [], ts: 1 });
    store2.append({ t: 'status-changed', taskId: 't9', from: 'pending', to: 'claimed', ts: 2 });
    const events2: SessionEvent[] = [];
    const board2 = new TaskBoard({
      store: store2,
      runner: { runSubagent: async () => ({ ok: true as const, value: { reply: 'r', tokens: 1 } }) } as unknown as SubagentRunner,
      registry: { submit: () => ({ id: 'b2', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry,
      onEvent: (e) => events2.push(e),
    });
    board2.init();
    const s = board2.snapshot();
    assert.equal(s.tasks['t9']!.status, 'pending', 'claimed 回池(§7.4)');
    assert.equal(s.tasks['t1']!.status, 'in-review', '前板的 in-review 存续');
    // 自愈事件已入流:再次裸 load(不 init)重放后 t9 应仍 pending(事件流自洽)
    const raw = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8');
    assert.ok(raw.includes('"note":"recovered after restart"'), '回池以事件落盘');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/taskboard/board.test.js`
Expected: FAIL——`Cannot find module './board'`。

- [ ] **Step 3: 实现 board.ts**

创建 `src/taskboard/board.ts`:

```ts
import type { SessionEvent } from '../types';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';
import { reactorMaxStepsEnv, subagentTokenCapEnv } from '../config/termination-config';
import { fail, ok, Result } from '../result';
import {
  applyBoardEvent, BoardEvent, BoardTask, dispatchable, emptyBoard, hasCycle,
  recoverOnLoad, TaskBoardState, transitionLegal,
} from './model';
import type { TeamStore } from './store';

/** TaskBoard 协调器(spec §5/§7):操作面(创建/依赖/指派/裁决/门)+ 事件发射(task-*/gate-* 进
 *  SessionEvent 公共面)+ event sourcing 持久化 + 批量并行派发 drain。
 *  派发(Ruling 1):dispatchable 批次经 registry.submit 登账本(task_wait(null) 可等待)后
 *  await runner.runSubagent(fork 顶替 teammate,§13 P1),完成即强制回写 claimed→in-review/failed
 *  (§5.4 harness 权威,不依赖模型自觉);失败对直接下游发 task-blocked(不自动 skip,§4.1)。
 *  init 只恢复不 kick(Ruling 2):旧任务不随会话启动自动执行。 */
export interface TaskBoardDeps {
  store: TeamStore;
  runner: SubagentRunner;
  registry: TaskRegistry;
  onEvent?: (e: SessionEvent) => void;
  now?: () => number;
  /** 单任务执行预算上限(ms),缺省 30 分钟 */
  taskTimeoutMs?: number;
  /** 未终态任务限流(spec §5.8),缺省 64 */
  maxOpenTasks?: number;
}

const DEFAULT_MAX_OPEN = 64;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export class TaskBoard {
  private state: TaskBoardState = emptyBoard();
  private draining = false;
  private readonly now: () => number;
  private readonly maxOpen: number;
  private readonly taskTimeoutMs: number;

  constructor(private readonly deps: TaskBoardDeps) {
    this.now = deps.now ?? Date.now;
    this.maxOpen = deps.maxOpenTasks ?? DEFAULT_MAX_OPEN;
    this.taskTimeoutMs = deps.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  }

  /** 载入恢复(§7.5):重放 → claimed 回池(自愈事件落流)→ 不 kick(Ruling 2) */
  init(): void {
    const loaded = this.deps.store.load();
    const { state, recovered } = recoverOnLoad(loaded);
    this.state = state;
    for (const id of recovered) {
      this.deps.store.append({ t: 'status-changed', taskId: id, from: 'claimed', to: 'pending', ts: this.now(), note: 'recovered after restart' });
      this.emit('task-status-changed', { taskId: id, from: 'claimed', status: 'pending', note: 'recovered after restart' });
    }
    this.deps.store.writeSnapshot(this.state);
  }

  snapshot(): TaskBoardState {
    return this.state;
  }

  /** 面板摘要行(工具 observation 与 TUI 共用):`t1 [in-review] A (等 t2)` 形态 */
  summaryLines(): string[] {
    return Object.values(this.state.tasks)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((t) => {
        const dep = t.dependsOn.length > 0 ? ` (等 ${t.dependsOn.join(',')})` : '';
        const gate = t.gated === true ? ' [gated]' : '';
        return `${t.id} [${t.status}]${gate} ${t.title}${dep}`;
      });
  }

  create(input: { title: string; spec: string; dependsOn?: string[]; assignee?: string }): Result<{ taskId: string }> {
    if (typeof input.title !== 'string' || input.title.length === 0 || typeof input.spec !== 'string' || input.spec.length === 0) {
      return fail('INVALID_ARG', 'create requires non-empty title and spec');
    }
    const deps = input.dependsOn ?? [];
    const unknown = deps.filter((d) => this.state.tasks[d] === undefined);
    if (unknown.length > 0) return fail('INVALID_ARG', `unknown dependency: ${unknown.join(', ')}`);
    const open = Object.values(this.state.tasks).filter((t) => t.status !== 'done' && t.status !== 'failed' && t.status !== 'cancelled').length;
    if (open >= this.maxOpen) return fail('INVALID_ARG', `task board open-task limit reached (${this.maxOpen}); review or cancel existing tasks first`);
    const taskId = `t${this.state.seq + 1}`;
    const ev: BoardEvent = { t: 'task-created', taskId, title: input.title, spec: input.spec, dependsOn: deps, ts: this.now() };
    this.applyAndPersist(ev);
    if (input.assignee !== undefined && input.assignee.length > 0) {
      this.applyAndPersist({ t: 'assigned', taskId, assignee: input.assignee, ts: this.now() });
    }
    this.emit('task-created', { taskId, title: input.title, dependsOn: deps });
    this.kick();
    return ok({ taskId });
  }

  setDependency(taskId: string, dependsOn: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (this.state.tasks[dependsOn] === undefined) return fail('INVALID_ARG', `unknown dependency: ${dependsOn}`);
    if (task.dependsOn.includes(dependsOn)) return ok(undefined);
    const candidate = Object.values(this.state.tasks).map((t) =>
      t.id === taskId ? { id: t.id, dependsOn: [...t.dependsOn, dependsOn] } : { id: t.id, dependsOn: [...t.dependsOn] },
    );
    const cycle = hasCycle(candidate);
    if (cycle !== null) return fail('INVALID_ARG', `dependency would create a cycle: ${cycle.join(' -> ')}`);
    this.applyAndPersist({ t: 'dependency-added', taskId, dependsOn, ts: this.now() });
    this.kick();
    return ok(undefined);
  }

  assign(taskId: string, assignee: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (typeof assignee !== 'string' || assignee.length === 0) return fail('INVALID_ARG', 'assignee must be non-empty');
    this.applyAndPersist({ t: 'assigned', taskId, assignee, ts: this.now() });
    return ok(undefined);
  }

  /** lead 裁决双语义:gated → 审批(approved 解锁 / 拒绝维持);in-review → 关单(approved=done / 拒=failed) */
  review(taskId: string, opts: { approved: boolean; note?: string }): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (task.gated === true) {
      if (opts.approved) {
        this.applyAndPersist({ t: 'gate-resolved', taskId, approved: true, ts: this.now() });
        this.emit('gate-resolved', { taskId, approved: true });
        this.kick();
        return ok(undefined);
      }
      return ok(undefined); // 拒绝审批:维持 gated(lead 可改任务或再议)
    }
    if (task.status === 'in-review') {
      const to = opts.approved ? 'done' : 'failed';
      if (!transitionLegal('in-review', to)) return fail('INVALID_STATE', `illegal transition in-review -> ${to}`);
      this.applyAndPersist({ t: 'status-changed', taskId, from: 'in-review', to, ts: this.now(), ...(opts.note !== undefined ? { note: opts.note } : {}) });
      this.emit('task-status-changed', { taskId, from: 'in-review', status: to, ...(opts.note !== undefined ? { note: opts.note } : {}) });
      if (!opts.approved) this.emitBlockedDownstream(taskId);
      this.kick();
      return ok(undefined);
    }
    return fail('INVALID_ARG', `review expects a gated or in-review task, ${taskId} is ${task.status}`);
  }

  gate(taskId: string, note?: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (task.status === 'claimed') return fail('INVALID_ARG', 'cannot gate a task mid-execution');
    this.applyAndPersist({ t: 'gate-set', taskId, ts: this.now(), ...(note !== undefined ? { note } : {}) });
    this.emit('gate-waiting', { taskId, ...(note !== undefined ? { note } : {}) });
    return ok(undefined);
  }

  private applyAndPersist(ev: BoardEvent): void {
    this.state = applyBoardEvent(this.state, ev);
    this.deps.store.append(ev);
    this.deps.store.writeSnapshot(this.state);
  }

  private emit(type: SessionEvent['type'], payload: Record<string, unknown>): void {
    this.deps.onEvent?.({ type, payload, ts: this.now() });
  }

  /** 上游 failed:直接下游 pending 者发 task-blocked(§4.1 不自动 skip;blockedBy=其依赖中的失败者) */
  private emitBlockedDownstream(failedId: string): void {
    for (const t of Object.values(this.state.tasks)) {
      if (t.status === 'pending' && t.dependsOn.includes(failedId)) {
        const blockedBy = t.dependsOn.filter((d) => this.state.tasks[d]?.status === 'failed' || this.state.tasks[d]?.status === 'cancelled');
        this.emit('task-blocked', { taskId: t.id, blockedBy });
      }
    }
  }

  private kick(): void {
    void this.drain();
  }

  /** 批量并行派发(graph 层内 allSettled 先例):每轮取当前 dispatchable 全批并发,完成后续跑下一轮 */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const batch = dispatchable(this.state);
        if (batch.length === 0) break;
        for (const t of batch) this.emit('task-unlocked', { taskId: t.id });
        await Promise.allSettled(batch.map((t) => this.executeOne(t)));
      }
    } finally {
      this.draining = false;
    }
  }

  private async executeOne(task: BoardTask): Promise<void> {
    this.applyAndPersist({ t: 'status-changed', taskId: task.id, from: 'pending', to: 'claimed', ts: this.now() });
    this.emit('task-status-changed', { taskId: task.id, from: 'pending', status: 'claimed' });
    const ledger = this.deps.registry.submit({ kind: 'subagent', label: `task-${task.id}` });
    const abort = new AbortController();
    ledger.stop = () => abort.abort();
    this.deps.registry.append(ledger.id, `[taskboard] ${task.id}: ${task.title}\n`);
    const startedAt = this.now();
    let okRun = false;
    let reply = '';
    let tokens = 0;
    try {
      const tokenCap = subagentTokenCapEnv();
      const r = await this.deps.runner.runSubagent(
        { prompt: task.spec, label: `task-${task.id}` },
        {
          taskLine: `Task ${task.id}: ${task.title}`,
          signal: abort.signal,
          budget: {
            maxSteps: reactorMaxStepsEnv() ?? 400,
            ...(tokenCap !== undefined ? { tokenCap } : {}),
            deadlineAt: Date.now() + this.taskTimeoutMs,
          },
        },
      );
      if (r.ok) {
        okRun = true;
        reply = r.value.reply;
        tokens = r.value.tokens;
      }
    } catch {
      okRun = false;
    }
    const durationMs = this.now() - startedAt;
    // harness 强制回写(§5.4):claimed → in-review/failed,不依赖模型自觉标记
    this.applyAndPersist({
      t: 'status-changed', taskId: task.id, from: 'claimed', to: okRun ? 'in-review' : 'failed', ts: this.now(),
      ...(okRun ? { conclusion: reply, tokens, durationMs } : { note: 'execution failed' }),
    });
    this.emit('task-status-changed', { taskId: task.id, from: 'claimed', status: okRun ? 'in-review' : 'failed' });
    if (okRun) {
      this.deps.registry.finish(ledger.id, 'done', { marker: `[conclusion] ${reply}\n` });
    } else {
      this.deps.registry.finish(ledger.id, 'failed');
      this.emitBlockedDownstream(task.id);
    }
  }
}
```

注意:`ok`/`fail`/`Result` 自 `src/result.ts`(仓库既有 Result 体系,签名现场核对);`reactorMaxStepsEnv`/`subagentTokenCapEnv` 与 `SubagentBudget.deadlineAt` 字段以 src/graph/agents.ts:49-55 同款为准,如有出入按现场类型微调并在报告记录。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/taskboard/board.test.js dist/taskboard/model.test.js dist/taskboard/store.test.js`
Expected: PASS(4+5+3 用例)。

- [ ] **Step 5: 提交**

```bash
git add src/taskboard/board.ts src/taskboard/board.test.ts
git commit -m "feat(taskboard): 协调器——操作面+task-*/gate-* 事件发射+批量并行 drain 派发(台账登记/task_wait 可等)+harness 强制回写 claimed→in-review/failed+失败下游 task-blocked 不自动 skip+恢复回池自愈事件"
```

---

### Task 4: lead 工具五件套 + 装配 + 工具面收窄扩剔

**Files:**
- Create: `src/harness/tools/taskboard-tools.ts`
- Modify: `src/harness/index.ts`(task_wait 注册点之后 ~:208:TaskBoard 构造 + 工具注册)
- Modify: `src/harness/subagent.ts:238-248`(deriveChildRegistry 两个分支的剔除清单扩入五件套)
- Test: `src/harness/tools/taskboard-tools.test.ts`

**Interfaces:**
- Consumes: `TaskBoard`(Task 3)、`RegisteredTool`/`CodedToolError`(src/harness/tools.ts)、task-wait.ts 工具形态模板
- Produces:
  - `const TASKBOARD_TOOL_NAMES = ['create_task', 'set_dependency', 'assign', 'review_task', 'gate_task'] as const`
  - `function makeTaskBoardTools(board: TaskBoard): RegisteredTool[]`(五件套,category `'task'`,fullObservation true,observation 尾附 `board.summaryLines()`)
  - Harness 新增公开只读字段 `readonly taskboard: TaskBoard`(测试/后续阶段消费)

- [ ] **Step 1: 写失败测试**

创建 `src/harness/tools/taskboard-tools.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeTaskBoardTools, TASKBOARD_TOOL_NAMES } from './taskboard-tools';
import { TaskBoard } from '../../taskboard/board';
import { TeamStore } from '../../taskboard/store';
import type { SubagentRunner } from '../subagent';
import type { TaskRegistry } from '../tasks';

function makeBoard(tmp: string): TaskBoard {
  const runner = { runSubagent: async (_i: unknown, o?: { taskLine?: string }) => ({ ok: true as const, value: { reply: `r ${o?.taskLine ?? ''}`, tokens: 1 } }) } as unknown as SubagentRunner;
  const registry = { submit: () => ({ id: 'b1', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry;
  const board = new TaskBoard({ store: new TeamStore(path.join(tmp, 'teams', 'main')), runner, registry });
  board.init();
  return board;
}

const drain = () => new Promise((r) => setImmediate(r));

test('五件套:name/category 全集与 observation 带板摘要', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools-'));
  try {
    const board = makeBoard(tmp);
    const tools = makeTaskBoardTools(board);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TASKBOARD_TOOL_NAMES].sort());
    assert.ok(tools.every((t) => t.category === 'task'));
    const create = tools.find((t) => t.name === 'create_task')!;
    const r = await create.executor({ title: 'A', spec: 'do A', dependsOn: null, assignee: null });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /t1/, 'observation 含新任务 id');
    await drain();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create_task 依赖校验 + set_dependency 环拒绝经工具面透出', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools2-'));
  try {
    const board = makeBoard(tmp);
    const tools = makeTaskBoardTools(board);
    const create = tools.find((t) => t.name === 'create_task')!;
    const setDep = tools.find((t) => t.name === 'set_dependency')!;
    await create.executor({ title: 'A', spec: 'a', dependsOn: null, assignee: null });
    await create.executor({ title: 'B', spec: 'b', dependsOn: ['t1'], assignee: null });
    await drain();
    await assert.rejects(() => setDep.executor({ taskId: 't1', dependsOn: 't2' }), /cycle/, '环拒绝透出 INVALID_ARG');
    await assert.rejects(() => create.executor({ title: 'C', spec: 'c', dependsOn: ['tX'], assignee: null }), /unknown dependency/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/tools/taskboard-tools.test.js`
Expected: FAIL——`Cannot find module './taskboard-tools'`。

- [ ] **Step 3: 实现 taskboard-tools.ts + 两处装配**

创建 `src/harness/tools/taskboard-tools.ts`(形态对齐 task-wait.ts;description 英文;null 联合进 required):

```ts
// TaskBoard lead 工具五件套(spec §5.8):主链模型操作任务板的唯一入口——create_task / set_dependency /
// assign / review_task / gate_task。category 'task';observation 尾附板摘要(summaryLines)供模型一眼
// 看板;create_task 即触发派发(drain 异步),等待经既有 task_wait(null)(Ruling 1)。
// lead-only 不变量:五件套随 deriveChildRegistry 扩剔(TASKBOARD_TOOL_NAMES),子代理工具面不可见。
import { CodedToolError, RegisteredTool } from '../tools';
import type { TaskBoard } from '../../taskboard/board';

export const TASKBOARD_TOOL_NAMES = ['create_task', 'set_dependency', 'assign', 'review_task', 'gate_task'] as const;

function boardTail(board: TaskBoard): string {
  const lines = board.summaryLines();
  return lines.length === 0 ? '(task board empty)' : ['board:', ...lines].join('\n');
}

export function makeTaskBoardTools(board: TaskBoard): RegisteredTool[] {
  const createTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'spec', 'dependsOn', 'assignee'],
      properties: {
        title: { type: ['string', 'null'], description: 'Short task title shown on the board.' },
        spec: { type: ['string', 'null'], description: 'Self-contained task description: the executing agent sees ONLY this (no main-chain context), so include everything needed.' },
        dependsOn: { type: ['array', 'null'], items: { type: 'string' }, description: 'Task ids this task depends on (e.g. ["t1"]); null/empty = no dependencies. A task dispatches only after all dependencies are done.' },
        assignee: { type: ['string', 'null'], description: 'Optional assignee label (bookkeeping; executor routing lands in P2).' },
      },
    },
    name: 'create_task',
    description:
      'Create a task on the shared task board. Unblocked tasks (no unfinished dependencies, not gated) are dispatched automatically to a subagent; wait with task_wait (taskIds=null). The board persists across sessions.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { title?: string | null; spec?: string | null; dependsOn?: string[] | null; assignee?: string | null };
      const r = board.create({
        title: String(raw.title ?? ''),
        spec: String(raw.spec ?? ''),
        dependsOn: raw.dependsOn ?? undefined,
        assignee: raw.assignee ?? undefined,
      });
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: [`task ${r.value.taskId} created; dispatch is automatic for unblocked tasks — block with task_wait (taskIds=null)`, boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };
  const setDependency: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'dependsOn'],
      properties: {
        taskId: { type: ['string', 'null'], description: 'Task id that gains a dependency (e.g. "t2").' },
        dependsOn: { type: ['string', 'null'], description: 'Task id to depend on; rejected if it would create a cycle.' },
      },
    },
    name: 'set_dependency',
    description: 'Add a dependency edge to a board task. Fails fast on unknown ids or cycles.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskId?: string | null; dependsOn?: string | null };
      const r = board.setDependency(String(raw.taskId ?? ''), String(raw.dependsOn ?? ''));
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: ['dependency added', boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };
  const assign: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'assignee'],
      properties: {
        taskId: { type: ['string', 'null'], description: 'Task id.' },
        assignee: { type: ['string', 'null'], description: 'Assignee label (bookkeeping in P1).' },
      },
    },
    name: 'assign',
    description: 'Record an assignee on a board task (bookkeeping; executor routing lands in P2).',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskId?: string | null; assignee?: string | null };
      const r = board.assign(String(raw.taskId ?? ''), String(raw.assignee ?? ''));
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: ['assigned', boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };
  const reviewTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'approved', 'note'],
      properties: {
        taskId: { type: ['string', 'null'], description: 'Task id to review.' },
        approved: { type: ['boolean', 'null'], description: 'For an in-review task: true = done, false = failed. For a gated task: true = approve and resume dispatch, false = keep gated.' },
        note: { type: ['string', 'null'], description: 'Optional rationale recorded with the decision.' },
      },
    },
    name: 'review_task',
    description:
      'Lead ruling on a board task: close an in-review task (approved=true marks done and unblocks dependents; false marks failed, which blocks dependents) or resolve a gate (approved=true resumes dispatch).',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskId?: string | null; approved?: boolean | null; note?: string | null };
      const r = board.review(String(raw.taskId ?? ''), { approved: raw.approved === true, note: raw.note ?? undefined });
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: ['review recorded', boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };
  const gateTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'note'],
      properties: {
        taskId: { type: ['string', 'null'], description: 'Task id to gate (must not be mid-execution).' },
        note: { type: ['string', 'null'], description: 'Why human approval is needed; shown with the gate.' },
      },
    },
    name: 'gate_task',
    description: 'Put a task behind an approval gate: dispatch skips it until review_task(approved=true) resolves the gate.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskId?: string | null; note?: string | null };
      const r = board.gate(String(raw.taskId ?? ''), raw.note ?? undefined);
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: ['gate set — task will not dispatch until approved via review_task', boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };
  return [createTask, setDependency, assign, reviewTask, gateTask];
}
```

`src/harness/index.ts` 装配(task_wait 注册行之后,形态同 spawn/task_stop/task_wait 三连):

```ts
    // TaskBoard(spec 2026-10-04 §13 P1):工作区单隐式 team main(Ruling 2),teams 目录走统一定位面;
    // init 只恢复不 kick;lead 工具五件套 lead-only(deriveChildRegistry 扩剔)
    this.taskboard = new TaskBoard({
      store: new TeamStore(path.join(resolveDataDir(base), 'teams', 'main')),
      runner: this.runner,
      registry: this.tasks,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    });
    this.taskboard.init();
    for (const t of makeTaskBoardTools(this.taskboard)) this.tools.register(t);
```

(顶部 import:`TaskBoard`/`TeamStore`/`makeTaskBoardTools`;`path` 若未引入则补。`readonly taskboard: TaskBoard` 字段声明加在 `tasks` 字段旁。)

`src/harness/subagent.ts` deriveChildRegistry(238-248)两个分支的剔除清单各扩入五件套:

```ts
import { TASKBOARD_TOOL_NAMES } from './tools/taskboard-tools';
// ...
      child.unregister(TODO_TOOL_NAME);
      child.unregister(SPAWN_TOOL_NAME);
      child.unregister('ask_question');
      child.unregister('worktree');
      for (const n of TASKBOARD_TOOL_NAMES) child.unregister(n);
// 与 exclude 分支:
    return this.deps.registry.derive({ exclude: [SPAWN_TOOL_NAME, TODO_TOOL_NAME, 'ask_question', 'worktree', ...TASKBOARD_TOOL_NAMES] });
```

并在该函数头部注释补一句:「taskboard 五件套 lead-only(2026-10-05 P1)」。

- [ ] **Step 4: 跑测试确认通过 + 装配回归**

Run: `pnpm build && node --test dist/harness/tools/taskboard-tools.test.js dist/taskboard/board.test.js dist/harness/subagent.test.js dist/harness/subagent.spawn.test.js`
Expected: PASS(新 2 用例;deriveChildRegistry 扩剔不破既有 spawn 系测试)。

- [ ] **Step 5: 提交**

```bash
git add src/harness/tools/taskboard-tools.ts src/harness/tools/taskboard-tools.test.ts src/harness/index.ts src/harness/subagent.ts
git commit -m "feat(harness): lead 工具五件套装配——create_task/set_dependency/assign/review_task/gate_task(category task,observation 附板摘要);TaskBoard 入 Harness(teams/main 惰性档);deriveChildRegistry 扩剔五件套(lead-only 不变量)"
```

---

### Task 5: 端到端集成(主链 → 板 → 派发 → 强制回写 → 裁决)

**Files:**
- Test: `src/harness/taskboard.e2e.test.ts`(新建,零产品码——装配正确性的行为证明)

**Interfaces:**
- Consumes: Task 4 全部装配(`Harness` + 五件套)、`ScriptedAdapter`、既有 spawn e2e 形态(src/harness/subagent.spawn.test.ts:10-34)
- Produces: 无(纯验收测试)

- [ ] **Step 1: 写测试(直接写通过形态——装配已在 Task 4 落地,本任务是行为验收)**

创建 `src/harness/taskboard.e2e.test.ts`:

```ts
// P1 端到端验收(spec §13):lead 建任务+依赖 → 自动派发(fork 顶替)→ harness 强制回写 →
// task_wait(null) 拉模式唤醒 → review 裁决闭环。ScriptedAdapter 消费序确定性依据:
// 主链在 task_wait 工具执行内阻塞(不发起下一次模型调用),fork 的模型调用独占脚本队列;
// B 依赖 A,B 的脚本位必然在 A 之后。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { ScriptedAdapter } from '../model/adapter';
import { SessionEvent } from '../types';

test('e2e:依赖链 t1→t2 顺序执行、强制回写、review 闭环', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbe2e-'));
  try {
    // 脚本消费序确定性:主链阻塞在 task_wait 工具执行器内时不发起模型调用,fork 独占脚本队列;
    // B 依赖 A → B 的脚本位必然在 A 之后。数组位序:1-3 主链建板+首等,A 消费 4,
    // 二次 task_wait 等 B(5 主链/B 消费 6),7-8 裁决,9 收尾。
    const model = new ScriptedAdapter([
      JSON.stringify({ tool: 'create_task', input: { title: 'A', spec: 'produce A report', dependsOn: null, assignee: null } }),
      JSON.stringify({ tool: 'create_task', input: { title: 'B', spec: 'produce B report', dependsOn: ['t1'], assignee: null } }),
      JSON.stringify({ tool: 'task_wait', input: { taskIds: null, timeoutSeconds: 30 } }),
      JSON.stringify({ done: true, reply: 'A report done' }),
      JSON.stringify({ tool: 'task_wait', input: { taskIds: null, timeoutSeconds: 30 } }),
      JSON.stringify({ done: true, reply: 'B report done' }),
      JSON.stringify({ tool: 'review_task', input: { taskId: 't1', approved: true, note: null } }),
      JSON.stringify({ tool: 'review_task', input: { taskId: 't2', approved: true, note: null } }),
      JSON.stringify({ done: true, reply: 'board closed' }),
    ]);
    const events: SessionEvent[] = [];
    const h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false, onEvent: (e) => events.push(e) });
    const r = await h.reactor.run({ goal: '完成板上任务并收尾' }, { maxSteps: 12 });
    assert.equal(r.done, true);
    const s = h.taskboard.snapshot();
    assert.equal(s.tasks['t1']!.status, 'done');
    assert.equal(s.tasks['t2']!.status, 'done');
    // 执行顺序:t2 的委派事件必在 t1 终态之后
    const idx = (pred: (e: SessionEvent) => boolean) => events.findIndex(pred);
    const t1Ended = idx((e) => e.type === 'delegation-ended' && (e.payload as Record<string, unknown>)?.delegationId === 'task-t1');
    const t2Started = idx((e) => e.type === 'delegation-started' && (e.payload as Record<string, unknown>)?.delegationId === 'task-t2');
    assert.ok(t1Ended >= 0 && t2Started > t1Ended, `t2 派发晚于 t1 终态(${t1Ended} < ${t2Started})`);
    assert.ok(events.some((e) => e.type === 'task-created' && (e.payload as Record<string, unknown>)?.taskId === 't1'));
    assert.ok(events.some((e) => e.type === 'task-unlocked'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

**实现注记(执行者必读)**:`HarnessOptions.onEvent` 以现场注入点为准(Pipeline/SubagentRunner 同源,src/harness/index.ts:170/196 先例)。断言不变;若脚本消费序与断言不符(装配时序差异),修**测试脚本的位序**而非产品码;若产品装配确有缺陷(事件不达/派发不触发),回 Task 3/4 定位并在报告记录。

- [ ] **Step 2: 跑测试**

Run: `pnpm build && node --test dist/harness/taskboard.e2e.test.js`
Expected: PASS。若脚本消费序与断言不符(装配时序差异),修**测试脚本的位序**而非产品码;若产品装配确有缺陷(事件不达/派发不触发),回 Task 3/4 定位并在报告记录。

- [ ] **Step 3: 提交**

```bash
git add src/harness/taskboard.e2e.test.ts
git commit -m "test(harness): P1 端到端验收——依赖链顺序派发(fork 顶替)/task_wait(null) 拉模式唤醒/强制回写 in-review/review 闭环 done/事件序断言(t2 派发晚于 t1 终态)"
```

---

### Task 6: Inbox / Executor 接口定型 + MemoryInbox

**Files:**
- Create: `src/taskboard/inbox.ts`
- Create: `src/taskboard/executor.ts`
- Test: `src/taskboard/inbox.test.ts`

**Interfaces:**
- Consumes: `SessionEvent`(types)
- Produces(P2 依赖,协议占位 per spec §4.3/§4.4/Ruling 7):
  - `interface AgentMessage { id: string; from: string; to: string; text: string; ts: number }`
  - `interface Inbox { send(to: string, msg: Omit<AgentMessage, 'id' | 'to' | 'ts'>): Promise<AgentMessage>; poll(agent: string, since: number): AgentMessage[] }`
  - `class MemoryInbox implements Inbox`(append-only 数组 + 单调 id `m<seq>` + poll 按 ts 严格大于)
  - `interface Executor { capabilities(): { contextSource: 'fork' | 'independent'; tools: string[]; stopGranularity: 'turn' | 'process'; budgetModel: 'event-precise' | 'deadline-coarse' }; start(task: { id: string; spec: string; title: string }, inbox: Inbox): { events$: AsyncIterable<SessionEvent>; conclusion$: Promise<{ ok: boolean; reply: string; tokens: number }>; stop(): Promise<void> } }`(纯类型 + JSDoc:P1 的 drain+runSubagent 即 internal-fork 执行体的非正式实现,P2 落 class)

- [ ] **Step 1: 写失败测试**

创建 `src/taskboard/inbox.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryInbox } from './inbox';

test('MemoryInbox:send/poll/位点语义(ts 严格大于,至少一次投递的读侧)', async () => {
  const inbox = new MemoryInbox();
  const m1 = await inbox.send('worker', { from: 'lead', text: 'hello' });
  const m2 = await inbox.send('worker', { from: 'lead', text: 'second' });
  assert.notEqual(m1.id, m2.id);
  assert.ok(m1.ts <= m2.ts, 'ts 单调');
  assert.deepEqual(inbox.poll('worker', 0).map((m) => m.text), ['hello', 'second']);
  assert.deepEqual(inbox.poll('worker', m1.ts).map((m) => m.text), ['second'], '位点含等于的上一条之后');
  assert.deepEqual(inbox.poll('other', 0), [], '按收件人隔离');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/taskboard/inbox.test.js`
Expected: FAIL——`Cannot find module './inbox'`。

- [ ] **Step 3: 实现 inbox.ts + executor.ts**

`src/taskboard/inbox.ts`:

```ts
/** Inbox 接口定型(spec §4.4/Ruling 7):agent 间消息收件箱——append-only 队列 + 消费位点(ts)。
 *  P1 只交付 MemoryInbox(单进程内存实现);文件 inbox(<teams>/inbox/<agent>.jsonl)随 P2
 *  agent-message 落地,协议(append-only + 位点 + 至少一次 + 注入幂等)两实现共用——换实现不换语义。 */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  ts: number;
}

export interface Inbox {
  send(to: string, msg: Omit<AgentMessage, 'id' | 'to' | 'ts'>): Promise<AgentMessage>;
  /** 取 agent 的 ts 严格大于 since 的消息(位点 = 已消费的最大 ts;至少一次投递的读侧) */
  poll(agent: string, since: number): AgentMessage[];
}

export class MemoryInbox implements Inbox {
  private messages: AgentMessage[] = [];
  private seq = 0;
  private clock = 0;

  async send(to: string, msg: Omit<AgentMessage, 'id' | 'to' | 'ts'>): Promise<AgentMessage> {
    this.seq += 1;
    this.clock = Math.max(this.clock + 1, Date.now());
    const full: AgentMessage = { id: `m${this.seq}`, to, ts: this.clock, from: msg.from, text: msg.text };
    this.messages = [...this.messages, full];
    return full;
  }

  poll(agent: string, since: number): AgentMessage[] {
    return this.messages.filter((m) => m.to === agent && m.ts > since);
  }
}
```

`src/taskboard/executor.ts`:

```ts
/** Executor 接口定型(spec §4.3/Ruling 7):执行体统一契约——P1 的 drain + runSubagent 即
 *  internal-fork 执行体的非正式实现(协议面先立,P2 落 internal-team/external-cli 两个 class)。 */
import type { SessionEvent } from '../types';
import type { Inbox } from './inbox';

export interface Executor {
  capabilities(): {
    contextSource: 'fork' | 'independent';
    tools: string[];
    stopGranularity: 'turn' | 'process';
    budgetModel: 'event-precise' | 'deadline-coarse';
  };
  start(task: { id: string; spec: string; title: string }, inbox: Inbox): {
    events$: AsyncIterable<SessionEvent>;
    conclusion$: Promise<{ ok: boolean; reply: string; tokens: number }>;
    stop(): Promise<void>;
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/taskboard/inbox.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/taskboard/inbox.ts src/taskboard/executor.ts src/taskboard/inbox.test.ts
git commit -m "feat(taskboard): Inbox/Executor 接口定型——MemoryInbox(append-only+ts 位点,至少一次读侧);Executor 契约(P2 internal-team/external-cli 的协议占位)"
```

---

### Task 7: TUI 收敛——分流防御 + 板投影 + 投影单源 + 门限对齐 + 受保护测试协议补齐

**Files:**
- Modify: `src/tui/session.ts:1052-1066`(onEvent:类型前缀防御前置 + task-*/gate-* 进板投影)
- Modify: `src/tui/chat-model.ts:244-257`(TuiState.board 字段 + runningDelegations 收敛为投影单源)
- Modify: `src/tui/session.ts:94、820` 与 `src/tui/commands-session.ts:104`(三处构造点补 `board: emptyBoard()`)
- Modify: `src/tui/components/App.tsx:287、~507-513`(runningChildren 口径沿用 runningDelegations;面板渲染门限从 `state.children.length > 0` 改为 rows 非空)
- Modify(协议补齐,仅限以下两文件):`src/tui/components/App.spawn-browse.test.tsx`、`src/tui/components/App.inspect.test.tsx`
- Test: `src/tui/session.board.test.tsx`(新建)

**Interfaces:**
- Consumes: `applyBoardEvent`/`emptyBoard`/`TaskBoardState`(Task 1)、P0 的 `applyDelegation`/`runningDelegations` 体系
- Produces: `TuiState.board: TaskBoardState`(瞬态,事件流推导,与 task/LiveTaskState 同口径);`runningDelegations(st: Pick<TuiState, 'delegations'>)`(签名收窄——children 不再入参,投影单源)

- [ ] **Step 1: 写失败测试**

创建 `src/tui/session.board.test.tsx`:

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { runningDelegations } from './chat-model';
import { ScriptedAdapter } from '../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('task-* 事件进板投影;delegation 带标签不再误吞(分流防御)', () => {
  const tmp = tmpdir('sunshinex-sess-board-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'task-created', ts: 100, payload: { taskId: 't1', title: 'A', dependsOn: [] } } as never);
    ctrl.onEventForTest({ type: 'task-status-changed', ts: 101, payload: { taskId: 't1', from: 'pending', status: 'claimed' } } as never);
    let st = ctrl.getState();
    assert.equal(st.board.tasks['t1']!.status, 'claimed');
    assert.equal(st.board.seq, 1);
    // 分流防御:delegation 事件即使被误打 subagent 标签也走投影(终审 minor 的结构性回避)
    ctrl.onEventForTest({ type: 'delegation-started', ts: 102, payload: { delegationId: 'task-t1', kind: 'subagent', label: 'task-t1', subagent: 'task-t1' } } as never);
    st = ctrl.getState();
    assert.equal(st.delegations.length, 1, '带标签的 delegation 事件仍进投影');
    assert.equal(st.children.length, 0, '不误入子代理面板分支');
    // 单源收敛:children 不再是 runningDelegations 数据源
    ctrl.onEventForTest({ type: 'token', text: 'x\n', payload: { subagent: 'orphan' } } as never);
    assert.deepEqual(runningDelegations(ctrl.getState()).map((r) => r.label), ['task-t1'], '无 delegation 事件的 children 行不再显示');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/new 重置板投影', () => {
  const tmp = tmpdir('sunshinex-sess-boardnew-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'task-created', ts: 100, payload: { taskId: 't1', title: 'A', dependsOn: [] } } as never);
    assert.ok(Object.keys(ctrl.getState().board.tasks).length > 0);
    void ctrl.submit('/new');
    assert.equal(Object.keys(ctrl.getState().board.tasks).length, 0, '/new 清空板投影');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tui/session.board.test.js`
Expected: FAIL——`st.board` undefined;带标签 delegation 事件被 subagent 分支吞掉。

- [ ] **Step 3: 实现五处接线**

① `src/tui/chat-model.ts`:import 补 `import type { TaskBoardState } from '../taskboard/model';` 与 `import { applyBoardEvent, emptyBoard } from '../taskboard/model';`——**board 字段只进类型,applyBoardEvent 由 session.ts 引**(chat-model 零 this 依赖纯件纪律)。TuiState 的 `delegations` 字段后加:

```ts
  /** 板投影(P1,spec §4.5/§11):task-*/gate-* 事件经 applyBoardEvent 推导;瞬态不进 journal
   *  (真相源是 teams 目录 events.jsonl);Ctrl+T 任务视图是 P2,当前仅状态层就位 */
  board: TaskBoardState;
```

`runningDelegations` 替换为单源版(P0 并集退役,注释更新为「P1 收敛:投影单源——children 只是转录明细存储,成员资格唯一源是投影」):

```ts
export function runningDelegations(st: Pick<TuiState, 'delegations'>): { label: string; startedAt: number }[] {
  return st.delegations
    .filter((d) => d.status === 'running')
    .map((d) => ({ label: d.label, startedAt: d.startedAt }))
    .sort((a, b) => a.startedAt - b.startedAt);
}
```

② `src/tui/session.ts`:import 补 `applyBoardEvent, emptyBoard`;初始 state(:94 `delegations: [],` 后)与 /new 重置(:820)各加 `board: emptyBoard(),`;`commands-session.ts:104` 恢复点同加。onEvent 分流改造——**类型前缀防御前置到子代理分支之前**(:1052 附近):

```ts
    // 委派/板事件分流(P1 收敛,spec §11):类型前缀判定前置——即便上游误打 subagent 标签也不误吞(终审裁定);
    // delegation-* 进委派投影,task-*/gate-* 进板投影,两者都不触达主链消息分支
    if (e.type.startsWith('delegation-')) {
      this.state = { ...this.state, delegations: applyDelegation(this.state.delegations, e) };
      this.notifyThrottled();
      return;
    }
    if (e.type.startsWith('task-') || e.type.startsWith('gate-')) {
      const board = applyBoardEvent(this.state.board, boardEventFrom(e));
      if (board !== this.state.board) {
        this.state = { ...this.state, board };
        this.notifyThrottled();
      }
      return;
    }
    const sub = e.payload?.subagent;
    if (typeof sub === 'string' && sub.length > 0) {
      onChildEvent(this, e, sub);
      return;
    }
```

session.ts 内新增私有映射(把 SessionEvent 的 task-*/gate-* 翻译成 BoardEvent 喂 reducer——**翻译单点**,与 Task 3 发射口径互为镜像):

```ts
/** SessionEvent(task-*/gate-*) → BoardEvent 翻译单点:与 TaskBoard.emit 载荷口径互为镜像(P1 子集:
 *  created/status/unlocked/blocked/gate 两态;conclusion 等富字段不进 UI 事件,投影无需) */
function boardEventFrom(e: SessionEvent): import('../taskboard/model').BoardEvent {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const taskId = String(p.taskId ?? '');
  const ts = e.ts;
  switch (e.type) {
    case 'task-created':
      return { t: 'task-created', taskId, title: String(p.title ?? ''), spec: String(p.spec ?? ''), dependsOn: Array.isArray(p.dependsOn) ? (p.dependsOn as string[]) : [], ts };
    case 'task-status-changed':
      return { t: 'status-changed', taskId, from: (p.from as TaskStatus) ?? 'pending', to: (p.status as TaskStatus) ?? 'pending', ts };
    case 'gate-waiting':
      return { t: 'gate-set', taskId, ts, ...(typeof p.note === 'string' ? { note: p.note } : {}) };
    case 'gate-resolved':
      return { t: 'gate-resolved', taskId, approved: p.approved === true, ts };
    default:
      return { t: 'status-changed', taskId, from: 'pending', to: 'pending', ts }; // task-unlocked/task-blocked:投影无状态变化,reducer 原引用返回
  }
}
```

(`TaskStatus` 类型 import 自 taskboard/model;`task-unlocked`/`task-blocked` 无板状态迁移——reducer 对 pending→pending 返回原引用,天然幂等。)

③ `src/tui/components/App.tsx`:面板渲染门限(~:507,`state.children.length > 0 && !browseMode` 语义处)改为以 `runningDelegations(state).length > 0`(或既有 childPanelRows 计算的同源变量)为门限——rows 非空才渲染面板;高度计算(:287)口径已同源无需再动。`ChildPanel` 的 `rows` 传参维持。

④ 受保护测试协议补齐(**仅限以下两文件,规则统一**):`App.spawn-browse.test.tsx` 与 `App.inspect.test.tsx` 中,凡"合成子代理事件流后断言面板行/浏览运行行在场"的用例,在其**首个子代理事件之前**补一行:

```ts
ctrl.onEventForTest({ type: 'delegation-started', ts: <该用例首事件 ts 或 Date.now()>, payload: { delegationId: '<label>', kind: 'subagent', label: '<label>' } } as never);
```

(label 取该用例的子代理标签,如 `rv`/`w`);凡断言"完成后面板离场/浏览转归档"的用例,在其 done/终态事件处补 `delegation-ended`(status `'done'`,同 label)。**逐用例定位**:先跑 `pnpm build && node --test dist/tui/components/App.spawn-browse.test.js dist/tui/components/App.inspect.test.js` 看红,对红的用例按上述规则补事件,直至绿。除此之外零改动。

⑤ `ChildPanel.tsx` 的缺省路径(rows 未传时 children 过滤)保留——组件直渲染测试(ChildPanel.live.test.tsx)不受影响。

- [ ] **Step 4: 跑测试确认通过 + TUI 全回归**

Run: `pnpm build && node --test dist/tui/session.board.test.js dist/tui/session.delegation.test.js dist/tui/session.subagent-meta.test.js dist/tui/session.subagent-bg.test.js dist/tui/session.subagent-done.test.js dist/tui/session.subagent-page.test.js dist/tui/components/App.spawn-browse.test.js dist/tui/components/App.inspect.test.js dist/tui/components/ChildPanel.live.test.js`
Expected: PASS(新 2 用例;子代理系零改动绿;两个受保护文件协议补齐后绿)。

- [ ] **Step 5: 提交**

```bash
git add src/tui/session.ts src/tui/chat-model.ts src/tui/commands-session.ts src/tui/components/App.tsx src/tui/components/App.spawn-browse.test.tsx src/tui/components/App.inspect.test.tsx src/tui/session.board.test.tsx
git commit -m "feat(tui): P1 收敛——delegation-*/task-* 类型前缀分流前置(带标签不误吞);TuiState.board 板投影(boardEventFrom 翻译单点);runningDelegations 投影单源(并集退役);App 面板门限对齐 rows;受保护测试协议补齐(两文件,合成流补 delegation 事件)"
```

---

### Task 8: kill -9 崩溃注入测试(spec §7.6 硬验收)

**Files:**
- Create: `src/taskboard/crash-fixture.ts`(子进程脚本,编译进 dist)
- Test: `src/taskboard/crash.test.ts`

**Interfaces:**
- Consumes: TaskBoard/TeamStore(Task 2/3)、child_process(process.execPath)
- Produces: 无(纯验收);fixture 契约:stdout 打印 `READY`(claimed 已落盘)后挂住,env `SUNSHINEX_DATA_DIR` 定向

- [ ] **Step 1: 写失败测试**

创建 `src/taskboard/crash.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('kill -9 于 claimed 时刻:重启恢复,任务回池、事件完整、可继续追加(spec §7.6)', async () => {
  const tmp = tmpdir('sunshinex-tbcrash-');
  try {
    const child = spawn(process.execPath, [path.resolve(__dirname, 'crash-fixture.js')], {
      env: { ...process.env, SUNSHINEX_DATA_DIR: path.join(tmp, 'data') },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => { out += c; });
    // 等 fixture 打印 READY(claimed 已落盘)后强杀
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (out.includes('READY')) { clearInterval(t); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(t); resolve(); }, 10_000);
    });
    assert.ok(out.includes('READY'), 'fixture 达到 claimed 挂起点');
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // 重启恢复:同目录新协调器
    const runner = { runSubagent: async () => ({ ok: true as const, value: { reply: 'r', tokens: 1 } }) } as unknown as SubagentRunner;
    const registry = { submit: () => ({ id: 'b9', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry;
    const board = new TaskBoard({ store: new TeamStore(path.join(tmp, 'data', 'teams', 'main')), runner, registry });
    board.init();
    const s = board.snapshot();
    assert.equal(s.tasks['t1']!.status, 'pending', 'claimed 回池(§7.4)');
    assert.ok(s.tasks['t1']!.artifact?.conclusion === undefined, '无半成品 artifact');
    assert.equal(s.tasks['t2']!.status, 'pending', '依赖任务原样');
    // 恢复后可继续:create 成功且事件流追加畅通
    const r = board.create({ title: 'C', spec: 'c', dependsOn: ['t1'] });
    assert.ok(r.ok);
    await new Promise((r2) => setImmediate(r2));
    // events.jsonl 无撕裂行:全部可解析
    const lines = fs.readFileSync(path.join(tmp, 'data', 'teams', 'main', 'events.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
    for (const line of lines) JSON.parse(line);
    assert.ok(lines.some((l) => l.includes('recovered after restart')), '自愈事件在流中');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('进程内变体:events.jsonl 尾行截断,重放跳过不炸(Task 2 语义的崩溃面复验)', () => {
  const tmp = tmpdir('sunshinex-tbcrash2-');
  try {
    const dir = path.join(tmp, 'teams', 'main');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      JSON.stringify({ t: 'task-created', taskId: 't1', title: 'A', spec: 'a', dependsOn: [], ts: 1 }),
      '{"t":"task-cr',
    ].join('\n'), 'utf8');
    const store = new TeamStore(dir);
    const s = store.load();
    assert.equal(s.tasks['t1'] !== undefined, true, '完好行生效');
    assert.equal(s.seq, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/taskboard/crash.test.js`
Expected: FAIL——`crash-fixture.js` 不存在(spawn ENOENT)。

- [ ] **Step 3: 实现 crash-fixture.ts**

创建 `src/taskboard/crash-fixture.ts`:

```ts
// 崩溃注入 fixture(测试子进程拉起):构造真实 TaskBoard(假 runner 首任务永不返回),
// 创建依赖链任务 t1→t2,drain 派发 t1 至 claimed(事件已落盘)后向 stdout 打印 READY 并挂住,
// 等待父进程强杀。env SUNSHINEX_DATA_DIR 由父进程定向临时目录。
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import { resolveDataDir } from '../config/data-dir';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

function main(): void {
  const root = process.cwd();
  const runner = {
    runSubagent: () => new Promise<{ ok: boolean; value: { reply: string; tokens: number } }>(() => {}),
  } as unknown as SubagentRunner;
  const registry = {
    submit: () => ({ id: 'fixture', stop: () => {} }),
    append: () => {},
    finish: () => {},
  } as unknown as TaskRegistry;
  const board = new TaskBoard({
    store: new TeamStore(path.join(resolveDataDir(root), 'teams', 'main')),
    runner,
    registry,
  });
  board.init();
  const a = board.create({ title: 'A', spec: 'hang forever', dependsOn: [] });
  board.create({ title: 'B', spec: 'b', dependsOn: ['t1'] });
  if (!a.ok) {
    process.stderr.write(`fixture create failed: ${a.error.message}\n`);
    process.exit(1);
  }
  // drain 是异步的:等微任务两拍保证 claimed 落盘后再报 READY
  setImmediate(() => {
    setImmediate(() => {
      process.stdout.write('READY\n');
      setInterval(() => {}, 1 << 30); // 挂住等杀
    });
  });
}
main();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/taskboard/crash.test.js`
Expected: PASS(2 用例;win32 下 `kill('SIGKILL')` = TerminateProcess 强杀语义)。

- [ ] **Step 5: 提交**

```bash
git add src/taskboard/crash-fixture.ts src/taskboard/crash.test.ts
git commit -m "test(taskboard): kill -9 崩溃注入硬验收——claimed 时刻强杀后重启:任务回池/无半成品 artifact/事件流无撕裂/自愈事件在流/可继续追加;进程内尾行截断复验"
```

---

### Task 9: 全量回归 + GUI 同源验收 + spec 回写

**Files:**
- Modify: `docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md`(§13 P1 段执行回写 + P2 段模板宏排期裁定句)

**Interfaces:**
- Consumes: Task 1-8 全部产物
- Produces: 全量绿基线 + spec P1 落地记录

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 0 败(2 既有 win32 跳过容忍);任何红即停,回对应任务修,不带病过闸。

- [ ] **Step 2: selfcheck**

Run: `pnpm selfcheck`
Expected: OK。

- [ ] **Step 3: spec 执行回写**

§13 P1 段末尾(验收 bullet 之后)追加:

```markdown
> **落地记录**:P1 已交付——TaskBoard 域模型/teams 目录 event sourcing(events.jsonl 真相源+board.json 快照写不读)/lead 工具五件套(lead-only,deriveChildRegistry 扩剔)/批量并行 drain 派发(fork 顶替)+harness 强制回写/kill -9 崩溃注入硬验收(claimed 回池自愈事件)/TUI 投影单源收敛与板投影。裁定:唤醒复用 task_wait(null) 拉模式;team-id 工作区单隐式 main;gate 经 review_task(approved) 解,行内审批卡随 P2;快照读取优化与文件 inbox 随 P2;cancelled 无 P1 工具入口。
```

§13 P2 段第一条 bullet 后追加一句(排期空隙裁定):

```markdown
- 模板宏化排期本阶段中段(GraphEngine 静态模板展开成任务集注入 TaskBoard,§12.1;2026-10-05 裁定补记)
```

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md
git commit -m "docs(spec): P1 执行回写——TaskBoard 核心落地记录与四项裁定;P2 段补模板宏化排期裁定"
```
