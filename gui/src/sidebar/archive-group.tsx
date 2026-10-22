import { useState } from 'react';
import { ArchiveRestore, Folder, Trash2 } from 'lucide-react';
import { t } from '../i18n';
import { relTime } from '../ui-util';
import { RECENT_VISIBLE_DEFAULT, RECENT_VISIBLE_STEP, useConfirmOutsideCancel } from './project-menu-util';

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
}

export interface ArchiveSectionProps {
  readonly rows: ArchivedRow[] | null;
  readonly busy: boolean;
  readonly onOpenSession: (root: string, journalId: string, updatedAt?: number) => void;
  /** 撤销归档(宿主落库+重拉归档行/组计数/展开组) */
  readonly onUnarchive: (id: string) => void;
  /** 受控删除(已归档态才可删;宿主 deleteSession 真清+重拉) */
  readonly onDelete: (id: string) => void;
}

/** 来源项目目录名(用户裁定「项目使用文件名」):root 末段(slash 归一),slug 折叠名太长不可读 */
const rootBaseName = (root: string): string => root.split(/[\\/]+/).filter(Boolean).pop() ?? root;

export function ArchiveSection(props: ArchiveSectionProps): JSX.Element {
  const { rows, busy, onOpenSession, onUnarchive, onDelete } = props;
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
      {rows !== null && rows.length === 0 && <li className="no-sessions">{t('No archived sessions', '暂无归档会话')}</li>}
      {visible.map((r) => (
        <li
          key={r.id}
          data-row-id={r.id}
          className="sx-archive-item"
          onClick={() => {
            if (!busy) onOpenSession(r.root, r.id, r.updatedAt);
          }}
        >
          <span className="sx-archive-item-main">
            <span className="sx-archive-title-row">
              <span className="sx-archive-title">{r.title ?? r.id}</span>
              <span className="sx-archive-time">{relTime(r.updatedAt)}</span>
            </span>
            <span className="sx-archive-slug-row">
              <Folder size={11} strokeWidth={1.75} aria-hidden="true" />
              <span className="sx-archive-slug">{rootBaseName(r.root)}</span>
              {/* 动作钮常驻第二行右缘(2026-10-21 用户裁定:非 hover 显隐) */}
              <span className="session-row-actions">
                {confirmId === r.id ? (
                  <button
                    type="button"
                    className="sx-archive-confirm"
                    aria-label={`${t('Confirm delete', '确认删除')} ${r.id}`}
                    data-tip={t('Confirm delete', '确认删除')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmId('');
                      onDelete(r.id);
                    }}
                  >
                    {t('Confirm', '确认')}
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
                      <ArchiveRestore size={12} strokeWidth={1.75} />
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
                      <Trash2 size={12} strokeWidth={1.75} />
                    </button>
                  </>
                )}
              </span>
            </span>
          </span>
        </li>
      ))}
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
}
