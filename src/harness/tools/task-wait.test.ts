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
    setTimeout(() => {
      tasks.append(a.id, 'out-a\n');
      tasks.finish(a.id, 'done', { exitCode: 2 });
      tasks.finish(b.id, 'stopped', { marker: '[stopped: test]' });
    }, 50);
    const r = await registry.execute('task_wait', { taskIds: null, timeoutSeconds: null }, stubSafety);
    assert.ok(r.ok);
    assert.match(r.value.stdout, new RegExp(`${a.id} \\(exec\\) done, exit 2`));
    assert.match(r.value.stdout, new RegExp(`${b.id} \\(subagent\\) stopped`));
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
