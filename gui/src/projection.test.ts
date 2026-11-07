import { describe, it, expect } from 'vitest';
import {
  boardEventFrom,
  applyBoardEvent,
  applyBgTaskEvent,
  applyTeamMemberEvent,
  applyTeamNameEvent,
  emptyBoard,
  applyDelegation,
} from './projection';
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

  it('队名直播：team-created / task-created.teamName upsert，同 id 覆盖名', () => {
    let teams = applyTeamNameEvent([], {
      type: 'team-created',
      ts: 10,
      payload: { teamId: 'team-a', name: '测试小分队', createdAt: 1 },
    });
    expect(teams).toEqual([{ teamId: 'team-a', name: '测试小分队', createdAt: 1 }]);
    teams = applyTeamNameEvent(teams, {
      type: 'task-created',
      ts: 20,
      payload: { taskId: 't1', teamId: 'team-a', teamName: '测试小分队', teamCreatedAt: 1 },
    });
    expect(teams).toHaveLength(1);
    teams = applyTeamNameEvent(teams, {
      type: 'task-created',
      ts: 30,
      payload: { taskId: 't2', teamId: 'team-b', teamName: 'Beta', teamCreatedAt: 2 },
    });
    expect(teams).toEqual([
      { teamId: 'team-a', name: '测试小分队', createdAt: 1 },
      { teamId: 'team-b', name: 'Beta', createdAt: 2 },
    ]);
    // 无 teamName 的旧帧不改 teams（卡头仍靠快照）
    expect(
      applyTeamNameEvent(teams, {
        type: 'task-created',
        ts: 40,
        payload: { taskId: 't3', teamId: 'team-c', title: 'x' },
      }),
    ).toEqual(teams);
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

  it('成员名册直播：teammate-created 登记；名册内 delegation 翻转 busy；spawn 同形委派不入册', () => {
    let team = applyTeamMemberEvent([], {
      type: 'teammate-created',
      ts: 10,
      payload: { name: '需求分析师', teamId: 'team-a', createdAt: 1, busy: false },
    });
    expect(team).toEqual([{ name: '需求分析师', busy: false, teamId: 'team-a', createdAt: 1 }]);
    team = applyTeamMemberEvent(team, {
      type: 'delegation-started',
      ts: 20,
      payload: { delegationId: 'task-t1', kind: 'subagent', label: '需求分析师', title: '分析需求' },
    });
    expect(team[0]!.busy).toBe(true);
    team = applyTeamMemberEvent(team, {
      type: 'delegation-ended',
      ts: 30,
      payload: { delegationId: 'task-t1', kind: 'subagent', label: '需求分析师', status: 'done' },
    });
    expect(team[0]!.busy).toBe(false);
    // 未在名册的 spawn fork 委派不误入成员栏
    expect(
      applyTeamMemberEvent(team, {
        type: 'delegation-started',
        ts: 40,
        payload: { delegationId: 'spawn-1', kind: 'subagent', label: 'researcher' },
      }),
    ).toEqual(team);
  });

  it('后台任务直播：bg-task upsert；保留既有 outputTail；非 exec/subagent 忽略', () => {
    let rows = applyBgTaskEvent([], {
      type: 'bg-task',
      ts: 10,
      payload: { id: 'bg1', kind: 'exec', label: 'sleep 30', status: 'running', startedAt: 10 },
    });
    expect(rows).toEqual([{ id: 'bg1', kind: 'exec', label: 'sleep 30', status: 'running', startedAt: 10 }]);
    rows = applyBgTaskEvent(rows, {
      type: 'bg-task',
      ts: 20,
      payload: {
        id: 'bg1',
        kind: 'exec',
        label: 'sleep 30',
        status: 'done',
        startedAt: 10,
        endedAt: 20,
        exitCode: 0,
      },
    });
    expect(rows[0]).toMatchObject({ id: 'bg1', status: 'done', endedAt: 20, exitCode: 0 });
    // GET 播种的尾部在事件更新后仍保留
    rows = applyBgTaskEvent(
      [{ id: 'bg1', kind: 'exec', label: 'sleep 30', status: 'running', startedAt: 10, outputTail: 'out…', outputTruncated: true }],
      {
        type: 'bg-task',
        ts: 30,
        payload: { id: 'bg1', kind: 'exec', label: 'sleep 30', status: 'stopped', startedAt: 10, endedAt: 30 },
      },
    );
    expect(rows[0]).toMatchObject({ status: 'stopped', outputTail: 'out…', outputTruncated: true });
    // teammate 等非账本 kind 不入后台任务面
    expect(
      applyBgTaskEvent(rows, {
        type: 'bg-task',
        ts: 40,
        payload: { id: 'tm1', kind: 'teammate', label: '分析师', status: 'running', startedAt: 40 },
      }),
    ).toEqual(rows);
  });
});

describe('bg-task 任务名(exec purpose,2026-11-07)', () => {
  it('事件带 title 即落行;缺省不落(显示回落 label)', () => {
    const rows = applyBgTaskEvent([], { type: 'bg-task', ts: 1, payload: { id: 'b', kind: 'exec', label: 'npm run dev', title: '启动开发服务器', status: 'running', startedAt: 1 } });
    expect(rows[0]!.title).toBe('启动开发服务器');
    expect(applyBgTaskEvent([], { type: 'bg-task', ts: 1, payload: { id: 'c', kind: 'exec', label: 'ls', status: 'running', startedAt: 1 } })[0]!.title).toBeUndefined();
  });
});
