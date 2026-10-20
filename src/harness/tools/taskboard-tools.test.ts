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

/** 从 create_task observation 捕获真实板 id(id 方言(2026-10-19)随机段不可写字面量) */
function createdId(stdout: string): string {
  const m = /task (\S+) created;/.exec(stdout);
  assert.ok(m, `observation 含新任务 id:${stdout}`);
  return m![1]!;
}

test('四件套:name/category 全集(TASKBOARD_TOOL_NAMES 随动)与 observation 带板摘要;update_task cancel 动作', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools-'));
  try {
    const board = makeBoard(tmp);
    const tools = makeTaskBoardTools(board);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TASKBOARD_TOOL_NAMES].sort());
    assert.ok(tools.every((t) => t.category === 'task'));
    const create = tools.find((t) => t.name === 'create_task')!;
    const r = await create.executor({ title: 'A', spec: 'do A', dependsOn: null, assignee: null });
    assert.equal(r.exitCode, 0);
    const idA = createdId(r.stdout);
    assert.match(idA, /^task-[a-z0-9][a-z0-9-]*-[a-z0-9]{4}$/, `新方言形态:${idA}`);
    assert.ok(r.stdout.includes(idA), 'observation 含新任务 id');
    await drain();
    // update_task cancel 动作(旧 cancel_task 薄工具收束):gated 建即 pending——取消 → cancelled + 板摘要透出
    const rx = await create.executor({ title: 'X', spec: 'x', dependsOn: null, assignee: null, gated: true });
    assert.equal(rx.exitCode, 0);
    const idX = createdId(rx.stdout);
    assert.equal(board.snapshot().tasks[idX]!.status, 'pending', 'gated 停 pending(可取消面)');
    const update = tools.find((t) => t.name === 'update_task')!;
    const c = await update.executor({ taskId: idX, action: 'cancel' });
    assert.equal(c.exitCode, 0);
    assert.match(c.stdout, /cancelled/, 'observation 确认取消');
    assert.match(c.stdout, new RegExp(`${idX} \\[cancelled\\]`), '板摘要含 cancelled 行(容量已回收)');
    assert.equal(board.snapshot().tasks[idX]!.status, 'cancelled');
    await assert.rejects(() => update.executor({ taskId: idX, action: 'cancel' }), /cancel expects a pending task/, '终态取消经工具面透出 INVALID_ARG');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create_task 依赖校验 + update_task depend 环拒绝经工具面透出', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools2-'));
  try {
    const board = makeBoard(tmp);
    const tools = makeTaskBoardTools(board);
    const create = tools.find((t) => t.name === 'create_task')!;
    const update = tools.find((t) => t.name === 'update_task')!;
    const ra = await create.executor({ title: 'A', spec: 'a', dependsOn: null, assignee: null });
    const idA = createdId(ra.stdout);
    const rb = await create.executor({ title: 'B', spec: 'b', dependsOn: [idA], assignee: null });
    assert.equal(rb.exitCode, 0);
    const idB = createdId(rb.stdout);
    await drain();
    // A←B 加边即与既有 B→A 边成环:拒绝
    await assert.rejects(() => update.executor({ taskId: idA, action: 'depend', dependsOn: idB }), /cycle/, '环拒绝透出 INVALID_ARG');
    await assert.rejects(() => create.executor({ title: 'C', spec: 'c', dependsOn: ['tX'], assignee: null }), /unknown dependency/);
    // 未知 action:INVALID_ARG(动作枚举面)
    await assert.rejects(() => update.executor({ taskId: idA, action: 'nope' }), /unknown action/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('get_board 收编进 lead 面:摘要行+门标记+预算行(2026-10-20 缺口补齐回归)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools3-'));
  try {
    const board = makeBoard(tmp);
    const tools = makeTaskBoardTools(board);
    const create = tools.find((t) => t.name === 'create_task')!;
    const getBoard = tools.find((t) => t.name === 'get_board')!;
    const r = await create.executor({ title: 'GateDemo', spec: 'g', dependsOn: null, assignee: null, gated: true });
    const id = createdId(r.stdout);
    const out = (await getBoard.executor({})) as { stdout: string };
    assert.match(out.stdout, new RegExp(`${id} \\[pending\\] \\[gated\\] GateDemo`), '板摘要行含 id/状态/门标记/标题');
    assert.ok(!out.stdout.includes('team budget'), '未设预算帽不透出预算行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
