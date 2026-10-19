// 后台任务线 T3：task_stop 内置工具行为测试——按 ID 停止在飞任务（规格 D8，对标 CC TaskStop）：
// 命中 running 触发 stop 句柄并转终态；未命中报错列出现存任务（id+label）；命中已终态任务幂等回执当前终态。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskRegistry } from '../tasks';
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
