import { useCallback, useEffect, useState } from 'react';
import type { SessionRow } from '../connection';
import { autoSeenSuppressed, loadSeenMap, persistSeenMap } from './project-menu-util';
import type { SeenMap } from './project-menu-util';

/** 已读档连接面(结构满足即收;App 实传整只 Connection 运行时满足) */
export interface MenuSeenConn {
  appSeen(): Promise<{ seen: Record<string, number> }>;
  saveAppSeen(seen: Record<string, number>): Promise<void>;
}

/**
 * 侧栏已读档+journal 映射簇(ProjectMenu 外提,D62 批J):seenMap=localStorage 即时面+
 * /app/seen 服务端权威双写收敛(id → 最近已读 updatedAt);isUnseen=行 updatedAt 新于已读时刻
 * 即未读;markSeen=已读压戳(本地落档+远端 fire-and-forget,断链/旧桩静默);loadSeen=装载
 * (localStorage 先行,服务端应答落定接管并回写本地镜像;挂载与 recentVersion bump 各拉一次);
 * journalOfSession=attach 时记下的会话 id → journal 行 id 映射(行 active 只亮当前打开会话
 * 对应 journal 行,root 兜底退役);正在看的会话跑完自动已读(markUnread 抑制旗在场则让位)。
 */
export function useMenuSeen(conn: MenuSeenConn, sessions: SessionRow[] | null, activeSessionId: string): {
  seenMap: SeenMap;
  isUnseen: (id: string, updatedAt: number) => boolean;
  markSeen: (id: string, updatedAt: number) => void;
  markJournal: (sessionId: string, journalId: string) => void;
  loadSeen: () => void;
  journalOfSession: ReadonlyMap<string, string>;
} {
  /** 已读会话映射(2026-10-23 落底层——用户裁定:刷新/跨端不再全员未读):localStorage 即时面
   *  + /app/seen 服务端权威双写收敛;id → 最近已读 updatedAt */
  const [seenMap, setSeenMap] = useState<SeenMap>(() => loadSeenMap());
  /** 未读判定:行 updatedAt 新于已读时刻即未读(2026-11-16 流畅轮:useCallback 恒稳——memo 分区判等面) */
  const isUnseen = useCallback((id: string, updatedAt: number): boolean => (seenMap[id] ?? -1) < updatedAt, [seenMap]);
  /** 已读档远端写(fire-and-forget):旧 daemon/测试桩未实现即静默跳过(探活口径同 sessionTasks) */
  const saveSeenRemote = useCallback((m: SeenMap): void => {
    if (typeof conn.saveAppSeen !== 'function') return;
    void conn.saveAppSeen(m).then(() => undefined, () => undefined);
  }, [conn]);
  const markSeen = useCallback((id: string, updatedAt: number): void =>
    setSeenMap((prev) => {
      if ((prev[id] ?? -1) >= updatedAt) return prev;
      const next = { ...prev, [id]: updatedAt };
      persistSeenMap(next);
      saveSeenRemote(next); // 落底层(服务端权威+跨端共用;断链静默保持本地面)
      return next;
    }), [saveSeenRemote]);
  /** 已读档装载:localStorage 即时面先行,服务端应答落定即接管并回写本地镜像(跨端权威收敛;
   *  断链/旧 daemon 保持本地不回退)。挂载与 recentVersion bump 各拉一次(bump 后服务端已
   *  收到标记为未读的 PUT,联动重拉读到的就是新档) */
  const loadSeen = useCallback((): void => {
    setSeenMap(loadSeenMap());
    if (typeof conn.appSeen !== 'function') return;
    conn.appSeen().then(
      (r) => {
        setSeenMap(r.seen);
        persistSeenMap(r.seen);
      },
      () => undefined,
    );
  }, [conn]);
  /** 会话 id → journal 行 id 映射(attach 时记下):行 active 只亮当前打开会话对应的 journal 行,
   *  不再用 root 兜底(兜底会把同组所有行全点亮,看起来像误 hover) */
  const [journalOfSession, setJournalOfSession] = useState<ReadonlyMap<string, string>>(() => new Map());
  /** 正在看的会话跑完自动已读(2026-10-28 用户裁定):行刷新后,当前打开会话对应行的
   *  updatedAt 新于已读戳即补戳(markSeen 自守恒)——蓝点只亮「非当前会话的新活动」 */
  useEffect(() => {
    if (activeSessionId === '' || sessions === null) return;
    const sr = sessions.find(
      (s) => s.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === s.id,
    );
    // 显式标记未读抑制(2026-11-07 用户实测「标记未读左栏不亮蓝点」):顶栏 markUnread 落抑制
    // 旗,本 effect 不再补戳——蓝点亮到用户再次进入该会话(openSession 清旗)为止
    if (sr !== undefined && !autoSeenSuppressed(sr.id) && isUnseen(sr.id, sr.updatedAt)) markSeen(sr.id, sr.updatedAt);
  }, [sessions, activeSessionId, journalOfSession, isUnseen, markSeen]);

  const markJournal = useCallback((sessionId: string, journalId: string): void =>
    setJournalOfSession((prev) => {
      if (prev.get(sessionId) === journalId) return prev;
      const next = new Map(prev);
      next.set(sessionId, journalId);
      return next;
    }), []);

  return { seenMap, isUnseen, markSeen, markJournal, loadSeen, journalOfSession };
}
