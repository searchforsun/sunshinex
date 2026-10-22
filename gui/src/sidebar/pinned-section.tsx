import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { t } from '../i18n';
import { relTime } from '../ui-util';
import { SessionRowMenu } from './session-row-menu';
import type { PinEntry } from './pin-store';

/** 置顶会话分组(2026-10-21 用户裁定):「项目」上方常驻层,不支持折叠;无置顶会话不渲染
 *  (宿主判空)。行=会话行同构:状态点(运行/未读,常显)+标题+末次活动时间+行尾 ⋯ 钮
 *  (2026-10-22 用户裁定:直连取消置顶/归档钮收敛为 ⋯ 弹窗——取消置顶/归档会话);点击行
 *  经宿主 attachJournal 链正常打开。归档联动:置顶组恒显所有钉,不因归档离组。纯渲染件。 */
export interface PinnedSectionProps {
  readonly pins: PinEntry[];
  /** 归档中(in-flight 禁双发/禁打开) */
  readonly busy: boolean;
  readonly activeSessionId: string;
  /** 运行态/未读态(置顶行状态点与会话行同语言) */
  readonly runningIds: ReadonlySet<string>;
  readonly journalOfSession: ReadonlyMap<string, string>;
  readonly isUnseen: (id: string, updatedAt: number) => boolean;
  readonly onOpenSession: (root: string, journalId: string, updatedAt?: number) => void;
  readonly onUnpin: (id: string) => void;
  /** 行尾归档(落库+宿主重拉;⋯ 菜单归档项消费) */
  readonly onArchiveRow: (id: string, archived: boolean) => void;
}

export function PinnedSection(props: PinnedSectionProps): JSX.Element {
  const { pins, busy, activeSessionId, runningIds, journalOfSession, isUnseen, onOpenSession, onUnpin, onArchiveRow } = props;
  /** ⋯ 菜单开态:锚行 id + 钮坐标(fixed 定位随锚点) */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  if (pins.length === 0) return <></>;
  return (
    <>
      <div className="sx-side-head sx-side-head-row sx-side-head-btn">
        <span>{t('Pinned', '置顶')}</span>
      </div>
      <ul className="sx-pin-list" aria-label="pinned sessions">
        {pins.map((p) => {
          const active = activeSessionId !== '' && journalOfSession.get(activeSessionId) === p.id;
          const running = active && runningIds.has(activeSessionId);
          return (
            <li
              key={p.id}
              data-row-id={p.id}
              className="sx-pin-item"
              onClick={() => {
                if (!busy) onOpenSession(p.root, p.id, p.updatedAt);
              }}
            >
              {running ? (
                <span className="sx-session-dot running" />
              ) : isUnseen(p.id, p.updatedAt) ? (
                <span className="sx-session-dot unseen" />
              ) : null}
              <span className="sx-pin-title">{p.title}</span>
              <span className="sx-pin-time">{relTime(p.updatedAt)}</span>
              <span className="session-row-actions">
                <button
                  type="button"
                  className="sx-iconbtn"
                  data-tip={t('More actions', '更多操作')}
                  aria-label={`${t('More actions', '更多操作')} ${p.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ id: p.id, x: Math.round(r.right), y: Math.round(r.bottom) });
                  }}
                >
                  <MoreHorizontal size={13} strokeWidth={1.75} />
                </button>
              </span>
              {menu !== null && menu.id === p.id && (
                <SessionRowMenu
                  x={menu.x}
                  y={menu.y}
                  onClose={() => setMenu(null)}
                  items={[
                    { id: 'unpin', label: t('Unpin session', '取消置顶'), onSelect: () => onUnpin(p.id) },
                    { id: 'archive', label: t('Archive session', '归档会话'), onSelect: () => onArchiveRow(p.id, true) },
                  ]}
                />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
