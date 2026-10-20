// 后台任务线 T4：task_wait 工具行为测试——阻塞等待后台任务到终态并内联回执（对标 CC TaskOutput）：
// 已终态幂等即回；运行中等到终态回执带 exitCode 与日志尾部；超时回执 running；
// taskIds=null 等全部 running、无 running 立即空回执；未知 id INVALID_ARG 附现存清单；
// 子代理任务回执 [conclusion] 结论全文；空数组 INVALID_ARG。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskRegistry } from '../tasks';
import { TaskBoard } from '../../taskboard/board';
import { TeamStore } from '../../taskboard/store';
import { makeTaskWaitTool } from './task-wait';
import { ToolRegistry } from '../tools';

const stubSafety = {
  async evaluateAsync(name: string, input: unknown) {
    return { allowed: true, tool: name, input };
  },
  maskResult(_name: string, r: unknown) {
    return r;
  },
} as never;

function makeRegistry(tasks: TaskRegistry): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(makeTaskWaitTool(tasks));
  return registry;
}

test('task_wait 已终态任务幂等即回：状态 + exitCode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-tool-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const t = tasks.submit({ kind: 'exec', label: 'done' });
    tasks.finish(t.id, 'done', { exitCode: 0 });
    const r = await makeRegistry(tasks).execute('task_wait', { taskIds: [t.id], timeoutSeconds: null }, stubSafety);
    assert.ok(r.ok);
    assert.match(r.value.stdout, new RegExp(`${t.id} \\(exec\\) done, exit 0`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_wait 等运行中任务到终态：回执 exitCode 与日志尾部', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-tool-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const t = tasks.submit({ kind: 'exec', label: 'build-all' });
    tasks.append(t.id, 'line-one\nline-two\n');
    setTimeout(() => tasks.finish(t.id, 'done', { exitCode: 0 }), 50);
    const r = await makeRegistry(tasks).execute('task_wait', { taskIds: [t.id], timeoutSeconds: null }, stubSafety);
    assert.ok(r.ok);
    assert.match(r.value.stdout, /exit 0/);
    assert.match(r.value.stdout, /line-two/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_wait 超时回执 running 状态与续等指引', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-tool-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const t = tasks.submit({ kind: 'exec', label: 'long' });
    const r = await makeRegistry(tasks).execute('task_wait', { taskIds: [t.id], timeoutSeconds: 0.2 }, stubSafety);
    assert.ok(r.ok);
    assert.match(r.value.stdout, /still running/);
    assert.match(r.value.stdout, /task_wait again/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_wait taskIds=null：等全部 running；无 running 立即空回执', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-tool-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const registry = makeRegistry(tasks);
    const empty = await registry.execute('task_wait', { taskIds: null, timeoutSeconds: null }, stubSafety);
    assert.ok(empty.ok);
    assert.match(empty.value.stdout, /no background tasks running/);
    const a = tasks.submit({ kind: 'exec', label: 'a' });
    const b = tasks.submit({ kind: 'subagent', label: 'b' });
    // 长驻 teammate 条目:taskIds=null 排除(存活即 running,等它=等到 task_stop;2026-10-06 契约收敛)
    const tm = tasks.submit({ kind: 'teammate', label: 'w1' });
    setTimeout(() => {
      tasks.append(a.id, 'out-a\n');
      tasks.finish(a.id, 'done', { exitCode: 2 });
      tasks.finish(b.id, 'stopped', { marker: '[stopped: test]' });
    }, 50);
    const r = await registry.execute('task_wait', { taskIds: null, timeoutSeconds: null }, stubSafety);
    assert.ok(r.ok);
    assert.match(r.value.stdout, new RegExp(`${a.id} \\(exec\\) done, exit 2`));
    assert.match(r.value.stdout, new RegExp(`${b.id} \\(subagent\\) stopped`));
    assert.doesNotMatch(r.value.stdout, new RegExp(tm.id), 'teammate 条目不在 null 等待面');
    // 显式点名 teammate 仍可等/查状态(null 排除 ≠ 不可见;kind 字面在回执头)
    const r2 = await registry.execute('task_wait', { taskIds: [tm.id], timeoutSeconds: 0 }, stubSafety);
    assert.ok(r2.ok);
    assert.match(r2.value.stdout, /teammate\) running/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_wait 未知 id：INVALID_ARG 附现存任务清单', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-tool-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const t = tasks.submit({ kind: 'exec', label: 'known' });
    const r = await makeRegistry(tasks).execute('task_wait', { taskIds: ['b999'], timeoutSeconds: null }, stubSafety);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, 'INVALID_ARG');
      assert.match(r.error.message, /Unknown task id: b999/);
      assert.match(r.error.message, new RegExp(`${t.id} \\(exec, running\\) known`));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_wait 空数组：INVALID_ARG', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-tool-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const r = await makeRegistry(tasks).execute('task_wait', { taskIds: [], timeoutSeconds: null }, stubSafety);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'INVALID_ARG');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_wait timeoutSeconds<0：INVALID_ARG（须为非负数）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-tool-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const t = tasks.submit({ kind: 'exec', label: 'edge' });
    const r = await makeRegistry(tasks).execute('task_wait', { taskIds: [t.id], timeoutSeconds: -1 }, stubSafety);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, 'INVALID_ARG');
      assert.match(r.error.message, /timeoutSeconds must be a non-negative number/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_wait timeoutSeconds=0：非阻塞 peek，即时回执当前状态快照', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-tool-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const running = tasks.submit({ kind: 'exec', label: 'peek-running' });
    const done = tasks.submit({ kind: 'exec', label: 'peek-done' });
    tasks.finish(done.id, 'done', { exitCode: 0 });
    const started = Date.now();
    const r = await makeRegistry(tasks).execute('task_wait', { taskIds: [running.id, done.id], timeoutSeconds: 0 }, stubSafety);
    // 非阻塞：整批立即返回（远小于任何等待窗口），不因 running 任务阻塞
    assert.ok(Date.now() - started < 1000, 'peek must return immediately without blocking');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.value.stdout, /status peek \(timeoutSeconds=0, non-blocking\)/);
      assert.match(r.value.stdout, new RegExp(`${running.id} \\(exec\\) running`));
      assert.match(r.value.stdout, new RegExp(`${done.id} \\(exec\\) done, exit 0`));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_wait 子代理任务：回执 [conclusion] 结论全文', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-tool-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const t = tasks.submit({ kind: 'subagent', label: 'research' });
    tasks.append(t.id, '[conclusion] first line\nsecond line\n');
    tasks.finish(t.id, 'done');
    const r = await makeRegistry(tasks).execute('task_wait', { taskIds: [t.id], timeoutSeconds: null }, stubSafety);
    assert.ok(r.ok);
    assert.match(r.value.stdout, /\[conclusion\] first line\nsecond line/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_wait 板任务原生 id 归一：tN/delegationId 形态命中派发台账条目(2026-10-19 真机「t5,t6,t7,t8 全量报错」回归)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-board-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    // 真实派发登记形态(teammate.ts execute):submit label='task-t5' → 台账 id=task-t5-<ts>-<rand>
    const a = tasks.submit({ kind: 'subagent', label: 'task-t5' });
    const b = tasks.submit({ kind: 'subagent', label: 'task-t6' });
    tasks.append(a.id, '[conclusion] t5 done\n');
    tasks.finish(a.id, 'done');
    tasks.append(b.id, '[conclusion] t6 done\n');
    tasks.finish(b.id, 'done');
    const r = await makeRegistry(tasks).execute('task_wait', { taskIds: ['t5', 'task-t6'], timeoutSeconds: null }, stubSafety);
    assert.ok(r.ok, `板 id 归一命中，实际 ${r.ok ? '' : r.error?.message}`);
    if (r.ok) {
      assert.match(r.value.stdout, /task-t5-/, '回执含 t5 派发台账条目');
      assert.match(r.value.stdout, /task-t6-/, '回执含 t6 派发台账条目');
      assert.match(r.value.stdout, /all target tasks finished \(2\)/);
    }
    // 无派发条目的板 id 仍 INVALID_ARG 附现存清单
    const bad = await makeRegistry(tasks).execute('task_wait', { taskIds: ['t7'], timeoutSeconds: 0 }, stubSafety);
    assert.ok(!bad.ok, '未派发板 id 仍报错');
    assert.match(bad.error.message, /Unknown task id: t7/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_wait 未派发板任务可等:板上在册即合法目标,轮询至工作终态(GUI 首呼 INVALID_ARG 回归)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-boardpre-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const board = new TaskBoard({
      store: new TeamStore(path.join(root, 'teams', 'main')),
      runner: { runSubagent: async () => ({ ok: true as const, value: { reply: 'r', tokens: 1 } }) } as never,
      registry: { submit: () => ({ id: 'lx', stop: () => {} }), append: () => {}, finish: () => {}, list: () => [], get: () => undefined } as never,
      onEvent: () => {},
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    board.init();
    const created = board.create({ title: 'GateDemo', spec: 'gated demo', gated: true }); // gated=永不派发,台账恒无条目
    assert.ok(created.ok);
    const boardId = created.value.taskId;
    const registry = new ToolRegistry();
    registry.register(makeTaskWaitTool(tasks, board));
    // timeoutSeconds=0 peek:gated 任务在板,合法目标(不再 INVALID_ARG),回执板态 pending
    const peek = await registry.execute('task_wait', { taskIds: [boardId], timeoutSeconds: 0 }, stubSafety);
    assert.ok(peek.ok, `板任务应合法,实际 ${peek.ok ? '' : peek.error?.message}`);
    if (peek.ok) {
      assert.match(peek.value.stdout, /\(board\) pending — GateDemo/, '回执含板态与标题');
      assert.match(peek.value.stdout, /status peek/, 'peek 非阻塞');
    }
    // review 放行 → fork 消化至 in-review → 工作完成即收口 settled
    assert.ok(board.review(boardId, { approved: true }).ok);
    const settled = await registry.execute('task_wait', { taskIds: [boardId], timeoutSeconds: 10 }, stubSafety);
    assert.ok(settled.ok);
    if (settled.ok) {
      assert.match(settled.value.stdout, /all target tasks finished \(1\)/, '板任务工作完成即收口');
      assert.match(settled.value.stdout, /\(board\) in-review — GateDemo/, '回执 in-review(等复核)');
    }
    // 真未知 id 仍 INVALID_ARG(板上无、台账无)
    const bad = await registry.execute('task_wait', { taskIds: ['task-not-on-board-x9z9'], timeoutSeconds: 0 }, stubSafety);
    assert.ok(!bad.ok, '板/台账皆无仍报错');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
