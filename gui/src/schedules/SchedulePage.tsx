import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, PanelLeft, Plus, RefreshCw } from 'lucide-react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { usePopOutsideClose } from '../use-pop-outside-close';
import type { Connection, ScheduleJobView } from '../connection';
import { ScheduleCard } from './ScheduleCard';
import { ScheduleConfig } from './ScheduleConfig';
import { ScheduleRuns } from './ScheduleRuns';

/**
 * 定时任务页(scheduled-tasks Task 10,spec §9.4):列表/配置/记录三态同页切换,
 * 顶栏恒 chat-topbar 语言(列表=定时任务+刷新+新建;配置/记录=返回+标题)。
 * 列表 10s 静默重拉、1s 倒计时 tick;保存/取消/记录返回后对应卡 is-focus ~1.6s;
 * Esc 层级:配置/记录 → 列表,列表 → onExit。删除两步确认(首点改文案,再点才发)。
 */
export interface SchedulePageProps {
  readonly conn: Connection;
  readonly onOpenSession: (journalId: string, root: string) => void;
  readonly onExit: () => void;
  /** 左侧菜单开合(菜单收起时仍能从本页重开;App 传 toggleMenuStable) */
  readonly onToggleMenu?: () => void;
}

type View = { kind: 'list' } | { kind: 'config'; editingId?: string } | { kind: 'records'; jobId: string };

const FOCUS_MS = 1600;

export function SchedulePage({ conn, onOpenSession, onExit, onToggleMenu }: SchedulePageProps): JSX.Element {
  const [jobs, setJobs] = useState<ScheduleJobView[] | null>(null);
  const [defaultModel, setDefaultModel] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [menuId, setMenuId] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [busyId, setBusyId] = useState('');
  const [focusId, setFocusId] = useState('');
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reload = useCallback(() => setRefresh((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    conn.schedules().then(
      (r) => {
        if (alive) {
          setJobs(r.jobs);
          setDefaultModel(r.defaultModel);
          setError('');
        }
      },
      (e: unknown) => {
        if (alive) setError(errText(e));
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
  useEffect(() => {
    const h = setInterval(reload, 10_000);
    return () => clearInterval(h);
  }, [reload]);
  useEffect(() => {
    if (focusId === '') return;
    const h = setTimeout(() => setFocusId(''), FOCUS_MS);
    return () => clearTimeout(h);
  }, [focusId]);
  useEffect(() => {
    if (notice === '') return;
    const h = setTimeout(() => setNotice(''), 2200);
    return () => clearTimeout(h);
  }, [notice]);
  useEffect(
    () => () => {
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    },
    [],
  );
  usePopOutsideClose(menuId !== '', '.sx-menu-pop', '.sx-schedule-more', () => setMenuId(''));

  const jobOf = (id: string): ScheduleJobView | undefined => (jobs ?? []).find((j) => j.id === id);
  const backToList = useCallback((focus?: string): void => {
    if (focus !== undefined && focus !== '') setFocusId(focus);
    setView({ kind: 'list' });
  }, []);
  const clearConfirm = useCallback((): void => {
    if (confirmTimer.current !== null) {
      clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    setConfirmId('');
  }, []);

  const editing = view.kind === 'config' && view.editingId !== undefined ? jobOf(view.editingId) : undefined;
  const recordsJob = view.kind === 'records' ? jobOf(view.jobId) : undefined;
  const title =
    view.kind === 'list'
      ? t('Scheduled tasks', '定时任务')
      : view.kind === 'config'
        ? editing !== undefined
          ? t('Edit scheduled task', '编辑定时任务')
          : t('New scheduled task', '新建定时任务')
        : `${recordsJob?.name ?? ''} · ${t('Run history', '执行记录')}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // 弹层最内层:先收卡片菜单(与其余弹层 Esc 收口一致),不连带退出页面
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
  }, [view, editing, recordsJob, menuId, backToList, clearConfirm, onExit]);

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
    conn.runScheduleNow(job.id).then(
      () => {
        setNotice(t('Triggered once', '已触发一次执行'));
        setTimeout(reload, 700);
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

  return (
    <div className="sx-schedule-page">
      <header className="chat-topbar sx-schedules-topbar">
        {onToggleMenu !== undefined && (
          <button
            type="button"
            className="sx-iconbtn sx-menu-toggle"
            aria-label={t('Menu', '菜单')}
            onClick={onToggleMenu}
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
        )}
        {view.kind !== 'list' && (
          <button
            type="button"
            className="back"
            onClick={() => backToList(view.kind === 'config' ? editing?.id : recordsJob?.id)}
          >
            <ArrowLeft size={14} strokeWidth={1.75} />
            {t('Back', '返回')}
          </button>
        )}
        <span className="chat-title">{title}</span>
        <span className="sx-schedules-spacer" data-drag-band />
        {view.kind === 'list' && (
          <>
            <button type="button" className="sx-iconbtn" aria-label={t('Refresh', '刷新')} onClick={reload}>
              <RefreshCw size={16} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              className="sx-iconbtn"
              aria-label={t('New task', '新建任务')}
              onClick={() => setView({ kind: 'config' })}
            >
              <Plus size={16} strokeWidth={1.75} />
            </button>
          </>
        )}
      </header>
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
      <div className="sx-schedules-scroll">
        <div className="sx-schedules-content">
          {view.kind === 'list' &&
            (jobs === null ? (
              <p className="sx-schedule-empty">{t('Loading…', '加载中…')}</p>
            ) : jobs.length === 0 ? (
              <p className="sx-schedule-empty">{t('No scheduled tasks yet', '暂无定时任务')}</p>
            ) : (
              <div className="sx-schedule-grid">
                {jobs.map((job) => (
                  <ScheduleCard
                    key={job.id}
                    job={job}
                    now={now}
                    busy={busyId === job.id}
                    menuOpen={menuId === job.id}
                    confirmDelete={confirmId === job.id}
                    focus={focusId === job.id}
                    onOpen={() => setView({ kind: 'records', jobId: job.id })}
                    onToggle={() => toggle(job)}
                    onMenu={() => {
                      clearConfirm();
                      setMenuId((v) => (v === job.id ? '' : job.id));
                    }}
                    onRun={() => runNow(job)}
                    onRecords={() => {
                      setMenuId('');
                      setView({ kind: 'records', jobId: job.id });
                    }}
                    onEdit={() => {
                      setMenuId('');
                      setView({ kind: 'config', editingId: job.id });
                    }}
                    onDelete={() => remove(job)}
                  />
                ))}
              </div>
            ))}
          {view.kind === 'config' && (
            <ScheduleConfig conn={conn} job={editing} defaultModel={defaultModel} onSaved={saved} />
          )}
          {view.kind === 'records' && recordsJob !== undefined && (
            <ScheduleRuns conn={conn} job={recordsJob} onOpenSession={onOpenSession} />
          )}
        </div>
      </div>
    </div>
  );
}
