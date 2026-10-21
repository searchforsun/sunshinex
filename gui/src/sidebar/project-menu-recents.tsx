import { useState } from 'react';
import type { SessionRow } from '../connection';
import { relTime } from '../ui-util';
import { t } from '../i18n';
import { Archive, ChevronRight, SquarePen } from 'lucide-react';
import { RECENT_VISIBLE_DEFAULT, sessionMetaLine } from './project-menu-util';

/** RECENTS 区(D32 批PM-4 自 ProjectMenu 平移,行为零变化):分区头(折叠 + 默认工作区✎)
 *  + 最近会话行(G14.52 运行圆点/未读点)+ G14.115 尾行分页(显示更多/收起)。纯渲染件,
 *  数据/动作 props 注入——折叠复位与分页窗留宿主(onToggleRecents/onShowMore/onCollapse)。 */
export interface RecentsSectionProps {
  readonly recentsOpen: boolean;
  readonly onToggleRecents: () => void;
  readonly defaultAnchorRoot: string | undefined;
  readonly onComposeIn: (root: string, mode?: 'auto' | 'manual') => void;
  readonly recents: Array<SessionRow & { root: string; slug: string }> | null;
  readonly recentLimit: number;
  readonly onShowMore: () => void;
  readonly onCollapse: () => void;
  readonly activeSessionId: string;
  readonly runningIds: ReadonlySet<string>;
  readonly journalOfSession: ReadonlyMap<string, string>;
  readonly isUnseen: (id: string, updatedAt: number) => boolean;
  readonly busy: boolean;
  readonly onAttach: (root: string, journalId: string, journalUpdatedAt?: number) => void;
  /** T6 行内归档(落库 + 宿主重拉;确认 morph 由本组件行级 confirmId 承载) */
  readonly onArchiveRow: (id: string, archived: boolean) => void;
}

export function RecentsSection(props: RecentsSectionProps): JSX.Element {
  const { recentsOpen, onToggleRecents, defaultAnchorRoot, onComposeIn, recents, recentLimit, onShowMore, onCollapse, activeSessionId, runningIds, journalOfSession, isUnseen, busy, onAttach, onArchiveRow } = props;
  /** T6 行内归档确认 morph:存确认中的行 id('' = 无;行级单份,他行点击即换位) */
  const [confirmId, setConfirmId] = useState('');
  return (
    <>
        {/* RECENTS 在 PROJECTS 下侧(用户裁定);空态「暂无最近会话」占位 */}
        {/* G14.42:RECENTS 头同 PROJECTS 款——chevron 紧跟标题(hover 显形/点击折叠),✎ 新建默认会话 */}
        <div
          className="sx-side-head sx-side-head-row sx-side-head-btn"
          role="button"
          aria-expanded={recentsOpen}
          tabIndex={0}
          onClick={onToggleRecents}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleRecents();
            }
          }}
        >
          <span>{t('Recents', '最近会话')}</span>
          <ChevronRight
            size={12}
            strokeWidth={2}
            aria-hidden="true"
            className={`sx-side-chev${recentsOpen ? ' open' : ''}`}
          />
          {defaultAnchorRoot !== undefined && (
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="new default chat"
              data-tip={t('New chat in default workspace', '默认工作区新对话')}
              onClick={(e) => {
                e.stopPropagation();
                onComposeIn(defaultAnchorRoot);
              }}
            >
              <SquarePen size={14} strokeWidth={1.75} />
            </button>
          )}
        </div>
        <div className={`sx-collapse sx-collapse-recents${recentsOpen ? ' open' : ''}`}>
        <ul className="recent-list" aria-label="recent sessions">
          {recents !== null && recents.length === 0 && <li className="no-sessions">{t('No recent sessions', '暂无最近会话')}</li>}
          {(recents ?? []).slice(0, recentLimit).map((r) => {
            // G14.2xx running 身份按会话记(runningIds 含本行映射会话);他会话看 daemon 标注
            const active =
              activeSessionId !== '' &&
              (r.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === r.id);
            const running = active
              ? runningIds.has(activeSessionId)
              : r.liveSessionId !== undefined && r.liveSessionId !== activeSessionId;
            const label = r.title ?? r.firstUser ?? t('New session', '新会话');
            const metaLine = sessionMetaLine(r);
            return (
              <li
                key={`${r.root}/${r.id}`}
                className={`session-row sx-session-row${active ? ' active' : ''}`}
                data-session-row="1"
                onClick={() => {
                  if (busy) return;
                  onAttach(r.root, r.id);
                }}
              >
                {running ? (
                  <span className="sx-session-dot running" />
                ) : isUnseen(r.id, r.updatedAt) ? (
                  <span className="sx-session-dot unseen" />
                ) : null}
                <span className="session-summary" data-tip={`${label}${metaLine !== '' ? `\n${metaLine}` : ''}`} data-tip-pos="right">{label}</span>
                <span className="session-meta">{relTime(r.updatedAt)}</span>
                <span className="session-row-actions">
                  {confirmId === r.id ? (
                    <button type="button" className="sx-archive-confirm" aria-label={`${t('Confirm archive', '确认归档')} ${r.id}`}
                      onClick={(e) => { e.stopPropagation(); setConfirmId(''); onArchiveRow(r.id, true); }}>
                      {t('Confirm', '确认')}
                    </button>
                  ) : (
                    <button type="button" className="sx-iconbtn" data-tip={t('Archive', '归档')}
                      aria-label={`${t('Archive', '归档')} ${r.id}`}
                      onClick={(e) => { e.stopPropagation(); setConfirmId(r.id); }}>
                      <Archive size={12} strokeWidth={1.75} />
                    </button>
                  )}
                </span>
              </li>
            );
          })}
          {/* G14.115 尾行分页控件:有藏 >「显示更多」(步进 10);已全放且曾展开 >「收起」复位 */}
          {recents !== null && recents.length > RECENT_VISIBLE_DEFAULT && (
            recents.length > recentLimit ? (
              <li
                key="recent-more"
                className="recent-more"
                role="button"
                tabIndex={0}
                onClick={onShowMore}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onShowMore();
                  }
                }}
              >
                {t('Show more', '显示更多')}
              </li>
            ) : recentLimit > RECENT_VISIBLE_DEFAULT ? (
              <li
                key="recent-less"
                className="recent-more"
                role="button"
                tabIndex={0}
                onClick={onCollapse}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onCollapse();
                  }
                }}
              >
                {t('Collapse', '收起')}
              </li>
            ) : null
          )}
        </ul>
        </div>
    </>
  );
}
