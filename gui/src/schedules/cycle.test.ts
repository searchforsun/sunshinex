import { describe, it, expect } from 'vitest';
import { CYCLE_OPTIONS, recurrenceOf, cycleOf } from './cycle';

const start = new Date(2026, 10, 20, 9, 30, 0, 0).getTime(); // 2026-11-20 周五 09:30

describe('cycle ↔ recurrence', () => {
  it('每天：at 取 startAt 的 HH:mm', () => {
    expect(recurrenceOf('daily', start)).toEqual({ unit: 'day', every: 1, at: '09:30' });
  });
  it('每周：weekday 取 startAt 的星期（周五=5）', () => {
    expect(recurrenceOf('weekly', start)).toEqual({ unit: 'week', every: 1, weekdays: [5], at: '09:30' });
  });
  it('每月：dayOfMonth 取 startAt 的日', () => {
    expect(recurrenceOf('monthly', start)).toEqual({ unit: 'month', every: 1, dayOfMonth: 20, at: '09:30' });
  });
  it('每年：month/day 取 startAt 的月日', () => {
    expect(recurrenceOf('yearly', start)).toEqual({ unit: 'year', every: 1, month: 11, day: 20, at: '09:30' });
  });
  it('反查：预设 → 原 cycle', () => {
    expect(cycleOf(recurrenceOf('every15m', start))).toBe('every15m');
    expect(cycleOf(recurrenceOf('hourly', start))).toBe('hourly');
    expect(cycleOf(recurrenceOf('daily', start))).toBe('daily');
    expect(cycleOf(recurrenceOf('weekdays', start))).toBe('weekdays');
    expect(cycleOf(recurrenceOf('weekly', start))).toBe('weekly');
    expect(cycleOf(recurrenceOf('monthly', start))).toBe('monthly');
    expect(cycleOf(recurrenceOf('yearly', start))).toBe('yearly');
  });
  it('反查：非预设回 daily（防御）', () => {
    expect(cycleOf({ unit: 'minute', every: 7 })).toBe('daily');
  });
  it('下拉七项全量在场（顺序固定）', () => {
    expect(CYCLE_OPTIONS.map((o) => o.id)).toEqual([
      'every15m', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly',
    ]);
    for (const o of CYCLE_OPTIONS) {
      expect(o.label.en.length).toBeGreaterThan(0);
      expect(o.label.zh.length).toBeGreaterThan(0);
    }
  });
});
