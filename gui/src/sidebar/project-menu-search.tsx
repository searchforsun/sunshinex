import type { SessionRow, WorkspaceRow } from '../connection';
import { relTime } from '../ui-util';
import { t } from '../i18n';
import { Folder } from 'lucide-react';
import { fuzzyHit, sessionMetaLine, wsName } from './project-menu-util';

/** 查找面板(G10-C13):品牌行查找钮开的项目+会话聚合搜索弹层(D32 批PM-2 自 ProjectMenu
 *  平移,行为零变化)。纯渲染件:数据/动作经 props 注入(attachJournal/isUnseen 为宿主闭包,
 *  原样回调传入);开关态留宿主(searchOpen),本件只渲染弹层面。 */
export interface ProjectSearchProps {
  readonly rows: WorkspaceRow[] | null;
  readonly allSessions: Array<SessionRow & { root: string; slug: string }> | null;
  readonly query: string;
  readonly onQuery: (q: string) => void;
  readonly onClose: () => void;
  readonly activeSessionId: string;
  readonly runActive: boolean;
  readonly journalOfSession: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly isUnseen: (id: string, updatedAt: number) => boolean;
  readonly onAttach: (root: string, journalId: string, journalUpdatedAt?: number) => void;
  readonly onComposeIn: (root: string, mode?: 'auto' | 'manual') => void;
}

export function ProjectSearch(props: ProjectSearchProps): JSX.Element {
  const { rows, allSessions, query, onQuery, onClose, activeSessionId, runActive, journalOfSession, busy, isUnseen, onAttach, onComposeIn } = props;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="sx-search-modal"
        role="search"
        aria-label={t('Search projects & sessions', '搜索项目与会话')}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          placeholder={t('Search projects & sessions', '搜索项目与会话…')}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="sx-search-modal-list">
          <div className="sx-search-sec">{t('Projects', '项目')}</div>
          {(rows ?? [])
            .filter((r) => fuzzyHit(wsName(r) + ' ' + r.slug, query))
            .map((r) => (
              <button
                key={r.slug}
                type="button"
                className="sx-search-row"
                onClick={() => {
                  const row = (rows ?? []).find((x) => x.slug === r.slug);
                  if (row !== undefined && row.root !== undefined) onComposeIn(row.root);
                  onClose();
                }}
              >
                <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                <span className="sx-search-label">{wsName(r)}</span>
                <span className="sx-search-meta">{r.sessionCount}</span>
              </button>
            ))}
          {(rows ?? []).length === 0 && <div className="sx-search-empty">{t('No matching projects', '无匹配项目')}</div>}
          <div className="sx-search-sec">{t('Sessions', '会话')}</div>
          {(allSessions ?? [])
            .filter((r) => fuzzyHit((r.title ?? r.firstUser ?? '') + ' ' + r.id, query))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 20)
            .map((r) => {
              // G14.52 running 身份:活动会话以 runActive 为准(收束即时熄);他会话看 daemon 标注
              const isMapped = r.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === r.id;
              const running = isMapped ? activeSessionId !== '' && runActive : r.liveSessionId !== undefined;
              const label = r.title ?? r.firstUser ?? t('New session', '新会话');
              const metaLine = sessionMetaLine(r);
              return (
                <button
                  key={r.root + '/' + r.id}
                  type="button"
                  className="sx-search-row"
                  data-tip={`${label}${metaLine !== '' ? `
${metaLine}` : ''}`}
                  onClick={() => {
                    if (busy) return;
                    onAttach(r.root, r.id, r.updatedAt);
                    onClose();
                  }}
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
          {(allSessions ?? []).length === 0 && <div className="sx-search-empty">{t('No matching sessions', '无匹配会话')}</div>}
        </div>
      </div>
    </div>
  );
}
