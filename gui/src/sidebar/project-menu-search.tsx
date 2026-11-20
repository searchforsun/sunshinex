import { useRef, useState } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { relTime } from '../ui-util';
import { t } from '../i18n';
import { Folder } from 'lucide-react';
import { fuzzyHit, sessionMetaLine, wsName } from './project-menu-util';
import { SearchCatBar, SearchSectionHead, useSearchListNav } from '../search-kit';

/** 分类过滤(搜索框下常驻三档) */
type SearchCat = 'all' | 'project' | 'session';

type SessionHit = SessionRow & { root: string; slug: string };
type SearchEntry = { readonly kind: 'project'; readonly row: WorkspaceRow } | { readonly kind: 'session'; readonly row: SessionHit };

/** 查找面板(G10-C13):品牌行查找钮开的项目+会话聚合搜索弹层(D32 批PM-2 自 ProjectMenu
 *  平移,行为零变化)。纯渲染件:数据/动作经 props 注入(attachJournal/isUnseen 为宿主闭包,
 *  原样回调传入);开关态留宿主(searchOpen),本件只渲染弹层面。
 *  2026-11-21 用户裁定「各个类型的所有搜索框下边可以置顶分类,搜索出来内容可以进行合理跳转」:
 *  搜索框下常驻 全部/项目/会话 分类条(带条数),结果分组头在滚动面内吸顶;↑↓/Home/End 移动
 *  + Enter 直达(会话→附接打开,项目→回欢迎页预选该项目);宽度随主会话列宽(--chat-max)伸缩。 */
export interface ProjectSearchProps {
  readonly rows: WorkspaceRow[] | null;
  readonly allSessions: ReadonlyArray<SessionHit> | null;
  readonly query: string;
  readonly onQuery: (q: string) => void;
  readonly onClose: () => void;
  readonly activeSessionId: string;
  readonly runningIds: ReadonlySet<string>;
  readonly journalOfSession: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly isUnseen: (id: string, updatedAt: number) => boolean;
  readonly onAttach: (root: string, journalId: string, journalUpdatedAt?: number) => void;
  readonly onComposeIn: (root: string) => void;
}

export function ProjectSearch(props: ProjectSearchProps): JSX.Element {
  const { rows, allSessions, query, onQuery, onClose, activeSessionId, runningIds, journalOfSession, busy, isUnseen, onAttach, onComposeIn } = props;
  /** 分类态:切换即回焦点到搜索框,键盘流不断(↑↓ 仍可直达结果) */
  const [cat, setCat] = useState<SearchCat>('all');
  const inputRef = useRef<HTMLInputElement>(null);
  const projects = (rows ?? []).filter((r) => fuzzyHit(wsName(r) + ' ' + r.slug, query));
  const sessions = (allSessions ?? [])
    .filter((r) => fuzzyHit((r.title ?? r.firstUser ?? '') + ' ' + r.id, query))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20);
  const showProjects = cat !== 'session';
  const showSessions = cat !== 'project';
  const entries: SearchEntry[] = [
    ...(showProjects ? projects.map((row): SearchEntry => ({ kind: 'project', row })) : []),
    ...(showSessions ? sessions.map((row): SearchEntry => ({ kind: 'session', row })) : []),
  ];
  const pick = (index: number): void => {
    const entry = entries[index];
    if (entry === undefined) return;
    if (entry.kind === 'project') {
      if (entry.row.root !== undefined) onComposeIn(entry.row.root);
      onClose();
      return;
    }
    if (busy) return;
    onAttach(entry.row.root, entry.row.id, entry.row.updatedAt);
    onClose();
  };
  const nav = useSearchListNav({ count: entries.length, onPick: pick, resetKey: query + '|' + cat });
  const sessionOffset = showProjects ? projects.length : 0;
  const pickCat = (id: string): void => {
    setCat(id as SearchCat);
    inputRef.current?.focus(); // 分类条点击后焦点回搜索框:方向键/Enter 连续可用
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="sx-search-modal"
        role="search"
        aria-label={t('Search projects & sessions', '搜索项目与会话')}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          autoFocus
          value={query}
          placeholder={t('Search projects & sessions', '搜索项目与会话…')}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onClose();
              return;
            }
            nav.onKeyDown(e);
          }}
        />
        <SearchCatBar
          cats={[
            { id: 'all', en: 'All', zh: '全部', count: entries.length },
            { id: 'project', en: 'Projects', zh: '项目', count: projects.length },
            { id: 'session', en: 'Sessions', zh: '会话', count: allSessions === null ? undefined : sessions.length },
          ]}
          active={cat}
          onPick={pickCat}
        />
        <div className="sx-search-modal-list">
          {showProjects && (
            <>
              <SearchSectionHead label={t('Projects', '项目')} count={projects.length} />
              {projects.map((r, i) => (
                <button
                  key={r.slug}
                  ref={i === nav.active ? nav.activeRef : undefined}
                  type="button"
                  className={`sx-search-row${i === nav.active ? ' active' : ''}`}
                  onMouseEnter={() => nav.setActive(i)}
                  onClick={() => pick(i)}
                >
                  <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span className="sx-search-label">{wsName(r)}</span>
                  <span className="sx-search-meta">{r.sessionCount}</span>
                </button>
              ))}
              {projects.length === 0 && <div className="sx-search-empty">{t('No matching projects', '无匹配项目')}</div>}
            </>
          )}
          {showSessions && (
            <>
              <SearchSectionHead label={t('Sessions', '会话')} count={sessions.length} />
              {allSessions === null && <div className="sx-search-empty">{t('Loading sessions…', '正在加载会话…')}</div>}
              {sessions.map((r, i) => {
                const index = sessionOffset + i;
                // G14.2xx running 身份按会话记(runningIds 含本行映射会话);他会话看 daemon 标注
                const isMapped = r.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === r.id;
                const running = isMapped ? runningIds.has(activeSessionId) : r.liveSessionId !== undefined;
                const label = r.title ?? r.firstUser ?? t('New session', '新会话');
                const metaLine = sessionMetaLine(r);
                return (
                  <button
                    key={r.root + '/' + r.id}
                    ref={index === nav.active ? nav.activeRef : undefined}
                    type="button"
                    className={`sx-search-row${index === nav.active ? ' active' : ''}`}
                    data-tip={`${label}${metaLine !== '' ? `\n${metaLine}` : ''}`}
                    onMouseEnter={() => nav.setActive(index)}
                    onClick={() => pick(index)}
                  >
                    {running ? (
                      <span className="sx-session-dot running" />
                    ) : isUnseen(r.id, r.updatedAt) ? (
                      <span className="sx-session-dot unseen" />
                    ) : null}
                    <span className="sx-search-label">{label}</span>
                    <span className="sx-search-meta">{relTime(r.updatedAt)}</span>
                  </button>
                );
              })}
              {allSessions !== null && sessions.length === 0 && <div className="sx-search-empty">{t('No matching sessions', '无匹配会话')}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
