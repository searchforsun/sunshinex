import { Clock3, Folder, History, MessageSquare, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react';
import { t } from '../i18n';
import { pathBasename } from '../ui-util';
import { SunxIcon } from '../sunx-icon';
import { whenOf, whenSummary } from './cycle';
import type { ScheduleJobView, ScheduleTargetKind } from '../connection';

/**
 * 列表卡(scheduled-tasks Task 10,spec §9.4):恒三行——首行开关+名称+⋯ 菜单、
 * 内容两行截断、倒计时行(停用=已暂停/ended=已结束)。2026-11-21 用户裁定:倒计时行左侧
 * 补调度周期说明(如「每天 00:45 ·」),右端补已运行次数;卡面字号随 --sx-font(≥14px)。
 * 首行名称后补目标 chip(项目/SUNX/通道+目标名)。卡体点击进执行记录;开关/⋯/菜单项
 * 各自 stopPropagation。
 */
interface ScheduleCardProps {
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

/** 目标类型/显示名（2026-11-21 用户裁定「外侧卡片展示三种类型」）：旧任务 target 缺席=项目 */
function targetOf(job: ScheduleJobView): { kind: ScheduleTargetKind; label: string; type: { en: string; zh: string } } {
  const kind: ScheduleTargetKind = job.target === 'sunx' || job.target === 'channel' ? job.target : 'project';
  if (kind === 'sunx') {
    return { kind, label: job.targetLabel ?? t('Sunx session', 'Sunx 会话'), type: { en: 'SUNX', zh: 'SUNX' } };
  }
  if (kind === 'channel') {
    const fallback = [job.targetChannelId, job.targetChatId].filter((x) => x !== undefined && x !== '').join(' · ');
    return { kind, label: job.targetLabel ?? (fallback !== '' ? fallback : t('Channel', '通道')), type: { en: 'Channel', zh: '通道' } };
  }
  const base = job.root === 'default' ? '' : pathBasename(job.root);
  const label = job.targetLabel ?? (base === '' || base === 'default' || base.startsWith('sunshinex-default') ? t('Default workspace', '默认工作区') : base);
  return { kind, label, type: { en: 'Project', zh: '项目' } };
}

export function ScheduleCard(props: ScheduleCardProps): JSX.Element {
  const { job, now, busy, menuOpen, confirmDelete, focus } = props;
  // 周期说明（2026-11-21 用户裁定「左下角最前面补充调度的周期」）：由 recurrence 反推四档口径
  const summary = whenSummary(whenOf({ recurrence: job.recurrence, startAt: job.startAt }));
  const target = targetOf(job);
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
      {/* 目标类型行（2026-11-21 用户裁定三种落点可见）：项目/SUNX/通道 + 目标名。
          独立一行——与名称同挤首行会把任务名截断 */}
      <div className="sx-schedule-target-row">
        <span
          className={`sx-schedule-target-chip is-${target.kind}`}
          data-tip={`${t(target.type.en, target.type.zh)} · ${target.label}`}
        >
          {target.kind === 'project' ? (
            <Folder size={13} strokeWidth={1.75} aria-hidden="true" />
          ) : target.kind === 'sunx' ? (
            <SunxIcon size={15} strokeWidth={1.75} />
          ) : (
            <MessageSquare size={13} strokeWidth={1.75} aria-hidden="true" />
          )}
          <span className="sx-schedule-target-type">{t(target.type.en, target.type.zh)}</span>
          <span className="sx-schedule-target-label">{target.label}</span>
        </span>
      </div>
      <p className="sx-schedule-prompt">{job.prompt}</p>
      <div className="sx-schedule-next">
        <Clock3 size={14} strokeWidth={1.75} />
        <span className="sx-schedule-next-cadence">{t(summary.en, summary.zh)}</span>
        {job.enabled && job.ended !== true && <span className="sx-schedule-next-dot">·</span>}
        <span className="sx-schedule-next-label">{t('Next', '下次')}</span>
        <span className={`count${job.enabled ? '' : ' off'}`}>
          {job.ended === true
            ? t('Ended', '已结束')
            : !job.enabled
              ? t('Paused', '已暂停')
              : countdown((job.nextRunAt ?? now) - now)}
        </span>
        {job.runCount > 0 && (
          <span className="sx-schedule-runcount" data-tip={t('Total runs', '累计运行次数')}>
            {t(`${job.runCount} runs`, `已运行 ${job.runCount} 次`)}
          </span>
        )}
      </div>
    </div>
  );
}
