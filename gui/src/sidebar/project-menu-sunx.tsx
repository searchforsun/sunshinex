/**
 * SUNX 过滤组（2026-11-26 群组规格 §6）：SUNX 组头 → 群组行（二级）→ 实例行（三级）。
 * 群行右侧「进入群聊」「在本群新建」；SUNX 组头「新建群组」（新建 Sunx 入口在顶部快捷区/群行）。
 * 纯渲染件：群/行/动作全部 props 注入；折叠态本组件自持并持久化。
 */
import { memo, useMemo, useState } from 'react';
import type { SessionRow, SunxGroupRow } from '../connection';
import { t, useLanguage } from '../i18n';
import { Archive, ChevronRight, FolderPlus, KanbanSquare, MessagesSquare } from 'lucide-react';
import { SunxIcon } from '../sunx-icon';
import { SessionRow as SessionRowView, SortPop, useConfirmOutsideCancel } from './project-menu-util';

const COLLAPSED_KEY = 'sunshinex.sunx-groups.collapsed';
const DEFAULT_GROUP_ID = 'grp_default';

function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    // 本地持久化失败只影响下次默认展开
  }
}

interface SunxSectionProps {
  readonly rows: Array<SessionRow & { root: string; slug: string }> | null;
  /** 群列表（null=装载中/旧 daemon 降级：合成默认群）；空数组=旧 daemon，仅一个默认群 */
  readonly groups?: SunxGroupRow[] | null;
  readonly activeSessionId: string;
  readonly runningIds: ReadonlySet<string>;
  readonly journalOfSession: ReadonlyMap<string, string>;
  readonly isUnseen: (id: string, updatedAt: number) => boolean;
  readonly busy: boolean;
  readonly onAttach: (root: string, journalId: string, journalUpdatedAt?: number) => void;
  readonly onArchiveRow: (id: string, archived: boolean) => void;
  readonly onOpenBoard?: () => void;
  readonly onNewGroup?: () => void;
  readonly onNewSunxInGroup?: (groupId: string) => void;
  readonly onOpenGroupChat?: (groupId: string) => void;
  readonly activeSunxGroupId?: string;
  readonly onOpenArchive?: () => void;
}

interface GroupView {
  id: string;
  name: string;
  isDefault: boolean;
  members: Array<SessionRow & { root: string; slug: string }>;
}

export const SunxSection = memo(function SunxSection(props: SunxSectionProps): JSX.Element | null {
  useLanguage();
  const {
    rows, groups = null, activeSessionId, runningIds, journalOfSession, isUnseen, busy,
    onAttach, onArchiveRow, onOpenBoard, onNewGroup, onNewSunxInGroup, onOpenGroupChat, activeSunxGroupId, onOpenArchive,
  } = props;
  const [sortMode, setSortMode] = useState<'updated' | 'name'>('updated');
  const [sortOpen, setSortOpen] = useState(false);
  const [open, setOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [confirmId, setConfirmId] = useState('');
  useConfirmOutsideCancel(confirmId, () => setConfirmId(''));

  const visibleRows = useMemo(() => (rows === null ? null : rows.filter((r) => r.archived !== true)), [rows]);

  const groupViews = useMemo<GroupView[]>(() => {
    const base: GroupView[] = [];
    const seen = new Set<string>();
    const add = (id: string, name: string, isDefault: boolean): void => {
      if (seen.has(id)) return;
      seen.add(id);
      base.push({ id, name, isDefault, members: [] });
    };
    if (groups !== null && groups.length > 0) {
      for (const g of groups) add(g.id, g.isDefault === true && g.name === '默认群组' ? t('Default group', '默认群组') : g.name, g.isDefault === true);
    } else {
      add(DEFAULT_GROUP_ID, t('Default group', '默认群组'), true);
    }
    for (const r of visibleRows ?? []) {
      const gid = r.groupId !== undefined && r.groupId !== '' ? r.groupId : DEFAULT_GROUP_ID;
      if (!seen.has(gid)) add(gid, gid, false);
    }
    const byId = new Map(base.map((g) => [g.id, g]));
    for (const r of visibleRows ?? []) {
      const gid = r.groupId !== undefined && r.groupId !== '' ? r.groupId : DEFAULT_GROUP_ID;
      byId.get(gid)?.members.push(r);
    }
    for (const g of base) {
      if (sortMode === 'name') g.members.sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id));
      else g.members.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return base;
  }, [groups, sortMode, t, visibleRows]);

  const total = visibleRows?.length ?? 0;

  const toggleGroup = (gid: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      writeCollapsed(next);
      return next;
    });
  };

  return (
    <>
      <div
        className="sx-side-head sx-side-head-row sx-side-head-btn"
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span>{t('SUNX', 'SUNX')}</span>
        <ChevronRight size={14} strokeWidth={2} aria-hidden="true" className={`sx-side-chev${open ? ' open' : ''}`} />
        <span className="sx-side-head-actions">
          {visibleRows !== null && <span className="sx-sunx-count" aria-label="sunx count">{total}</span>}
          {onOpenBoard !== undefined && (
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="sunx board"
              data-tip={t('Sunx board', 'Sunx 看板')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onOpenBoard(); }}
            >
              <KanbanSquare size={14} strokeWidth={1.75} />
            </button>
          )}
          <SortPop
            open={sortOpen}
            ariaLabel={t('Sort Sunx', 'Sunx 排序')}
            buttonLabel="sort sunx"
            items={[
              { mode: 'updated', label: t('By recent activity', '按最近活动') },
              { mode: 'name', label: t('By name', '按名称') },
            ]}
            mode={sortMode}
            onPick={(m) => { setSortMode(m); setSortOpen(false); }}
            onClose={() => setSortOpen(false)}
            onToggle={() => setSortOpen((v) => !v)}
            buttonMouseDown={(e) => e.stopPropagation()}
          />
          {onOpenArchive !== undefined && (
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="archive sunx"
              data-tip={t('Archive Sunx', '归档 Sunx')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onOpenArchive(); }}
            >
              <Archive size={14} strokeWidth={1.75} />
            </button>
          )}
          {onNewGroup !== undefined && (
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="new group"
              data-tip={t('New group', '新建群组')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onNewGroup(); }}
            >
              <FolderPlus size={14} strokeWidth={1.75} />
            </button>
          )}
        </span>
      </div>
      <div className={`sx-collapse sx-collapse-sunx${open ? ' open' : ''}`}>
        {rows !== null && (
        <ul className="sx-sunx-groups" aria-label="sunx sessions">
        {groupViews.map((g) => {
          const groupOpen = !collapsed.has(g.id);
          return (
            <li className="sx-sunx-group" key={g.id}>
              <div
                className={`sx-sunx-group-head${activeSunxGroupId === g.id ? ' active' : ''}`}
                role="button"
                aria-expanded={groupOpen}
                tabIndex={0}
                onClick={() => toggleGroup(g.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleGroup(g.id);
                  }
                }}
              >
                <ChevronRight size={14} strokeWidth={2} className={`sx-side-chev${groupOpen ? ' open' : ''}`} aria-hidden="true" />
                <MessagesSquare size={14} strokeWidth={1.75} aria-hidden="true" className="sx-sunx-group-icon" />
                <span className="sx-sunx-group-name">{g.name}</span>
                <span className="sx-sunx-count">{g.members.length}</span>
                <span className="sx-side-head-actions">
                  {onOpenGroupChat !== undefined && (
                    <button
                      type="button"
                      className="sx-iconbtn"
                      aria-label="open group chat"
                      data-tip={t('Open group chat', '进入群聊')}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onOpenGroupChat(g.id); }}
                    >
                      <MessagesSquare size={14} strokeWidth={1.75} />
                    </button>
                  )}
                  {onNewSunxInGroup !== undefined && (
                    <button
                      type="button"
                      className="sx-iconbtn"
                      aria-label="new sunx in group"
                      data-tip={t('New Sunx in this group', '在本群新建 Sunx')}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onNewSunxInGroup(g.id); }}
                    >
                      <SunxIcon size={14} strokeWidth={1.75} />
                    </button>
                  )}
                </span>
              </div>
              {groupOpen && (
                <ul className="recent-list sx-sunx-group-rows" aria-label={`sunx group ${g.name}`}>
                  {g.members.length === 0 && <li className="no-sessions">{t('No Sunx yet', '暂无Sunx')}</li>}
                  {g.members.map((sr) => {
                    const active =
                      activeSessionId !== '' &&
                      (sr.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === sr.id);
                    const running = active
                      ? runningIds.has(activeSessionId)
                      : sr.liveSessionId !== undefined && sr.liveSessionId !== activeSessionId;
                    const label = sr.title ?? sr.firstUser ?? t('New session', '新会话');
                    return (
                      <SessionRowView
                        key={sr.id}
                        rowId={sr.id}
                        label={label}
                        info={{ runs: sr.runs, steps: sr.steps, createdAt: sr.createdAt, rootPath: sr.root }}
                        updatedAt={sr.updatedAt}
                        active={active}
                        running={running}
                        awaiting={sr.awaiting === true}
                        unseen={isUnseen(sr.id, sr.updatedAt)}
                        busy={busy}
                        onOpen={() => onAttach(sr.root, sr.id, sr.updatedAt)}
                        confirmId={confirmId}
                        onArm={() => setConfirmId(sr.id)}
                        onConfirm={() => { setConfirmId(''); onArchiveRow(sr.id, true); }}
                      />
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
        </ul>
        )}
      </div>
    </>
  );
});
