import { useState } from 'react';
import type { SessionRow } from '../connection';
import { t } from '../i18n';
import { ChevronRight, Network, SquarePen } from 'lucide-react';
import { RECENT_VISIBLE_DEFAULT, SessionRow as SessionRowView, useConfirmOutsideCancel } from './project-menu-util';

/** RECENTS 区(D32 批PM-4 自 ProjectMenu 平移,行为零变化):分区头(折叠 + 默认工作区✎)
 *  + 最近会话行(G14.52 运行圆点/未读点)+ G14.115 尾行分页(显示更多/收起)。纯渲染件,
 *  数据/动作 props 注入——折叠复位与分页窗留宿主(onToggleRecents/onShowMore/onCollapse)。 */
export interface RecentsSectionProps {
  readonly recentsOpen: boolean;
  readonly onToggleRecents: () => void;
  /** 头部「新对话」钮(2026-10-23 用户裁定:常驻右侧,点击开默认工作区欢迎页) */
  readonly onNewChat: () => void;
  /** 头部「新建 Sunx」同级钮(sunx P1 Task 6,2026-11-15 用户裁定:与「新对话」同级、独立弹窗
   *  ——宿主开 NewSunxDialog;欢迎页 composer 零改动) */
  readonly onNewSunx: () => void;
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
  /** 置顶(2026-10-21,GUI 专属):已钉 journalId 集(列表滤除)+ 行 hover 状态点位置顶钮。
   *  onPinRow 载荷携 kind 快照(sunx P2 Task 7 徽标透传) */
  readonly pinnedIds: ReadonlySet<string>;
  readonly onPinRow: (row: { id: string; root: string; title?: string; updatedAt: number; kind?: string }) => void;
  /** 「编辑品性」行菜单(sunx P2 Task 7):仅 kind==='sunx' 行渲染菜单钮(gate 在行级);
   *  宿主解析寻址(liveSessionId 优先)+开 CharterDialog。未配=全组零菜单钮(旧桩兼容) */
  readonly onEditCharter?: (row: SessionRow & { root: string }) => void;
}

export function RecentsSection(props: RecentsSectionProps): JSX.Element {
  const { recentsOpen, onToggleRecents, onNewChat, onNewSunx, recents, recentLimit, onShowMore, onCollapse, activeSessionId, runningIds, journalOfSession, isUnseen, busy, onAttach, onArchiveRow, pinnedIds, onPinRow, onEditCharter } = props;
  /** T6 行内归档确认 morph:存确认中的行 id('' = 无;行级单份,他行点击即换位) */
  const [confirmId, setConfirmId] = useState('');
  useConfirmOutsideCancel(confirmId, () => setConfirmId('')); // 点外部取消归档确认(用户裁定)
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
          <ChevronRight size={14}
            strokeWidth={2}
            aria-hidden="true"
            className={`sx-side-chev${recentsOpen ? ' open' : ''}`}
          />
          {/* 头部动作簇(sunx P1 Task 6):「新建 Sunx」与「新对话」同级同槽(PROJECTS 组头
              .sx-side-head-actions 右贴容器同款——space-between 会把裸子元素撑散,projects 行同证)。
              aria 用「new sunx」——与「new default chat」判重(测试按名定位) */}
          <span className="sx-side-head-actions">
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="new sunx"
              data-tip={t('New Sunx', '新建 Sunx')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onNewSunx();
              }}
            >
              <Network size={14} strokeWidth={1.75} />
            </button>
            {/* 头部「新对话」钮(2026-10-23 用户裁定:常驻右侧;点击开默认工作区欢迎页)。
                aria 用旧名「new default chat」——与左上 sx-new-chat 主钮区分(测试 /new chat/i 判重) */}
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="new default chat"
              data-tip={t('New chat', '新对话')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onNewChat();
              }}
            >
              <SquarePen size={14} strokeWidth={1.75} />
            </button>
          </span>
        </div>
        <div className={`sx-collapse sx-collapse-recents${recentsOpen ? ' open' : ''}`}>
        <ul className="recent-list" aria-label="recent sessions">
          {recents !== null && recents.length === 0 && <li className="no-sessions">{t('No recent sessions', '暂无最近会话')}</li>}
          {(recents ?? []).filter((r) => !pinnedIds.has(r.id)).slice(0, recentLimit).map((r) => {
            // G14.2xx running 身份按会话记(runningIds 含本行映射会话);他会话看 daemon 标注
            const active =
              activeSessionId !== '' &&
              (r.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === r.id);
            const running = active
              ? runningIds.has(activeSessionId)
              : r.liveSessionId !== undefined && r.liveSessionId !== activeSessionId;
            const label = r.title ?? r.firstUser ?? t('New session', '新会话');
            return (
              <SessionRowView
                key={`${r.root}/${r.id}`}
                rowId={r.id}
                label={label}
                kind={r.kind}
                info={{ runs: r.runs, steps: r.steps, createdAt: r.createdAt, rootPath: r.root }}
                updatedAt={r.updatedAt}
                active={active}
                running={running}
                awaiting={r.awaiting === true}
                unseen={isUnseen(r.id, r.updatedAt)}
                busy={busy}
                onOpen={() => onAttach(r.root, r.id)}
                pin={{ onPin: () => onPinRow({ id: r.id, root: r.root, title: r.title ?? r.firstUser ?? '', updatedAt: r.updatedAt, ...(r.kind !== undefined ? { kind: r.kind } : {}) }) }}
                onEditCharter={
                  r.kind === 'sunx' && onEditCharter !== undefined ? () => onEditCharter(r) : undefined
                }
                confirmId={confirmId}
                onArm={() => setConfirmId(r.id)}
                onConfirm={() => { setConfirmId(''); onArchiveRow(r.id, true); }}
              />
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
