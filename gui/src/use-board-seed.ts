import { useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { SnapshotResponse } from './connection';
import type { SessionEvent } from '../../src/types';
import { applyBoardEvent, applyDelegation, applyTeamMemberEvent, applyTeamNameEvent, boardEventFrom, type SessionProjection } from './projection';
import { applyAgentEvent, sealOrphanAgentRuns, type AgentActivities } from './tabs/agent-activity';

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
  /** 快照权威 busy 成员名(影子水合落定后封悬空 run 共用) */
  readonly busyTeamRef: MutableRefObject<ReadonlySet<string>>;
  /** 已收到至少一次快照 team 段——水合在此之前不封(防刷新中途误封在飞流) */
  readonly busyTeamReadyRef: MutableRefObject<boolean>;
}

export function useBoardSeed(deps: BoardSeedDeps): {
  boardPendingRef: MutableRefObject<Array<{ e: SessionEvent; seq: number }>>;
  boardSeedingRef: MutableRefObject<boolean>;
  /** 播种窗重开(清缓冲):openSession/onReset/onResetSession 三处——均伴随 Chat reseed */
  reopenBoardSeedWindow: () => void;
  /** G5 Chat 播种回调:快照权威态回填 App 投影 */
  seedFromSnapshot: (snap: SnapshotResponse) => void;
  /** 近期板帧环(窗内外都记,带 seq):刷新快照整替后按 lastSeq 重放,在途增量不被吞 */
  boardRecentRef: MutableRefObject<Array<{ e: SessionEvent; seq: number }>>;
  /** 面板刷新(智能体团队/任务板刷新钮、打开即刷):快照整替 + 近期帧 seq 门重放 */
  refreshFromSnapshot: (snap: SnapshotResponse) => void;
} {
  const { sessionRef, setRunningIds, setProjection, bumpActs, busyTeamRef, busyTeamReadyRef } = deps;
  /** G6 板投影 seq 门:播种窗(快照在途)内 board/delegation 帧缓冲(与 Chat pendingRef 同构
   *  {seq, e}[])——onSeeded 整替快照板后过滤重放;窗由 Chat reseed 生命周期驱动 */
  const boardPendingRef = useRef<Array<{ e: SessionEvent; seq: number }>>([]);
  /** 板播种窗开关:true = 快照在途(帧入缓冲不直投);onSeeded 落定置 false */
  const boardSeedingRef = useRef(true);
  const boardRecentRef = useRef<Array<{ e: SessionEvent; seq: number }>>([]);

  const reopenBoardSeedWindow = (): void => {
    boardPendingRef.current = [];
    boardRecentRef.current = [];
    boardSeedingRef.current = true;
    // 会话切换/重连：busy 权威随新快照再立，避免沿用上一会话 busy 名误留悬空 run
    busyTeamReadyRef.current = false;
    busyTeamRef.current = new Set();
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
    mergeSnapshot(snap, replay, true);
    // G14.2xx 运行态对表(零额外请求,复用 reseed 快照的 status 权威):attach 收编运行中/
    // 重启重开均归位;非运行清同会话残留(修「已完成仍在转圈」的跨会话布尔卡滞)
    setRunningIds((s) => {
      const without = new Set([...s].filter((x) => x !== sessionRef.current));
      return snap.status === 'running' && sessionRef.current !== '' ? new Set([...without, sessionRef.current]) : without;
    });
  };

  /** 快照整替 + 帧重放单点(播种与面板刷新共用):replayActs=重放 delegation 帧时一并投子智能体
   *  聚合(播种窗内帧未投过;刷新时近期帧早已直投,不重复投) */
  const mergeSnapshot = (snap: SnapshotResponse, replay: Array<{ e: SessionEvent; seq: number }>, replayActs: boolean): void => {
    let nextBoard = snap.board;
    let nextDelegations = snap.delegations;
    // 快照 teams/team 为基线；窗内 team-created / teammate-created / task-created / delegation 尾随合并
    let nextTeams = snap.teams ?? [];
    let nextTeam = snap.team ?? [];
    for (const f of replay) {
      if (f.e.type === 'team-created') {
        nextTeams = applyTeamNameEvent(nextTeams, f.e);
      } else if (f.e.type === 'teammate-created') {
        nextTeam = applyTeamMemberEvent(nextTeam, f.e);
      } else if (f.e.type.startsWith('task-')) {
        nextBoard = applyBoardEvent(nextBoard, boardEventFrom(f.e));
        if (f.e.type === 'task-created') nextTeams = applyTeamNameEvent(nextTeams, f.e);
      } else if (f.e.type.startsWith('delegation-')) {
        nextDelegations = applyDelegation(nextDelegations, f.e);
        nextTeam = applyTeamMemberEvent(nextTeam, f.e);
        // G8e-T2:delegation 帧补投子智能体聚合(与 board/delegation 同窗)——窗外路径本就投
        // applyAgentEvent(权威终语:ended failed→error/done→done;label 命中既有卡才动),
        // 窗内缓冲帧此前只重放板/委派不投聚合,delegation 终语在播种窗内被吞(卡滞 running)
        if (replayActs && sessionRef.current !== '') bumpActs(sessionRef.current, (a) => applyAgentEvent(a, f.e));
      }
    }
    const busy = new Set(nextTeam.filter((m) => m.busy).map((m) => m.name));
    busyTeamRef.current = busy;
    busyTeamReadyRef.current = true;
    setProjection((p) => ({ ...p, board: nextBoard, delegations: nextDelegations, team: nextTeam, teams: nextTeams }));
    // 重启后 journal 未收口 run 与板 cancelled 对齐：非 busy 成员封悬空转圈
    if (sessionRef.current !== '') {
      bumpActs(sessionRef.current, (a) => sealOrphanAgentRuns(a, busy));
    }
  };

  /** 面板刷新:快照可能先于在途帧生成——整替后重放 seq > lastSeq 的近期帧(播种窗开着时其
   *  缓冲帧也在环内,Chat 播种落定会再以权威快照整替) */
  const refreshFromSnapshot = (snap: SnapshotResponse): void => {
    const lastSeq = (snap as SnapshotResponse & { lastSeq?: number }).lastSeq ?? 0;
    // 无 seq 的帧(旧 daemon/回放路径)无法判定先后,按「快照之后」重放(板/委派应用幂等)
    mergeSnapshot(snap, boardRecentRef.current.filter((f) => !(f.seq <= lastSeq)), false);
  };

  return { boardPendingRef, boardSeedingRef, reopenBoardSeedWindow, seedFromSnapshot, boardRecentRef, refreshFromSnapshot };
}
