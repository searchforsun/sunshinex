import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, ChevronDown, PanelLeft, Plus, RefreshCw, SquarePen } from 'lucide-react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { usePopOutsideClose } from '../use-pop-outside-close';
import { chatMaxFor } from '../thread-width';
import type { Connection, ScheduleJobView } from '../connection';
import { ScheduleCard } from './ScheduleCard';
import { ScheduleConfig } from './ScheduleConfig';
import { ScheduleRuns } from './ScheduleRuns';

/**
 * 定时任务页（2026-11-20 设置页式布局改版）：页顶是空白拖拽条（只有全局窗控 −□×，与本仓
 * 设置页同构），标题/筛选/刷新/创建全部落在内容区——不再把动作钮塞进窗顶。列表恒三行卡片，
 * 筛选按最近一次执行状态（进行中/完成/失败）；「创建定时任务 ▾ → 在会话中创建」走欢迎页
 * 示例提示词（自然语言创建，由 create_scheduled_task 工具落档）。
 * 列表 10s 静默重拉、1s 倒计时 tick；保存/取消/记录返回后对应卡 is-focus ~1.6s；
 * Esc 层级：创建下拉/卡片菜单 → 配置/记录 → 列表 → onExit。删除两步确认（首点改文案，再点才发）。
 */
export interface SchedulePageProps {
  readonly conn: Connection;
  readonly onOpenSession: (journalId: string, root: string) => void;
  readonly onExit: () => void;
  /** 左侧菜单开合（菜单收起时仍能从本页重开；App 传 toggleMenuStable） */
  readonly onToggleMenu?: () => void;
  /** 「在会话中创建」：App 负责退层、切欢迎页并把示例提示词预填进输入框 */
  readonly onCreateInChat?: () => void;
}

type View = { kind: 'list' } | { kind: 'config'; editingId?: string } | { kind: 'records'; jobId: string };
type Filter = 'all' | 'running' | 'done' | 'failed';

const FOCUS_MS = 1600;

const FILTERS: ReadonlyArray<{ id: Filter; en: string; zh: string }> = [
  { id: 'all', en: 'All', zh: '全部' },
  { id: 'running', en: 'Running', zh: '进行中' },
  { id: 'done', en: 'Completed', zh: '完成' },
  { id: 'failed', en: 'Failed', zh: '失败' },
];

/** 筛选口径：按最近一次 run 的终态（无 run 的任务只落「全部」） */
function matchesFilter(job: ScheduleJobView, filter: Filter): boolean {
  if (filter === 'all') return true;
  const status = job.lastRun?.status;
  if (filter === 'running') return status === 'running';
  if (filter === 'done') return status === 'succeeded';
  return status === 'failed';
}

function emptyText(filter: Filter): string {
  switch (filter) {
    case 'all':
      return t('No scheduled tasks yet', '暂无定时任务');
    case 'running':
      return t('No running tasks', '暂无进行中的任务');
    case 'done':
      return t('No completed tasks', '暂无已完成的任务');
    case 'failed':
      return t('No failed tasks', '暂无失败的任务');
  }
}

export function SchedulePage({ conn, onOpenSession, onExit, onToggleMenu, onCreateInChat }: SchedulePageProps): JSX.Element {
  const [jobs, setJobs] = useState<ScheduleJobView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [defaultModel, setDefaultModel] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [filter, setFilter] = useState<Filter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [menuId, setMenuId] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [busyId, setBusyId] = useState('');
  const [focusId, setFocusId] = useState('');
  const [chatMax, setChatMax] = useState<number | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const reload = useCallback(() => setRefresh((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    conn.schedules().then(
      (r) => {
        if (alive) {
          setJobs(r.jobs);
          setDefaultModel(r.defaultModel);
          setError('');
          setLoadFailed(false);
        }
      },
      (e: unknown) => {
        if (alive) {
          // 首拉失败不得永挂「加载中…」：失败旗 + 错误条，列表体不渲染；后续轮询成功自愈
          setError(errText(e));
          setLoadFailed(true);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, refresh]);
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);
  // 宽度阶梯（2026-11-20 用户裁定「整体宽度参考输入框的宽度，动态阶梯变换」）：与主对话同一
  // chatMaxFor 策略，盯本层实时宽——输入框/内容列随窗口/菜单收展即时跟宽，不再钉死 980。
  useEffect(() => {
    const el = pageRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setChatMax(chatMaxFor(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const h = setInterval(reload, 10_000);
    return () => clearInterval(h);
  }, [reload]);
  useEffect(() => {
    if (focusId === '') return;
    const h = setTimeout(() => setFocusId(''), FOCUS_MS);
    return () => clearTimeout(h);
  }, [focusId]);
  // 保存/取消回列表后把对应卡滚进视野（spec §9.2；block:'nearest' 已在视野内不动）
  useEffect(() => {
    if (focusId === '') return;
    cardRefs.current.get(focusId)?.scrollIntoView({ block: 'nearest' });
  }, [focusId]);
  // 视图切换：上一条视图的错误/提示不带入新视图；创建下拉随之收起
  useEffect(() => {
    setError('');
    setNotice('');
    setCreateOpen(false);
  }, [view]);
  useEffect(() => {
    if (notice === '') return;
    const h = setTimeout(() => setNotice(''), 2200);
    return () => clearTimeout(h);
  }, [notice]);
  useEffect(
    () => () => {
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
      if (runReloadTimer.current !== null) clearTimeout(runReloadTimer.current);
    },
    [],
  );

  const clearConfirm = useCallback((): void => {
    if (confirmTimer.current !== null) {
      clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    setConfirmId('');
  }, []);
  // 菜单外点关闭：待确认删除态一并清（确认窗不得在菜单已关后残留）
  usePopOutsideClose(menuId !== '', '.sx-menu-pop', '.sx-schedule-more', () => {
    setMenuId('');
    clearConfirm();
  });
  usePopOutsideClose(createOpen, '.sx-schedule-create-menu', '.sx-schedule-create-caret', () => setCreateOpen(false));

  const jobOf = (id: string): ScheduleJobView | undefined => (jobs ?? []).find((j) => j.id === id);
  const backToList = useCallback((focus?: string): void => {
    if (focus !== undefined && focus !== '') setFocusId(focus);
    setView({ kind: 'list' });
  }, []);

  const editing = view.kind === 'config' && view.editingId !== undefined ? jobOf(view.editingId) : undefined;
  const recordsJob = view.kind === 'records' ? jobOf(view.jobId) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // 弹层最内层：先收创建下拉/卡片菜单（与其余弹层 Esc 收口一致），不连带跳出页面
      if (createOpen) {
        setCreateOpen(false);
        return;
      }
      if (menuId !== '') {
        setMenuId('');
        clearConfirm();
        return;
      }
      if (view.kind !== 'list') {
        backToList(view.kind === 'config' ? editing?.id : recordsJob?.id);
        return;
      }
      onExit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view, editing, recordsJob, menuId, createOpen, backToList, clearConfirm, onExit]);

  const toggle = (job: ScheduleJobView): void => {
    if (busyId !== '') return;
    setBusyId(job.id);
    conn
      .setScheduleEnabled(job.id, !job.enabled)
      .then(
        (updated) => setJobs((list) => (list ?? []).map((j) => (j.id === updated.id ? updated : j))),
        (e: unknown) => setError(errText(e)),
      )
      .finally(() => setBusyId(''));
  };
  const runNow = (job: ScheduleJobView): void => {
    setMenuId('');
    clearConfirm();
    conn.runScheduleNow(job.id).then(
      () => {
        setNotice(t('Triggered once', '已触发一次执行'));
        if (runReloadTimer.current !== null) clearTimeout(runReloadTimer.current);
        runReloadTimer.current = setTimeout(() => {
          runReloadTimer.current = null;
          reload();
        }, 700);
      },
      (e: unknown) => setError(errText(e)),
    );
  };
  const remove = (job: ScheduleJobView): void => {
    if (confirmId !== job.id) {
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
      setConfirmId(job.id);
      confirmTimer.current = setTimeout(() => {
        confirmTimer.current = null;
        setConfirmId('');
      }, 2600);
      return;
    }
    clearConfirm();
    setMenuId('');
    conn.deleteSchedule(job.id).then(
      () => setJobs((list) => (list ?? []).filter((j) => j.id !== job.id)),
      (e: unknown) => setError(errText(e)),
    );
  };
  const saved = (job: ScheduleJobView): void => {
    setJobs((list) => {
      const l = list ?? [];
      return l.some((j) => j.id === job.id) ? l.map((j) => (j.id === job.id ? job : j)) : [job, ...l];
    });
    setFocusId(job.id);
    setView({ kind: 'list' });
  };

  const visibleJobs = (jobs ?? []).filter((j) => matchesFilter(j, filter));

  return (
    <div
      className="sx-schedule-page"
      ref={pageRef}
      style={{ '--chat-max': `${chatMax !== null && chatMax > 0 ? chatMax : 750}px` } as CSSProperties}
    >
      {/* 左菜单收起时的重开钮：与欢迎页同款浮动左上角（2026-11-20 用户裁定「【|】显示在左上角」），
          不占标题行——大标题恒独占一行 */}
      {onToggleMenu !== undefined && (
        <div className="sx-schedule-nav">
          <button
            type="button"
            className="sx-winbtn sx-menu-reopen"
            aria-label={t('Open menu', '打开菜单')}
            data-tip={t('Open menu', '打开菜单')}
            onClick={onToggleMenu}
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
        </div>
      )}
      {/* 设置页同构页顶：空白拖拽条，只有全局窗控 −□×（按钮全部在内容区） */}
      <div className="sx-schedules-topbar" data-drag-band aria-hidden="true" />
      <div className="sx-schedules-scroll">
        <div className="sx-schedules-content">
          {view.kind === 'list' ? (
            <div className="sx-schedule-head">
              <h1 className="sx-schedule-title">{t('Scheduled tasks', '定时任务')}</h1>
              <div className="sx-schedule-toolbar">
                <div className="sx-schedule-filters" role="group" aria-label={t('Filter', '筛选')}>
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`sx-schedule-filter${filter === f.id ? ' is-active' : ''}`}
                      aria-pressed={filter === f.id}
                      onClick={() => setFilter(f.id)}
                    >
                      {t(f.en, f.zh)}
                    </button>
                  ))}
                </div>
                <div className="sx-schedule-tools">
                  <button type="button" className="sx-iconbtn" aria-label={t('Refresh', '刷新')} onClick={reload}>
                    <RefreshCw size={16} strokeWidth={1.75} />
                  </button>
                  <div className="sx-schedule-create">
                    <button
                      type="button"
                      className="sx-schedule-create-main"
                      onClick={() => setView({ kind: 'config' })}
                    >
                      <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
                      {t('Create scheduled task', '创建定时任务')}
                    </button>
                    {onCreateInChat !== undefined && (
                      <>
                        <button
                          type="button"
                          className="sx-schedule-create-caret"
                          aria-label={t('More create options', '更多创建方式')}
                          aria-haspopup="menu"
                          aria-expanded={createOpen}
                          onClick={() => setCreateOpen((v) => !v)}
                        >
                          <ChevronDown size={14} strokeWidth={1.75} />
                        </button>
                        {createOpen && (
                          <div className="sx-menu-pop sx-schedule-create-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="sx-menuitem"
                              role="menuitem"
                              onClick={() => {
                                setCreateOpen(false);
                                onCreateInChat();
                              }}
                            >
                              <SquarePen size={14} strokeWidth={1.75} aria-hidden="true" />
                              {t('Create in chat', '在会话中创建')}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : view.kind === 'records' ? (
            <div className="sx-schedule-head">
              {/* 大标题恒独占一行（2026-11-20 用户裁定）；返回与任务名在下一行 */}
              <h1 className="sx-schedule-title">{t('Run history', '执行记录')}</h1>
              <div className="sx-schedule-subhead">
                <button type="button" className="sx-schedule-back" onClick={() => backToList(recordsJob?.id)}>
                  <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
                  {t('Back', '返回')}
                </button>
                <span className="sx-schedule-subtitle">{recordsJob?.name ?? ''}</span>
              </div>
            </div>
          ) : null}
          {error !== '' && (
            <p className="sx-schedule-error" role="alert">
              {error}
            </p>
          )}
          {notice !== '' && (
            <p className="sx-schedule-notice" role="status">
              {notice}
            </p>
          )}
          {view.kind === 'list' &&
            (loadFailed && jobs === null ? null : jobs === null ? (
              <p className="sx-schedule-empty">{t('Loading…', '加载中…')}</p>
            ) : visibleJobs.length === 0 ? (
              <p className="sx-schedule-empty">{emptyText(filter)}</p>
            ) : (
              <div className="sx-schedule-grid">
                {visibleJobs.map((job) => (
                  <ScheduleCard
                    key={job.id}
                    job={job}
                    now={now}
                    busy={busyId !== ''}
                    menuOpen={menuId === job.id}
                    confirmDelete={confirmId === job.id}
                    focus={focusId === job.id}
                    cardRef={(el) => {
                      if (el !== null) cardRefs.current.set(job.id, el);
                      else cardRefs.current.delete(job.id);
                    }}
                    onOpen={() => {
                      clearConfirm();
                      setView({ kind: 'records', jobId: job.id });
                    }}
                    onToggle={() => toggle(job)}
                    onMenu={() => {
                      clearConfirm();
                      setMenuId((v) => (v === job.id ? '' : job.id));
                    }}
                    onRun={() => runNow(job)}
                    onRecords={() => {
                      setMenuId('');
                      clearConfirm();
                      setView({ kind: 'records', jobId: job.id });
                    }}
                    onEdit={() => {
                      setMenuId('');
                      clearConfirm();
                      setView({ kind: 'config', editingId: job.id });
                    }}
                    onDelete={() => remove(job)}
                  />
                ))}
              </div>
            ))}
          {view.kind === 'config' && (
            <ScheduleConfig
              conn={conn}
              job={editing}
              defaultModel={defaultModel}
              onSaved={saved}
              onBack={() => backToList(editing?.id)}
            />
          )}
          {view.kind === 'records' && recordsJob !== undefined && (
            <ScheduleRuns conn={conn} job={recordsJob} onOpenSession={onOpenSession} tick={refresh} />
          )}
        </div>
      </div>
    </div>
  );
}
