import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBoardEvent, BoardEvent, dispatchable, emptyBoard, hasCycle,
  recoverOnLoad, transitionLegal, derivedBlocked,
} from './model';

const created = (id: string, deps: string[] = [], extra: Partial<Extract<BoardEvent, { t: 'task-created' }>> = {}): BoardEvent =>
  ({ t: 'task-created', taskId: id, title: `T ${id}`, spec: `do ${id}`, dependsOn: deps, teamId: 'tm1', ts: 1, ...extra });

test('applyBoardEvent:created 建条、status-changed 迁移与 artifact 并入、未知 taskId 原引用', () => {
  let s = emptyBoard();
  s = applyBoardEvent(s, created('t1'));
  s = applyBoardEvent(s, created('t2', ['t1']));
  assert.equal(s.seq, 2);
  assert.equal(s.tasks['t1']!.status, 'pending');
  assert.equal(s.tasks['t1']!.teamId, 'tm1');
  const before = s;
  assert.equal(applyBoardEvent(s, { t: 'assigned', taskId: 'tX', assignee: 'a', ts: 2 }), before, '未知 id 原引用');
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't1', from: 'pending', to: 'running', ts: 3 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't1', from: 'running', to: 'success', ts: 4, conclusion: 'done A', tokens: 42, durationMs: 900 });
  assert.equal(s.tasks['t1']!.status, 'success');
  assert.deepEqual(s.tasks['t1']!.artifact, { conclusion: 'done A', tokens: 42, durationMs: 900 });
});

test('task-created executorHint:随事件入板;缺省时字段缺位(P2)', () => {
  let s = emptyBoard();
  s = applyBoardEvent(s, { t: 'task-created', taskId: 't1', title: 'A', spec: 'a', dependsOn: [], teamId: 'tm1', ts: 1, executorHint: 'external-cli' });
  assert.equal(s.tasks['t1']!.executorHint, 'external-cli', 'executorHint 随 task-created 事件入板');
  s = applyBoardEvent(s, created('t2'));
  assert.equal('executorHint' in s.tasks['t2']!, false, '不带 executorHint 的 task-created,字段缺位(非 undefined 值)');
});

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

test('dispatchable/derivedBlocked:依赖须 success 与失败传播', () => {
  let s = emptyBoard();
  s = applyBoardEvent(s, created('t1'));
  s = applyBoardEvent(s, created('t2', ['t1']));
  s = applyBoardEvent(s, created('t3', ['t2']));
  assert.deepEqual(dispatchable(s).map((t) => t.id), ['t1'], '仅无依赖者可派发');
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't1', from: 'pending', to: 'running', ts: 2 });
  assert.deepEqual(dispatchable(s), [], 'running 不重复派发');
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't1', from: 'running', to: 'success', ts: 3 });
  assert.deepEqual(dispatchable(s).map((t) => t.id), ['t2'], '上游 success 解锁下游');
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't2', from: 'pending', to: 'running', ts: 7 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't2', from: 'running', to: 'failed', ts: 8 });
  assert.ok(derivedBlocked(s, 't3'), '上游 failed → 下游派生 blocked');
  assert.deepEqual(dispatchable(s), [], 'blocked 不派发');
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
