import type { ReasoningEffort } from '../../types';

type CadenceUnit = 'minute' | 'hour' | 'day' | 'weekday' | 'week' | 'month' | 'year';
export type ScheduleMode = 'read-only' | 'acceptEdits' | 'full-access';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped' | 'skipped' | 'interrupted';
export type RunTrigger = 'schedule' | 'catch-up' | 'manual';

/** 指令落点（2026-11-21 用户裁定三种）：project=按工作区新建会话（原行为，不动）；
 *  sunx=发给已选 Sunx 会话（不新建）；channel=发给通道聊天对应的在座会话（不新建）。
 *  缺席=project（旧任务零迁移）。 */
export type ScheduleTargetKind = 'project' | 'sunx' | 'channel';

/** 目标选择字段（job/draft 共用；执行只认 id，label 是展示快照） */
export interface ScheduleTargetFields {
  target?: ScheduleTargetKind;
  /** 显示名快照：项目=工作区名 / SUNX=群组名·会话名 / 通道=应用·聊天名（卡片/记录展示，执行不依赖） */
  targetLabel?: string;
  /** SUNX 目标：目标会话 journal id */
  targetJournalId?: string;
  /** SUNX 目标所属群组 id（2026-11-21：卡片按此反查群名显示「群组名 · 会话名」） */
  targetGroupId?: string;
  /** 通道目标：通道配置 id + 聊天 id（binding key 两段） */
  targetChannelId?: string;
  targetChatId?: string;
  /** 通道目标平台（2026-11-21：卡片/记录按此显示平台图标，如飞书羽毛） */
  targetPlatform?: string;
}

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
  /** 本轮落点类型/显示名/平台（2026-11-21）：执行记录列表展示目标用 */
  target?: ScheduleTargetKind;
  targetLabel?: string;
  targetPlatform?: string;
}

export interface ScheduleJob extends ScheduleTargetFields {
  id: string;
  name: string;
  prompt: string;
  root: string;
  /** 固定模型 id（2026-11-20 用户裁定「模型和强度完全用输入框的」）：undefined=执行时用 daemon
   *  当前默认模型；非 undefined=该任务每轮用此模型（per-session 适配器，不切全局选择） */
  model?: string;
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

export interface ScheduleDraft extends ScheduleTargetFields {
  name: string;
  prompt: string;
  root: string;
  model?: string;
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
const TARGETS: readonly ScheduleTargetKind[] = ['project', 'sunx', 'channel'];

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
  const modelRaw = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (modelRaw.length > 200) return { ok: false, error: 'model id too long' };
  const model = modelRaw === '' ? undefined : modelRaw;
  const effort = typeof raw.effort === 'string' ? (raw.effort.trim() as ReasoningEffort) : undefined;
  if (effort === undefined || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    return { ok: false, error: 'invalid effort' };
  }
  if (typeof raw.mode !== 'string' || !(MODES as readonly string[]).includes(raw.mode)) return { ok: false, error: 'invalid mode' };
  // 指令落点（2026-11-21 用户裁定三种）：sunx/channel 必须带齐目标 id；project（旧缺省）不带
  const targetRaw = raw.target === undefined || raw.target === null || raw.target === '' ? 'project' : raw.target;
  if (typeof targetRaw !== 'string' || !(TARGETS as readonly string[]).includes(targetRaw)) return { ok: false, error: 'invalid target' };
  const target = targetRaw as ScheduleTargetKind;
  const cleanId = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const targetLabelRaw = cleanId(raw.targetLabel, 200);
  const targetLabel = targetLabelRaw === '' ? undefined : targetLabelRaw;
  const targetJournalId = cleanId(raw.targetJournalId, 200);
  const targetGroupId = cleanId(raw.targetGroupId, 100);
  const targetChannelId = cleanId(raw.targetChannelId, 200);
  const targetChatId = cleanId(raw.targetChatId, 400);
  const targetPlatform = cleanId(raw.targetPlatform, 40);
  if (target === 'sunx' && targetJournalId === '') return { ok: false, error: 'targetJournalId required for sunx target' };
  if (target === 'channel' && (targetChannelId === '' || targetChatId === '')) {
    return { ok: false, error: 'targetChannelId and targetChatId required for channel target' };
  }
  const rec = validateRecurrence(raw.recurrence);
  if (!rec.ok) return rec;
  if (typeof raw.startAt !== 'number' || !Number.isFinite(raw.startAt)) return { ok: false, error: 'startAt required' };
  const until = raw.until === undefined || raw.until === null ? undefined : raw.until;
  if (until !== undefined && (typeof until !== 'number' || !Number.isFinite(until))) return { ok: false, error: 'invalid until' };
  if (until !== undefined && until <= raw.startAt) return { ok: false, error: 'until must be after startAt' };
  void now;
  return {
    ok: true,
    value: {
      name,
      prompt,
      root,
      ...(model !== undefined ? { model } : {}),
      effort,
      mode: raw.mode as ScheduleMode,
      recurrence: rec.value,
      startAt: raw.startAt,
      ...(until !== undefined ? { until } : {}),
      target,
      ...(targetLabel !== undefined ? { targetLabel } : {}),
      ...(target === 'sunx' ? { targetJournalId, ...(targetGroupId !== '' ? { targetGroupId } : {}) } : {}),
      ...(target === 'channel' ? { targetChannelId, targetChatId, ...(targetPlatform !== '' ? { targetPlatform } : {}) } : {}),
    },
  };
}

export function jobView(job: ScheduleJob): ScheduleJobView {
  const { runs, ...rest } = job;
  return { ...rest, runCount: runs.length, ...(runs[0] !== undefined ? { lastRun: runs[0] } : {}) };
}
