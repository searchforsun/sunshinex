import { useMemo, useState } from 'react';
import type { SessionRow } from '../connection';
import { t } from '../i18n';
import { Archive, Check, ChevronRight, KanbanSquare, ListFilter } from 'lucide-react';
import { SunxIcon } from '../sunx-icon';
import { SessionRow as SessionRowView, useConfirmOutsideCancel, wsName } from './project-menu-util';

/**
 * SUNX 过滤组(sunx P2 Task 7,spec §10+R10):侧栏视图过滤器——按 /sessions 行 kind==='sunx'
 * 聚合(聚合在宿主:ProjectsSection 工作区组之后、RECENTS 之前挂载,两组并存不互斥),按工作区
 * 分节(R10:工作区名小节头);空组整块不显(宿主/本组件双层判空)。条目=既有 SessionRow 复用
 * (kind 徽标已在),点击=既有 attach 链(onAttach)。组头=「SUNX」标题(可折叠,同 PROJECTS/
 * RECENTS 分区头语言)+右侧看板钮(可选 guard:onOpenBoard 未接线不渲染——Task 8 注册 sunxboard
 * 页签后 App 传接线,本任务先留开合点)。纯渲染件:数据/动作 props 注入,折叠态本组件自持。
 */
export interface SunxSectionProps {
  /** kind==='sunx' 聚合行(跨工作区,行携 root/slug;null=装载中);空列=无 sunx 会话整块不显 */
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
  /** 组头看板钮(可选 guard:Task 8 页签注册后接线;未传=钮不渲染) */
  readonly onOpenBoard?: () => void;
  /** 「编辑品性」行菜单(仅 sunx 行有本组;宿主解析寻址+开 CharterDialog) */
  readonly onEditCharter?: (row: SessionRow & { root: string }) => void;
  /** 组头「新建 Sunx」(P2 2026-11-15 用户裁定组头动作簇对齐「项目」:数量/排序/归档/看板/新建) */
  readonly onNewSunx?: () => void;
  /** 组头「归档」入口(P2 2026-11-15):进归档层(宿主 archiveOpen 整替语义) */
  readonly onOpenArchive?: () => void;
}

export function SunxSection(props: SunxSectionProps): JSX.Element | null {
  const { rows, activeSessionId, runningIds, journalOfSession, isUnseen, busy, onAttach, onArchiveRow, onOpenBoard, onEditCharter, onNewSunx, onOpenArchive } = props;
  /** 行排序(P2 2026-11-15 用户裁定组头簇对齐「项目」):updated=更新时间新→旧(默认)/name=名称 */
  const [sortMode, setSortMode] = useState<'updated' | 'name'>('updated');
  const [sortOpen, setSortOpen] = useState(false);
  /** 分区折叠(本组件自持——宿主只管 Projects/Recents 折叠与归档层,过滤组内聚) */
  const [open, setOpen] = useState(true);
  /** T6 行内归档确认 morph:行级单份,他行点击即换位 */
  const [confirmId, setConfirmId] = useState('');
  useConfirmOutsideCancel(confirmId, () => setConfirmId(''));
  /** 按工作区分节(R10):slug 保序分组(宿主按工作区行序聚合,首现序=工作区行序),组内新→旧 */
  const sections = useMemo(() => {
    const sorted = rows === null ? null : (() => {
      const list = [...rows];
      if (sortMode === 'name') list.sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id));
      else list.sort((a, b) => b.updatedAt - a.updatedAt);
      return list;
    })();
    const bySlug = new Map<string, { root: string; rows: Array<SessionRow & { root: string; slug: string }> }>();
    for (const r of sorted ?? []) {
      let sec = bySlug.get(r.slug);
      if (sec === undefined) {
        sec = { root: r.root, rows: [] };
        bySlug.set(r.slug, sec);
      }
      sec.rows.push(r);
    }
    for (const sec of bySlug.values()) sec.rows.sort((a, b) => b.updatedAt - a.updatedAt);
    return [...bySlug.entries()];
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
          {/* 排序钮+二选弹层(更新时间/名称;PROJECTS 三选同构) */}
          {sortOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 44, background: 'transparent' }} onClick={() => setSortOpen(false)} />
              <div className="sx-menu-pop sx-ws-sort-pop" role="menu" aria-label={t('Sort Sunx', 'Sunx 排序')} style={{ zIndex: 45 }}>
                {(['updated', 'name'] as const).map((m) => (
                  <button key={m} type="button" role="menuitemradio" aria-checked={sortMode === m} className={`sx-menuitem${sortMode === m ? ' sx-ws-sort-active' : ''}`} onClick={() => { setSortMode(m); setSortOpen(false); }}>
                    <span className="sx-ws-sort-name">{m === 'updated' ? t('By recent activity', '按最近活动') : t('By name', '按名称')}</span>
                    {sortMode === m && <Check size={14} strokeWidth={2} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            className="sx-iconbtn"
            aria-label="sort sunx"
            data-tip={t('Sort Sunx', 'Sunx 排序')}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setSortOpen((v) => !v);
            }}
          >
            <ListFilter size={14} strokeWidth={1.75} />
          </button>
          {/* 归档入口(可选 guard):进归档层(宿主 archiveOpen 整替) */}
          {onOpenArchive !== undefined && (
            <button
              type="button"
              className="sx-iconbtn"
              aria-label="archive sunx"
              data-tip={t('Archived sessions', '归档会话')}
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
        {sections.length === 0 ? (
          <div className="sx-sunx-empty">{t('No Sunx yet — create one with New Sunx above.', '还没有 Sunx——点上方「新建 Sunx」创建。')}</div>
        ) : (
        <ul className="sx-sunx-list" aria-label="sunx sessions">
          {sections.map(([slug, sec]) => (
            <li key={slug} className="sx-sunx-ws-item">
              {/* 工作区小节头(R10):目录名 basename(wsName 单点——slug 仅兜底) */}
              <div className="sx-sunx-ws">{wsName({ root: sec.root, slug })}</div>
              <ul className="sx-sunx-ws-rows">
                {sec.rows.map((sr) => {
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
                      kind={sr.kind}
                      info={{ runs: sr.runs, steps: sr.steps, createdAt: sr.createdAt, rootPath: sr.root }}
                      updatedAt={sr.updatedAt}
                      active={active}
                      running={running}
                      awaiting={sr.awaiting === true}
                      unseen={isUnseen(sr.id, sr.updatedAt)}
                      busy={busy}
                      onOpen={() => onAttach(sr.root, sr.id, sr.updatedAt)} // 条目点击=既有 attach 链
                      // 「编辑品性」行菜单(sunx 行恒有 kind;宿主未接线=undefined 无菜单钮,guard 同看板钮)
                      onEditCharter={
                        onEditCharter !== undefined && sr.kind === 'sunx' ? () => onEditCharter(sr) : undefined
                      }
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
            </li>
          ))}
        </ul>
        )}
      </div>
    </>
  );
}
