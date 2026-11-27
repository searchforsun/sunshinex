import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import type { SnapshotResponse } from './connection';
import { applyAgentEvent, type AgentActivities } from './tabs/agent-activity';
import { inFlightAgentNames, useBoardSeed } from './use-board-seed';

/** 2026-11-27 用户报障「同步派发的子智能体显示已停止,实际运行中」：封悬空 run 的在飞权威
 *  = team.busy ∪ 快照 subagents（spawn/后台任务子代不在成员名册），且会话在飞时不封。 */
describe('inFlightAgentNames(悬空 run 封口的在飞权威)', () => {
  it('team.busy ∪ subagents：非名册的同步 spawn 子代同样视为在飞', () => {
    const names = inFlightAgentNames(
      [
        { name: '分析师', busy: true },
        { name: '空闲员', busy: false },
      ],
      ['Kafka 配置 open 接口'],
    );
    expect([...names].sort()).toEqual(['Kafka 配置 open 接口', '分析师']);
  });

  it('旧 daemon 无 subagents 字段 = 只按 team.busy（行为不回归）', () => {
    expect([...inFlightAgentNames([{ name: '分析师', busy: true }], undefined)]).toEqual(['分析师']);
    expect(inFlightAgentNames([], undefined).size).toBe(0);
  });
});

const LABEL = '同步子代';

const snapOf = (status: 'idle' | 'running'): SnapshotResponse & { lastSeq: number } => ({
  messages: [],
  board: { tasks: {}, seq: 0 },
  delegations: [],
  status,
  lastSeq: 1,
});

/** 探针：一张在飞子代卡（model-start + token 半截 = 未收口 run）+ useBoardSeed 实例 */
function useProbe(): {
  acts: AgentActivities;
  refreshFromSnapshot: (snap: SnapshotResponse) => void;
} {
  const sessionRef = useRef('s1');
  const busyTeamRef = useRef<ReadonlySet<string>>(new Set());
  const busyTeamReadyRef = useRef(false);
  const sessionLiveRef = useRef(false);
  const [acts, setActs] = useState<AgentActivities>(() => {
    let s: AgentActivities = {};
    s = applyAgentEvent(s, { type: 'model-start', ts: 1, payload: { subagent: LABEL } });
    s = applyAgentEvent(s, { type: 'token', text: '半截', ts: 2, payload: { subagent: LABEL } });
    return s;
  });
  const bumpActs = useCallback(
    (_sid: string, fold: (a: AgentActivities) => AgentActivities): void => {
      setActs(fold);
    },
    [],
  );
  const { refreshFromSnapshot } = useBoardSeed({
    sessionRef,
    setRunningIds: () => {},
    setProjection: () => {},
    bumpActs,
    busyTeamRef,
    busyTeamReadyRef,
    sessionLiveRef,
  });
  return { acts, refreshFromSnapshot };
}

describe('快照刷新封悬空轮守门', () => {
  it('会话在飞（status=running）不封：同步 spawn 子代保持运行中', () => {
    const { result } = renderHook(() => useProbe());
    act(() => {
      result.current.refreshFromSnapshot(snapOf('running'));
    });
    expect(result.current.acts[LABEL]!.chat.status).toBe('running');
    expect(result.current.acts[LABEL]!.status).toBe('running');
  });

  it('会话空闲（status=idle）照旧封：重启恢复语义不回归', () => {
    const { result } = renderHook(() => useProbe());
    act(() => {
      result.current.refreshFromSnapshot(snapOf('idle'));
    });
    expect(result.current.acts[LABEL]!.chat.status).toBe('idle');
    expect(result.current.acts[LABEL]!.status).toBe('done');
  });

  it('会话空闲但子代在快照 subagents 名单内（后台任务在飞）不封', () => {
    const { result } = renderHook(() => useProbe());
    act(() => {
      result.current.refreshFromSnapshot({ ...snapOf('idle'), subagents: [LABEL] });
    });
    expect(result.current.acts[LABEL]!.chat.status).toBe('running');
  });
});
