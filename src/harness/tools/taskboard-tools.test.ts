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

test('六件套:name/category 全集(TASKBOARD_TOOL_NAMES 随动)与 observation 带板摘要;cancel_task 工具面', async () => {
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
    // cancel_task(终审 Item 2):gated 建即 pending——经工具面取消 → cancelled + 板摘要透出
    await create.executor({ title: 'X', spec: 'x', dependsOn: null, assignee: null, gated: true });
    assert.equal(board.snapshot().tasks['t2']!.status, 'pending', 'gated 停 pending(可取消面)');
    const cancel = tools.find((t) => t.name === 'cancel_task')!;
    const c = await cancel.executor({ taskId: 't2' });
    assert.equal(c.exitCode, 0);
    assert.match(c.stdout, /cancelled/, 'observation 确认取消');
    assert.match(c.stdout, /t2 \[cancelled\]/, '板摘要含 cancelled 行(容量已回收)');
    assert.equal(board.snapshot().tasks['t2']!.status, 'cancelled');
    await assert.rejects(() => cancel.executor({ taskId: 't2' }), /cancel expects a pending task/, '终态取消经工具面透出 INVALID_ARG');
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
