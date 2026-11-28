import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { Connection, SnapshotResponse } from './connection';
import { upsertBoardTeam } from './projection';
import type { SessionProjection } from './projection';
import { WELCOME_TAB_SEAT, patchTabMeta, setActive, setCollapsed } from './tabs/tab-state';
import type { TabStates } from './tabs/tab-state';
import type { BgTaskRow } from './projection';
import type { AgentActivity } from './tabs/agent-activity';
import type { TabServices } from './tabs/registry';
import { mergeTodoBatches } from './pages/chat/tool-entry-data';
import { pathBasename } from './ui-util';
import type { TodoBatch, ChatSink } from './pages/Chat';

/**
 * 标签体服务面簇(App 外提,D62 批H):任务板停钮(pending|running → boardStop,失败倒 Chat
 * error 条);页签切换跟随(agent 驱动内置浏览器页签时侧栏跟随,双座都试+展开收起侧栏);web
 * 标签元数据回写(页内导航 url/页名 → patchTabMeta,标签条标题/判重键同源演进,useCallback
 * 零依赖稳定——services useMemo 不因回写重建;欢迎页页签落 '@welcome' 草稿座,uid 全局唯一
 * 双座都试);智能体团队刷新(快照整替 board/teams/team/delegations,seq 门防吞增量);side
 * 快照并入主投影(2026-11-07「辅助投影挂主对话下」持久化面,开会话/辅助对账落定逐 side 并集
 * 合并)+ memo 派生值面(bgRunningCount/projectNameOfOpenRoot——ChatMemo/TabStripMemo 下发)。
 */
export function useAppServices({ connRef, sessionRef, chatSinkRef, sideParentRef, sideListing, projection, setProjection, setTabStates, agentActivitiesBySession, openSessionId, openRoot, setBgTasks, bgTasks, todoBatches, seededTodoBatches, setTodoBatches, taskFocus, openTaskFocus, todoLocateSig, openLeaderBubble, refreshFromSnapshot }: {
  connRef: RefObject<Connection | null>;
  sessionRef: MutableRefObject<string>;
  chatSinkRef: MutableRefObject<ChatSink | null>;
  sideParentRef: MutableRefObject<Map<string, string>>;
  sideListing: unknown;
  projection: SessionProjection;
  setProjection: Dispatch<SetStateAction<SessionProjection>>;
  setTabStates: Dispatch<SetStateAction<TabStates>>;
  agentActivitiesBySession: Record<string, Record<string, AgentActivity>>;
  openSessionId: string;
  openRoot: string;
  setBgTasks: Dispatch<SetStateAction<BgTaskRow[]>>;
  bgTasks: BgTaskRow[];
  todoBatches: TodoBatch[];
  seededTodoBatches: TodoBatch[];
  setTodoBatches: Dispatch<SetStateAction<TodoBatch[]>>;
  taskFocus: { ref: string; nonce: number; kind?: 'task' | 'team' | 'agent' } | null;
  openTaskFocus: (ref: string) => void;
  todoLocateSig: { sig: string; nonce: number } | null;
  openLeaderBubble: (m: { member: string; text: string; dir: 'toLeader' | 'fromLeader' }) => void;
  refreshFromSnapshot: (snap: SnapshotResponse) => void;
}): {
  onActivateTab: (sessionId: string, uid: string) => void;
  onTabMeta: (sessionId: string, uid: string, patch: { url?: string; pageTitle?: string; pageIcon?: string; insert?: string; insertContent?: string }) => void;
  services: TabServices;
  bgRunningCount: number;
  projectNameOfOpenRoot: string | undefined;
} {
  /** 任务板停钮：pending|running → boardStop。失败倒 Chat error 条。 */
  const stopTask = useCallback((taskId: string): void => {
    const conn = connRef.current;
    if (conn === null) return;
    void conn.boardStop(sessionRef.current, taskId).catch((err: unknown) => {
      chatSinkRef.current?.on(
        { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() },
        Number.MAX_SAFE_INTEGER,
      );
    });
  }, [connRef, sessionRef, chatSinkRef]);
  /** 页签切换(agent 驱动内置浏览器页签时侧栏跟随):同 onTabMeta 双座都试,并展开收起的侧栏 */
  const onActivateTab = useCallback((sessionId: string, uid: string): void => {
    setTabStates((s) => {
      const has = (seat: string): boolean => s[seat]?.tabs.some((t) => t.uid === uid) === true;
      const seat = has(sessionId) ? sessionId : has(WELCOME_TAB_SEAT) ? WELCOME_TAB_SEAT : undefined;
      return seat === undefined ? s : setActive(setCollapsed(s, seat, false), seat, uid);
    });
  }, [setTabStates]);
  const onTabMeta = useCallback((sessionId: string, uid: string, patch: { url?: string; pageTitle?: string; pageIcon?: string; insert?: string; insertContent?: string }): void => {
    // 欢迎页页签落 '@welcome' 草稿座,而渲染传入的 sessionId 是 openSessionId(欢迎页不清,指向上个
    // 会话)——只按 sessionId 回写会落空,欢迎页浏览器页签名/站标永不更新;uid 全局唯一,双座都试
    setTabStates((s) => patchTabMeta(patchTabMeta(s, sessionId, uid, patch), WELCOME_TAB_SEAT, uid, patch));
  }, [setTabStates]);
  /** 智能体团队刷新:快照整替 board/teams/team/delegations(成员名册仅快照有——漏 team 即「暂无成员」) */
  const refreshBoard = useCallback((sessionId: string): Promise<void> => {
    if (connRef.current === null) return Promise.resolve();
    // seq 门:快照可能早于在途帧——整替后重放更新的近期帧(直接整替曾吞掉刷新期间到达的增量)
    return connRef.current.sessionSnapshot(sessionId).then((snap) => {
      if (sessionId === sessionRef.current) refreshFromSnapshot(snap);
    });
  }, [connRef, sessionRef, refreshFromSnapshot]);
  /** side 快照并入主投影(2026-11-07「辅助投影挂主对话下」持久化面):重启后 live 帧不会回放,
   *  开会话/辅助页签对账落定即对本主会话名下每个 side 快照做并集合并——任务/委派按 id、
   *  teams 按 teamId、成员按名去重,团队板/待办跨重启仍在 */
  const mergeSideSnapshot = useCallback((snap: SnapshotResponse): void => {
    setProjection((p) => {
      const board = { ...p.board, tasks: { ...p.board.tasks, ...(snap.board?.tasks ?? {}) }, seq: Math.max(p.board.seq, snap.board?.seq ?? 0) };
      const delSeen = new Set(p.delegations.map((d) => d.id));
      const delegations = [...p.delegations, ...(snap.delegations ?? []).filter((d) => !delSeen.has(d.id))];
      let teams = p.teams;
      for (const t of snap.teams ?? []) teams = upsertBoardTeam(teams, t);
      const memSeen = new Set(p.team.map((m) => m.name));
      const team = [...p.team, ...(snap.team ?? []).filter((m) => !memSeen.has(m.name))];
      return { ...p, board, delegations, teams, team };
    });
  }, [setProjection]);
  // 拉取时机:开会话变化/辅助对账落定(sideListing 更新)——side 父表两路(fork/恢复)填充后再拉
  const sideSeedDoneRef = useRef(new Set<string>());
  useEffect(() => {
    if (openSessionId === '' || connRef.current === null) return;
    const sides = [...sideParentRef.current.entries()].filter(([, parent]) => parent === openSessionId).map(([sid]) => sid).filter((sid) => !sideSeedDoneRef.current.has(sid));
    if (sides.length === 0) return;
    for (const sid of sides) sideSeedDoneRef.current.add(sid);
    let alive = true;
    const conn = connRef.current;
    void Promise.all(sides.map((sid) => conn.sessionSnapshot(sid).catch(() => null))).then((snaps) => {
      if (!alive) return;
      for (const snap of snaps) if (snap !== null) mergeSideSnapshot(snap);
    });
    return () => {
      alive = false;
    };
  }, [openSessionId, sideListing, mergeSideSnapshot, connRef, sideParentRef]);
  /** memo 值面(2026-11-16 流畅轮):ChatMemo/TabStripMemo 下发的派生数值——useMemo 免内联重建 */
  const bgRunningCount = useMemo(() => bgTasks.filter((r) => r.status === 'running').length, [bgTasks]);
  const projectNameOfOpenRoot = useMemo(
    () => (openRoot !== '' ? pathBasename(openRoot.replace(/[\/]+$/, '')) : undefined),
    [openRoot],
  );

  const services = useMemo<TabServices>(
    () => ({
      board: projection.board, delegations: [...projection.delegations], team: [...projection.team], teams: projection.teams, onStopTask: stopTask, onTabMeta, onActivateTab,
      // 子智能体桶并入 side 会话(2026-11-07「辅助投影挂主对话下」):side 会话跑的子智能体转录
      // 在主会话开签也有数据;onTodoBatches 下发=辅助待办批次同收主待办页签
      agentActivities: (() => {
        const merged = { ...(agentActivitiesBySession[openSessionId] ?? {}) };
        for (const [sid, parent] of sideParentRef.current) {
          if (parent !== openSessionId) continue;
          for (const [label, acts] of Object.entries(agentActivitiesBySession[sid] ?? {})) {
            const prev = merged[label];
            merged[label] = prev === undefined ? acts : { ...prev, ...acts };
          }
        }
        return merged;
      })(), todos: [...projection.sessionTodos], onTodoBatches: setTodoBatches,
      // 待办=权威播种+转录派生合并后**按标题跨轮归并**（2026-11-25「一个待办跨多轮」:
      // 同标题更新收敛同一待办，首写 key/ts 落定；末位=最近更新的待办）
      todoBatches: mergeTodoBatches([...seededTodoBatches, ...todoBatches]),
      taskFocus, onOpenTask: openTaskFocus, todoLocateSig,
      onOpenLeader: openLeaderBubble,
      refreshBoard,
      bgTasks,
      onRefreshBgTasks: (): Promise<void> =>
        connRef.current === null
          ? Promise.resolve()
          : connRef.current.sessionTasks(openSessionId).then((rows) => setBgTasks(rows)),
    }),
    [projection, stopTask, onTabMeta, agentActivitiesBySession, openSessionId, todoBatches, seededTodoBatches, taskFocus, openTaskFocus, todoLocateSig, refreshBoard, bgTasks, sideParentRef.current.size, openLeaderBubble],
  );
  return { onActivateTab, onTabMeta, services, bgRunningCount, projectNameOfOpenRoot };
}
