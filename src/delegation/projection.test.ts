import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent } from '../types';
import { applyDelegation, Delegation } from './projection';

const ev = (type: string, payload: Record<string, unknown>, ts = 1000): SessionEvent =>
  ({ type, payload, ts }) as never;

test('applyDelegation:started 建条、ended 收态、未知事件引用不变', () => {
  let list: Delegation[] = [];
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'rv', kind: 'subagent', label: 'rv' }, 100));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, 'running');
  assert.equal(list[0]!.startedAt, 100);
  const same = applyDelegation(list, ev('token', { x: 1 }, 200));
  assert.equal(same, list, '非委派事件返回原引用(零分配)');
  list = applyDelegation(list, ev('delegation-ended', { delegationId: 'rv', kind: 'subagent', status: 'done', tokens: 42 }, 300));
  assert.equal(list[0]!.status, 'done');
  assert.equal(list[0]!.endedAt, 300);
  assert.equal(list[0]!.tokens, 42);
});

test('applyDelegation:ended 无 started 时合成终态条目(skipped 语义)', () => {
  let list: Delegation[] = [];
  list = applyDelegation(list, ev('delegation-ended', { delegationId: 'b', kind: 'graph-node', status: 'skipped' }, 500));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, 'skipped');
  assert.equal(list[0]!.startedAt, 500, '合成条目起点取终态时刻');
});

test('applyDelegation:载荷缺 delegationId/kind 非法即忽略(防御口径)', () => {
  let list: Delegation[] = [];
  list = applyDelegation(list, ev('delegation-started', { kind: 'subagent' }));
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'x', kind: 'bogus' }));
  list = applyDelegation(list, ev('delegation-ended', {}));
  assert.equal(list.length, 0);
});

test('applyDelegation:started 重发幂等(保留首次起点)', () => {
  let list: Delegation[] = [];
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'rv', kind: 'subagent' }, 100));
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'rv', kind: 'subagent' }, 900));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.startedAt, 100);
});

test('applyDelegation:终态后重启起点取新事件时刻(仅 running 态保留首起点)', () => {
  let list: Delegation[] = [];
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'rv', kind: 'subagent' }, 100));
  list = applyDelegation(list, ev('delegation-ended', { delegationId: 'rv', kind: 'subagent', status: 'done', tokens: 42 }, 300));
  assert.equal(list[0]!.status, 'done');
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'rv', kind: 'subagent' }, 500));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, 'running');
  assert.equal(list[0]!.startedAt, 500, '真重启:起点取新事件时刻');
  assert.equal(list[0]!.endedAt, undefined, '重启后终态字段清空');
  assert.equal(list[0]!.tokens, undefined, '重启后旧 tokens 不残留');
});

test('applyDelegation:kind external-cli 载荷进投影(P2 external-cli 执行体)', () => {
  let list: Delegation[] = [];
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'task-t1', kind: 'external-cli', label: 'task-t1' }, 10));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.kind, 'external-cli');
  assert.equal(list[0]!.status, 'running');
  list = applyDelegation(list, ev('delegation-ended', { delegationId: 'task-t1', kind: 'external-cli', status: 'done', tokens: 42 }, 20));
  assert.deepEqual(list, [
    { id: 'task-t1', kind: 'external-cli', label: 'task-t1', status: 'done', startedAt: 10, endedAt: 20, tokens: 42 },
  ], 'external-cli 起止收敛为单条终态委派');
});

test('GUI 同源验证(spec §13 P0 验收):混合事件流 → 单一订阅者推导统一委派列表', () => {
  let list: Delegation[] = [];
  const stream: SessionEvent[] = [
    ev('delegation-started', { delegationId: 'planner', kind: 'graph-node', nodeKind: 'agent' }, 1),
    ev('delegation-started', { delegationId: 'rv', kind: 'subagent', label: 'rv' }, 2),
    ev('delegation-ended', { delegationId: 'planner', kind: 'graph-node', status: 'done', tokens: 900 }, 3),
    ev('delegation-started', { delegationId: 'bg1', kind: 'background-task', taskId: 'b1' }, 4),
    ev('delegation-ended', { delegationId: 'rv', kind: 'subagent', status: 'done' }, 5),
  ];
  for (const e of stream) list = applyDelegation(list, e);
  assert.deepEqual(list.map((d) => [d.id, d.kind, d.status]), [
    ['planner', 'graph-node', 'done'],
    ['rv', 'subagent', 'done'],
    ['bg1', 'background-task', 'running'],
  ]);
});
