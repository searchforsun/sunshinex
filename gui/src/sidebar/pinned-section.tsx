import { useState } from 'react';
import { Archive, PinOff } from 'lucide-react';
import { t } from '../i18n';
import { relTime } from '../ui-util';
import { useConfirmOutsideCancel } from './project-menu-util';
import type { PinEntry } from './pin-store';

/** 置顶会话分组(2026-10-21 用户裁定):「项目」上方常驻层,不支持折叠;无置顶会话不渲染
 *  (宿主判空)。行=行首取消置顶钮(常驻)+标题+末次活动时间+行尾归档钮(确认 morph 同
 *  归档层,点外部取消);点击行经宿主 attachJournal 链正常打开。归档联动:钉存 GUI 本地,
 *  归档行由宿主 archivedIds 滤出(置顶的归档即离组,撤销归档自动还回置顶)。纯渲染件。 */
export interface PinnedSectionProps {
  readonly pins: PinEntry[];
  /** 归档中(in-flight 禁双发/禁打开) */
  readonly busy: boolean;
  readonly onOpenSession: (root: string, journalId: string, updatedAt?: number) => void;
  readonly onUnpin: (id: string) => void;
  /** 行尾归档(落库+宿主重拉;确认 morph 行内承载,点外部取消) */
  readonly onArchiveRow: (id: string, archived: boolean) => void;
}

export function PinnedSection(props: PinnedSectionProps): JSX.Element {
  const { pins, busy, onOpenSession, onUnpin, onArchiveRow } = props;
  /** 行内归档确认 morph:存确认中的行 id('' = 无) */
  const [confirmId, setConfirmId] = useState('');
  useConfirmOutsideCancel(confirmId, () => setConfirmId(''));
  if (pins.length === 0) return <></>;
  return (
    <>
      <div className="sx-side-head sx-side-head-row sx-side-head-btn">
        <span>{t('Pinned', '置顶')}</span>
      </div>
      <ul className="sx-pin-list" aria-label="pinned sessions">
        {pins.map((p) => (
          <li
            key={p.id}
            data-row-id={p.id}
            className="sx-pin-item"
            onClick={() => {
              if (!busy) onOpenSession(p.root, p.id, p.updatedAt);
            }}
          >
            <button
              type="button"
              className="sx-iconbtn sx-pin-unpin"
              data-tip={t('Unpin', '取消置顶')}
              aria-label={`${t('Unpin', '取消置顶')} ${p.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onUnpin(p.id);
              }}
            >
              <PinOff size={12} strokeWidth={1.75} />
            </button>
            <span className="sx-pin-main">
              <span className="sx-pin-title-row">
                <span className="sx-pin-title">{p.title}</span>
                <span className="sx-archive-time">{relTime(p.updatedAt)}</span>
              </span>
            </span>
            <span className="session-row-actions">
              {confirmId === p.id ? (
                <button
                  type="button"
                  className="sx-archive-confirm"
                  aria-label={`${t('Confirm archive', '确认归档')} ${p.id}`}
                  data-tip={t('Confirm archive', '确认归档')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmId('');
                    onArchiveRow(p.id, true);
                  }}
                >
                  {t('Confirm', '确认')}
                </button>
              ) : (
                <button
                  type="button"
                  className="sx-iconbtn"
                  data-tip={t('Archive', '归档')}
                  aria-label={`${t('Archive', '归档')} ${p.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmId(p.id);
                  }}
                >
                  <Archive size={12} strokeWidth={1.75} />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
