import { useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { SnapshotResponse } from './connection';
import type { SessionEvent } from '../../src/types';
import { applyBoardEvent, applyDelegation, boardEventFrom, type SessionProjection } from './projection';
import { applyAgentEvent, type AgentActivities } from './tabs/agent-activity';

/**
 * 板播种窗 hook(2026-10-27 技术债轮 D53 批F 自 App.tsx 外提,行为零变化):
 * G6 seq 门——播种窗(快照在途)内 board/delegation 帧缓冲(与 Chat pendingRef 同构 {seq,e}[]),
 * onSeeded 整替快照板后按 lastSeq 过滤重放(窗内增量不再被整替吞掉,丢一帧增量竞态根除);
 * 窗由 Chat reseed 生命周期驱动(openSession/onReset/onResetSession 三处重开,窗内残留帧属
 * 旧基线/旧板,弃)。refs 穿透 use-connection-wiring(onEvent 帧路由按窗分流直投/缓冲)。
 */

export interface BoardSeedDeps {
  readonly sessionRef: MutableRefObject<string>;
  /** G14.2xx 运行态对表(零额外请求,复用 reseed 快照的 status 权威) */
  readonly setRunningIds: (f: (s: ReadonlySet<string>) => ReadonlySet<string>) => void;
  readonly setProjection: (f: (p: SessionProjection) => SessionProjection) => void;
  readonly bumpActs: (sessionId: string, f: (a: AgentActivities) => AgentActivities) => void;
}

export function useBoardSeed(deps: BoardSeedDeps): {
  boardPendingRef: MutableRefObject<Array<{ e: SessionEvent; seq: number }>>;
  boardSeedingRef: MutableRefObject<boolean>;
  /** 播种窗重开(清缓冲):openSession/onReset/onResetSession 三处——均伴随 Chat reseed */
  reopenBoardSeedWindow: () => void;
  /** G5 Chat 播种回调:快照权威态回填 App 投影 */
  seedFromSnapshot: (snap: SnapshotResponse) => void;
} {
  const { sessionRef, setRunningIds, setProjection, bumpActs } = deps;
  /** G6 板投影 seq 门:播种窗(快照在途)内 board/delegation 帧缓冲(与 Chat pendingRef 同构
   *  {seq, e}[])——onSeeded 整替快照板后过滤重放;窗由 Chat reseed 生命周期驱动 */
  const boardPendingRef = useRef<Array<{ e: SessionEvent; seq: number }>>([]);
  /** 板播种窗开关:true = 快照在途(帧入缓冲不直投);onSeeded 落定置 false */
  const boardSeedingRef = useRef(true);

  const reopenBoardSeedWindow = (): void => {
    boardPendingRef.current = [];
    boardSeedingRef.current = true;
  };

  /** G5 Chat 播种回调:快照权威态回填 App 投影——team(事件流无此面)+board/delegations
   *  (快照本就携带:会话打开/reseed 即板随快照)。G6 seq 门(G5 交接 b 根修):整替前先关窗+
   *  过滤缓冲(≤ snap.lastSeq 丢——快照已含,再投即双应用;> 逐帧依序 apply 重放到快照板上)
   *  ——播种窗内到达的增量帧不再被整替吞掉(丢一帧增量竞态根除)。lastSeq 运行时必在
   *  (sessionSnapshot 应答字段;ChatSink 类型面未声明,收窄读取防 undefined 旧档) */
  const seedFromSnapshot = (snap: SnapshotResponse): void => {
    const lastSeq = (snap as SnapshotResponse & { lastSeq?: number }).lastSeq ?? 0;
    const replay = boardPendingRef.current.filter((f) => f.seq > lastSeq);
    boardPendingRef.current = [];
    boardSeedingRef.current = false;
    // G14.2xx 运行态对表(零额外请求,复用 reseed 快照的 status 权威):attach 收编运行中/
    // 重启重开均归位;非运行清同会话残留(修「已完成仍在转圈」的跨会话布尔卡滞)
    setRunningIds((s) => {
      const without = new Set([...s].filter((x) => x !== sessionRef.current));
      return snap.status === 'running' && sessionRef.current !== '' ? new Set([...without, sessionRef.current]) : without;
    });
    let nextBoard = snap.board;
    let nextDelegations = snap.delegations;
    for (const f of replay) {
      if (f.e.type.startsWith('task-') || f.e.type.startsWith('gate-')) {
        nextBoard = applyBoardEvent(nextBoard, boardEventFrom(f.e));
      } else if (f.e.type.startsWith('delegation-')) {
        nextDelegations = applyDelegation(nextDelegations, f.e);
        // G8e-T2:delegation 帧补投子智能体聚合(与 board/delegation 同窗)——窗外路径本就投
        // applyAgentEvent(权威终语:ended failed→error/done→done;label 命中既有卡才动),
        // 窗内缓冲帧此前只重放板/委派不投聚合,delegation 终语在播种窗内被吞(卡滞 running)
        if (sessionRef.current !== '') bumpActs(sessionRef.current, (a) => applyAgentEvent(a, f.e));
      }
    }
    setProjection((p) => ({ ...p, board: nextBoard, delegations: nextDelegations, team: snap.team ?? [] }));
  };

  return { boardPendingRef, boardSeedingRef, reopenBoardSeedWindow, seedFromSnapshot };
}
