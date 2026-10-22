import { useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { relTime } from '../ui-util';
import { t } from '../i18n';
import { Archive, ChevronRight, Folder, FolderOpen, Pin, SquarePen, X } from 'lucide-react';
import { useConfirmOutsideCancel } from './project-menu-util';
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
  readonly runningIds: ReadonlySet<string>;
  readonly journalOfSession: ReadonlyMap<string, string>;
  readonly isUnseen: (id: string, updatedAt: number) => boolean;
  readonly onToggleGroup: (row: WorkspaceRow) => void;
  readonly onComposeIn: (root: string, mode?: 'auto' | 'manual') => void;
  readonly onAttach: (root: string, journalId: string, journalUpdatedAt?: number) => void;
  /** T6 行内归档(落库 + 宿主重拉;确认 morph 由本组件行级 confirmId 承载) */
  readonly onArchiveRow: (id: string, archived: boolean) => void;
  /** T6 归档页入口(组头归档箱钮;可选——未配时钮不渲染) */
  readonly onOpenArchived?: () => void;
  /** 2026-10-21 用户裁定:归档层模式——组头改题「归档会话」+X 退出,列表体整替为归档行 */
  readonly archiveMode?: boolean;
  readonly onExitArchive?: () => void;
  /** 置顶(2026-10-21,GUI 专属):已钉 journalId 集(列表滤除)+ 行 hover 状态点位置顶钮 */
  readonly pinnedIds: ReadonlySet<string>;
  readonly onPinRow: (row: { id: string; root: string; title?: string; updatedAt: number }) => void;
}

export function ProjectsSection(props: ProjectsSectionProps): JSX.Element {
  const { projectsOpen, onToggleProjects, busy, onAddWorkspace, actionError, rows, listError, openSlug, sessions, sessionsError, activeRoot, activeSessionId, runningIds, journalOfSession, isUnseen, onToggleGroup, onComposeIn, onAttach, onArchiveRow, onOpenArchived, archiveMode, onExitArchive, pinnedIds, onPinRow, groupShowAll, onGroupShowMore } = props;
  /** T6 行内归档确认 morph:存确认中的行 id('' = 无;行级单份,他行点击即换位) */
  const [confirmId, setConfirmId] = useState('');
  useConfirmOutsideCancel(confirmId, () => setConfirmId('')); // 点外部取消归档确认(用户裁定)
  if (archiveMode === true) {
    /* 归档层(2026-10-21 用户裁定):组头=「归档会话」+X 退出(无折叠无归档/新增钮);列表体=归档行 */
    return (
      <>
        <div className="sx-side-head sx-side-head-row sx-side-head-btn">
          <span>{t('Archived sessions', '归档会话')}</span>
          <span className="sx-side-head-actions">
            <button type="button" className="sx-iconbtn sx-archive-exit" data-tip={t('Exit archive', '退出归档')}
              aria-label="exit archive"
              onClick={(e) => { e.stopPropagation(); onExitArchive?.(); }}>
              <X size={14} strokeWidth={1.75} />
            </button>
          </span>
        </div>
        {actionError !== '' && <p className="home-error">{actionError}</p>}
      </>
    );
  }
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
          {/* 2026-10-21 用户裁定:归档钮挨着新项目钮右侧成簇贴右——组头 space-between 会把裸子元素撑散,包右贴容器 */}
          <span className="sx-side-head-actions">
            {onOpenArchived !== undefined && (
              <button type="button" className="sx-iconbtn" data-tip={t('Archived sessions', '归档会话')}
                aria-label="archived sessions"
                onClick={(e) => { e.stopPropagation(); onOpenArchived(); }}>
                <Archive size={14} strokeWidth={1.75} />
              </button>
            )}
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
          </span>
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
              // 置顶滤除先行(2026-10-22 用户裁定:分页只数实际可显示行——钉/归档过滤不计为隐藏内容)
              const listable = sorted24.filter((sr: SessionRow) => !pinnedIds.has(sr.id));
              const headRows = showAll ? listable : listable.slice(0, defN);
              const tailRows = showAll ? [] : listable.slice(defN).filter((sr: SessionRow) => isActiveRow(sr));
              const visible = [...headRows, ...tailRows];
              const hidden = listable.length - visible.length;
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
                          // G14.2xx running 身份按会话记(runningIds 含本行映射会话);他会话看 daemon 标注
                          const active =
                            activeSessionId !== '' &&
                            (sr.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === sr.id);
                          const running = active
                            ? runningIds.has(activeSessionId)
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
                              data-row-id={sr.id}
                              className={`session-row sx-session-row${active ? ' active' : ''}`}
                              data-session-row="1"
                              data-tip={`${label}${srMeta !== '' ? `\n${srMeta}` : ''}`}
                              data-tip-pos="right"
                              onClick={() => {
                                if (busy || root === undefined) return;
                                onAttach(root, sr.id, sr.updatedAt);
                              }}
                            >
                              {/* 置顶钮:行 hover 显于状态点位(2026-10-21);钉后离组上浮置顶分组 */}
                              {root !== undefined && (
                                <button type="button" className="sx-pin-btn" data-tip={t('Pin', '置顶')}
                                  aria-label={`${t('Pin', '置顶')} ${sr.id}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onPinRow({ id: sr.id, root, title: sr.title ?? sr.firstUser ?? '', updatedAt: sr.updatedAt });
                                  }}
                                >
                                  <Pin size={16} strokeWidth={1.75} />
                                </button>
                              )}
                              {running ? (
                                <span className="sx-session-dot running" />
                              ) : isUnseen(sr.id, sr.updatedAt) ? (
                                <span className="sx-session-dot unseen" />
                              ) : null}
                              <span className="session-summary" data-id={sr.id}>{label}</span>
                              <span className="session-meta">{relTime(sr.updatedAt)}</span>
                              <span className="session-row-actions">
                                {confirmId === sr.id ? (
                                  <button type="button" className="sx-archive-confirm" aria-label={`${t('Confirm archive', '确认归档')} ${sr.id}`}
                                    onClick={(e) => { e.stopPropagation(); setConfirmId(''); onArchiveRow(sr.id, true); }}>
                                    {t('Confirm', '确认')}
                                  </button>
                                ) : (
                                  <button type="button" className="sx-iconbtn" data-tip={t('Archive', '归档')}
                                    aria-label={`${t('Archive', '归档')} ${sr.id}`}
                                    onClick={(e) => { e.stopPropagation(); setConfirmId(sr.id); }}>
                                    <Archive size={13} strokeWidth={1.75} />
                                  </button>
                                )}
                              </span>
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
