// create_scheduled_task（2026-11-20 用户裁定「提供一个创建定时任务的工具，用户可以使用自然语言创建定时任务」）：
// 模型把自然语言落成结构化 Recurrence + 任务提示词，宿主（daemon ScheduleEngine）负责校验/落档/布防。
// 与 schedule_wakeup/schedule_task（会话级一次性调度）不同：本工具创建的是 **daemon 级周期任务**，每次
// 触发都由宿主新建普通会话并模拟用户发送 prompt——工具面零 IO，接缝缺席=不注册。
import { CodedToolError, RegisteredTool, jsonAbsent } from '../tools';
import type { ReasoningEffort } from '../../types';

type ScheduleCadenceUnit = 'minute' | 'hour' | 'day' | 'weekday' | 'week' | 'month' | 'year';
type ScheduleCreateMode = 'read-only' | 'acceptEdits' | 'full-access';

/** 工具归一后的创建草稿（与 serve/schedules/model.ts 的 ScheduleDraft 结构同形；harness 不反向依赖 serve）。 */
export interface ScheduleCreateDraft {
  name: string;
  prompt: string;
  root: string;
  /** 固定模型 id（继承当前输入框；undefined=执行时用 daemon 默认模型） */
  model?: string;
  effort: ReasoningEffort;
  mode: ScheduleCreateMode;
  recurrence: {
    unit: ScheduleCadenceUnit;
    every: number;
    at?: string;
    weekdays?: number[];
    dayOfMonth?: number;
    month?: number;
    day?: number;
  };
  startAt: number;
  until?: number;
}

/** 接缝返回（只回传工具回执需要的字段，避免 harness 依赖 ScheduleJob 全形） */
interface ScheduleCreateResult {
  id: string;
  name: string;
  nextRunAt: number | null;
  enabled: boolean;
}

/** 宿主任意校验失败都走 Result 面（不抛）；工具转译成同名 CodedToolError 回喂模型。 */
export interface ScheduleCreateSeam {
  create(draft: ScheduleCreateDraft): { ok: true; value: ScheduleCreateResult } | { ok: false; code: string; message: string };
}

/** 工具缺省配置（2026-11-20 用户裁定「各种配置复用当前输入框的」）：工作区/模型/权限/强度**始终**取自
 *  当前会话输入框（SessionRuntime 提供活值函数），模型面不再暴露可覆盖参数——避免在只读输入框里
 *  造出一条 full-access 任务（权限只降不升）。 */
export interface ScheduleCreateDefaults {
  model?: string;
  effort?: ReasoningEffort;
  mode?: ScheduleCreateMode;
}

const UNITS: readonly ScheduleCadenceUnit[] = ['minute', 'hour', 'day', 'weekday', 'week', 'month', 'year'];

/** 缺席判定：null/"null"/"undefined"/空串 + **undefined**。执行边界 stripNullInputArgs 会把
 *  JSON null 键剥掉，所以可选项在 executor 里通常以 undefined 出现——jsonAbsent 本身不收
 *  undefined（其余工具用 `!== undefined && !jsonAbsent` 组合），本文件统一包一层防漏。 */
function absent(v: unknown, includeEmpty = false): boolean {
  return v === undefined || jsonAbsent(v, includeEmpty);
}

/** 可选字符串：null / "null" / "undefined" / 空串 = 缺席（jsonAbsent 单点，includeEmpty=true）。 */
function optString(v: unknown): string | undefined {
  if (absent(v, true)) return undefined;
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

/** 可选数字：null/缺席 undefined；非数字原样塞进草稿，由宿主 validateDraft 出 INVALID_ARG（单点校验）。 */
function optNumber(v: unknown): number | undefined {
  if (absent(v)) return undefined;
  return typeof v === 'number' ? v : Number(v);
}

/** ISO-8601 → epoch ms；解析失败立即 INVALID_ARG（时间语义不能猜）。 */
function parseIso(raw: unknown, field: string): number {
  const s = optString(raw);
  const at = s === undefined ? NaN : Date.parse(s);
  if (!Number.isFinite(at)) {
    throw new CodedToolError('INVALID_ARG', `${field} must be a parseable ISO-8601 timestamp, got: ${String(raw)}`);
  }
  return at;
}

function localStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 回执用的人话周期（模型/用户都读它核对语义；正式语义仍以结构化 recurrence 为准）。 */
function cadenceText(rec: ScheduleCreateDraft['recurrence']): string {
  const every = rec.every;
  const at = rec.at === undefined ? '' : ` at ${rec.at}`;
  switch (rec.unit) {
    case 'minute':
      return `every ${every} minute(s), anchored at the start time`;
    case 'hour':
      return `every ${every} hour(s)${rec.at === undefined ? '' : `, minute ${rec.at.slice(3)}`}`;
    case 'day':
      return `every ${every} day(s)${at}`;
    case 'weekday':
      return `every ${every} weekday(s)${at} (Mon-Fri)`;
    case 'week':
      return `every ${every} week(s) on days ${(rec.weekdays ?? []).join(',')} (1=Mon..7=Sun)${at}`;
    case 'month':
      return `every ${every} month(s) on day ${String(rec.dayOfMonth)}${at}`;
    case 'year':
      return `every ${every} year(s) on ${String(rec.month)}/${String(rec.day)}${at}`;
  }
}

/**
 * create_scheduled_task 工具工厂。defaultRoot=当前会话工作区（root 传 null 时兜底）；now 可注入供测试。
 * 只做入参整形与回执，校验/落档/布防全在宿主接缝（单点，防工具面与 HTTP 面两套规则漂移）。
 */
export function makeCreateScheduledTaskTool(
  seam?: ScheduleCreateSeam,
  defaultRoot?: string,
  now: () => number = Date.now,
  defaults?: () => ScheduleCreateDefaults,
): RegisteredTool {
  return {
    name: 'create_scheduled_task',
    description:
      'Create a recurring scheduled task (定时任务) that runs fully unattended. At each trigger the app creates a NEW ordinary session in the chosen workspace and submits `prompt` as if the user had sent it, so the prompt must be self-contained (that session cannot see this conversation). Cadence is structured: unit=minute|hour|day|weekday|week|month|year, every=N (>=1), plus:\n' +
      '- minute: every N minutes anchored at start_at (at ignored)\n' +
      '- hour: every N hours; at="HH:mm" anchors the minute of the hour (e.g. at "09:30" = :30 every hour)\n' +
      '- day: at="HH:mm" daily\n' +
      '- weekday: at="HH:mm" every weekday (Mon-Fri)\n' +
      '- week: weekdays=[1..7] (1=Mon..7=Sun) + at="HH:mm"\n' +
      '- month: day_of_month=1..31 + at="HH:mm"\n' +
      '- year: month=1..12 + day + at="HH:mm"\n' +
      'All wall-clock times are the user’s local time. start_at (ISO-8601) is both the first allowed run and the recurrence anchor; JSON null = now. until (ISO-8601) is an inclusive deadline; JSON null = no deadline. name must be 1..80 chars. Workspace, model, permission mode, and thinking effort are inherited from the current input box and are NOT parameters of this tool — do not try to set them. Examples: 每天 9:00 → {unit:"day",every:1,at:"09:00"}; 每 30 分钟 → {unit:"minute",every:30}; 每周一三五 10:30 → {unit:"week",every:1,weekdays:[1,3,5],at:"10:30"}; 每月 1 号 9:00 → {unit:"month",every:1,dayOfMonth:1,at:"09:00"}. Use this when the user asks to create a recurring unattended task; for a single future wake-up inside this session use schedule_wakeup/schedule_task instead.',
    category: 'task',
    display: { verb: 'SCHEDULE', targetFields: ['name'] },
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'prompt', 'recurrence', 'start_at', 'until'],
      properties: {
        name: { type: 'string', description: 'Short task name shown on the card (1..80 chars)' },
        prompt: { type: 'string', description: 'The full task prompt sent as the user message at every trigger; self-contained (goal, paths, constraints, acceptance criteria)' },
        recurrence: {
          type: 'object',
          additionalProperties: false,
          required: ['unit', 'every', 'at', 'weekdays', 'day_of_month', 'month', 'day'],
          properties: {
            unit: {
              type: ['string', 'null'],
              enum: [...UNITS, null],
              description: 'minute | hour | day | weekday | week | month | year',
            },
            every: { type: ['number', 'null'], description: 'Repeat interval, integer >= 1' },
            at: { type: ['string', 'null'], description: 'HH:mm local wall clock; required for day/weekday/week/month/year; for hour it anchors the minute-of-hour; ignored for minute' },
            weekdays: {
              type: ['array', 'null'],
              items: { type: 'number' },
              description: 'Required for unit=week: 1=Monday .. 7=Sunday, e.g. [1,3,5]',
            },
            day_of_month: { type: ['number', 'null'], description: 'Required for unit=month: 1..31' },
            month: { type: ['number', 'null'], description: 'Required for unit=year: 1..12' },
            day: { type: ['number', 'null'], description: 'Required for unit=year: day of month (1..31)' },
          },
        },
        start_at: { type: ['string', 'null'], description: 'ISO-8601 first allowed run / recurrence anchor; JSON null = now' },
        until: { type: ['string', 'null'], description: 'ISO-8601 inclusive deadline; JSON null = no deadline' },
      },
    },
    executor: async (input) => {
      if (seam === undefined) throw new CodedToolError('NOT_SUPPORTED', 'scheduled tasks require the daemon scheduler (not wired in this assembly)');
      const raw = input as Record<string, unknown>;
      const name = optString(raw.name) ?? '';
      if (name === '') throw new CodedToolError('INVALID_ARG', 'name is required (1..80 chars)');
      const prompt = optString(raw.prompt) ?? '';
      if (prompt === '') throw new CodedToolError('INVALID_ARG', 'prompt is required: the task message sent at each run');
      const recRaw = raw.recurrence;
      if (recRaw === null || typeof recRaw !== 'object' || Array.isArray(recRaw)) {
        throw new CodedToolError('INVALID_ARG', 'recurrence object is required');
      }
      const r = recRaw as Record<string, unknown>;
      const at = optString(r.at);
      const weekdays = Array.isArray(r.weekdays) ? r.weekdays.filter((d): d is number => typeof d === 'number') : undefined;
      const recurrence = {
        unit: (optString(r.unit) ?? '') as ScheduleCadenceUnit,
        every: optNumber(r.every) ?? NaN,
        ...(at !== undefined ? { at } : {}),
        ...(weekdays !== undefined && weekdays.length > 0 ? { weekdays } : {}),
        ...(optNumber(r.day_of_month) !== undefined ? { dayOfMonth: optNumber(r.day_of_month) } : {}),
        ...(optNumber(r.month) !== undefined ? { month: optNumber(r.month) } : {}),
        ...(optNumber(r.day) !== undefined ? { day: optNumber(r.day) } : {}),
      };
      // 工作区/权限/强度只从当前输入框继承（模型面没有对应参数，旧模型多发同名键也一律忽略）
      const root = defaultRoot ?? process.cwd();
      const inherited = defaults?.() ?? {};
      const model = inherited.model;
      const effort = inherited.effort ?? 'medium';
      const mode = inherited.mode ?? 'full-access';
      const startAt = absent(raw.start_at, true) ? now() : parseIso(raw.start_at, 'start_at');
      const until = absent(raw.until, true) ? undefined : parseIso(raw.until, 'until');
      if (until !== undefined && until <= startAt) {
        throw new CodedToolError('INVALID_ARG', 'until must be after start_at');
      }
      const draft: ScheduleCreateDraft = {
        name,
        prompt,
        root,
        ...(model !== undefined ? { model } : {}),
        effort,
        mode,
        recurrence,
        startAt,
        ...(until !== undefined ? { until } : {}),
      };
      const created = seam.create(draft);
      if (!created.ok) throw new CodedToolError(created.code, created.message);
      const v = created.value;
      const when = v.nextRunAt === null ? 'none (no future occurrence before the deadline)' : `${localStamp(v.nextRunAt)} (local) / ${new Date(v.nextRunAt).toISOString()}`;
      const lines = [
        `created scheduled task "${v.name}" (${v.id})`,
        `next run: ${when}`,
        `workspace: ${root}`,
        `model: ${model ?? 'app default'}; effort: ${effort}; permission: ${mode}`,
        `cadence: ${cadenceText(recurrence)}`,
        'each trigger opens a new session in that workspace and submits the task prompt.',
      ];
      return { exitCode: 0, stdout: lines.join('\n'), stderr: '', timedOut: false };
    },
  };
}
