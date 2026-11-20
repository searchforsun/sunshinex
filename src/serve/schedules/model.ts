import type { ReasoningEffort } from '../../types';

export type CadenceUnit = 'minute' | 'hour' | 'day' | 'weekday' | 'week' | 'month' | 'year';
export type ScheduleMode = 'read-only' | 'acceptEdits' | 'full-access';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped' | 'skipped' | 'interrupted';
export type RunTrigger = 'schedule' | 'catch-up' | 'manual';

export interface Recurrence {
  unit: CadenceUnit;
  every: number;
  at?: string;
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  day?: number;
}

export interface RunRecord {
  id: string;
  trigger: RunTrigger;
  scheduledAt?: number;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  sessionId?: string;
  journalId?: string;
  root: string;
  error?: string;
  seconds?: number;
}

export interface ScheduleJob {
  id: string;
  name: string;
  prompt: string;
  root: string;
  effort: ReasoningEffort;
  mode: ScheduleMode;
  recurrence: Recurrence;
  startAt: number;
  until?: number;
  enabled: boolean;
  ended?: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  runs: RunRecord[];
}

export interface StoreFile {
  version: 1;
  jobs: ScheduleJob[];
}

export interface ScheduleDraft {
  name: string;
  prompt: string;
  root: string;
  effort: ReasoningEffort;
  mode: ScheduleMode;
  recurrence: Recurrence;
  startAt: number;
  until?: number;
}

export interface ScheduleJobView extends Omit<ScheduleJob, 'runs'> {
  runCount: number;
  lastRun?: RunRecord;
}

export const SCHEDULE_RUN_LIMIT = 100;

const UNITS: readonly CadenceUnit[] = ['minute', 'hour', 'day', 'weekday', 'week', 'month', 'year'];
const MODES: readonly ScheduleMode[] = ['read-only', 'acceptEdits', 'full-access'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function optionalInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

export function validateRecurrence(raw: unknown): { ok: true; value: Recurrence } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'recurrence object required' };
  if (typeof raw.unit !== 'string' || !(UNITS as readonly string[]).includes(raw.unit)) {
    return { ok: false, error: 'invalid recurrence.unit' };
  }
  const unit = raw.unit as CadenceUnit;
  const every = optionalInt(raw.every);
  if (every === undefined || every < 1) return { ok: false, error: 'recurrence.every must be >= 1' };
  if (unit !== 'minute' && unit !== 'hour') {
    if (typeof raw.at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.at)) {
      return { ok: false, error: 'recurrence.at must be HH:mm' };
    }
  }
  if (unit === 'week') {
    if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) return { ok: false, error: 'recurrence.weekdays required' };
    if (!raw.weekdays.every((x) => Number.isInteger(x) && x >= 1 && x <= 7)) return { ok: false, error: 'recurrence.weekdays must be 1..7' };
  }
  if (unit === 'month') {
    const d = optionalInt(raw.dayOfMonth);
    if (d === undefined || d < 1 || d > 31) return { ok: false, error: 'recurrence.dayOfMonth must be 1..31' };
  }
  if (unit === 'year') {
    const m = optionalInt(raw.month);
    const d = optionalInt(raw.day);
    if (m === undefined || m < 1 || m > 12) return { ok: false, error: 'recurrence.month must be 1..12' };
    // 用闰年 2000 的月长做上限：允许 2/29（闰年跳过在 nextRunAt 里按年处理）
    const maxDay = new Date(2000, m, 0).getDate();
    if (d === undefined || d < 1 || d > maxDay) return { ok: false, error: 'recurrence.day invalid' };
  }
  return {
    ok: true,
    value: {
      unit,
      every,
      ...(typeof raw.at === 'string' ? { at: raw.at } : {}),
      ...(Array.isArray(raw.weekdays) ? { weekdays: [...new Set(raw.weekdays as number[])].sort((a, b) => a - b) } : {}),
      ...(optionalInt(raw.dayOfMonth) !== undefined ? { dayOfMonth: optionalInt(raw.dayOfMonth) } : {}),
      ...(optionalInt(raw.month) !== undefined ? { month: optionalInt(raw.month) } : {}),
      ...(optionalInt(raw.day) !== undefined ? { day: optionalInt(raw.day) } : {}),
    },
  };
}

export function validateDraft(raw: unknown, now: number): { ok: true; value: ScheduleDraft } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'draft object required' };
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '' || name.length > 80) return { ok: false, error: 'name must be 1..80 chars' };
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (prompt === '' || prompt.length > 20_000) return { ok: false, error: 'prompt must be 1..20000 chars' };
  const root = typeof raw.root === 'string' && raw.root.trim() !== '' ? raw.root.trim() : '';
  if (root === '') return { ok: false, error: 'root required' };
  const effort = typeof raw.effort === 'string' ? (raw.effort.trim() as ReasoningEffort) : undefined;
  if (effort === undefined || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    return { ok: false, error: 'invalid effort' };
  }
  if (typeof raw.mode !== 'string' || !(MODES as readonly string[]).includes(raw.mode)) return { ok: false, error: 'invalid mode' };
  const rec = validateRecurrence(raw.recurrence);
  if (!rec.ok) return rec;
  if (typeof raw.startAt !== 'number' || !Number.isFinite(raw.startAt)) return { ok: false, error: 'startAt required' };
  const until = raw.until === undefined || raw.until === null ? undefined : raw.until;
  if (until !== undefined && (typeof until !== 'number' || !Number.isFinite(until))) return { ok: false, error: 'invalid until' };
  if (until !== undefined && until <= raw.startAt) return { ok: false, error: 'until must be after startAt' };
  void now;
  return {
    ok: true,
    value: { name, prompt, root, effort, mode: raw.mode as ScheduleMode, recurrence: rec.value, startAt: raw.startAt, ...(until !== undefined ? { until } : {}) },
  };
}

export function jobView(job: ScheduleJob): ScheduleJobView {
  const { runs, ...rest } = job;
  return { ...rest, runCount: runs.length, ...(runs[0] !== undefined ? { lastRun: runs[0] } : {}) };
}
