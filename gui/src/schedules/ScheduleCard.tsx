import { Clock3, History, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react';
import { t } from '../i18n';
import type { ScheduleJobView } from '../connection';

/**
 * 列表卡(scheduled-tasks Task 10,spec §9.4):恒三行——首行开关+名称+⋯ 菜单、
 * 内容两行截断、倒计时行(停用=已暂停/ended=已结束)。工作区/强度/上次运行徽标不落卡面。
 * 卡体点击进执行记录;开关/⋯/菜单项各自 stopPropagation,不误触卡体跳转。
 */
export interface ScheduleCardProps {
  readonly job: ScheduleJobView;
  readonly now: number;
  readonly busy: boolean;
  readonly menuOpen: boolean;
  readonly confirmDelete: boolean;
  readonly focus: boolean;
  /** 卡根 ref 回调(SchedulePage 按 id 收表:保存/取消后 scrollIntoView 定位) */
  readonly cardRef?: (el: HTMLDivElement | null) => void;
  readonly onOpen: () => void;
  readonly onToggle: () => void;
  readonly onMenu: () => void;
  readonly onRun: () => void;
  readonly onRecords: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

/** 距下次触发的相对文案(秒/分/时/天四档;≤0=即将执行) */
function countdown(ms: number): string {
  if (ms <= 0) return t('Due now', '即将执行');
  const s = Math.floor(ms / 1000);
  if (s < 60) return t(`${s}s`, `${s} 秒后`);
  const m = Math.floor(s / 60);
  if (m < 60) return t(`${m}m`, `${m} 分后`);
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return t(`${h}h${rm > 0 ? ` ${rm}m` : ''}`, `${h} 小时${rm > 0 ? ` ${rm} 分` : ''}后`);
  return t(`${Math.floor(h / 24)}d ${h % 24}h`, `${Math.floor(h / 24)} 天 ${h % 24} 小时后`);
}

export function ScheduleCard(props: ScheduleCardProps): JSX.Element {
  const { job, now, busy, menuOpen, confirmDelete, focus } = props;
  return (
    <div
      className={`sx-schedule-card${job.enabled ? '' : ' is-off'}${focus ? ' is-focus' : ''}`}
      ref={props.cardRef}
      onClick={props.onOpen}
    >
      <div className="sx-schedule-card-top">
        <button
          type="button"
          role="switch"
          aria-checked={job.enabled}
          aria-label={job.enabled ? t('Disable', '停用') : t('Enable', '启用')}
          className={`sx-switch${job.enabled ? ' on' : ''}`}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle();
          }}
        >
          <span className="knob" />
        </button>
        <span className="sx-schedule-name">{job.name}</span>
        <button
          type="button"
          className="sx-iconbtn sx-schedule-more"
          aria-label={t('More', '更多')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            props.onMenu();
          }}
        >
          <MoreHorizontal size={16} strokeWidth={1.75} />
        </button>
        {menuOpen && (
          <div className="sx-menu-pop" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="sx-menuitem" onClick={props.onRun}>
              <Play size={14} strokeWidth={1.75} />
              {t('Run now', '立即执行')}
            </button>
            <button type="button" className="sx-menuitem" onClick={props.onRecords}>
              <History size={14} strokeWidth={1.75} />
              {t('Run history', '执行记录')}
            </button>
            <button type="button" className="sx-menuitem" onClick={props.onEdit}>
              <Pencil size={14} strokeWidth={1.75} />
              {t('Edit', '编辑')}
            </button>
            <button
              type="button"
              className={`sx-menuitem${confirmDelete ? ' sx-schedule-danger' : ''}`}
              onClick={props.onDelete}
            >
              <Trash2 size={14} strokeWidth={1.75} />
              {confirmDelete ? t('Confirm delete', '确认删除') : t('Delete', '删除')}
            </button>
          </div>
        )}
      </div>
      <p className="sx-schedule-prompt">{job.prompt}</p>
      <div className="sx-schedule-next">
        <Clock3 size={14} strokeWidth={1.75} />
        <span>{t('Next', '下次')}</span>
        <span className={`count${job.enabled ? '' : ' off'}`}>
          {job.ended === true
            ? t('Ended', '已结束')
            : !job.enabled
              ? t('Paused', '已暂停')
              : countdown((job.nextRunAt ?? now) - now)}
        </span>
      </div>
    </div>
  );
}
