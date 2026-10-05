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
  // brief 原文此处 pending→done 直达,与 transitionLegal 闭集及 test 2 的断言矛盾(reducer 拒绝后 t2 停留 pending);
  // 改走合法链 pending→claimed→in-review→done,测试意图不变:终态任务 recoverOnLoad 不动。
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't2', from: 'pending', to: 'claimed', ts: 3 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't2', from: 'claimed', to: 'in-review', ts: 3 });
  s = applyBoardEvent(s, { t: 'status-changed', taskId: 't2', from: 'in-review', to: 'done', ts: 3 });
  const r = recoverOnLoad(s);
  assert.deepEqual(r.recovered, ['t1']);
  assert.equal(r.state.tasks['t1']!.status, 'pending');
  assert.equal(r.state.tasks['t2']!.status, 'done', '终态不动');
});
