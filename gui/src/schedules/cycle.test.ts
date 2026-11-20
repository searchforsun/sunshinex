import { describe, it, expect } from 'vitest';
import { buildWhen, whenOf, whenSummary, weekdayListLabel } from './cycle';
import type { ScheduleWhen } from './cycle';

const hourly = (minute: number): ScheduleWhen => ({ cadence: 'hourly', hour: 0, minute, weekdays: [1], dayOfMonth: 1 });
const daily = (hour: number, minute: number): ScheduleWhen => ({ cadence: 'daily', hour, minute, weekdays: [1], dayOfMonth: 1 });

describe('调度值映射（周期 → recurrence/锚点）', () => {
  it('whenOf：新建缺省每天 09:00；四档识别；分钟/年/多倍间隔归 custom', () => {
    expect(whenOf()).toEqual({ cadence: 'daily', hour: 9, minute: 0, weekdays: [1], dayOfMonth: 1 });
    const start = new Date(2026, 10, 20, 10, 42, 0, 0).getTime();
    expect(whenOf({ recurrence: { unit: 'hour', every: 1 }, startAt: start })).toMatchObject({ cadence: 'hourly', minute: 42 });
    expect(whenOf({ recurrence: { unit: 'day', every: 1, at: '08:15' }, startAt: start })).toMatchObject({ cadence: 'daily', hour: 8, minute: 15 });
    expect(whenOf({ recurrence: { unit: 'weekday', every: 1, at: '08:15' }, startAt: start })).toMatchObject({ cadence: 'weekly', weekdays: [1, 2, 3, 4, 5] });
    expect(whenOf({ recurrence: { unit: 'week', every: 1, weekdays: [3, 1], at: '10:30' }, startAt: start })).toMatchObject({ cadence: 'weekly', weekdays: [1, 3], hour: 10, minute: 30 });
    expect(whenOf({ recurrence: { unit: 'month', every: 1, dayOfMonth: 5, at: '07:00' }, startAt: start })).toMatchObject({ cadence: 'monthly', dayOfMonth: 5 });
    expect(whenOf({ recurrence: { unit: 'year', every: 1, month: 3, day: 5, at: '09:00' }, startAt: start }).cadence).toBe('custom');
    expect(whenOf({ recurrence: { unit: 'minute', every: 15 }, startAt: start }).cadence).toBe('custom');
    expect(whenOf({ recurrence: { unit: 'day', every: 2, at: '09:00' }, startAt: start }).cadence).toBe('custom');
  });

  it('hourly：锚点=当前小时+选中分钟（秒/毫秒清零），engine 自行快进到未来', () => {
    const now = new Date(2026, 10, 20, 10, 40, 12, 345).getTime();
    const built = buildWhen(hourly(30), now);
    expect(built.recurrence).toEqual({ unit: 'hour', every: 1 });
    const anchor = new Date(built.startAt);
    expect([anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), anchor.getMilliseconds()]).toEqual([10, 30, 0, 0]);
  });

  it('daily/weekly/monthly：startAt=now，at=HH:mm；weekdays 去重排序；custom 原样保留', () => {
    const now = new Date(2026, 10, 20, 10, 40, 0, 0).getTime();
    expect(buildWhen(daily(9, 5), now)).toEqual({ recurrence: { unit: 'day', every: 1, at: '09:05' }, startAt: now });
    expect(
      buildWhen({ cadence: 'weekly', hour: 10, minute: 30, weekdays: [5, 1, 3, 3], dayOfMonth: 1 }, now),
    ).toEqual({ recurrence: { unit: 'week', every: 1, weekdays: [1, 3, 5], at: '10:30' }, startAt: now });
    expect(
      buildWhen({ cadence: 'monthly', hour: 7, minute: 0, weekdays: [1], dayOfMonth: 15 }, now),
    ).toEqual({ recurrence: { unit: 'month', every: 1, dayOfMonth: 15, at: '07:00' }, startAt: now });
    const custom = { recurrence: { unit: 'year' as const, every: 1, month: 3, day: 5, at: '09:00' }, startAt: 123 };
    expect(buildWhen({ cadence: 'custom', hour: 9, minute: 0, weekdays: [1], dayOfMonth: 1 }, now, custom)).toEqual(custom);
  });

  it('人话说明/星期标签：不同周期不同文案；每 + 周一、周三 不叠「周周」', () => {
    expect(whenSummary({ cadence: 'hourly', hour: 0, minute: 30, weekdays: [1], dayOfMonth: 1 })).toEqual({
      en: 'Hourly at :30',
      zh: '每小时第 30 分钟',
    });
    expect(whenSummary(daily(9, 0)).zh).toBe('每天 09:00');
    expect(whenSummary({ cadence: 'weekly', hour: 9, minute: 0, weekdays: [1, 3], dayOfMonth: 1 })).toEqual({
      en: 'Weekly on Mon, Wed at 09:00',
      zh: '每周一、周三 09:00',
    });
    expect(whenSummary({ cadence: 'monthly', hour: 9, minute: 0, weekdays: [1], dayOfMonth: 15 }).zh).toBe('每月 15 日 09:00');
    expect(whenSummary({ cadence: 'custom', hour: 9, minute: 0, weekdays: [1], dayOfMonth: 1 }).zh).toBe('沿用原有自定义周期');
    expect(weekdayListLabel([5, 1, 3, 3])).toEqual({ en: 'Mon, Wed, Fri', zh: '周一、周三、周五' });
  });
});
