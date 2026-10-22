import { useState } from 'react';
import { Archive, PinOff } from 'lucide-react';
import { t } from '../i18n';
import { relTime } from '../ui-util';
import { useConfirmOutsideCancel } from './project-menu-util';
import type { PinEntry } from './pin-store';

/** 置顶会话分组(2026-10-21 用户裁定):「项目」上方常驻层,不支持折叠;无置顶会话不渲染
 *  (宿主判空)。行=会话行同构:状态点(运行/未读)+标题+右槽[时间⇄归档](默认显时间,hover
 *  状态点位换取消置顶、右槽换归档钮;确认 morph 点外部取消);点击行经宿主 attachJournal 链
 *  正常打开。归档联动(2026-10-22 追裁定「点击归档不覆盖置顶分组」):置顶组恒显所有钉。
 *  右缘锚=工作区「新会话」钮:时间/归档右缘对齐(margin -8 对齐中心线)。纯渲染件。 */
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
  /** 行尾归档(落库+宿主重拉;hover 槽确认 morph,点外部取消) */
  readonly onArchiveRow: (id: string, archived: boolean) => void;
}

export function PinnedSection(props: PinnedSectionProps): JSX.Element {
  const { pins, busy, activeSessionId, runningIds, journalOfSession, isUnseen, onOpenSession, onUnpin, onArchiveRow } = props;
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
              {/* hover:取消置顶显于状态点位(与普通行置顶钮同款钮座,字形对齐 PinOff) */}
              <button
                type="button"
                className="sx-pin-btn"
                data-tip={t('Unpin', '取消置顶')}
                aria-label={`${t('Unpin', '取消置顶')} ${p.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onUnpin(p.id);
                }}
              >
                <PinOff size={16} strokeWidth={1.75} />
              </button>
              {running ? (
                <span className="sx-session-dot running" />
              ) : isUnseen(p.id, p.updatedAt) ? (
                <span className="sx-session-dot unseen" />
              ) : null}
              <span className="sx-pin-title">{p.title}</span>
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
                <>
                  {/* 右槽:默认时间,hover 换归档钮(同槽切换);margin -8 对齐新会话钮中心线 */}
                  <span className="sx-pin-time">{relTime(p.updatedAt)}</span>
                  <button
                    type="button"
                    className="sx-iconbtn sx-pin-archive"
                    data-tip={t('Archive', '归档')}
                    aria-label={`${t('Archive', '归档')} ${p.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmId(p.id);
                    }}
                  >
                    <Archive size={13} strokeWidth={1.75} />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
