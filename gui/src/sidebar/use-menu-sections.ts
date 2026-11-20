import { useCallback, useMemo, useState } from 'react';
import { listShallowEqual, RECENT_VISIBLE_DEFAULT, RECENT_VISIBLE_STEP } from './project-menu-util';
import type { ArchivedRow } from './archive-group';
import { pinFromRow, type PinEntry } from './pin-store';

/** 归档区连接面(结构满足即收;App 实传整只 Connection 运行时满足) */
interface MenuArchiveConn {
  archivedSessions(): Promise<ArchivedRow[]>;
}

/** 最近会话显形簇(ProjectMenu 外提,D62 批J):分区折叠开合+逐步显形(默认 10 条,「显示更多」
 *  每次 +10,「收起」/折叠复位)。recents 仅供「显示更多」上界取行数。 */
export function useMenuRecentsDisplay(recents: Array<{ id: string }> | null): {
  recentsOpen: boolean;
  recentLimit: number;
  toggleRecents: () => void;
  recentsShowMore: () => void;
  recentsCollapse: () => void;
} {
  const [recentsOpen, setRecentsOpen] = useState(true);
  /** G14.115 最近会话逐步显形:默认 10 条,「显示更多」每次多放 10 条,「收起」/分区折叠复位 */
  const [recentLimit, setRecentLimit] = useState(RECENT_VISIBLE_DEFAULT);
  const toggleRecents = useCallback((): void => {
    setRecentsOpen((v) => !v);
    setRecentLimit(RECENT_VISIBLE_DEFAULT); // G14.115 折叠再展开回默认显形
  }, []);
  const recentsShowMore = useCallback((): void => setRecentLimit((v) => Math.min(v + RECENT_VISIBLE_STEP, recents?.length ?? v)), [recents]);
  const recentsCollapse = useCallback((): void => setRecentLimit(RECENT_VISIBLE_DEFAULT), []);
  return { recentsOpen, recentLimit, toggleRecents, recentsShowMore, recentsCollapse };
}

/**
 * 归档会话区簇(ProjectMenu 外提,D62 批J;2026-10-21 用户裁定:归档视图在左侧菜单栏,非右侧
 * 主对话页):开合态+跨工作区聚合行(GET /sessions/archived,浅等守卫保引用)+装载器+三入口
 * (带重拉开层/纯开层/退层)。
 */
export function useMenuArchive(conn: MenuArchiveConn): {
  archiveOpen: boolean;
  setArchiveOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  archivedRows: ArchivedRow[] | null;
  loadArchived: () => void;
  openArchivedWithReload: () => void;
  openArchiveView: () => void;
  exitArchiveView: () => void;
} {
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivedRows, setArchivedRows] = useState<ArchivedRow[] | null>(null);
  const loadArchived = useCallback((): void => {
    conn.archivedSessions().then(
      (list) => setArchivedRows((prev) => (listShallowEqual(prev, list) ? prev : list)),
      () => setArchivedRows([]),
    );
  }, [conn]);
  const openArchivedWithReload = useCallback((): void => {
    setArchiveOpen(true);
    loadArchived();
  }, [loadArchived]);
  const openArchiveView = useCallback((): void => setArchiveOpen(true), []);
  const exitArchiveView = useCallback((): void => setArchiveOpen(false), []);
  return { archiveOpen, setArchiveOpen, archivedRows, loadArchived, openArchivedWithReload, openArchiveView, exitArchiveView };
}

/**
 * 置顶会话簇(ProjectMenu 外提,D62 批J;2026-10-21 用户裁定,GUI 专属):钉存 userConfigDir/gui/
 * pins.json(GET/PUT /app/pins,桌面壳与浏览器同 daemon 同享;TUI 无此概念不进共享会话档)。
 * pinSessionRow=会话行置顶钮消费面:行快照 → 钉条目入列(Projects/Recents 两组行共用)——
 * D49④ seen 对齐:置顶即压已读戳到钉档同一时刻,与顶栏置顶同一不变量(钉组按钉档 updatedAt
 * 判未读,侧栏路径漏压=「钉组恒亮蓝点」实测病的同源分叉);已读则 no-op(markSeen 自守恒)。
 * pins/persistPins 自 App 单源下传(2026-11-07 置顶卡顿根修:顶栏/侧栏共享乐观态,点击零往返)。
 */
export function useMenuPins(pins: PinEntry[], persistPins: (next: PinEntry[]) => void, markSeen: (id: string, updatedAt: number) => void): {
  pinSessionRow: (row: { id: string; root: string; title?: string; updatedAt: number; kind?: string }) => void;
  unpinRow: (id: string) => void;
  pinnedIds: ReadonlySet<string>;
} {
  const pinRow = useCallback((row: PinEntry): void => {
    if (pins.some((p) => p.id === row.id)) return;
    persistPins([row, ...pins]); // 新钉居前
  }, [pins, persistPins]);
  const pinSessionRow = useCallback(
    (row: { id: string; root: string; title?: string; updatedAt: number; kind?: string }): void => {
      pinRow(pinFromRow(row)); // kind 随行(sunx P2 Task 7 徽标快照透传)
      markSeen(row.id, row.updatedAt);
    },
    [pinRow, markSeen],
  );
  const unpinRow = useCallback((id: string): void => {
    persistPins(pins.filter((p) => p.id !== id));
  }, [pins, persistPins]);
  const pinnedIds = useMemo(() => new Set(pins.map((p) => p.id)), [pins]);
  return { pinSessionRow, unpinRow, pinnedIds };
}
