import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { Connection, ScheduleJobView, ScheduleRunStatus, ScheduleRunView, ScheduleRunTrigger } from '../connection';

/**
 * 任务执行记录表(scheduled-tasks Task 9,spec §9.5):
 * 触发方式/计划时间/开始时间/状态/耗时/会话六列;状态只用项目 `.tb-status-dot`(五态点+转圈),
 * 失败原因 err 色、跳过/中断原因与补跑延迟灰字,会话列 accent 文本链直开 journal 会话。
 * 取数单点 conn.scheduleRuns(job.id),挂载/任务切换重取;空态与取数失败各有独立文案。
 */
export interface ScheduleRunsProps {
  readonly conn: Connection;
  readonly job: ScheduleJobView;
  readonly onOpenSession: (journalId: string, root: string) => void;
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

/** 时间戳 → 本地 `MM-DD HH:mm`(缺值=—;记录表窄列,不铺年份) */
function timeLabel(ts: number | undefined): string {
  if (ts === undefined) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleRuns({ conn, job, onOpenSession }: ScheduleRunsProps): JSX.Element {
  const [runs, setRuns] = useState<ScheduleRunView[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setRuns(null);
    setError('');
    conn.scheduleRuns(job.id).then(
      (r) => { if (alive) setRuns(r.runs); },
      (e: unknown) => { if (alive) setError(errText(e)); },
    );
    return () => { alive = false; };
  }, [conn, job.id]);
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
                <td>{t(TRIGGER_LABEL[run.trigger].en, TRIGGER_LABEL[run.trigger].zh)}</td>
                <td className="num">{timeLabel(run.scheduledAt)}</td>
                <td className="num">{timeLabel(run.startedAt)}</td>
                <td>
                  <span className="sx-schedule-status"><span className={`tb-status-dot ${STATUS_CLASS[run.status]}`} />{t(STATUS_LABEL[run.status].en, STATUS_LABEL[run.status].zh)}</span>
                  {run.status === 'succeeded' && run.scheduledAt !== undefined && run.startedAt - run.scheduledAt > 60_000 ? (
                    <div className="sx-schedule-note">{t('Late', '延迟')} {Math.round((run.startedAt - run.scheduledAt) / 60_000)} {t('min', '分钟')}</div>
                  ) : null}
                  {run.error !== undefined ? (
                    <div className={run.status === 'failed' ? 'sx-schedule-err' : 'sx-schedule-note'}>{run.error}</div>
                  ) : null}
                </td>
                <td className="num">{run.seconds !== undefined ? `${run.seconds} ${t('s', '秒')}` : '—'}</td>
                <td>{run.journalId !== undefined ? (
                  <button type="button" className="sx-schedule-open" onClick={() => onOpenSession(run.journalId!, run.root)}>
                    {t('Open session', '打开会话')} <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
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
