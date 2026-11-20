import type { Recurrence } from './model';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_ITER = 20_000;

function atHM(rec: Recurrence): { h: number; m: number } {
  const [h, m] = (rec.at ?? '00:00').split(':').map(Number);
  return { h: h ?? 0, m: m ?? 0 };
}
function localDate(y: number, m: number, d: number, h: number, mi: number): Date {
  return new Date(y, m, d, h, mi, 0, 0);
}
function dayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}
function isoWeekday(d: Date): number {
  const w = d.getDay();
  return w === 0 ? 7 : w;
}

/** 严格大于 after、且不早于 startAt 的最小触发时刻；越过 until 回 null。 */
export function nextRunAt(rec: Recurrence, startAt: number, after: number, until?: number): number | null {
  const floor = Math.max(startAt, after + 1);
  let candidate: number | null = null;

  if (rec.unit === 'minute') {
    const step = rec.every * MINUTE_MS;
    const k = Math.max(0, Math.ceil((floor - startAt) / step));
    candidate = startAt + k * step;
  } else if (rec.unit === 'hour') {
    const step = rec.every * HOUR_MS;
    const anchor = new Date(startAt);
    anchor.setSeconds(0, 0);
    const a = anchor.getTime();
    const k = Math.max(0, Math.ceil((floor - a) / step));
    candidate = a + k * step;
  } else if (rec.unit === 'day') {
    const { h, m } = atHM(rec);
    const s = new Date(startAt);
    let first = localDate(s.getFullYear(), s.getMonth(), s.getDate(), h, m).getTime();
    if (first < startAt) first = localDate(s.getFullYear(), s.getMonth(), s.getDate() + rec.every, h, m).getTime();
    if (first < floor) {
      const approx = Math.floor((floor - first) / (rec.every * DAY_MS));
      const d0 = new Date(first);
      first = localDate(d0.getFullYear(), d0.getMonth(), d0.getDate() + approx * rec.every, h, m).getTime();
    }
    let cur = first;
    for (let i = 0; i < MAX_ITER && cur < floor; i++) {
      const d = new Date(cur);
      cur = localDate(d.getFullYear(), d.getMonth(), d.getDate() + rec.every, h, m).getTime();
    }
    candidate = cur;
  } else if (rec.unit === 'weekday') {
    const { h, m } = atHM(rec);
    const s = new Date(Math.max(startAt, after + 1));
    let cur = localDate(s.getFullYear(), s.getMonth(), s.getDate(), h, m).getTime();
    if (cur < startAt) {
      cur = localDate(s.getFullYear(), s.getMonth(), s.getDate() + 1, h, m).getTime();
    }
    for (let i = 0; i < 21; i++) {
      if (cur >= startAt && cur > after) {
        const wd = isoWeekday(new Date(cur));
        if (wd >= 1 && wd <= 5) { candidate = cur; break; }
      }
      const d = new Date(cur);
      cur = localDate(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime();
    }
    if (candidate === null) return null;
  } else if (rec.unit === 'week') {
    const { h, m } = atHM(rec);
    const start = new Date(startAt);
    const startWeek = dayNumber(start) - (isoWeekday(start) - 1);
    const wds = new Set(rec.weekdays ?? []);
    const from = new Date(Math.max(startAt, after + 1));
    const cap = Math.min(rec.every * 7 + 21, MAX_ITER);
    for (let i = 0; i < cap; i++) {
      const d = localDate(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m);
      const t = d.getTime();
      if (t < startAt || t <= after) continue;
      const weekIdx = Math.floor((dayNumber(d) - startWeek) / 7);
      if (weekIdx < 0 || weekIdx % rec.every !== 0) continue;
      if (!wds.has(isoWeekday(d))) continue;
      candidate = t;
      break;
    }
    if (candidate === null) return null;
  } else if (rec.unit === 'month') {
    const { h, m } = atHM(rec);
    const start = new Date(startAt);
    const startIdx = start.getFullYear() * 12 + start.getMonth();
    const afterDate = new Date(Math.max(startAt, after + 1));
    const fromIdx = Math.max(startIdx, afterDate.getFullYear() * 12 + afterDate.getMonth() - 1);
    for (let idx = fromIdx, i = 0; i < MAX_ITER; idx++, i++) {
      if ((idx - startIdx) % rec.every !== 0) continue;
      const yy = Math.floor(idx / 12);
      const mm = idx % 12;
      const day = rec.dayOfMonth ?? 1;
      const d = localDate(yy, mm, day, h, m);
      if (d.getMonth() !== mm) continue;
      const t = d.getTime();
      if (t < startAt || t <= after) continue;
      candidate = t;
      break;
    }
    if (candidate === null) return null;
  } else {
    const { h, m } = atHM(rec);
    const start = new Date(startAt);
    const month = (rec.month ?? 1) - 1;
    const day = rec.day ?? 1;
    const afterDate = new Date(Math.max(startAt, after + 1));
    const fromYear = Math.max(start.getFullYear(), afterDate.getFullYear() - 1);
    for (let y = fromYear, i = 0; i < MAX_ITER; y++, i++) {
      if ((y - start.getFullYear()) % rec.every !== 0) continue;
      const d = localDate(y, month, day, h, m);
      if (d.getMonth() !== month || d.getDate() !== day) continue;
      const t = d.getTime();
      if (t < startAt || t <= after) continue;
      candidate = t;
      break;
    }
    if (candidate === null) return null;
  }

  if (until !== undefined && candidate > until) return null;
  return candidate;
}
