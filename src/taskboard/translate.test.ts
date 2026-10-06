// 翻译单点迁移口径镜像断言(G3 Task 2):boardEventFrom 自 tui/session.ts 逐字迁至本模块——
// 六事件型翻译与既有口径逐字段镜像(迁移不改语义,session.board.test/mirror.test 零改动全绿为胜利判据)。
// 现状口径钉边界(G2 终审 minor 登记):TaskBoard 发射的 task-created 载荷带 executorHint,
// 翻译侧不携带(投影无需路由提示,消费面为 P2 派发路由)——断言按现状镜像,现状是什么就什么。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardEventFrom } from './translate';
import type { SessionEvent } from '../types';
import type { TaskBoardState } from './model';
import { applyBoardEvent, emptyBoard } from './model';

test('task-created 翻译:title/spec/dependsOn/ts 逐字段;载荷 executorHint 不携带(现状口径)', () => {
  const ev = boardEventFrom({ type: 'task-created', ts: 100, payload: { taskId: 't1', title: 'A', spec: 'do A', dependsOn: ['t0'], executorHint: 'external-cli' } });
  assert.deepEqual(ev, { t: 'task-created', taskId: 't1', title: 'A', spec: 'do A', dependsOn: ['t0'], ts: 100 });
  // 缺省载荷防御:payload 缺席/字段缺失回退空串与空数组
  assert.deepEqual(boardEventFrom({ type: 'task-created', ts: 101 }), { t: 'task-created', taskId: '', title: '', spec: '', dependsOn: [], ts: 101 });
});

test('task-dep-added/task-assigned 翻译(P2 新型)', () => {
  assert.deepEqual(
    boardEventFrom({ type: 'task-dep-added', ts: 102, payload: { taskId: 't2', dependsOn: 't1' } }),
    { t: 'dependency-added', taskId: 't2', dependsOn: 't1', ts: 102 },
  );
  assert.deepEqual(
    boardEventFrom({ type: 'task-assigned', ts: 103, payload: { taskId: 't2', assignee: 'bob' } }),
    { t: 'assigned', taskId: 't2', assignee: 'bob', ts: 103 },
  );
});

test('task-status-changed 翻译:from/状态键 status→to;缺省回退 pending', () => {
  assert.deepEqual(
    boardEventFrom({ type: 'task-status-changed', ts: 104, payload: { taskId: 't1', from: 'pending', status: 'claimed' } }),
    { t: 'status-changed', taskId: 't1', from: 'pending', to: 'claimed', ts: 104 },
  );
  // from/status 缺席回退 pending(防御:非法/残缺载荷不炸)
  assert.deepEqual(
    boardEventFrom({ type: 'task-status-changed', ts: 105, payload: { taskId: 't9' } }),
    { t: 'status-changed', taskId: 't9', from: 'pending', to: 'pending', ts: 105 },
  );
});

test('gate 两态翻译:waiting 带 note(字符串时)/resolved 带 approved', () => {
  assert.deepEqual(
    boardEventFrom({ type: 'gate-waiting', ts: 106, payload: { taskId: 't4', note: 'need human check' } }),
    { t: 'gate-set', taskId: 't4', ts: 106, note: 'need human check' },
  );
  // note 非字符串不携带(条件展开)
  assert.deepEqual(boardEventFrom({ type: 'gate-waiting', ts: 107, payload: { taskId: 't4', note: 42 } }), { t: 'gate-set', taskId: 't4', ts: 107 });
  assert.deepEqual(
    boardEventFrom({ type: 'gate-resolved', ts: 108, payload: { taskId: 't4', approved: true } }),
    { t: 'gate-resolved', taskId: 't4', approved: true, ts: 108 },
  );
  assert.deepEqual(
    boardEventFrom({ type: 'gate-resolved', ts: 109, payload: { taskId: 't4', approved: false } }),
    { t: 'gate-resolved', taskId: 't4', approved: false, ts: 109 },
  );
});

test('task-unlocked/task-blocked 默认分支:pending→pending 翻译,reducer 原引用返回(零分配)', () => {
  for (const type of ['task-unlocked', 'task-blocked'] as const) {
    assert.deepEqual(
      boardEventFrom({ type, ts: 110, payload: { taskId: 't2' } }),
      { t: 'status-changed', taskId: 't2', from: 'pending', to: 'pending', ts: 110 },
    );
  }
  let board: TaskBoardState = emptyBoard();
  board = applyBoardEvent(board, { t: 'task-created', taskId: 't2', title: 'B', spec: '', dependsOn: [], ts: 1 });
  const before = board;
  const after = applyBoardEvent(board, boardEventFrom({ type: 'task-blocked', ts: 110, payload: { taskId: 't2' } } satisfies SessionEvent));
  assert.equal(after, before, '投影无状态变化,reducer 原引用返回');
});
