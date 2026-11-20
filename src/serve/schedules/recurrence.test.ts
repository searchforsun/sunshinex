import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRunAt } from './recurrence';
import { validateRecurrence } from './model';
import type { Recurrence } from './model';

const at = (y: number, m: number, d: number, h: number, mi = 0): number => new Date(y, m - 1, d, h, mi, 0, 0).getTime();
const local = (t: number | null): number[] | null => {
  if (t === null) return null;
  const d = new Date(t);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

const cases: Array<{ name: string; rec: Recurrence; start: number; after: number; until?: number; want: number[] | null }> = [
  { name: 'minute：相位锚定且严格大于 after', rec: { unit: 'minute', every: 15 }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 20, 9, 0) - 1, want: [2026, 11, 20, 9, 0] },
  { name: 'minute：after=触发点 → 下一相位', rec: { unit: 'minute', every: 15 }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 20, 9, 0), want: [2026, 11, 20, 9, 15] },
  { name: 'hour：分钟位跟随 startAt', rec: { unit: 'hour', every: 1 }, start: at(2026, 11, 20, 9, 7), after: at(2026, 11, 20, 9, 7), want: [2026, 11, 20, 10, 7] },
  { name: 'day：每天 09:00', rec: { unit: 'day', every: 1, at: '09:00' }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 20, 9, 0), want: [2026, 11, 21, 9, 0] },
  { name: 'day：每 3 天', rec: { unit: 'day', every: 3, at: '09:00' }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 20, 9, 0), want: [2026, 11, 23, 9, 0] },
  { name: 'day：start 在将来（第一次=start）', rec: { unit: 'day', every: 1, at: '09:00' }, start: at(2026, 11, 22, 9, 0), after: at(2026, 11, 20, 12, 0), want: [2026, 11, 22, 9, 0] },
  { name: 'weekday：跳过周末', rec: { unit: 'weekday', every: 1, at: '09:00' }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 20, 9, 0), want: [2026, 11, 23, 9, 0] },
  { name: 'week：每周一', rec: { unit: 'week', every: 1, weekdays: [1], at: '09:00' }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 20, 9, 0), want: [2026, 11, 23, 9, 0] },
  { name: 'week：每周五（下一次在下周）', rec: { unit: 'week', every: 1, weekdays: [5], at: '09:00' }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 20, 9, 0), want: [2026, 11, 27, 9, 0] },
  { name: 'month：每月 20 日', rec: { unit: 'month', every: 1, dayOfMonth: 20, at: '09:00' }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 20, 9, 0), want: [2026, 12, 20, 9, 0] },
  { name: 'month：31 日遇短月跳过', rec: { unit: 'month', every: 1, dayOfMonth: 31, at: '09:00' }, start: at(2026, 1, 31, 9, 0), after: at(2026, 1, 31, 9, 0), want: [2026, 3, 31, 9, 0] },
  { name: 'year：每年 6/1', rec: { unit: 'year', every: 1, month: 6, day: 1, at: '09:00' }, start: at(2026, 6, 1, 9, 0), after: at(2026, 6, 1, 9, 0), want: [2027, 6, 1, 9, 0] },
  { name: 'year：2/29 只在闰年', rec: { unit: 'year', every: 1, month: 2, day: 29, at: '09:00' }, start: at(2024, 2, 29, 9, 0), after: at(2024, 2, 29, 9, 0), want: [2028, 2, 29, 9, 0] },
  { name: 'until：含边界', rec: { unit: 'day', every: 1, at: '09:00' }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 20, 9, 0), until: at(2026, 11, 21, 9, 0), want: [2026, 11, 21, 9, 0] },
  { name: 'until：越过即结束', rec: { unit: 'day', every: 1, at: '09:00' }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 20, 9, 0), until: at(2026, 11, 21, 8, 59), want: null },
  { name: 'start 过去：从 after 向前推', rec: { unit: 'day', every: 1, at: '09:00' }, start: at(2026, 11, 20, 9, 0), after: at(2026, 11, 22, 10, 0), want: [2026, 11, 23, 9, 0] },
];

for (const c of cases) {
  test(c.name, () => {
    assert.deepEqual(local(nextRunAt(c.rec, c.start, c.after, c.until)), c.want);
  });
}

test('validateRecurrence：合法/非法', () => {
  assert.equal(validateRecurrence({ unit: 'day', every: 1, at: '09:00' }).ok, true);
  assert.equal(validateRecurrence({ unit: 'week', every: 1, at: '09:00', weekdays: [1, 3] }).ok, true);
  for (const bad of [
    { unit: 'nope', every: 1 },
    { unit: 'minute', every: 0 },
    { unit: 'day', every: 1, at: '24:00' },
    { unit: 'week', every: 1, at: '09:00', weekdays: [] },
    { unit: 'month', every: 1, at: '09:00', dayOfMonth: 32 },
    { unit: 'year', every: 1, at: '09:00', month: 13, day: 1 },
  ]) {
    assert.equal(validateRecurrence(bad).ok, false, JSON.stringify(bad));
  }
});
