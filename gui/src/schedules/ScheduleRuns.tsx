import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { Connection, ScheduleJobView, ScheduleRunStatus, ScheduleRunView, ScheduleRunTrigger } from '../connection';

/**
 * 任务执行记录表(scheduled-tasks Task 9,spec §9.5):
 * 触发方式/计划时间/开始时间/状态/耗时/会话六列;状态只用项目 `.tb-status-dot`(五态点+转圈),
 * 失败原因 err 色、跳过/中断原因与补跑延迟灰字,会话列 accent 文本链直开 journal 会话。
 * 取数单点 conn.scheduleRuns(job.id),挂载/任务切换重取;`tick`(页面轮询计数)变化时静默刷新
 * (旧行保留,不闪加载态——配合列表 10s 重拉,运行中记录到点转终态);空态与取数失败各有独立文案。
 */
interface ScheduleRunsProps {
  readonly conn: Connection;
  readonly job: ScheduleJobView;
  readonly onOpenSession: (journalId: string, root: string) => void;
  /** 页面轮询计数(SchedulePage 的 refresh):变化即后台重取记录,保留旧行 */
  readonly tick?: number;
}

const STATUS_CLASS: Record<ScheduleRunStatus, string> = {
  succeeded: 'task-status-success',
  failed: 'task-status-failed',
  skipped: 'task-status-cancelled',
  interrupted: 'task-status-cancelled',
  stopped: 'task-status-cancelled',
  running: 'task-status-running',
};
const STATUS_LABEL: Record<ScheduleRunStatus, { en: string; zh: string }> = {
  succeeded: { en: 'Succeeded', zh: '成功' },
  failed: { en: 'Failed', zh: '失败' },
  skipped: { en: 'Skipped', zh: '跳过' },
  interrupted: { en: 'Interrupted', zh: '已中断' },
  stopped: { en: 'Stopped', zh: '已停止' },
  running: { en: 'Running', zh: '运行中' },
};
const TRIGGER_LABEL: Record<ScheduleRunTrigger, { en: string; zh: string }> = {
  schedule: { en: 'Schedule', zh: '定时' },
  'catch-up': { en: 'Catch-up', zh: '补跑' },
  manual: { en: 'Manual', zh: '手动' },
};
/** 未知枚举值容错(旧档/前瞻字段):原样显示,状态点走 cancelled 灰,不让一条坏行炸整表 */
function statusLabel(s: ScheduleRunStatus): { en: string; zh: string } {
  return STATUS_LABEL[s] ?? { en: String(s), zh: String(s) };
}
function statusClass(s: ScheduleRunStatus): string {
  return STATUS_CLASS[s] ?? 'task-status-cancelled';
}
function triggerLabel(tr: ScheduleRunTrigger): { en: string; zh: string } {
  return TRIGGER_LABEL[tr] ?? { en: String(tr), zh: String(tr) };
}

/** 时间戳 → 本地 `MM-DD HH:mm`(缺值=—;记录表窄列,不铺年份) */
function timeLabel(ts: number | undefined): string {
  if (ts === undefined) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 耗时 → 时/分/秒（2026-11-21 用户裁定「这个显示应该是时分秒」）：不足 1 分只显示秒，
 *  不足 1 时显示分+秒，≥1 时显示时+分+秒；原始秒数四舍五入为整数。 */
function durationLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return t(`${h} h ${m} min ${s} s`, `${h} 时 ${m} 分 ${s} 秒`);
  if (m > 0) return t(`${m} min ${s} s`, `${m} 分 ${s} 秒`);
  return t(`${s} s`, `${s} 秒`);
}

export function ScheduleRuns({ conn, job, onOpenSession, tick }: ScheduleRunsProps): JSX.Element {
  const [state, setState] = useState<{ runs: ScheduleRunView[] | null; error: string }>({ runs: null, error: '' });
  /** 已取数任务 id:仅任务切换才清行回加载态;同任务 tick/重挂静默刷新保留旧行 */
  const shownId = useRef('');
  useEffect(() => {
    let alive = true;
    if (shownId.current !== job.id) {
      shownId.current = job.id;
      setState({ runs: null, error: '' });
    }
    conn.scheduleRuns(job.id).then(
      (r) => { if (alive) setState({ runs: r.runs, error: '' }); },
      (e: unknown) => {
        // 首拉失败=整表错误态;轮询刷新失败保留旧行静默(网络抖一下不该把记录表打回错误页)
        if (alive) setState((s) => (s.runs === null ? { runs: null, error: errText(e) } : s));
      },
    );
    return () => { alive = false; };
  }, [conn, job.id, tick]);
  const { runs, error } = state;
  return (
    <div className="sx-schedule-records">
      {error !== '' ? (
        <p className="sx-schedule-error" role="alert">{error}</p>
      ) : runs === null ? (
        <p className="sx-schedule-empty">{t('Loading…', '加载中…')}</p>
      ) : runs.length === 0 ? (
        <p className="sx-schedule-empty">{t('No runs yet', '暂无执行记录')}</p>
      ) : (
        <table className="sx-schedule-table">
          <thead>
            <tr>
              <th>{t('Trigger', '触发方式')}</th>
              <th>{t('Scheduled', '计划时间')}</th>
              <th>{t('Started', '开始时间')}</th>
              <th>{t('Status', '状态')}</th>
              <th>{t('Duration', '耗时')}</th>
              <th>{t('Session', '会话')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{t(triggerLabel(run.trigger).en, triggerLabel(run.trigger).zh)}</td>
                <td className="num">{timeLabel(run.scheduledAt)}</td>
                <td className="num">{timeLabel(run.startedAt)}</td>
                <td>
                  <span className="sx-schedule-status"><span className={`tb-status-dot ${statusClass(run.status)}`} aria-hidden="true" />{t(statusLabel(run.status).en, statusLabel(run.status).zh)}</span>
                  {run.status === 'succeeded' && run.scheduledAt !== undefined && run.startedAt - run.scheduledAt > 60_000 ? (
                    <div className="sx-schedule-note">{t('Late', '延迟')} {Math.round((run.startedAt - run.scheduledAt) / 60_000)} {t('min', '分钟')}</div>
                  ) : null}
                  {run.error !== undefined ? (
                    <div className={run.status === 'failed' ? 'sx-schedule-err' : 'sx-schedule-note'}>{run.error}</div>
                  ) : null}
                </td>
                <td className="num">{run.seconds !== undefined ? durationLabel(run.seconds) : '—'}</td>
                <td>{run.journalId !== undefined ? (
                  <button type="button" className="sx-schedule-open" onClick={() => onOpenSession(run.journalId!, run.root)}>
                    {t('Open session', '打开会话')} <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                ) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
