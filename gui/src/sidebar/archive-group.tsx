import { memo, useState } from 'react';
import { ArchiveRestore, CircleHelp, Folder, MessagesSquare, Trash2 } from 'lucide-react';
import { t, useLanguage } from '../i18n';
import { pathBasename, relTime } from '../ui-util';
import { RECENT_VISIBLE_DEFAULT, RECENT_VISIBLE_STEP, rowRunning, useConfirmOutsideCancel } from './project-menu-util';

/** 归档会话层(2026-10-21 用户裁定:点项目组头归档钮后,侧栏下侧整层替换为归档列表——
 *  覆盖项目组与最近会话,无独立分组头;组头 X 退出。跨工作区聚合行(GET /sessions/archived):
 *  行=标题+末次活动时间 / 来源项目(目录名 basename)+动作两行式,hover 显 [撤销归档]
 *  [红删除→「确认」morph];尾部分页「显示更多」(默认 10 条步进 10,同 RECENTS 档);
 *  点击行经宿主 attachJournal 链正常打开。纯渲染件:数据/动作 props 注入。 */
export interface ArchivedRow {
  id: string;
  slug: string;
  root: string;
  title?: string;
  updatedAt: number;
  archivedAt: number;
  /** 会话形态(sunx P2 Task 7,daemon /sessions/archived meta 读面):'sunx'=编排会话(行徽标) */
  kind?: string;
  /** 来源展示名(2026-11-22 通道归档专域):通道行=应用名(免 domainSlug 长名);缺席=pathBasename(root) */
  rootLabel?: string;
  /** 所属群组名（2026-11-26 用户裁定「归档的要显示所属群组」）：仅 Sunx 归档域注入 */
  groupLabel?: string;
  /** daemon 运行标注(运行中可归档,2026-11-07):仅 running 运行时才带 */
  liveSessionId?: string;
  awaiting?: boolean;
}

interface ArchiveSectionProps {
  readonly rows: ArchivedRow[] | null;
  /** 归档层作用域(2026-11-16 用户裁定「归档 Sunx ≠ 归档会话」;2026-11-22 用户裁定「通道归档
   *  单独成域」):标题/空态文案随域——'sunx'=「归档 Sunx」,'channel'=「归档通道」;缺省 'session' */
  readonly scope?: 'session' | 'sunx' | 'channel';
  readonly busy: boolean;
  readonly onOpenSession: (root: string, journalId: string, updatedAt?: number) => void;
  /** 撤销归档(宿主落库+重拉归档行/组计数/展开组) */
  readonly onUnarchive: (id: string) => void;
  /** 受控删除(已归档态才可删;宿主 deleteSession 真清+重拉) */
  readonly onDelete: (id: string) => void;
  /** 运行态判定上下文(与最近会话行同口径:本会话看 GUI 运行集,他会话看行标注);缺省不显运行态 */
  readonly activeSessionId?: string;
  readonly runningIds?: ReadonlySet<string>;
  readonly journalOfSession?: ReadonlyMap<string, string>;
}

/** 来源项目目录名(用户裁定「项目使用文件名」):pathBasename 单点(D34 口径),slug 折叠名太长不可读 */

export const ArchiveSection = memo(function ArchiveSection(props: ArchiveSectionProps): JSX.Element {
  useLanguage(); // memo 响应面:语言同步强制重渲染(memo bail 否则永钉启动期语言,2026-11-16 混排根修)
  const { rows, busy, scope = 'session', onOpenSession, onUnarchive, onDelete, activeSessionId = '', runningIds, journalOfSession } = props;
  /** 行内删除确认 morph:存确认中的行 id('' = 无;行级单份,他行点击即换位) */
  const [confirmId, setConfirmId] = useState('');
  useConfirmOutsideCancel(confirmId, () => setConfirmId('')); // 点外部取消删除确认(用户裁定)
  /** 尾部分页(2026-10-21 用户裁定:最大显示条数+「显示更多」;同 RECENTS 10/步进 10 档) */
  const [limit, setLimit] = useState(RECENT_VISIBLE_DEFAULT);
  const visible = (rows ?? []).slice(0, limit);
  const hidden = (rows ?? []).length - visible.length;
  return (
    <ul className="recent-list sx-archive-list" aria-label="archived sessions">
      {rows === null && <li className="no-sessions">{t('Loading…', '加载中…')}</li>}
      {rows !== null && rows.length === 0 && (
    <li className="no-sessions">{scope === 'sunx' ? t('No archived Sunx', '暂无归档 Sunx') : scope === 'channel' ? t('No archived channels', '暂无归档通道') : t('No archived sessions', '暂无归档会话')}</li>
  )}
      {visible.map((r) => {
        const active = activeSessionId !== '' && (r.liveSessionId === activeSessionId || journalOfSession?.get(activeSessionId) === r.id);
        const running = rowRunning(active, activeSessionId, runningIds ?? new Set(), r.liveSessionId);
        return (
        <li
          key={r.id}
          data-row-id={r.id}
          className="sx-archive-item"
          onClick={() => {
            if (!busy) onOpenSession(r.root, r.id, r.updatedAt);
          }}
        >
          {r.awaiting === true ? (
            <span className="sx-session-dot asking">
              <CircleHelp size={16} strokeWidth={1.75} />
            </span>
          ) : running ? (
            <span className="sx-session-dot running" />
          ) : null}
          <span className="sx-archive-item-main">
            <span className="sx-archive-title-row">
              <span className="sx-archive-title">{r.title ?? r.id}</span>
              {/* kind 徽标退役(2026-11-15 用户裁定「Sunx 标签去掉」):归档行与普通行同款零徽标 */}
              <span className="sx-archive-time">{relTime(r.updatedAt)}</span>
            </span>
            <span className="sx-archive-slug-row">
              {/* 归档 Sunx 先示所属群组（2026-11-26 用户裁定「归档的要显示所属群组」），
                  再示来源工作区；两段同用归档第二行弱色，动作簇仍钉右缘 */}
              {r.groupLabel !== undefined && (
                <>
                  <span className="sx-archive-group">
                    <MessagesSquare size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span className="sx-archive-slug">{r.groupLabel}</span>
                  </span>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="sx-archive-slug">{r.rootLabel ?? pathBasename(r.root)}</span>
              {/* 动作钮常驻第二行右缘(2026-10-21 用户裁定:非 hover 显隐) */}
              <span className="session-row-actions">
                {confirmId === r.id ? (
                  // 二次确认统一形态(2026-11-09 用户裁定):删除图标原地红底 18px 盒(白 14px 图形)
                  <button
                    type="button"
                    className="sx-arm"
                    aria-label={`${t('Confirm delete', '确认删除')} ${r.id}`}
                    data-tip={t('Confirm delete', '确认删除')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmId('');
                      onDelete(r.id);
                    }}
                  >
                    <Trash2 size={14} strokeWidth={2} />
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="sx-iconbtn"
                      data-tip={t('Unarchive', '撤销归档')}
                      aria-label={`${t('Unarchive', '撤销归档')} ${r.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnarchive(r.id);
                      }}
                    >
                      <ArchiveRestore size={14} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      className="sx-iconbtn sx-danger"
                      data-tip={t('Delete', '删除')}
                      aria-label={`${t('Delete', '删除')} ${r.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmId(r.id);
                      }}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </button>
                  </>
                )}
              </span>
            </span>
          </span>
        </li>
        );
      })}
      {hidden > 0 && (
        <li
          className="session-more"
          role="button"
          tabIndex={0}
          onClick={() => setLimit((v) => v + RECENT_VISIBLE_STEP)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setLimit((v) => v + RECENT_VISIBLE_STEP);
            }
          }}
        >
          {t('Show more', '显示更多')}
        </li>
      )}
    </ul>
  );
});
