import { memo, useMemo, useState } from 'react';
import type { SessionRow } from '../connection';
import { t, useLanguage } from '../i18n';
import { Archive, ChevronRight, KanbanSquare } from 'lucide-react';
import { SunxIcon } from '../sunx-icon';
import { SessionRow as SessionRowView, SortPop, useConfirmOutsideCancel } from './project-menu-util';

/**
 * SUNX 过滤组(sunx P2 Task 7,spec §10):侧栏 SUNX 会话聚合组(宿主挂载:ProjectsSection 工作区组
 * 之前、RECENTS 之前,两组并存不互斥)。**平铺单列**(2026-11-15 用户实测裁定:工作区分节头退役——
 * 「sunshinex-default」根标签行去掉;行布局与最近会话完全同款 recent-list/SessionRow,左对齐含
 * 状态图标)。空组整块不隐(组头恒显+「暂无Sunx」空态行)。条目=既有 SessionRow 复用,点击=宿主
 * attachSunx 链。组头=「SUNX」标题(可折叠)+动作簇(数量/看板/排序/归档/新建,可选 guard 缺接线
 * 不渲染)。纯渲染件:数据/动作 props 注入,折叠态本组件自持。
 */
export interface SunxSectionProps {
  /** kind==='sunx' 聚合行(跨工作区;null=装载中);空列=「暂无Sunx」空态行 */
  readonly rows: Array<SessionRow & { root: string; slug: string }> | null;
  readonly activeSessionId: string;
  readonly runningIds: ReadonlySet<string>;
  readonly journalOfSession: ReadonlyMap<string, string>;
  readonly isUnseen: (id: string, updatedAt: number) => boolean;
  readonly busy: boolean;
  /** 条目点击链(sunx P3 Task 3 数据源改向):宿主注入 attachSunx 包装——root 参数退役
   *  (journalId 直寻址重开,不再 newSession(root)+attach 两步) */
  readonly onAttach: (root: string, journalId: string, journalUpdatedAt?: number) => void;
  /** T6 行内归档(落库+宿主重拉;确认 morph 本组件行级 confirmId 承载) */
  readonly onArchiveRow: (id: string, archived: boolean) => void;
  /** 组头看板钮(可选 guard):未接线不渲染 */
  readonly onOpenBoard?: () => void;
  /** 组头「新建 Sunx」(2026-11-15 用户裁定组头动作簇对齐「项目」:数量/排序/归档/看板/新建) */
  readonly onNewSunx?: () => void;
  /** 组头「归档」入口:进归档层(宿主 archiveOpen 整替语义) */
  readonly onOpenArchive?: () => void;
}

export const SunxSection = memo(function SunxSection(props: SunxSectionProps): JSX.Element | null {
  useLanguage(); // memo 响应面:语言同步(en→zh)强制重渲染,区块头标签随 t() 调用时求值归位
  const { rows, activeSessionId, runningIds, journalOfSession, isUnseen, busy, onAttach, onArchiveRow, onOpenBoard, onNewSunx, onOpenArchive } = props;
  /** 行排序(2026-11-15 用户裁定组头簇对齐「项目」):updated=更新时间新→旧(默认)/name=名称 */
  const [sortMode, setSortMode] = useState<'updated' | 'name'>('updated');
  const [sortOpen, setSortOpen] = useState(false);
  /** 分区折叠(本组件自持——宿主只管 Projects/Recents 折叠与归档层,过滤组内聚) */
  const [open, setOpen] = useState(true);
  /** T6 行内归档确认 morph:行级单份,他行点击即换位 */
  const [confirmId, setConfirmId] = useState('');
  useConfirmOutsideCancel(confirmId, () => setConfirmId(''));
  /** 平铺单列(2026-11-15 用户裁定:工作区分节头退役)——排序后直出,行与最近会话同款 */
  const sorted = useMemo(() => {
    if (rows === null) return null;
    const list = [...rows];
    if (sortMode === 'name') list.sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id));
    else list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }, [rows, sortMode]);
  // SUNX 分组常驻(2026-11-15 用户裁定「SUNX分组常驻」:空组不再整块隐——组头恒显+空态行
  // 引导创建;装载中 null 同口径=区块随数据在场,不闪占位)
  return (
    <>
      <div
        className="sx-side-head sx-side-head-row sx-side-head-btn"
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span>{t('SUNX', 'SUNX')}</span>
        <ChevronRight size={14} strokeWidth={2} aria-hidden="true" className={`sx-side-chev${open ? ' open' : ''}`} />
        {/* 组头动作簇(2026-11-15 用户裁定:数量/排序/归档/看板/新建——对齐「项目」组头同款簇;
            数量值在簇内、看板钮左侧——同日二轮裁定「数量跟随在看板图标左侧」) */}
        <span className="sx-side-head-actions">
          {/* 数量值:sunx 行数计数 chip(装载中 null 不显) */}
          {rows !== null && (
            <span className="sx-sunx-count" aria-label="sunx count">{rows.length}</span>
          )}
          {/* 看板钮(可选 guard):onOpenBoard 接线才渲染 */}
          {onOpenBoard !== undefined && (
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="sunx board"
              data-tip={t('Sunx board', 'Sunx 看板')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenBoard();
              }}
            >
              <KanbanSquare size={14} strokeWidth={1.75} />
            </button>
          )}
          {/* 排序钮+二选弹层(SortPop 共用件,PROJECTS 三选同构) */}
          <SortPop
            open={sortOpen}
            ariaLabel={t('Sort Sunx', 'Sunx 排序')}
            buttonLabel="sort sunx"
            items={[
              { mode: 'updated', label: t('By recent activity', '按最近活动') },
              { mode: 'name', label: t('By name', '按名称') },
            ]}
            mode={sortMode}
            onPick={(m) => { setSortMode(m); setSortOpen(false); }}
            onClose={() => setSortOpen(false)}
            onToggle={() => setSortOpen((v) => !v)}
            buttonMouseDown={(e) => e.stopPropagation()}
          />
          {/* 归档入口(可选 guard):进归档层(宿主 archiveOpen 整替) */}
          {onOpenArchive !== undefined && (
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="archive sunx"
              data-tip={t('Archive Sunx', '归档 Sunx')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenArchive();
              }}
            >
              <Archive size={14} strokeWidth={1.75} />
            </button>
          )}
          {/* 新建钮(可选 guard):开创建弹窗(顶部快捷区行同款弹窗) */}
          {onNewSunx !== undefined && (
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="new sunx header"
              data-tip={t('New Sunx', '新建 Sunx')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onNewSunx();
              }}
            >
              <SunxIcon size={14} strokeWidth={1.75} />
            </button>
          )}
        </span>
      </div>
      <div className={`sx-collapse sx-collapse-sunx${open ? ' open' : ''}`}>
        <ul className="recent-list" aria-label="sunx sessions">
          {sorted !== null && sorted.length === 0 && <li className="no-sessions">{t('No Sunx yet', '暂无Sunx')}</li>}
          {(sorted ?? []).map((sr) => {
            const active =
              activeSessionId !== '' &&
              (sr.liveSessionId === activeSessionId || journalOfSession.get(activeSessionId) === sr.id);
            const running = active
              ? runningIds.has(activeSessionId)
              : sr.liveSessionId !== undefined && sr.liveSessionId !== activeSessionId;
            const label = sr.title ?? sr.firstUser ?? t('New session', '新会话');
            return (
              <SessionRowView
                key={sr.id}
                rowId={sr.id}
                label={label}
                info={{ runs: sr.runs, steps: sr.steps, createdAt: sr.createdAt, rootPath: sr.root }}
                updatedAt={sr.updatedAt}
                active={active}
                running={running}
                awaiting={sr.awaiting === true}
                unseen={isUnseen(sr.id, sr.updatedAt)}
                busy={busy}
                onOpen={() => onAttach(sr.root, sr.id, sr.updatedAt)} // 条目点击=既有 attach 链
                confirmId={confirmId}
                onArm={() => setConfirmId(sr.id)}
                onConfirm={() => {
                  setConfirmId('');
                  onArchiveRow(sr.id, true);
                }}
              />
            );
          })}
        </ul>
      </div>
    </>
  );
});
