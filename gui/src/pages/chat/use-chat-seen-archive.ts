import { useCallback, useEffect, useRef } from 'react';
import { autoSeenSuppressed, stampSeen } from '../../sidebar/project-menu-util';
import { SESSION_ARCHIVE_CHANGED_EVENT, type SessionArchiveChange } from '../../session-events';
import type { ChatProps } from './chat-types';

/**
 * 归档/已读联动簇(Chat 外提,D62 批I):onArchive=归档/撤销归档(2026-10-21 T5)——conn
 * .archiveSession 落 daemon + 本地 archived 即时换面;失败回摆(409 running 等不静默驻留假态),
 * 下次 reseed 快照再权威对齐;错误经 onOpError(App showOpError 通道,与 fork/rewind 同一错误条)
 * 上屏。他处入口(侧栏行/归档层撤销钮等)改归档态:顶栏徽标随事件同步(寻址 id 可能是运行时 id
 * 或 journalId)。运行收束即压已读(2026-10-23 用户裁定)+ journalId 到位即压已读(2026-11-07
 * 用户实测「欢迎页升级首条完成仍亮未读」根修)——回调经 ref 读取、不入 effect 依赖:压读成功即
 * 上抛 → 宿主 bump → 重渲染,宿主回调身份若随渲染变化,入依赖即「压读→重渲染→再压读」死循环。
 */
export function useChatSeenArchive({ conn, sessionId, journalId, running, setArchived, onOpError, onSessionsMutated }: {
  conn: ChatProps['conn'];
  sessionId: string;
  journalId: string | undefined;
  running: boolean;
  setArchived: (v: boolean) => void;
  onOpError: ((err: unknown) => void) | undefined;
  onSessionsMutated: (() => void) | undefined;
}): { onArchive: (v: boolean) => void } {
  /** 归档/撤销归档(2026-10-21 T5):conn.archiveSession 落 daemon + 本地 archived 即时换面;
   *  失败回摆(409 running 等不静默驻留假态),下次 reseed 快照再权威对齐;错误经 onOpError
   *  (App showOpError 通道,与 fork/rewind 同一错误条)上屏——静默失败病根修复(终审 F4) */
  const onArchive = useCallback((v: boolean): void => {
    setArchived(v);
    conn.archiveSession(sessionId, v).then(
      () => onSessionsMutated?.(), // 落库后再上抛联动——落库前上抛,侧栏归档聚合读到旧档
      (err: unknown) => {
        setArchived(!v);
        onOpError?.(err);
      },
    );
  }, [conn, sessionId, onOpError, onSessionsMutated, setArchived]);
  // 他处入口(侧栏行/归档层撤销钮等)改归档态:顶栏徽标随事件同步。寻址 id 可能是运行时 id 或 journalId
  useEffect(() => {
    const onChanged = (e: Event): void => {
      const { id, archived: v } = (e as CustomEvent<SessionArchiveChange>).detail;
      if (id === sessionId || (journalId !== undefined && journalId !== '' && id === journalId)) setArchived(v);
    };
    window.addEventListener(SESSION_ARCHIVE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SESSION_ARCHIVE_CHANGED_EVENT, onChanged);
  }, [sessionId, journalId, setArchived]);

  /** 运行收束即压已读(2026-10-23 用户裁定):打开中的会话跑完,流式内容已尽收眼底,不再重亮未读;
   *  后台会话完成仍按 journal 更新时刻亮真未读(语义保留)。落库后再联动,侧栏重拉读到的才是新档 */
  // 回调经 ref 读取、不入 effect 依赖:压读成功即上抛 → 宿主 bump → 重渲染,宿主回调身份若随渲染
  // 变化,入依赖即「压读→重渲染→再压读」死循环(2026-11-07 实测 8.6 次/秒,主线程与连接池双占满)
  const onSessionsMutatedRef = useRef(onSessionsMutated);
  onSessionsMutatedRef.current = onSessionsMutated;
  const prevRunningRef = useRef(running);
  useEffect(() => {
    const was = prevRunningRef.current;
    prevRunningRef.current = running;
    if (!was || running || journalId === undefined || journalId === '') return;
    if (autoSeenSuppressed(journalId)) return; // 显式标记未读压制旗:蓝点亮到再次进入为止
    const done = (): void => onSessionsMutatedRef.current?.();
    void stampSeen(conn, journalId, Date.now()).then(done, done);
  }, [running, journalId, conn]);
  // journalId 到位即压已读(2026-11-07 用户实测「欢迎页升级首条完成仍亮未读」根修):升级链
  // journalId 晚到(晚于首轮收束)——上一 effect 因 journalId 空恒跳过。本会话在座(本组件即打开面),
  // journal 一旦寻得即刻压已读,与运行收束压读同语义。每个 journalId 只压一次
  useEffect(() => {
    if (journalId === undefined || journalId === '') return;
    if (autoSeenSuppressed(journalId)) return; // 显式标记未读压制旗:蓝点亮到再次进入为止
    const done = (): void => onSessionsMutatedRef.current?.();
    void stampSeen(conn, journalId, Date.now()).then(done, done);
  }, [journalId, conn]);
  return { onArchive };
}
