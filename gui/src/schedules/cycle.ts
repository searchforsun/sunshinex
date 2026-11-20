import type { ScheduleRecurrence } from '../connection-types';

/** 配置页调度口径（2026-11-20 用户裁定「调度一行、不同周期不同时间、最大是月、去掉开始时间」）：
 *  hourly/daily/weekly/monthly 四档自适应控件；custom=编辑既有非四档（分钟/年/多倍间隔）任务时
 *  保留原 recurrence 不动，避免静默改语义。所有时间取本地墙钟 HH:mm。 */
export type ScheduleCadence = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

export interface ScheduleWhen {
  cadence: ScheduleCadence;
  /** 0..23（daily/weekly/monthly 的时间；hourly 不用） */
  hour: number;
  /** 0..59（hourly 的分钟锚；daily/weekly/monthly 的分钟） */
  minute: number;
  /** ISO 星期 1=周一..7=周日（weekly 用；有序去重） */
  weekdays: number[];
  /** 1..31（monthly 用） */
  dayOfMonth: number;
}

/** 周期下拉四档（custom 不出现在新建下拉；编辑既有自定义任务时由 whenOf 识别） */
export const CADENCE_OPTIONS: ReadonlyArray<{ id: Exclude<ScheduleCadence, 'custom'>; label: { en: string; zh: string } }> = [
  { id: 'hourly', label: { en: 'Hourly', zh: '每小时' } },
  { id: 'daily', label: { en: 'Daily', zh: '每天' } },
  { id: 'weekly', label: { en: 'Weekly', zh: '每周' } },
  { id: 'monthly', label: { en: 'Monthly', zh: '每月' } },
];

const WEEKDAY_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function hhmm(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** 本地时间戳 → `YYYY-MM-DD HH:mm`（截止时间展示/测试稳定格式） */
export function formatStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function weekdayLabel(day: number): { en: string; zh: string } {
  return { en: WEEKDAY_EN[day - 1] ?? '', zh: WEEKDAY_ZH[day - 1] ?? '' };
}

export function weekdayListLabel(days: readonly number[]): { en: string; zh: string } {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  return {
    en: sorted.map((d) => WEEKDAY_EN[d - 1] ?? '').join(', '),
    zh: sorted.map((d) => WEEKDAY_ZH[d - 1] ?? '').join('、'),
  };
}

/** HH:mm → {h,m}（坏值回落 09:00） */
function parseAt(at: string | undefined, fallbackTs: number): { h: number; m: number } {
  const m = at !== undefined ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at) : null;
  if (m !== null) return { h: Number(m[1]), m: Number(m[2]) };
  const d = new Date(fallbackTs);
  return { h: d.getHours(), m: d.getMinutes() };
}

/** 既有任务 → 编辑态调度值；四档外（minute/year/多倍 every）判 custom，弹层控件仍填合理初值。 */
export function whenOf(src?: { recurrence: ScheduleRecurrence; startAt: number }): ScheduleWhen {
  const fallback: ScheduleWhen = { cadence: 'daily', hour: 9, minute: 0, weekdays: [1], dayOfMonth: 1 };
  if (src === undefined) return fallback;
  const { recurrence: rec, startAt } = src;
  const d = new Date(startAt);
  const { h, m } = parseAt(rec.at, startAt);
  const base = {
    hour: h,
    minute: rec.unit === 'hour' ? d.getMinutes() : m,
    weekdays: rec.unit === 'week' && rec.weekdays !== undefined && rec.weekdays.length > 0 ? [...new Set(rec.weekdays)].sort((a, b) => a - b) : [1],
    dayOfMonth: rec.dayOfMonth ?? d.getDate(),
  };
  if (rec.unit === 'hour' && rec.every === 1) return { cadence: 'hourly', ...base };
  if (rec.unit === 'day' && rec.every === 1) return { cadence: 'daily', ...base };
  if (rec.unit === 'weekday') return { cadence: 'weekly', ...base, weekdays: [1, 2, 3, 4, 5] };
  if (rec.unit === 'week' && rec.every === 1) return { cadence: 'weekly', ...base };
  if (rec.unit === 'month' && rec.every === 1) return { cadence: 'monthly', ...base };
  return { cadence: 'custom', ...base };
}

/** 调度值 → 存储 recurrence + 开始锚（去掉用户可见开始时间后由周期反推）：
 *  - hourly：锚=今天当前小时 + 选中分钟（秒/毫秒清零）——engine 的 hour 步进以 startAt 为相位，
 *    「每小时第 N 分钟」由此成立；
 *  - daily/weekly/monthly：startAt=now，recurrence.at 承载时刻；
 *  - custom：原样保留既有 recurrence/startAt（没有既有任务时回落 daily）。 */
export function buildWhen(
  when: ScheduleWhen,
  now: number,
  custom?: { recurrence: ScheduleRecurrence; startAt: number },
): { recurrence: ScheduleRecurrence; startAt: number } {
  if (when.cadence === 'custom') {
    if (custom !== undefined) return { recurrence: custom.recurrence, startAt: custom.startAt };
    return { recurrence: { unit: 'day', every: 1, at: hhmm(when.hour, when.minute) }, startAt: now };
  }
  if (when.cadence === 'hourly') {
    const anchor = new Date(now);
    anchor.setHours(anchor.getHours(), when.minute, 0, 0);
    return { recurrence: { unit: 'hour', every: 1 }, startAt: anchor.getTime() };
  }
  if (when.cadence === 'daily') {
    return { recurrence: { unit: 'day', every: 1, at: hhmm(when.hour, when.minute) }, startAt: now };
  }
  if (when.cadence === 'weekly') {
    const days = [...new Set(when.weekdays)].sort((a, b) => a - b);
    return {
      recurrence: { unit: 'week', every: 1, weekdays: days.length > 0 ? days : [1], at: hhmm(when.hour, when.minute) },
      startAt: now,
    };
  }
  return {
    recurrence: { unit: 'month', every: 1, dayOfMonth: when.dayOfMonth, at: hhmm(when.hour, when.minute) },
    startAt: now,
  };
}

/** 周期人话说明（「不同周期显示不同开始时间说明」的文案源；渲染期 t() 求值） */
export function whenSummary(when: ScheduleWhen): { en: string; zh: string } {
  const time = hhmm(when.hour, when.minute);
  switch (when.cadence) {
    case 'hourly':
      return { en: `Hourly at :${pad2(when.minute)}`, zh: `每小时第 ${when.minute} 分钟` };
    case 'daily':
      return { en: `Daily at ${time}`, zh: `每天 ${time}` };
    case 'weekly':
      return {
        en: `Weekly on ${weekdayListLabel(when.weekdays).en} at ${time}`,
        zh: `每${weekdayListLabel(when.weekdays).zh} ${time}`,
      };
    case 'monthly':
      return { en: `Monthly on day ${when.dayOfMonth} at ${time}`, zh: `每月 ${when.dayOfMonth} 日 ${time}` };
    case 'custom':
      return { en: 'Keep the existing custom cadence', zh: '沿用原有自定义周期' };
  }
}
