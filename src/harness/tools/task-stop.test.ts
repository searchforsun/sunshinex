// task_stop 行为：纯台账 running → stopped；板任务 pending|running → cancelled（running 同时 abort 台账）；
// 终态幂等回执；未命中列出现存任务；teammate 按名打断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskRegistry } from '../tasks';
import { TaskBoard } from '../../taskboard/board';
import { TeamStore } from '../../taskboard/store';
import { AgentTeamRegistry, MemoryAgentTeamStore } from '../../taskboard/team-registry';
import type { TeamRegistry } from '../../taskboard/teammate';
import { makeTaskStopTool } from './task-stop';
import { ToolRegistry } from '../tools';

/** 最小安全链桩：evaluateAsync 直通放行、maskResult 原样返回（task_stop 非文件/bash 面，不触发路径判定） */
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
  registry.register(makeTaskStopTool(tasks));
  return registry;
}

function clock(): () => number {
  let n = 1000;
  return () => ++n;
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 30 && !pred(); i++) await new Promise((r) => setImmediate(r));
}

function openBoard(
  root: string,
  tasks: TaskRegistry,
  mode: 'hang' | 'success' = 'hang',
): { board: TaskBoard; teamId: string; releaseHang: () => void; interrupted: () => boolean } {
  const agentTeams = new AgentTeamRegistry(new MemoryAgentTeamStore(), () => 1);
  const created = agentTeams.create('alpha');
  if (!created.ok) throw new Error(created.error.message);
  const teamId = created.value.teamId;
  let boardRef: TaskBoard | undefined;
  let hangResolve: (() => void) | undefined;
  let aborted = false;
  let hanging = false;
  const worker = {
    name: 'worker',
    teamId,
    stopped: false,
    kick(): void {
      const task = boardRef!.claim('worker', teamId);
      if (task !== undefined) void this.runTask(task);
    },
    async runTask(task: { id: string; title: string; spec: string }): Promise<void> {
      const board = boardRef!;
      if (!board.markClaimed(task.id, 'worker')) return;
      const ledger = tasks.submit({ kind: 'subagent', label: task.id.startsWith('task-') ? task.id : `task-${task.id}` });
      const hang = mode === 'hang'
        ? new Promise<void>((res) => { hanging = true; hangResolve = res; })
        : Promise.resolve();
      ledger.stop = () => { aborted = true; hangResolve?.(); };
      if (mode === 'success') await new Promise<void>((r) => setImmediate(r));
      else await hang;
      hanging = false;
      if (aborted) {
        board.finishExecution(task.id, {
          ok: false,
          terminal: 'cancelled',
          by: 'worker',
          error: { code: 'ABORTED', message: 'aborted' },
        }, ledger.id);
        return;
      }
      board.finishExecution(task.id, { ok: true, by: 'worker', reply: 'r', tokens: 1 }, ledger.id);
    },
    interruptCurrent(): boolean {
      if (!hanging || hangResolve === undefined) return false;
      aborted = true;
      hangResolve();
      return true;
    },
  };
  const stubTeam = {
    get: (name: string) => (name === 'worker' ? worker : undefined),
    aliveNames: () => ['worker'],
    hasAlive: () => true,
  } as unknown as TeamRegistry;
  const board = new TaskBoard({
    store: new TeamStore(path.join(root, 'teams', 'main')),
    registry: tasks,
    agentTeams,
    team: stubTeam,
    onEvent: () => {},
    now: clock(),
  });
  boardRef = board;
  board.init();
  return {
    board,
    teamId,
    releaseHang: () => { hangResolve?.(); },
    interrupted: () => aborted,
  };
}

test('task_stop 命中 running：触发 stop 句柄、终态 stopped、回执确认', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstop-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    let stopped = false;
    const task = tasks.submit({ kind: 'exec', label: 'sleep-loop' });
    task.stop = () => {
      stopped = true;
      tasks.finish(task.id, 'stopped', { marker: '[stopped: task_stop]' });
    };
    const registry = makeRegistry(tasks);
    const r = await registry.execute('task_stop', { taskId: task.id }, stubSafety);
    assert.ok(r.ok, `期望 ok，实际 ${r.ok ? '' : r.error.message}`);
    assert.match(r.value.stdout, /stopped/, '回执含任务终态');
    assert.equal(stopped, true, 'stop 句柄已触发');
    assert.equal(tasks.get(task.id)?.status, 'stopped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_stop 未命中 ID：报错列出现存任务 id+label（规格 D8 照 CC）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstop-miss-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const t1 = tasks.submit({ kind: 'exec', label: 'echo-alive' });
    const registry = makeRegistry(tasks);
    const r = await registry.execute('task_stop', { taskId: 'b999' }, stubSafety);
    assert.ok(!r.ok, '期望失败');
    assert.match(r.error.message, /b999/, '报错含请求的 ID');
    assert.match(r.error.message, new RegExp(`${t1.id}.*echo-alive`, 's'), '列出现存任务 id+label');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_stop 板任务原生 id 归一：tN → 派发台账条目(2026-10-19 真机「板 id 直停报错」回归)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstop-board-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    let stopped = false;
    // 真实派发登记形态(teammate.ts execute):submit label='task-t5' → 台账 id=task-t5-<ts>-<rand>
    const ledger = tasks.submit({ kind: 'subagent', label: 'task-t5' });
    assert.match(ledger.id, /^task-t5-/, '前置:台账 id 为 task-tN 完整方言形态');
    ledger.stop = () => {
      stopped = true;
      tasks.finish(ledger.id, 'stopped', { marker: '[stopped: task_stop]' });
    };
    const registry = makeRegistry(tasks);
    const r = await registry.execute('task_stop', { taskId: 't5' }, stubSafety);
    assert.ok(r.ok, `期望按板 id 命中，实际 ${r.ok ? '' : r.error.message}`);
    assert.equal(stopped, true, 'stop 句柄已触发');
    assert.match(r.value.stdout, /task-t5-/, '回执按台账 id 报告');
    assert.equal(tasks.get(ledger.id)?.status, 'stopped');
    // delegationId 形态 task-t5 同样命中
    const ledger2 = tasks.submit({ kind: 'subagent', label: 'task-t6' });
    ledger2.stop = () => tasks.finish(ledger2.id, 'stopped', { marker: '[stopped]' });
    const r2 = await registry.execute('task_stop', { taskId: 'task-t6' }, stubSafety);
    assert.ok(r2.ok, 'delegationId 形态 task-tN 同样归一命中');
    // 真未知 id 仍报错
    const r3 = await registry.execute('task_stop', { taskId: 't99' }, stubSafety);
    assert.ok(!r3.ok, '无派发条目的板 id 仍 INVALID_ARG');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_stop 命中已终态任务：幂等回执当前终态，不重复触发 stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstop-done-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    let stopCalls = 0;
    const task = tasks.submit({ kind: 'exec', label: 'already-done' });
    task.stop = () => {
      stopCalls++;
    };
    tasks.finish(task.id, 'done');
    const registry = makeRegistry(tasks);
    const r = await registry.execute('task_stop', { taskId: task.id }, stubSafety);
    assert.ok(r.ok, `期望幂等 ok，实际 ${r.ok ? '' : r.error.message}`);
    assert.match(r.value.stdout, /done/, '回执当前终态');
    assert.equal(stopCalls, 0, '已终态不重复触发 stop 句柄');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_stop 板 pending → cancelled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstop-pending-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const { board, teamId, releaseHang, interrupted } = openBoard(root, tasks, 'hang');
    const running = board.create({ teamId, title: 'Run', spec: 'hold the lane' });
    assert.ok(running.ok);
    const runId = running.value.taskId;
    await until(() => board.snapshot().tasks[runId]?.status === 'running');
    assert.equal(board.snapshot().tasks[runId]?.status, 'running');
    const pending = board.create({ teamId, title: 'Hold', spec: 'wait', dependsOn: [runId] });
    assert.ok(pending.ok);
    const holdId = pending.value.taskId;
    assert.equal(board.snapshot().tasks[holdId]?.status, 'pending');
    const registry = new ToolRegistry();
    registry.register(makeTaskStopTool(tasks, undefined, board));
    const r = await registry.execute('task_stop', { taskId: holdId }, stubSafety);
    assert.ok(r.ok, `期望 ok，实际 ${r.ok ? '' : r.error.message}`);
    assert.match(r.value.stdout, new RegExp(`task ${holdId} cancelled`));
    assert.equal(board.snapshot().tasks[holdId]?.status, 'cancelled');
    assert.equal(board.snapshot().tasks[runId]?.status, 'running', '只停 pending，在跑的上游继续');
    assert.equal(interrupted(), false, 'pending 无执行体，不 abort');
    const again = await registry.execute('task_stop', { taskId: holdId }, stubSafety);
    assert.ok(again.ok);
    assert.match(again.value.stdout, /already finished with status cancelled/);
    assert.equal(board.snapshot().tasks[holdId]?.status, 'cancelled');
    releaseHang();
    await new Promise((r) => setImmediate(r));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_stop 板 running → cancelled 并 abort 台账', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstop-running-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const { board, teamId, interrupted } = openBoard(root, tasks, 'hang');
    const created = board.create({ teamId, title: 'Run', spec: 'work' });
    assert.ok(created.ok);
    const boardId = created.value.taskId;
    await until(() => board.snapshot().tasks[boardId]?.status === 'running');
    assert.equal(board.snapshot().tasks[boardId]?.status, 'running');
    const ledger = tasks.list().find((t) => t.status === 'running');
    assert.ok(ledger, 'running 板任务有台账条目');
    let stopCalls = 0;
    const orig = ledger.stop;
    ledger.stop = () => {
      stopCalls++;
      orig?.();
    };
    const registry = new ToolRegistry();
    registry.register(makeTaskStopTool(tasks, undefined, board));
    const r = await registry.execute('task_stop', { taskId: boardId }, stubSafety);
    assert.ok(r.ok, `期望 ok，实际 ${r.ok ? '' : r.error.message}`);
    assert.match(r.value.stdout, new RegExp(`task ${boardId} cancelled`));
    assert.equal(board.snapshot().tasks[boardId]?.status, 'cancelled');
    assert.equal(interrupted(), true, 'running 的 stop abort 执行体');
    assert.equal(stopCalls, 1, 'running 同时调用台账 stop');
    assert.equal(tasks.get(ledger.id)?.status, 'stopped');
    const again = await registry.execute('task_stop', { taskId: boardId }, stubSafety);
    assert.ok(again.ok);
    assert.match(again.value.stdout, /already finished with status cancelled/);
    assert.equal(stopCalls, 1, '终态不重复 abort');
    assert.equal(board.snapshot().tasks[boardId]?.status, 'cancelled');
    await new Promise((r) => setImmediate(r));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_stop 板 success 幂等回执，不重复 abort', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstop-success-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const { board, teamId } = openBoard(root, tasks, 'success');
    const created = board.create({ teamId, title: 'Run', spec: 'done fast' });
    assert.ok(created.ok);
    const boardId = created.value.taskId;
    await until(() => board.snapshot().tasks[boardId]?.status === 'success');
    assert.equal(board.snapshot().tasks[boardId]?.status, 'success');
    const ledger = tasks.list()[0];
    let stopCalls = 0;
    if (ledger !== undefined) ledger.stop = () => { stopCalls++; };
    const registry = new ToolRegistry();
    registry.register(makeTaskStopTool(tasks, undefined, board));
    const r = await registry.execute('task_stop', { taskId: boardId }, stubSafety);
    assert.ok(r.ok, `期望幂等 ok，实际 ${r.ok ? '' : r.error.message}`);
    assert.match(r.value.stdout, /already finished with status success/);
    assert.equal(board.snapshot().tasks[boardId]?.status, 'success');
    assert.equal(stopCalls, 0, '终态不 abort');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_stop 纯台账任务在板在场时仍落 stopped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstop-ledger-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const { board, teamId, releaseHang } = openBoard(root, tasks, 'hang');
    const created = board.create({ teamId, title: 'Run', spec: 'stay running' });
    assert.ok(created.ok);
    const boardId = created.value.taskId;
    await until(() => board.snapshot().tasks[boardId]?.status === 'running');
    let stopped = false;
    const exec = tasks.submit({ kind: 'exec', label: 'echo-job' });
    exec.stop = () => {
      stopped = true;
      tasks.finish(exec.id, 'stopped', { marker: '[stopped: task_stop]' });
    };
    const registry = new ToolRegistry();
    registry.register(makeTaskStopTool(tasks, undefined, board));
    const r = await registry.execute('task_stop', { taskId: exec.id }, stubSafety);
    assert.ok(r.ok, `期望 ok，实际 ${r.ok ? '' : r.error.message}`);
    assert.match(r.value.stdout, /stopped/);
    assert.equal(stopped, true);
    assert.equal(tasks.get(exec.id)?.status, 'stopped');
    assert.equal(board.snapshot().tasks[boardId]?.status, 'running', '纯台账停止不改板任务');
    releaseHang();
    await new Promise((r) => setImmediate(r));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task_stop 按 teammate 名打断当前任务', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstop-mate-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    let interrupted = false;
    const team = {
      get: (id: string) => (id === 'coder'
        ? { interruptCurrent: () => { interrupted = true; return true; } }
        : undefined),
      aliveNames: () => ['coder'],
    } as unknown as TeamRegistry;
    const registry = new ToolRegistry();
    registry.register(makeTaskStopTool(tasks, team));
    const r = await registry.execute('task_stop', { taskId: 'coder' }, stubSafety);
    assert.ok(r.ok, `期望 ok，实际 ${r.ok ? '' : r.error.message}`);
    assert.equal(interrupted, true);
    assert.match(r.value.stdout, /teammate coder current task interrupted/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
