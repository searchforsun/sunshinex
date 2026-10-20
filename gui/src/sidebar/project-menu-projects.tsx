import type { MouseEvent as ReactMouseEvent } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { relTime } from '../ui-util';
import { t } from '../i18n';
import { ChevronRight, Folder, FolderOpen, SquarePen } from 'lucide-react';
import { FolderAddIcon, visibleWorkspaces, wsName } from './project-menu-util';

/** PROJECTS 区(D32 批PM-3 自 ProjectMenu 平移,行为零变化):分区头(折叠 + 添加工作区)
 *  + 工作区组列表(展开惰拉会话/组内行 attach)。纯渲染件,数据/动作 props 注入——
 *  分区折叠与添加工作区在途态(actionError/busy)留宿主。 */
export interface ProjectsSectionProps {
  readonly projectsOpen: boolean;
  readonly onToggleProjects: () => void;
  readonly busy: boolean;
  readonly onAddWorkspace: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly actionError: string;
  readonly rows: WorkspaceRow[] | null;
  readonly listError: string;
  readonly openSlug: string | null;
  readonly sessions: SessionRow[] | null;
  /** G14.2xx 组内会话默认收窄:24h 内活跃全显(上限 10),显示更多放全量,收起复位 */
  readonly groupShowAll: boolean;
  readonly onGroupShowMore: () => void;
  readonly sessionsError: string;
  readonly activeRoot: string;
  readonly activeSessionId: string;
  readonly runningId: string;
  readonly journalOfSession: ReadonlyMap<string, string>;
  readonly isUnseen: (id: string, updatedAt: number) => boolean;
  readonly onToggleGroup: (row: WorkspaceRow) => void;
  readonly onComposeIn: (root: string, mode?: 'auto' | 'manual') => void;
  readonly onAttach: (root: string, journalId: string, journalUpdatedAt?: number) => void;
}

export function ProjectsSection(props: ProjectsSectionProps): JSX.Element {
  const { projectsOpen, onToggleProjects, busy, onAddWorkspace, actionError, rows, listError, openSlug, sessions, sessionsError, activeRoot, activeSessionId, runningId, journalOfSession, isUnseen, onToggleGroup, onComposeIn, onAttach, groupShowAll, onGroupShowMore } = props;
  return (
    <>
        <div
          className="sx-side-head sx-side-head-row sx-side-head-btn"
          role="button"
          aria-expanded={projectsOpen}
          tabIndex={0}
          onClick={onToggleProjects}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleProjects();
            }
          }}
        >
          <span>{t('Projects', '项目')}</span>
          <ChevronRight
            size={12}
            strokeWidth={2}
            aria-hidden="true"
            className={`sx-side-chev${projectsOpen ? ' open' : ''}`}
          />
          <button
            type="button"
            className="sx-iconbtn"
            aria-label="add workspace"
            data-tip={t('Open a folder as workspace', '打开文件夹作为工作区')}
            disabled={busy}
            onClick={onAddWorkspace}
          >
            <FolderAddIcon size={14} />
          </button>
        </div>
        <div className={`sx-collapse${projectsOpen ? ' open' : ''}`}>
          <ul className="workspace-list sx-groups" aria-label="workspace groups">
            {rows === null && listError === '' && <li className="home-loading">{t('Loading workspaces…', '加载工作区…')}</li>}
            {listError !== '' && (
              <li className="home-error" role="alert">
                {listError.startsWith('-> 401')
                  ? t('Token expired — reopen the URL printed by `serve` (or append ?token=<new> to the address)', 'token 已失效——请重新打开 serve 启动时打印的链接(或在地址后追加 ?token=<新 token>)')
                  : listError}
              </li>
            )}
            {rows !== null && rows.length === 0 && (
              <li className="home-empty">{t('No projects yet', '暂无项目')}</li>
            )}
            {actionError !== '' && (
              <li className="home-error" role="alert">
                {actionError}
              </li>
            )}
            {visibleWorkspaces(rows ?? []).map((row) => {
              const root = row.root; // const 捕获:root 收窄可入回调
              // G14.2xx 组内会话默认收窄:默认显 24h 内活跃(最多 10;活跃不足 10 有几条显几条),
              // 「显示更多」放全量、「收起」复位;当前打开的会话恒显(避免点开后从列表消失)
              const now24 = Date.now() - 24 * 60 * 60 * 1000;
              const sorted24 = (sessions ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
              const activeN = sorted24.filter((sr) => sr.updatedAt >= now24).length;
              const defN = Math.min(10, Math.max(activeN, 1));
              const showAll = groupShowAll;
              const isActiveRow = (sr: SessionRow) =>
                activeSessionId !== '' && (sr.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === sr.id);
              const headRows = showAll ? sorted24 : sorted24.slice(0, defN);
              const tailRows = showAll ? [] : sorted24.slice(defN).filter((sr: SessionRow) => isActiveRow(sr));
              const visible = [...headRows, ...tailRows];
              const hidden = sorted24.length - visible.length;
              const groupShowMore = () => onGroupShowMore();
              return (
                <li
                  key={row.slug}
                  className={`workspace-item${root === undefined ? ' no-root' : ''}`}
                  style={{ position: 'relative' }}
                >
                  <div className="workspace-row" style={{ display: 'flex', alignItems: 'center' }}>
                    <button
                      type="button"
                      className={`workspace-toggle sx-group-head${root !== undefined && root === activeRoot ? ' active' : ''}`}
                      disabled={root === undefined}
                      aria-expanded={openSlug === row.slug}
                      data-tip={root ?? 'root 未登记(历史工作区)——无法新建会话'}
                      onClick={() => onToggleGroup(row)}
                    >
                      <span className="sx-ws-folder" aria-hidden="true">
                        {openSlug === row.slug ? <FolderOpen size={16} strokeWidth={1.75} /> : <Folder size={16} strokeWidth={1.75} />}
                      </span>
                      <span className="ws-slug sx-ws-name">{wsName(row)}</span>
                      <span className="ws-count sx-count">
                        {row.sessionCount}
                      </span>
                    </button>
                    {root !== undefined && (
                      <button
                        type="button"
                        aria-label={`new session in ${row.slug}`}
                        className="sx-iconbtn"
                        data-tip={t('New chat in this project', '在此项目中新对话')}
                        onClick={() => onComposeIn(root)}
                      >
                        <SquarePen size={14} strokeWidth={1.75} />
                      </button>
                    )}
                  </div>
                  {root !== undefined && (
                    <div className={`sx-collapse${openSlug === row.slug ? ' open' : ''}`}>
                      <ul className="session-list" aria-label="sessions">
                        {sessionsError !== '' && <li className="home-error">{sessionsError}</li>}
                        {/* G14.35:RECENTS 只收默认锚点会话,组内列表恢复展示本项目全部会话 */}
                        {sessions !== null && sessions.length === 0 && (
                          <li className="no-sessions">{t('No sessions', '暂无会话')}</li>
                        )}
                        {visible.map((sr) => {
                          // G14.2xx running 身份按会话记(runningId===本行映射会话);他会话看 daemon 标注
                          const active =
                            activeSessionId !== '' &&
                            (sr.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === sr.id);
                          const running = active
                            ? runningId === activeSessionId
                            : sr.liveSessionId !== undefined && sr.liveSessionId !== activeSessionId;
                          const label = sr.title ?? sr.firstUser ?? t('New session', '新会话');
                          // G14.188 项目组会话行同样 hover 出会话信息(与最近会话行同款;贴主对话缘)
                          const srMeta = [
                            sr.runs !== undefined ? t(`${sr.runs} rounds`, `${sr.runs} 轮`) : '',
                            sr.steps !== undefined ? t(`${sr.steps} steps`, `${sr.steps} 步`) : '',
                            sr.createdAt !== undefined ? `${t('Created', '创建于')} ${sr.createdAt.slice(5, 16).replace('T', ' ')}` : '',
                          ].filter((x) => x !== '').join(' · ');
                          return (
                            <li
                              key={sr.id}
                              className={`session-row sx-session-row${active ? ' active' : ''}`}
                              data-session-row="1"
                              data-tip={`${label}${srMeta !== '' ? `\n${srMeta}` : ''}`}
                              data-tip-pos="right"
                              onClick={() => {
                                if (busy || root === undefined) return;
                                onAttach(root, sr.id, sr.updatedAt);
                              }}
                            >
                              {running ? (
                                <span className="sx-session-dot running" />
                              ) : isUnseen(sr.id, sr.updatedAt) ? (
                                <span className="sx-session-dot unseen" />
                              ) : null}
                              <span className="session-summary" data-id={sr.id}>{label}</span>
                              <span className="session-meta">{relTime(sr.updatedAt)}</span>
                            </li>
                              );
                            })}
                        {hidden > 0 && (
                          <li key="more" className="session-more" role="button" tabIndex={0} onClick={groupShowMore}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); groupShowMore(); } }}>
                            {t('Show more', '显示更多')}
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
    </>
  );
}
