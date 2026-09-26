// task_wait 底座：TaskRegistry.waitUntilSettled 等待单点——全部目标到终态即 resolve；
// 超时 resolve settled=false（不抛错，回执形态由工具层承载）；已终态目标零等待幂等即回。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskRegistry } from './tasks';

function makeRegistry(): { reg: TaskRegistry; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskwait-'));
  return { reg: new TaskRegistry(path.join(root, 'data')), root };
}

test('waitUntilSettled 已终态目标零等待即回 settled=true', async () => {
  const { reg, root } = makeRegistry();
  try {
    const t = reg.submit({ kind: 'exec', label: 'done-task' });
    reg.finish(t.id, 'done', { exitCode: 0 });
    const r = await reg.waitUntilSettled([t.id], 5000);
    assert.equal(r.settled, true);
    assert.equal(r.tasks.length, 1);
    assert.equal(r.tasks[0].status, 'done');
    assert.equal(r.tasks[0].exitCode, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitUntilSettled 运行中任务终态到达后 resolve', async () => {
  const { reg, root } = makeRegistry();
  try {
    const t = reg.submit({ kind: 'exec', label: 'slow-task' });
    setTimeout(() => reg.finish(t.id, 'done', { exitCode: 0 }), 50);
    const r = await reg.waitUntilSettled([t.id], 5000);
    assert.equal(r.settled, true);
    assert.equal(r.tasks[0].status, 'done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitUntilSettled 超时 resolve settled=false 且带当前快照', async () => {
  const { reg, root } = makeRegistry();
  try {
    const t = reg.submit({ kind: 'exec', label: 'never-ends' });
    const r = await reg.waitUntilSettled([t.id], 150);
    assert.equal(r.settled, false);
    assert.equal(r.tasks[0].status, 'running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitUntilSettled 批量混合：部分已完成 + 部分稍后终态，等到全部收口', async () => {
  const { reg, root } = makeRegistry();
  try {
    const a = reg.submit({ kind: 'exec', label: 'a' });
    reg.finish(a.id, 'done', { exitCode: 0 });
    const b = reg.submit({ kind: 'exec', label: 'b' });
    setTimeout(() => reg.finish(b.id, 'failed', { exitCode: 1 }), 50);
    const r = await reg.waitUntilSettled([a.id, b.id], 5000);
    assert.equal(r.settled, true);
    assert.deepEqual(r.tasks.map((t) => t.status), ['done', 'failed']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitUntilSettled 空目标列表零等待即回（幂等空回执底座）', async () => {
  const { reg, root } = makeRegistry();
  try {
    const r = await reg.waitUntilSettled([], 300);
    assert.deepEqual(r, { settled: true, tasks: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitUntilSettled 未知 id 过滤后为空同样零等待即回', async () => {
  const { reg, root } = makeRegistry();
  try {
    const r = await reg.waitUntilSettled(['b999'], 300);
    assert.deepEqual(r, { settled: true, tasks: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
