import { describe, it, expect } from 'vitest';
import { boardEventFrom, applyBoardEvent, emptyBoard, applyDelegation } from './projection';
import type { SessionEvent } from '../../src/types';

/**
 * gui 投影实时化（G3 Task 2）：gui 侧事件流经单点 projection.ts（boardEventFrom + 同源 reducer）
 * 直推板态/委派态——不引 TUI 模块图、不复制投影逻辑，与 TUI session 同一单点防形态漂移。
 * 序列断言模仿 ChatState 的消费形态：SessionEvent → boardEventFrom → applyBoardEvent 归约。
 */

describe('gui 板投影（boardEventFrom + applyBoardEvent 同源直跑）', () => {
  it('task-created → running → success 事件序列得 success 板', () => {
    const events: SessionEvent[] = [
      { type: 'task-created', ts: 100, payload: { taskId: 't1', title: 'A', spec: 'do A', dependsOn: [], teamId: 'team-a' } },
      { type: 'task-status-changed', ts: 101, payload: { taskId: 't1', from: 'pending', status: 'running' } },
      { type: 'task-status-changed', ts: 102, payload: { taskId: 't1', from: 'running', status: 'success' } },
    ];
    let board = emptyBoard();
    for (const e of events) board = applyBoardEvent(board, boardEventFrom(e));
    expect(board.seq).toBe(1);
    expect(board.tasks['t1']).toMatchObject({ id: 't1', title: 'A', spec: 'do A', status: 'success', teamId: 'team-a' });
  });

  it('委派投影一例：delegation-started → delegation-ended(done) 归约出终态委派条目', () => {
    let delegations = applyDelegation([], {
      type: 'delegation-started',
      ts: 200,
      payload: { delegationId: 'task-t1', kind: 'subagent', label: 'task-t1' },
    });
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({ id: 'task-t1', kind: 'subagent', label: 'task-t1', status: 'running', startedAt: 200 });
    delegations = applyDelegation(delegations, {
      type: 'delegation-ended',
      ts: 201,
      payload: { delegationId: 'task-t1', kind: 'subagent', label: 'task-t1', status: 'done', tokens: 5, reply: 'ok' },
    });
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({ id: 'task-t1', status: 'done', endedAt: 201, tokens: 5, reply: 'ok' });
  });
});
