import type { ScheduleCycle, ScheduleRecurrence } from '../connection-types';

/** 周期下拉单点（GUI 只写预设七值；label 双语沿 i18n 面惯例） */
export const CYCLE_OPTIONS: ReadonlyArray<{ id: ScheduleCycle; label: { en: string; zh: string } }> = [
  { id: 'every15m', label: { en: 'Every 15 minutes', zh: '每 15 分钟' } },
  { id: 'hourly', label: { en: 'Hourly', zh: '每小时' } },
  { id: 'daily', label: { en: 'Daily', zh: '每天' } },
  { id: 'weekdays', label: { en: 'Weekdays', zh: '工作日' } },
  { id: 'weekly', label: { en: 'Weekly', zh: '每周' } },
  { id: 'monthly', label: { en: 'Monthly', zh: '每月' } },
  { id: 'yearly', label: { en: 'Yearly', zh: '每年' } },
];

/** HH:mm（本地时区——startAt 取用户选的开始时刻） */
function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** ISO 星期：1=周一..7=周日（JS getDay 周日=0 需折算） */
function isoWeekday(ts: number): number {
  const w = new Date(ts).getDay();
  return w === 0 ? 7 : w;
}

/** 周期下拉 + 开始时间（锚点）→ 存储 recurrence：at/weekday/dayOfMonth/month+day 均取 startAt 分量 */
export function recurrenceOf(cycle: ScheduleCycle, startAt: number): ScheduleRecurrence {
  const at = hhmm(startAt);
  switch (cycle) {
    case 'every15m': return { unit: 'minute', every: 15 };
    case 'hourly': return { unit: 'hour', every: 1 };
    case 'daily': return { unit: 'day', every: 1, at };
    case 'weekdays': return { unit: 'weekday', every: 1, at };
    case 'weekly': return { unit: 'week', every: 1, weekdays: [isoWeekday(startAt)], at };
    case 'monthly': return { unit: 'month', every: 1, dayOfMonth: new Date(startAt).getDate(), at };
    case 'yearly': {
      const d = new Date(startAt);
      return { unit: 'year', every: 1, month: d.getMonth() + 1, day: d.getDate(), at };
    }
  }
}

/** 存储 recurrence → 周期下拉（GUI 只写预设；非预设防御回 daily——认不出不误删任务） */
export function cycleOf(rec: ScheduleRecurrence): ScheduleCycle {
  if (rec.unit === 'minute' && rec.every === 15) return 'every15m';
  if (rec.unit === 'hour' && rec.every === 1) return 'hourly';
  if (rec.unit === 'day') return 'daily';
  if (rec.unit === 'weekday') return 'weekdays';
  if (rec.unit === 'week') return 'weekly';
  if (rec.unit === 'month') return 'monthly';
  if (rec.unit === 'year') return 'yearly';
  return 'daily';
}
