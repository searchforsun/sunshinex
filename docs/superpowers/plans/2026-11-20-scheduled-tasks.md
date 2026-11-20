# 定时任务（Scheduled Tasks）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 daemon 里增加一个全局调度器：按本地时间到点用既有 `createSessionIn + setEffort + submit` 新建一个普通会话并发送任务；GUI 在主区以两列三行卡片管理任务，配置页只有名称/调度/任务三行，任务直接复用对话输入框。

**Architecture:** 新增 `src/serve/schedules/` 域（纯日期计算 + JSON store + timer engine + executor + HTTP handlers），daemon 在启动时布防、关闭时停表；执行产物就是普通 standard 会话，不归档。GUI 新增 `gui/src/schedules/` 主区页（列表/配置/记录页内切换），复用项目既有 `.sx-switch` / `.sx-composer` / `.composer-pill` / `.tb-status-dot` / `.chat-topbar`。

**Tech Stack:** TypeScript 5.6、Node 22（node:test）、React 18 + Vite（vitest + @testing-library/react）。**零新增依赖**；周期用结构化 recurrence，不引入 cron 解析库。

**Spec:** `docs/superpowers/specs/2026-11-20-scheduled-tasks-design.md`
**Mockup:** `docs/superpowers/specs/2026-11-20-scheduled-tasks-mockup.html`

## Global Constraints

- 不新增 npm 依赖；不使用 cron 字符串；周期=结构化 `Recurrence`（minute/hour/day/weekday/week/month/year）。
- 时间一律本地时区；最小粒度 1 分钟；不支持秒级 / per-job 时区。
- 执行=新建**普通 standard 会话**：`createSessionIn(root, { mode, activate:false })` + `ensureJournalMinted` + `session.submit(prompt)`；不归档、不特殊保留。
- 记录每任务最多 100 条；调度定义/记录落 `userConfigDir()/schedules.json`（缺省）；`SUNSHINEX_DATA_DIR` 在场时落 `<dataDir>/schedules.json`（测试隔离，绝不读用户真实档），原子写。
- daemon 启动补跑一次；同一任务上次还在跑时定时触发跳过并记 `skipped`；手动触发允许并行。
- 卡片两列、每卡三行（名称/内容/下次倒计时），首行开关；**不显示工作目录、强度、上次结果、状态徽标**。
- 配置页只有三行：名称 / 调度 / 任务；任务复用 `ComposerCard`，底部 dock 与普通输入框一致（工作目录/＋/模型含强度/权限/保存），**没有单独的强度 pill**。
- 全部 GUI 文案走 `t(en, zh)`；状态图标只用项目 `.tb-status-dot`；颜色/圆角/阴影只用主题令牌。
- 每个任务先写失败测试、再实现、再跑测试；完成后跑对应测试与 `pnpm --dir gui run typecheck`。
- 提交步骤按仓库惯例 `feat(schedules): ...`；若操作者未被授权提交，停在 commit 步骤前询问。

---

## File Structure

**daemon**

- Create `src/serve/schedules/model.ts` — 类型、draft 校验、`jobView`。
- Create `src/serve/schedules/recurrence.ts` — `nextRunAt(rec, startAt, after, until?)` 纯函数。
- Create `src/serve/schedules/store.ts` — JSON 读写、100 条记录上限、running→interrupted 对账。
- Create `src/serve/schedules/engine.ts` — 每任务一个 timer、arm/fire/catch-up/enabled/run-now、启动/停止。
- Create `src/serve/schedules/executor.ts` — 建普通会话、设强度、标题、submit、记录状态、运行时 LRU。
- Create `src/serve/schedules/handlers.ts` — `/schedules*` HTTP handlers。
- Modify `src/serve/session-lifecycle.ts` — `CreateSessionOpts.activate` + `mode` 加 read-only。
- Modify `src/serve/session.ts` — `onRunEnd` 一次性观察者。
- Modify `src/serve/daemon.ts` — store/engine/executor 字段、路由、start/teardown、`releaseSession`。
- Tests: `src/serve/schedules/recurrence.test.ts`、`store.test.ts`、`engine.test.ts`、`executor.test.ts`、`src/serve/daemon.schedules.test.ts`。

**GUI**

- Create `gui/src/schedules/cycle.ts` — 周期下拉 ↔ recurrence 映射。
- Create `gui/src/schedules/ScheduleCard.tsx` — 两列三行卡片。
- Create `gui/src/schedules/SchedulePage.tsx` — 主区页、列表/配置/记录切换、顶部栏。
- Create `gui/src/schedules/ScheduleConfig.tsx` — 三行配置页（复用 ComposerCard）。
- Create `gui/src/schedules/ScheduleRuns.tsx` — 执行记录表。
- Modify `gui/src/connection-types.ts`、`connection-api.ts`、`connection.ts` — schedules 类型与方法。
- Modify `gui/src/sidebar/ProjectMenu.tsx`、`gui/src/App.tsx` — 侧栏入口 + 主区层 + 打开会话链。
- Modify `gui/src/app.css` — `.sx-schedule-*` 布局类。
- Tests: `cycle.test.ts`、`SchedulePage.test.tsx`、`ScheduleConfig.test.tsx`、`ScheduleRuns.test.tsx`、`ProjectMenu` 入口用例。

---

## Task 1: 周期核心（recurrence）

**Files:**
- Create: `src/serve/schedules/model.ts`
- Create: `src/serve/schedules/recurrence.ts`
- Test: `src/serve/schedules/recurrence.test.ts`

**Interfaces:**
- Produces:
  - `Recurrence { unit: CadenceUnit; every: number; at?: string; weekdays?: number[]; dayOfMonth?: number; month?: number; day?: number }`
  - `nextRunAt(rec: Recurrence, startAt: number, after: number, until?: number): number | null`
  - `validateRecurrence(raw: unknown): { ok:true; value: Recurrence } | { ok:false; error: string }`
  - `ScheduleJob`, `RunRecord`, `ScheduleDraft`, `ScheduleJobView`, `jobView(job)`
- 语义：`nextRunAt` 返回**严格大于 after** 的最小触发时刻、且不早于 startAt；越过 until 回 null。需要「包含当前时刻」的调用方传 `after = now - 1`。

- [ ] **Step 1: 写失败测试**

```ts
// src/serve/schedules/recurrence.test.ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/serve/schedules/recurrence.test.js`
Expected: FAIL（`Cannot find module './recurrence'` / `nextRunAt is not a function`）。

- [ ] **Step 3: 写 model.ts 与 recurrence.ts**

```ts
// src/serve/schedules/model.ts
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
```

```ts
// src/serve/schedules/recurrence.ts
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
    const cap = rec.every * 7 + 21;
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/serve/schedules/recurrence.test.js`
Expected: PASS（全部用例）。

- [ ] **Step 5: 提交**

```bash
git add src/serve/schedules/model.ts src/serve/schedules/recurrence.ts src/serve/schedules/recurrence.test.ts
git commit -m "feat(schedules): recurrence core and draft validation"
```

---

## Task 2: 持久化 store

**Files:**
- Create: `src/serve/schedules/store.ts`
- Test: `src/serve/schedules/store.test.ts`

**Interfaces:**
- Consumes: `ScheduleJob`, `RunRecord`, `StoreFile`, `SCHEDULE_RUN_LIMIT` from `./model`.
- Produces:
  - `class ScheduleStore { constructor(file: string); list(): ScheduleJob[]; get(id): ScheduleJob | undefined; upsert(job): void; patch(id, patch: Partial<ScheduleJob>): void; remove(id): boolean; addRun(id, run): void; patchRun(id, runId, patch: Partial<RunRecord>): void; markInterrupted(now): void; }`

- [ ] **Step 1: 写失败测试**

```ts
// src/serve/schedules/store.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScheduleStore } from './store';
import type { ScheduleJob } from './model';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-store-'));
  return path.join(dir, 'schedules.json');
}
function job(id: string): ScheduleJob {
  return {
    id, name: id, prompt: 'p', root: 'default', effort: 'high', mode: 'full-access',
    recurrence: { unit: 'day', every: 1, at: '09:00' }, startAt: 1, enabled: true,
    createdAt: 1, updatedAt: 1, nextRunAt: 2, runs: [],
  };
}

test('落盘-重读往返 + 原子文件', () => {
  const file = tmpFile();
  const s = new ScheduleStore(file);
  s.upsert(job('a'));
  assert.equal(fs.existsSync(file), true);
  assert.equal(new ScheduleStore(file).get('a')?.name, 'a');
});

test('坏档改名降级为空库', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not-json', 'utf8');
  const s = new ScheduleStore(file);
  assert.deepEqual(s.list(), []);
  assert.equal(fs.readdirSync(path.dirname(file)).some((n) => n.startsWith('schedules.corrupt-')), true);
});

test('记录最多 100 条且新→旧', () => {
  const file = tmpFile();
  const s = new ScheduleStore(file);
  s.upsert(job('a'));
  for (let i = 0; i < 105; i++) s.addRun('a', { id: `r${i}`, trigger: 'schedule', startedAt: i, status: 'succeeded', root: 'default' });
  const runs = s.get('a')!.runs;
  assert.equal(runs.length, 100);
  assert.equal(runs[0]!.id, 'r104');
});

test('markInterrupted：running → interrupted', () => {
  const file = tmpFile();
  const s = new ScheduleStore(file);
  s.upsert(job('a'));
  s.addRun('a', { id: 'r', trigger: 'schedule', startedAt: 1, status: 'running', root: 'default' });
  s.markInterrupted(99);
  const r = s.get('a')!.runs[0]!;
  assert.equal(r.status, 'interrupted');
  assert.equal(r.endedAt, 99);
  assert.match(r.error ?? '', /restart/i);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/serve/schedules/store.test.js`
Expected: FAIL（`ScheduleStore is not a constructor`）。

- [ ] **Step 3: 实现 store.ts**

```ts
// src/serve/schedules/store.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { userConfigDir } from '../../config/env';
import { SCHEDULE_RUN_LIMIT } from './model';
import type { RunRecord, ScheduleJob, StoreFile } from './model';

export function schedulesFile(): string {
  const override = process.env.SUNSHINEX_DATA_DIR;
  return path.join(override !== undefined && override !== '' ? path.resolve(override) : userConfigDir(), 'schedules.json');
}

export class ScheduleStore {
  private data: StoreFile;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): StoreFile {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { version: 1, jobs: [] };
    }
    try {
      const raw = JSON.parse(text) as unknown;
      if (raw === null || typeof raw !== 'object' || (raw as StoreFile).version !== 1 || !Array.isArray((raw as StoreFile).jobs)) {
        throw new Error('unsupported schedules file');
      }
      const jobs = (raw as StoreFile).jobs.map((j) => ({ ...j, runs: Array.isArray(j.runs) ? j.runs.slice(0, SCHEDULE_RUN_LIMIT) : [] }));
      return { version: 1, jobs };
    } catch (e) {
      console.warn('[schedules] corrupt store, starting empty:', e instanceof Error ? e.message : String(e));
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* 改名失败也按空库启动 */
      }
      return { version: 1, jobs: [] };
    }
  }

  list(): ScheduleJob[] {
    return this.data.jobs;
  }

  get(id: string): ScheduleJob | undefined {
    return this.data.jobs.find((j) => j.id === id);
  }

  upsert(job: ScheduleJob): void {
    const i = this.data.jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) this.data.jobs[i] = job;
    else this.data.jobs.push(job);
    this.persist();
  }

  patch(id: string, patch: Partial<ScheduleJob>): void {
    const job = this.get(id);
    if (job === undefined) return;
    Object.assign(job, patch);
    this.persist();
  }

  remove(id: string): boolean {
    const i = this.data.jobs.findIndex((j) => j.id === id);
    if (i < 0) return false;
    this.data.jobs.splice(i, 1);
    this.persist();
    return true;
  }

  addRun(id: string, run: RunRecord): void {
    const job = this.get(id);
    if (job === undefined) return;
    job.runs = [run, ...job.runs].slice(0, SCHEDULE_RUN_LIMIT);
    this.persist();
  }

  patchRun(id: string, runId: string, patch: Partial<RunRecord>): void {
    const job = this.get(id);
    const run = job?.runs.find((r) => r.id === runId);
    if (run === undefined) return;
    Object.assign(run, patch);
    this.persist();
  }

  markInterrupted(now: number): void {
    let changed = false;
    for (const job of this.data.jobs) {
      for (const run of job.runs) {
        if (run.status !== 'running') continue;
        run.status = 'interrupted';
        run.endedAt = now;
        run.error = 'daemon restarted before completion';
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[schedules] persist failed:', e instanceof Error ? e.message : String(e));
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/serve/schedules/store.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/serve/schedules/store.ts src/serve/schedules/store.test.ts
git commit -m "feat(schedules): atomic JSON store with run retention"
```

---

## Task 3: 调度引擎

**Files:**
- Create: `src/serve/schedules/engine.ts`
- Test: `src/serve/schedules/engine.test.ts`

**Interfaces:**
- Consumes: `ScheduleStore`、`ScheduleJob`、`ScheduleDraft`、`Recurrence`、`nextRunAt`、`jobView`。
- Produces:
  - `class ScheduleEngine { constructor(deps: { store: ScheduleStore; execute: (job: ScheduleJob, trigger: RunTrigger, plannedAt?: number) => string | undefined; now?: () => number; setTimeoutImpl?: (fn: () => void, ms: number) => unknown; clearTimeoutImpl?: (h: unknown) => void }); start(): void; stop(): void; create(draft: ScheduleDraft): ScheduleJob; update(id, draft): ScheduleJob | undefined; remove(id): boolean; setEnabled(id, enabled): ScheduleJob | undefined; runNow(id): string | undefined; list(): ScheduleJob[]; get(id): ScheduleJob | undefined; }`

- [ ] **Step 1: 写失败测试**

```ts
// src/serve/schedules/engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScheduleStore } from './store';
import { ScheduleEngine } from './engine';
import type { ScheduleDraft, ScheduleJob } from './model';

class FakeClock {
  t = 1_000_000;
  private id = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = (): number => this.t;
  setTimeoutImpl = (fn: () => void, ms: number): number => {
    const id = ++this.id;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeoutImpl = (h: unknown): void => { this.timers.delete(h as number); };
  advance(ms: number): void {
    this.t += ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= this.t).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      due[1].fn();
    }
  }
}

function tmpStore(): ScheduleStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-engine-'));
  return new ScheduleStore(path.join(dir, 'schedules.json'));
}

function draft(over: Partial<ScheduleDraft> = {}): ScheduleDraft {
  return {
    name: '巡检', prompt: '检查', root: 'default', effort: 'high', mode: 'full-access',
    recurrence: { unit: 'minute', every: 1 }, startAt: 1_000_000, ...over,
  };
}

test('到点执行一次、先算下一次、再按新时间布防', () => {
  const clock = new FakeClock();
  const calls: Array<{ id: string; trigger: string }> = [];
  const engine = new ScheduleEngine({ store: tmpStore(), execute: (job, trigger) => { calls.push({ id: job.id, trigger }); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  const job = engine.create(draft());
  engine.start();
  clock.advance(60_000);
  assert.deepEqual(calls.map((c) => c.trigger), ['schedule']);
  assert.equal(engine.get(job.id)!.nextRunAt, 1_000_000 + 120_000);
  clock.advance(60_000);
  assert.equal(calls.length, 2);
  engine.stop();
});

test('启动补跑一次，不按错过次数补', () => {
  const clock = new FakeClock();
  const store = tmpStore();
  const first = { ...draft(), id: 'job', createdAt: 1, updatedAt: 1, enabled: true, nextRunAt: 1_000_000 - 600_000, runs: [] } as ScheduleJob;
  store.upsert(first);
  const calls: string[] = [];
  const engine = new ScheduleEngine({ store, execute: (_j, trigger) => { calls.push(trigger); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  engine.start();
  assert.deepEqual(calls, ['catch-up']);
  assert.equal(engine.get('job')!.nextRunAt, 1_000_000 + 60_000);
  engine.stop();
});

test('上次运行未结束 → skipped，不并行', () => {
  const clock = new FakeClock();
  const store = tmpStore();
  const engine = new ScheduleEngine({ store, execute: () => 'run', now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  const job = engine.create(draft());
  store.addRun(job.id, { id: 'r', trigger: 'schedule', startedAt: clock.now(), status: 'running', root: 'default' });
  engine.start();
  clock.advance(60_000);
  assert.equal(engine.get(job.id)!.runs[0]!.status, 'skipped');
  engine.stop();
});

test('enabled 关=清表，开=以 now 重算', () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const engine = new ScheduleEngine({ store: tmpStore(), execute: (_j, t) => { calls.push(t); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  const job = engine.create(draft());
  engine.start();
  engine.setEnabled(job.id, false);
  clock.advance(120_000);
  assert.equal(calls.length, 0);
  const on = engine.setEnabled(job.id, true)!;
  assert.equal(on.enabled, true);
  assert.equal(on.nextRunAt, clock.now() + 60_000);
  clock.advance(60_000);
  assert.deepEqual(calls, ['schedule']);
  engine.stop();
});

test('next 越过 until → ended/disabled', () => {
  const clock = new FakeClock();
  const engine = new ScheduleEngine({ store: tmpStore(), execute: () => 'run', now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  const job = engine.create(draft({ until: 1_000_000 + 30_000 }));
  engine.start();
  clock.advance(30_000);
  const after = engine.get(job.id)!;
  assert.equal(after.ended, true);
  assert.equal(after.enabled, false);
  assert.equal(after.nextRunAt, null);
  engine.stop();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/serve/schedules/engine.test.js`
Expected: FAIL（`ScheduleEngine is not a constructor`）。

- [ ] **Step 3: 实现 engine.ts**

```ts
// src/serve/schedules/engine.ts
import { randomBytes } from 'node:crypto';
import { jobView } from './model';
import type { ScheduleDraft, ScheduleJob, ScheduleJobView, RunTrigger } from './model';
import { nextRunAt } from './recurrence';
import type { ScheduleStore } from './store';

const MAX_TIMER_MS = 2 ** 31 - 1;

export interface ScheduleEngineDeps {
  store: ScheduleStore;
  execute: (job: ScheduleJob, trigger: RunTrigger, plannedAt?: number) => string | undefined;
  now?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (h: unknown) => void;
}

function newJobId(): string {
  return `sch-${randomBytes(4).toString('hex')}`;
}

/** 「下一次（含当前时刻）」：创建/恢复/preview 用 now-1 让此刻的锚点也能成为第一次 */
export function nextAtOrAfter(rec: ScheduleJob['recurrence'], startAt: number, now: number, until?: number): number | null {
  return nextRunAt(rec, startAt, now - 1, until);
}

export class ScheduleEngine {
  private readonly store: ScheduleStore;
  private readonly execute: ScheduleEngineDeps['execute'];
  private readonly now: () => number;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (h: unknown) => void;
  private readonly timers = new Map<string, unknown>();
  /** 首次 create/update 用的稳定 now（测试与单元一致） */
  private started = false;

  constructor(deps: ScheduleEngineDeps) {
    this.store = deps.store;
    this.execute = deps.execute;
    this.now = deps.now ?? (() => Date.now());
    this.setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = deps.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  list(): ScheduleJob[] {
    return this.store.list();
  }
  get(id: string): ScheduleJob | undefined {
    return this.store.get(id);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.now();
    this.store.markInterrupted(now);
    for (const job of [...this.store.list()]) {
      if (!job.enabled || job.ended) continue;
      const planned = job.nextRunAt;
      if (planned !== null && planned <= now) {
        const next = nextRunAt(job.recurrence, job.startAt, Math.max(now, planned), job.until);
        this.store.patch(job.id, { nextRunAt: next, ...(next === null ? { ended: true, enabled: false } : {}) });
        this.execute(job, 'catch-up', planned);
        if (next !== null && job.enabled) this.arm(this.store.get(job.id)!);
      } else {
        this.arm(job);
      }
    }
  }

  stop(): void {
    this.started = false;
    for (const h of this.timers.values()) this.clearTimeoutImpl(h);
    this.timers.clear();
  }

  create(draft: ScheduleDraft): ScheduleJob {
    const now = this.now();
    const next = nextAtOrAfter(draft.recurrence, draft.startAt, now, draft.until);
    const job: ScheduleJob = {
      id: newJobId(),
      ...draft,
      enabled: next !== null,
      ...(next === null ? { ended: true } : {}),
      createdAt: now,
      updatedAt: now,
      nextRunAt: next,
      runs: [],
    };
    this.store.upsert(job);
    this.arm(job);
    return job;
  }

  update(id: string, draft: ScheduleDraft): ScheduleJob | undefined {
    const prev = this.store.get(id);
    if (prev === undefined) return undefined;
    const now = this.now();
    const next = prev.enabled ? nextAtOrAfter(draft.recurrence, draft.startAt, now, draft.until) : null;
    const job: ScheduleJob = {
      ...prev,
      ...draft,
      updatedAt: now,
      nextRunAt: next,
      ...(prev.enabled ? { ended: next === null, enabled: next !== null } : {}),
    };
    this.store.upsert(job);
    this.arm(job);
    return job;
  }

  remove(id: string): boolean {
    this.clear(id);
    return this.store.remove(id);
  }

  setEnabled(id: string, enabled: boolean): ScheduleJob | undefined {
    const job = this.store.get(id);
    if (job === undefined) return undefined;
    const now = this.now();
    const next = enabled ? nextAtOrAfter(job.recurrence, job.startAt, now, job.until) : null;
    this.store.patch(id, {
      enabled: enabled && next !== null,
      ended: enabled ? next === null : job.ended,
      nextRunAt: next,
    });
    const cur = this.store.get(id)!;
    if (cur.enabled && cur.nextRunAt !== null) this.arm(cur);
    else this.clear(id);
    return cur;
  }

  runNow(id: string): string | undefined {
    const job = this.store.get(id);
    if (job === undefined) return undefined;
    return this.execute(job, 'manual');
  }

  /** 测试/daemon 外窥用：与 handlers 同口径的视图 */
  views(): ScheduleJobView[] {
    return this.store.list().map(jobView);
  }

  private clear(id: string): void {
    const h = this.timers.get(id);
    if (h !== undefined) this.clearTimeoutImpl(h);
    this.timers.delete(id);
  }

  private arm(job: ScheduleJob): void {
    this.clear(job.id);
    if (!job.enabled || job.ended || job.nextRunAt === null) return;
    const delay = Math.max(0, job.nextRunAt - this.now());
    const wait = Math.min(delay, MAX_TIMER_MS);
    const h = this.setTimeoutImpl(() => {
      this.timers.delete(job.id);
      const cur = this.store.get(job.id);
      if (cur === undefined || !cur.enabled) return;
      if (cur.nextRunAt !== null && this.now() < cur.nextRunAt) {
        this.arm(cur);
        return;
      }
      this.fire(job.id);
    }, wait);
    this.timers.set(job.id, h);
  }

  private fire(id: string): void {
    const job = this.store.get(id);
    if (job === undefined || !job.enabled) return;
    const now = this.now();
    const planned = job.nextRunAt;
    if (planned === null) return;
    if (now < planned) {
      this.arm(job);
      return;
    }
    const next = nextRunAt(job.recurrence, job.startAt, Math.max(now, planned), job.until);
    this.store.patch(id, { nextRunAt: next, ...(next === null ? { ended: true, enabled: false } : {}) });
    const latest = this.store.get(id)!;
    if (latest.runs[0]?.status === 'running') {
      this.store.addRun(id, { id: `run-${randomBytes(4).toString('hex')}`, trigger: 'schedule', scheduledAt: planned, startedAt: now, endedAt: now, status: 'skipped', root: job.root });
    } else {
      this.execute(latest, 'schedule', planned);
    }
    if (next !== null && latest.enabled) this.arm(this.store.get(id)!);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/serve/schedules/engine.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/serve/schedules/engine.ts src/serve/schedules/engine.test.ts
git commit -m "feat(schedules): timer engine with catch-up and overlap skip"
```

---

## Task 4: 会话运行时扩面（onRunEnd / activate / read-only）

**Files:**
- Modify: `src/serve/session.ts`（`RunEndInfo`、`onRunEnd`、finally 回调）
- Modify: `src/serve/session-lifecycle.ts`（`CreateSessionOpts.activate`、`mode` 加 read-only）
- Test: `src/serve/session.onrunend.test.ts`

**Interfaces:**
- Produces:
  - `export interface RunEndInfo { stopReason?: string; endedAt: number; seconds: number; tokens?: number }`
  - `SessionRuntime.onRunEnd(cb: (info: RunEndInfo) => void): () => void`（一次性：run 收尾清空观察者集合）
  - `CreateSessionOpts = { mode?: 'read-only' | 'acceptEdits' | 'full-access'; activate?: boolean; kind?; name?; charter?; dataDir? }`

- [ ] **Step 1: 写失败测试**

```ts
// src/serve/session.onrunend.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';

test('onRunEnd：done 回调一次并带 stopReason/seconds；createSession activate:false 不抢 active', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-onrunend-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const s = await daemon.start({ port: 0, token: 't' });
    try {
      const r = daemon.createSession(tmp, { activate: false });
      assert.ok(r.ok);
      const sid = r.value.sessionId;
      const session = daemon.get(sid)!;
      const seen: Array<{ stopReason?: string; seconds: number }> = [];
      session.onRunEnd((info) => seen.push(info));
      session.submit('hi');
      const deadline = Date.now() + 10_000;
      while (seen.length === 0) {
        if (Date.now() > deadline) throw new Error('onRunEnd timeout');
        await new Promise((res) => setTimeout(res, 20));
      }
      assert.equal(seen[0]!.stopReason, 'done');
      assert.ok(seen[0]!.seconds >= 1);
      assert.equal(daemon.activeId(), undefined, 'activate:false 不抢 active');
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/serve/session.onrunend.test.js`
Expected: FAIL（`onRunEnd is not a function`）。

- [ ] **Step 3: 实现扩面**

`src/serve/session-lifecycle.ts`：

```ts
export interface CreateSessionOpts {
  /** 三档 + internal read-only（HTTP /session/new 仍只收 acceptEdits/full-access） */
  mode?: 'read-only' | 'acceptEdits' | 'full-access';
  /** false=后台建会话不抢 daemon active（定时任务用） */
  activate?: boolean;
  kind?: 'sunx';
  name?: string;
  charter?: string;
  dataDir?: string;
}
```

在 `createSessionIn` 的 `io.sessions.set(id, session);` 之后把：

```ts
io.setActive(id);
```

改成：

```ts
if (opts?.activate !== false) io.setActive(id);
```

`src/serve/session.ts` 顶部（`SessionSubmitResult` 附近）：

```ts
/** 一轮收尾信息（定时任务执行记录回填）：stopReason=done/interrupted/其它；一次性观察者 */
export interface RunEndInfo {
  stopReason?: string;
  endedAt: number;
  seconds: number;
  tokens?: number;
}
```

类字段（`private current?: CurrentRun;` 附近）：

```ts
/** 轮收尾观察者（一次性；run finally 清空——定时任务执行记录） */
private readonly runEndListeners = new Set<(info: RunEndInfo) => void>();
```

公开方法（`status()` 附近）：

```ts
/** 轮收尾观察者（一次性）：下一次 run 收尾时回调并清空；返回注销函数 */
onRunEnd(cb: (info: RunEndInfo) => void): () => void {
  this.runEndListeners.add(cb);
  return () => this.runEndListeners.delete(cb);
}
```

`submit()` 里 `let runOutcome...` 附近加：

```ts
let runEndedAt = 0;
let runSeconds = 0;
```

在 `then` 里 `const endedTs = Date.now();` 之后加：

```ts
runEndedAt = endedTs;
```

在 `const seconds = ...;` 之后加：

```ts
runSeconds = seconds;
```

在 `finally` 的 `this.current = undefined;` 之后加：

```ts
const endedAt = runEndedAt > 0 ? runEndedAt : Date.now();
const info: RunEndInfo = {
  stopReason: runOutcome?.stopReason,
  endedAt,
  seconds: runSeconds > 0 ? runSeconds : Math.max(0, Math.round((endedAt - startedAt) / 1000)),
  ...(runOutcome?.tokensUsed !== undefined ? { tokens: runOutcome.tokensUsed } : {}),
};
const listeners = [...this.runEndListeners];
this.runEndListeners.clear();
for (const cb of listeners) {
  try { cb(info); } catch { /* 观察者失败不影响收尾 */ }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/serve/session.onrunend.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/serve/session.ts src/serve/session-lifecycle.ts src/serve/session.onrunend.test.ts
git commit -m "feat(schedules): run-end observer and non-activating session create"
```

---

## Task 5: 执行器（建会话/提交/记录/LRU）

**Files:**
- Create: `src/serve/schedules/executor.ts`
- Test: `src/serve/schedules/executor.test.ts`

**Interfaces:**
- Consumes: `ScheduleStore`、`ScheduleJob`、`RunRecord`、`CreateSessionOpts`、`SessionRuntime`、`writeSessionMeta`、`purgeSession`、`defaultScratchRoot`。
- Produces:
  - `interface ScheduleExecutorIo { createSession(root, opts): Result<{sessionId}>; getSession(id): SessionRuntime | undefined; releaseSession(id): void; activeSessionId(): string | undefined; now?: () => number }`
  - `class ScheduleExecutor { constructor(io, store); run(job, trigger, plannedAt?): string | undefined }`

- [ ] **Step 1: 写失败测试**

```ts
// src/serve/schedules/executor.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScheduleStore } from './store';
import { ScheduleExecutor } from './executor';
import type { ScheduleJob } from './model';
import type { RunEndInfo } from '../session';

class FakeSession {
  attachedJournalId = 'jid1';
  dataDir: string;
  effort = '';
  submitted: string[] = [];
  private cb?: (info: RunEndInfo) => void;
  constructor(dataDir: string) { this.dataDir = dataDir; }
  setEffort(e: string): boolean { this.effort = e; return true; }
  ensureJournalMinted(): void {}
  submit(prompt: string): { ok: true } { this.submitted.push(prompt); return { ok: true }; }
  onRunEnd(cb: (info: RunEndInfo) => void): () => void { this.cb = cb; return () => { this.cb = undefined; }; }
  finish(stopReason: string): void { this.cb?.({ stopReason, endedAt: 123, seconds: 2 }); }
}

function tmpData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-exec-'));
}
function job(): ScheduleJob {
  return { id: 'j', name: '巡检', prompt: '检查', root: 'default', effort: 'high', mode: 'full-access', recurrence: { unit: 'day', every: 1, at: '09:00' }, startAt: 1, enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: 2, runs: [] };
}

test('run：建会话/设强度/标题/提交/记录成功', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const session = new FakeSession(dir);
  const released: string[] = [];
  const ex = new ScheduleExecutor({ createSession: () => ({ ok: true, value: { sessionId: 's1' } }), getSession: () => session as never, releaseSession: (id) => released.push(id), activeSessionId: () => undefined }, store);
  const runId = ex.run(j, 'schedule', 5)!;
  assert.ok(runId.startsWith('run-'));
  assert.equal(session.effort, 'high');
  assert.deepEqual(session.submitted, ['检查']);
  const run = store.get('j')!.runs[0]!;
  assert.equal(run.status, 'running');
  assert.equal(run.journalId, 'jid1');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'jid1.meta.json'), 'utf8')) as { title?: string };
  assert.match(meta.title ?? '', /^巡检 · \d{2}-\d{2} \d{2}:\d{2}$/);
  session.finish('done');
  assert.equal(store.get('j')!.runs[0]!.status, 'succeeded');
  assert.deepEqual(released, []);
});

test('run：create 失败记录 failed，不建会话', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const ex = new ScheduleExecutor({ createSession: () => ({ ok: false, error: { code: 'INVALID_ARG', message: 'root missing' } } as never), getSession: () => undefined, releaseSession: () => undefined, activeSessionId: () => undefined }, store);
  ex.run(j, 'manual');
  const run = store.get('j')!.runs[0]!;
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /root missing/);
});

test('LRU：>10 个已结束运行时释放最旧且跳过 active', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const released: string[] = [];
  let active = 's-active';
  const sessions = new Map<string, FakeSession>();
  let seq = 0;
  const ex = new ScheduleExecutor({
    createSession: () => { const id = `s${++seq}`; sessions.set(id, new FakeSession(dir)); return { ok: true, value: { sessionId: id } }; },
    getSession: (id) => sessions.get(id) as never,
    releaseSession: (id) => released.push(id),
    activeSessionId: () => active,
  }, store);
  for (let i = 0; i < 11; i++) { ex.run(j, 'manual'); sessions.get(`s${i + 1}`)!.finish('done'); }
  assert.equal(released.length, 1);
  assert.notEqual(released[0], active);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/serve/schedules/executor.test.js`
Expected: FAIL（`ScheduleExecutor is not a constructor`）。

- [ ] **Step 3: 实现 executor.ts**

```ts
// src/serve/schedules/executor.ts
import { randomBytes } from 'node:crypto';
import { defaultScratchRoot } from '../session-lifecycle';
import type { CreateSessionOpts } from '../session-lifecycle';
import type { Result } from '../../result';
import type { SessionRuntime } from '../session';
import { purgeSession, writeSessionMeta } from '../../tui/session-journal';
import type { RunRecord, RunStatus, RunTrigger, ScheduleJob } from './model';
import type { ScheduleStore } from './store';

const RETAIN_MAX = 10;

export interface ScheduleExecutorIo {
  createSession(root: string, opts?: CreateSessionOpts): Result<{ sessionId: string }>;
  getSession(id: string): SessionRuntime | undefined;
  releaseSession(id: string): void;
  activeSessionId(): string | undefined;
  now?: () => number;
}

function runId(): string {
  return `run-${randomBytes(4).toString('hex')}`;
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function stamp(now: number): string {
  const d = new Date(now);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class ScheduleExecutor {
  private readonly now: () => number;
  private readonly retained: Array<{ id: string; endedAt: number }> = [];

  constructor(private readonly io: ScheduleExecutorIo, private readonly store: ScheduleStore) {
    this.now = io.now ?? (() => Date.now());
  }

  run(job: ScheduleJob, trigger: RunTrigger, plannedAt?: number): string | undefined {
    const now = this.now();
    const root = job.root === 'default' ? defaultScratchRoot() : job.root;
    const created = this.io.createSession(root, { mode: job.mode, activate: false });
    if (!created.ok) {
      const run: RunRecord = { id: runId(), trigger, ...(plannedAt !== undefined ? { scheduledAt: plannedAt } : {}), startedAt: now, endedAt: now, status: 'failed', root, error: created.error.message };
      this.store.addRun(job.id, run);
      return run.id;
    }
    const sessionId = created.value.sessionId;
    const session = this.io.getSession(sessionId);
    if (session === undefined) {
      this.io.releaseSession(sessionId);
      const run: RunRecord = { id: runId(), trigger, ...(plannedAt !== undefined ? { scheduledAt: plannedAt } : {}), startedAt: now, endedAt: now, status: 'failed', root, error: 'session not found after create' };
      this.store.addRun(job.id, run);
      return run.id;
    }
    session.setEffort(job.effort);
    session.ensureJournalMinted();
    const jid = session.attachedJournalId;
    if (jid !== undefined) writeSessionMeta(session.dataDir, jid, { title: `${job.name} · ${stamp(now)}` });
    const submitted = session.submit(job.prompt);
    if (!submitted.ok) {
      this.io.releaseSession(sessionId);
      if (jid !== undefined) {
        try { purgeSession(session.dataDir, jid); } catch { /* 尽力清理空档 */ }
      }
      const run: RunRecord = { id: runId(), trigger, ...(plannedAt !== undefined ? { scheduledAt: plannedAt } : {}), startedAt: now, endedAt: now, status: 'failed', root, error: submitted.error };
      this.store.addRun(job.id, run);
      return run.id;
    }
    const run: RunRecord = {
      id: runId(),
      trigger,
      ...(plannedAt !== undefined ? { scheduledAt: plannedAt } : {}),
      startedAt: now,
      status: 'running',
      sessionId,
      ...(jid !== undefined ? { journalId: jid } : {}),
      root,
    };
    this.store.addRun(job.id, run);
    session.onRunEnd((info) => {
      const status: RunStatus = info.stopReason === 'done' ? 'succeeded' : info.stopReason === 'interrupted' ? 'stopped' : 'failed';
      this.store.patchRun(job.id, run.id, {
        status,
        endedAt: info.endedAt,
        seconds: info.seconds,
        ...(status === 'failed' ? { error: info.stopReason ?? 'run failed' } : {}),
      });
      this.retain(sessionId, info.endedAt);
    });
    return run.id;
  }

  private retain(sessionId: string, endedAt: number): void {
    this.retained.push({ id: sessionId, endedAt });
    while (this.retained.length > RETAIN_MAX) {
      const active = this.io.activeSessionId();
      const idx = this.retained.findIndex((r) => r.id !== active);
      if (idx < 0) break;
      const [old] = this.retained.splice(idx, 1);
      if (old !== undefined) this.io.releaseSession(old.id);
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/serve/schedules/executor.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/serve/schedules/executor.ts src/serve/schedules/executor.test.ts
git commit -m "feat(schedules): executor creates normal sessions and records runs"
```

---

## Task 6: HTTP handlers 与 daemon 接线

**Files:**
- Create: `src/serve/schedules/handlers.ts`
- Modify: `src/serve/daemon.ts`（imports/fields/constructor/routes/start/teardown/releaseSession）
- Test: `src/serve/daemon.schedules.test.ts`

**Interfaces:**
- Consumes: `ScheduleEngine`、`ScheduleStore`、`validateDraft`、`jobView`、`nextRunAt`。
- Produces: `SchedulesHandlerIo { send; readJson; engine; defaultModel(): string }` + `handleSchedulesList/Create/Update/Delete/Run/Enabled/Runs/Preview`。
- daemon 的路由表新增 `/schedules*`；`start()` 末尾 `this.scheduleEngine.start()`；`teardown()` 首行 `this.scheduleEngine.stop()`。

- [ ] **Step 1: 写 daemon 级失败测试**

```ts
// src/serve/daemon.schedules.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import { readSessionMeta, sessionsDir } from '../tui/session-journal';
import { resolveDataDir } from '../config/data-dir';

const AUTH = { authorization: 'Bearer t', 'content-type': 'application/json' };

async function withSchedulesDaemon(fn: (ctx: { base: string; tmp: string; daemon: GuiDaemon }) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-daemon-'));
  const prevHome = process.env.HOME;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.HOME = tmp;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
  const s = await daemon.start({ port: 0, token: 't' });
  try {
    await fn({ base: `http://127.0.0.1:${s.port}`, tmp, daemon });
  } finally {
    await s.close();
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test('schedules CRUD / enabled / run / records：触发建普通会话并落标题', async () => {
  await withSchedulesDaemon(async ({ base, tmp }) => {
    const list0 = await (await fetch(`${base}/schedules`, { headers: AUTH })).json() as { jobs: unknown[]; defaultModel: string };
    assert.deepEqual(list0.jobs, []);
    assert.ok(typeof list0.defaultModel === 'string');

    const startAt = Date.now() + 3_600_000;
    const created = await fetch(`${base}/schedules`, { method: 'POST', headers: AUTH, body: JSON.stringify({
      name: '巡检', prompt: '检查仓库', root: tmp, effort: 'high', mode: 'full-access',
      recurrence: { unit: 'day', every: 1, at: '09:00' }, startAt,
    }) });
    assert.equal(created.status, 200);
    const job = await created.json() as { id: string; enabled: boolean; nextRunAt: number | null };
    assert.equal(job.enabled, true);
    assert.ok(job.nextRunAt !== null && job.nextRunAt > Date.now());

    const off = await (await fetch(`${base}/schedules/${job.id}/enabled`, { method: 'POST', headers: AUTH, body: JSON.stringify({ enabled: false }) })).json() as { enabled: boolean; nextRunAt: number | null };
    assert.equal(off.enabled, false);
    assert.equal(off.nextRunAt, null);
    const on = await (await fetch(`${base}/schedules/${job.id}/enabled`, { method: 'POST', headers: AUTH, body: JSON.stringify({ enabled: true }) })).json() as { enabled: boolean };
    assert.equal(on.enabled, true);

    const run = await (await fetch(`${base}/schedules/${job.id}/run`, { method: 'POST', headers: AUTH })).json() as { runId: string };
    assert.ok(run.runId.startsWith('run-'));

    const deadline = Date.now() + 10_000;
    let runRow: { status: string; sessionId?: string; journalId?: string; root: string } | undefined;
    while (runRow?.status !== 'succeeded') {
      if (Date.now() > deadline) throw new Error('run timeout');
      const body = await (await fetch(`${base}/schedules/${job.id}/runs`, { headers: AUTH })).json() as { runs: Array<{ status: string; sessionId?: string; journalId?: string; root: string }> };
      runRow = body.runs[0];
      if (runRow !== undefined && runRow.status === 'running') await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(runRow.journalId !== undefined);
    const meta = readSessionMeta(resolveDataDir(tmp), runRow.journalId!);
    assert.match(meta.title ?? '', /^巡检 · \d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(meta.effort, 'high');
    assert.ok(fs.existsSync(path.join(sessionsDir(resolveDataDir(tmp)), `${runRow.journalId}.jsonl`)));

    const del = await fetch(`${base}/schedules/${job.id}`, { method: 'DELETE', headers: AUTH });
    assert.equal(del.status, 200);
    const list1 = await (await fetch(`${base}/schedules`, { headers: AUTH })).json() as { jobs: unknown[] };
    assert.deepEqual(list1.jobs, []);
  });
});

test('preview 与非法 draft 400', async () => {
  await withSchedulesDaemon(async ({ base }) => {
    const ok = await fetch(`${base}/schedules/preview`, { method: 'POST', headers: AUTH, body: JSON.stringify({ recurrence: { unit: 'day', every: 1, at: '09:00' }, startAt: Date.now() + 60_000 }) });
    assert.equal(ok.status, 200);
    const next = (await ok.json()) as { next: number[] };
    assert.equal(next.next.length, 3);
    const bad = await fetch(`${base}/schedules/preview`, { method: 'POST', headers: AUTH, body: JSON.stringify({ recurrence: { unit: 'day', every: 1, at: '99:99' }, startAt: 1 }) });
    assert.equal(bad.status, 400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/serve/daemon.schedules.test.js`
Expected: FAIL（`/schedules` 404）。

- [ ] **Step 3: 实现 handlers.ts**

```ts
// src/serve/schedules/handlers.ts
import type * as http from 'node:http';
import { jobView, validateDraft } from './model';
import type { ScheduleJobView } from './model';
import { nextRunAt } from './recurrence';
import type { ScheduleEngine } from './engine';

export interface SchedulesHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  engine: ScheduleEngine;
  defaultModel(): string;
}

function viewOf(job: Parameters<typeof jobView>[0]): ScheduleJobView {
  return jobView(job);
}

export function handleSchedulesList(io: SchedulesHandlerIo, res: http.ServerResponse): void {
  io.send(res, 200, { now: Date.now(), defaultModel: io.defaultModel(), jobs: io.engine.list().map(viewOf) });
}

export async function handleSchedulesCreate(io: SchedulesHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const draft = validateDraft(parsed.body, Date.now());
  if (!draft.ok) return io.send(res, 400, { error: draft.error });
  io.send(res, 200, viewOf(io.engine.create(draft.value)));
}

export async function handleSchedulesUpdate(io: SchedulesHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const draft = validateDraft(parsed.body, Date.now());
  if (!draft.ok) return io.send(res, 400, { error: draft.error });
  const job = io.engine.update(id, draft.value);
  if (job === undefined) return io.send(res, 404, { error: 'unknown schedule' });
  io.send(res, 200, viewOf(job));
}

export function handleSchedulesDelete(io: SchedulesHandlerIo, res: http.ServerResponse, id: string): void {
  if (!io.engine.remove(id)) return io.send(res, 404, { error: 'unknown schedule' });
  io.send(res, 200, { ok: true });
}

export function handleSchedulesRun(io: SchedulesHandlerIo, res: http.ServerResponse, id: string): void {
  const runId = io.engine.runNow(id);
  if (runId === undefined) return io.send(res, 404, { error: 'unknown schedule' });
  io.send(res, 200, { ok: true, runId });
}

export async function handleSchedulesEnabled(io: SchedulesHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const enabled = (parsed.body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== 'boolean') return io.send(res, 400, { error: 'enabled boolean required' });
  const job = io.engine.setEnabled(id, enabled);
  if (job === undefined) return io.send(res, 404, { error: 'unknown schedule' });
  io.send(res, 200, viewOf(job));
}

export function handleSchedulesRuns(io: SchedulesHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
  const job = io.engine.get(id);
  if (job === undefined) return io.send(res, 404, { error: 'unknown schedule' });
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const raw = Number(url.searchParams.get('limit') ?? '200');
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 200;
  io.send(res, 200, { runs: job.runs.slice(0, limit) });
}

export async function handleSchedulesPreview(io: SchedulesHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const body = parsed.body as { recurrence?: unknown; startAt?: unknown; until?: unknown } | null;
  const startAt = typeof body?.startAt === 'number' ? body.startAt : NaN;
  const until = typeof body?.until === 'number' ? body.until : undefined;
  const draft = validateDraft({ name: 'preview', prompt: 'preview', root: 'default', effort: 'medium', mode: 'full-access', recurrence: body?.recurrence, startAt, ...(until !== undefined ? { until } : {}) }, Date.now());
  if (!draft.ok) return io.send(res, 400, { error: draft.error });
  const next: number[] = [];
  let cursor = Date.now() - 1;
  for (let i = 0; i < 3; i++) {
    const t = nextRunAt(draft.value.recurrence, draft.value.startAt, cursor, draft.value.until);
    if (t === null) break;
    next.push(t);
    cursor = t;
  }
  io.send(res, 200, { next });
}
```


- [ ] **Step 4: 接线 daemon.ts**

Imports（文件顶部 imports 区）：

```ts
import { ScheduleStore, schedulesFile } from './schedules/store';
import { ScheduleEngine } from './schedules/engine';
import { ScheduleExecutor } from './schedules/executor';
import * as scheduleHandlers from './schedules/handlers';
import type { SchedulesHandlerIo } from './schedules/handlers';
```

Fields（`private readonly providerRoot: string;` 附近）：

```ts
/** 定时任务（2026-11-20）：store/engine/executor 单例；引擎 start/stop 随 daemon 生命周期 */
private readonly scheduleStore: ScheduleStore;
private readonly scheduleExecutor: ScheduleExecutor;
private readonly scheduleEngine: ScheduleEngine;
```

构造函数（`this.providerRoot = ...` 之后）：

```ts
this.scheduleStore = new ScheduleStore(schedulesFile());
this.scheduleExecutor = new ScheduleExecutor({
  createSession: (root, opts) => this.createSession(root, opts),
  getSession: (id) => this.sessions.get(id),
  releaseSession: (id) => this.releaseSession(id),
  activeSessionId: () => this.activeId(),
}, this.scheduleStore);
this.scheduleEngine = new ScheduleEngine({
  store: this.scheduleStore,
  execute: (job, trigger, plannedAt) => this.scheduleExecutor.run(job, trigger, plannedAt),
});
```

daemon 内新增私方法（`createSession` 附近）：

```ts
/** 定时任务/超限回收：teardown+出注册表+拆项目监听+杀 pty；journal 留盘，点记录可重建 */
private releaseSession(id: string): void {
  const session = this.sessions.get(id);
  if (session === undefined) return;
  void session.teardown().then(
    () => {
      this.sessions.delete(id);
      this.unwatchProjectRoot(session.root);
      this.sealAndKillPtyFor(id, session.attachedJournalId);
      if (this.active === id) this.active = undefined;
    },
    () => undefined,
  );
}

/** handlers 面（send/readJson 复用 daemon 单点；defaultModel 给 GUI 模型 pill） */
private get scheduleHandlerIo(): SchedulesHandlerIo {
  return {
    send: (res, status, body) => this.send(res, status, body),
    readJson: (req) => this.readJson(req),
    engine: this.scheduleEngine,
    defaultModel: () => {
      const m = this.model;
      return m.label ?? m.provider;
    },
  };
}
```

路由表（`/app/seen` 附近）：

```ts
{ method: 'GET', path: '/schedules', auth: true, run: async (_req, res) => scheduleHandlers.handleSchedulesList(this.scheduleHandlerIo, res) },
{ method: 'POST', path: '/schedules', auth: true, run: async (req, res) => scheduleHandlers.handleSchedulesCreate(this.scheduleHandlerIo, req, res) },
{ method: 'POST', path: '/schedules/preview', auth: true, run: async (req, res) => scheduleHandlers.handleSchedulesPreview(this.scheduleHandlerIo, req, res) },
{ method: 'PUT', path: '/schedules/:id', auth: true, run: async (req, res, p) => scheduleHandlers.handleSchedulesUpdate(this.scheduleHandlerIo, req, res, p.id) },
{ method: 'DELETE', path: '/schedules/:id', auth: true, run: async (_req, res, p) => scheduleHandlers.handleSchedulesDelete(this.scheduleHandlerIo, res, p.id) },
{ method: 'POST', path: '/schedules/:id/run', auth: true, run: async (_req, res, p) => scheduleHandlers.handleSchedulesRun(this.scheduleHandlerIo, res, p.id) },
{ method: 'POST', path: '/schedules/:id/enabled', auth: true, run: async (req, res, p) => scheduleHandlers.handleSchedulesEnabled(this.scheduleHandlerIo, req, res, p.id) },
{ method: 'GET', path: '/schedules/:id/runs', auth: true, run: async (req, res, p) => scheduleHandlers.handleSchedulesRuns(this.scheduleHandlerIo, req, res, p.id) },
```

`start()` 末尾（`return { port: addr.port, token, close: () => this.close() };` 之前）：

```ts
// 定时任务布防：监听已就绪后再补跑/布防，catch-up 建的会话走完整 HTTP/会话栈
this.scheduleEngine.start();
```

`teardown()` 首行（`private async teardown()` 的 `{` 之后）：

```ts
this.scheduleEngine.stop();
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm build && node --test dist/serve/daemon.schedules.test.js`
Expected: PASS（两条用例）。

- [ ] **Step 6: 提交**

```bash
git add src/serve/schedules/handlers.ts src/serve/schedules/daemon.schedules.test.ts src/serve/daemon.ts
git commit -m "feat(schedules): HTTP API and daemon lifecycle wiring"
```

---

## Task 7: GUI 连接面与周期映射

**Files:**
- Modify: `gui/src/connection-types.ts`（类型）
- Modify: `gui/src/connection-api.ts`（`Connection` 接口）
- Modify: `gui/src/connection.ts`（实现 + `putJson`/`del` 助手）
- Create: `gui/src/schedules/cycle.ts`
- Test: `gui/src/schedules/cycle.test.ts`

**Interfaces:**
- Produces:
  - `ScheduleCycle = 'every15m'|'hourly'|'daily'|'weekdays'|'weekly'|'monthly'|'yearly'`
  - `recurrenceOf(cycle: ScheduleCycle, startAt: number): ScheduleRecurrence`
  - `cycleOf(rec: ScheduleRecurrence): ScheduleCycle`
  - `Connection.schedules/createSchedule/updateSchedule/deleteSchedule/runScheduleNow/setScheduleEnabled/scheduleRuns/previewSchedule`

- [ ] **Step 1: 写失败测试**

```ts
// gui/src/schedules/cycle.test.ts
import { describe, it, expect } from 'vitest';
import { recurrenceOf, cycleOf } from './cycle';

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
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir gui exec vitest run src/schedules/cycle.test.ts`
Expected: FAIL（module not found）。

- [ ] **Step 3: 写类型、连接方法、cycle.ts**

`gui/src/connection-types.ts` 追加：

```ts
export type ScheduleCycle = 'every15m' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';
export type ScheduleRecurrenceUnit = 'minute' | 'hour' | 'day' | 'weekday' | 'week' | 'month' | 'year';
export interface ScheduleRecurrence {
  unit: ScheduleRecurrenceUnit;
  every: number;
  at?: string;
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  day?: number;
}
export type ScheduleMode = 'read-only' | 'acceptEdits' | 'full-access';
export type ScheduleRunStatus = 'running' | 'succeeded' | 'failed' | 'stopped' | 'skipped' | 'interrupted';
export type ScheduleRunTrigger = 'schedule' | 'catch-up' | 'manual';
export interface ScheduleRunView {
  id: string; trigger: ScheduleRunTrigger; scheduledAt?: number; startedAt: number; endedAt?: number;
  status: ScheduleRunStatus; sessionId?: string; journalId?: string; root: string; error?: string; seconds?: number;
}
export interface ScheduleJobView {
  id: string; name: string; prompt: string; root: string; effort: string; mode: ScheduleMode;
  recurrence: ScheduleRecurrence; startAt: number; until?: number; enabled: boolean; ended?: boolean;
  createdAt: number; updatedAt: number; nextRunAt: number | null; runCount: number; lastRun?: ScheduleRunView;
}
export interface ScheduleDraft {
  name: string; prompt: string; root: string; effort: string; mode: ScheduleMode;
  recurrence: ScheduleRecurrence; startAt: number; until?: number;
}
export interface SchedulesView { now: number; defaultModel: string; jobs: ScheduleJobView[] }
```

`gui/src/connection-api.ts` 的 `Connection` 接口追加：

```ts
schedules(): Promise<SchedulesView>;
createSchedule(body: ScheduleDraft): Promise<ScheduleJobView>;
updateSchedule(id: string, body: ScheduleDraft): Promise<ScheduleJobView>;
deleteSchedule(id: string): Promise<{ ok: true }>;
runScheduleNow(id: string): Promise<{ ok: true; runId: string }>;
setScheduleEnabled(id: string, enabled: boolean): Promise<ScheduleJobView>;
scheduleRuns(id: string, limit?: number): Promise<{ runs: ScheduleRunView[] }>;
previewSchedule(body: { recurrence: ScheduleRecurrence; startAt: number; until?: number }): Promise<{ next: number[] }>;
```

`gui/src/connection.ts` 的 imports type 列表追加 `ScheduleDraft, ScheduleJobView, ScheduleRecurrence, SchedulesView, ScheduleRunView`；helpers 追加：

```ts
async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}
async function del(path: string): Promise<void> {
  const res = await fetch(`${base}${path}`, { method: 'DELETE', headers: authHeaders });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
}
```

返回对象里（`sunxSessions` 附近）追加：

```ts
schedules() { return getJson<SchedulesView>('/schedules'); },
createSchedule(body: ScheduleDraft) { return postJson<ScheduleJobView>('/schedules', body); },
updateSchedule(id: string, body: ScheduleDraft) { return putJson<ScheduleJobView>(`/schedules/${encodeURIComponent(id)}`, body); },
async deleteSchedule(id: string): Promise<{ ok: true }> { await del(`/schedules/${encodeURIComponent(id)}`); return { ok: true }; },
runScheduleNow(id: string) { return postJson<{ ok: true; runId: string }>(`/schedules/${encodeURIComponent(id)}/run`, {}); },
setScheduleEnabled(id: string, enabled: boolean) { return postJson<ScheduleJobView>(`/schedules/${encodeURIComponent(id)}/enabled`, { enabled }); },
scheduleRuns(id: string, limit?: number) { return getJson<{ runs: ScheduleRunView[] }>(`/schedules/${encodeURIComponent(id)}/runs${limit !== undefined ? `?limit=${limit}` : ''}`); },
previewSchedule(body: { recurrence: ScheduleRecurrence; startAt: number; until?: number }) { return postJson<{ next: number[] }>('/schedules/preview', body); },
```

`gui/src/schedules/cycle.ts`：

```ts
import type { ScheduleCycle, ScheduleRecurrence } from '../connection-types';

export const CYCLE_OPTIONS: ReadonlyArray<{ id: ScheduleCycle; label: { en: string; zh: string } }> = [
  { id: 'every15m', label: { en: 'Every 15 minutes', zh: '每 15 分钟' } },
  { id: 'hourly', label: { en: 'Hourly', zh: '每小时' } },
  { id: 'daily', label: { en: 'Daily', zh: '每天' } },
  { id: 'weekdays', label: { en: 'Weekdays', zh: '工作日' } },
  { id: 'weekly', label: { en: 'Weekly', zh: '每周' } },
  { id: 'monthly', label: { en: 'Monthly', zh: '每月' } },
  { id: 'yearly', label: { en: 'Yearly', zh: '每年' } },
];

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function isoWeekday(ts: number): number {
  const w = new Date(ts).getDay();
  return w === 0 ? 7 : w;
}

/** 周期下拉 + 开始时间（锚点）→ 存储 recurrence */
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

/** 存储 recurrence → 周期下拉（GUI 只写预设；非预设防御回 daily） */
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
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `pnpm --dir gui exec vitest run src/schedules/cycle.test.ts`
Expected: PASS。
Run: `pnpm --dir gui run typecheck`
Expected: 零错误（若 `Connection` 的其他实现/桩缺方法，补到对应测试桩）。

- [ ] **Step 5: 提交**

```bash
git add gui/src/connection-types.ts gui/src/connection-api.ts gui/src/connection.ts gui/src/schedules/cycle.ts gui/src/schedules/cycle.test.ts
git commit -m "feat(schedules): GUI connection API and cycle mapping"
```

---

## Task 8: 三行配置页（名称 / 调度 / 任务，复用 ComposerCard）

**Files:**
- Create: `gui/src/schedules/ScheduleConfig.tsx`
- Test: `gui/src/schedules/ScheduleConfig.test.tsx`

**Interfaces:**
- Consumes: `Connection`（schedules 方法 + workspaces/createWorkspace/locateWorkspace/onConfigChanged/dirpicker）、`recurrenceOf`、`cycleOf`、`CYCLE_OPTIONS`、`useWelcomeWorkspaces`、`WelcomeProjectPop`、`DirPicker`、`ComposerCard`、`EffortSlider`、`effortLabel`。
- Produces: `ScheduleConfig({ conn, job?, defaultModel, onSaved })`；保存 payload=`ScheduleDraft`（recurrence 由 cycle+start 映射）。

- [ ] **Step 1: 写失败测试**

```tsx
// gui/src/schedules/ScheduleConfig.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ScheduleConfig } from './ScheduleConfig';
import type { Connection } from '../connection';

const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

function makeConn() {
  return {
    workspaces: vi.fn(async () => [{ slug: 'default', root: 'default', sessionCount: 0 }]),
    createSchedule: vi.fn(async (body: unknown) => ({ id: 'new', ...(body as object), createdAt: 1, updatedAt: 1, nextRunAt: Date.now() + 60_000, runCount: 0 })),
    updateSchedule: vi.fn(async (_id: string, body: unknown) => ({ id: 'j1', ...(body as object), createdAt: 1, updatedAt: 1, nextRunAt: Date.now() + 60_000, runCount: 0 })),
    previewSchedule: vi.fn(async () => ({ next: [Date.now() + 60_000] })),
    locateWorkspace: vi.fn(async () => ({ path: null })),
    createWorkspace: vi.fn(async () => ({ ok: true as const, root: 'D:/w/p', slug: 'p' })),
    dirpicker: vi.fn(async () => ({ path: '', parent: '', dirs: [] })),
    onConfigChanged: vi.fn(() => () => undefined),
  } as unknown as Connection;
}

describe('ScheduleConfig 三行', () => {
  it('只有名称/调度/任务；调度以开始时间为锚点；保存 payload 映射正确', async () => {
    const conn = makeConn();
    const onSaved = vi.fn();
    render(<ScheduleConfig conn={conn} defaultModel="DeepSeek" onSaved={onSaved} />);
    expect(await screen.findByText(bi('Name', '名称'))).toBeDefined();
    expect(screen.getByText(bi('Schedule', '调度'))).toBeDefined();
    expect(screen.getByText(bi('Task', '任务'))).toBeDefined();

    fireEvent.change(screen.getByLabelText(bi('Name', '名称')), { target: { value: '巡检' } });
    fireEvent.change(screen.getByLabelText(bi('Task', '任务')), { target: { value: '检查仓库' } });
    fireEvent.change(screen.getByLabelText(bi('Starts at', '开始时间')), { target: { value: '2026-11-20T09:30' } });
    fireEvent.change(screen.getByLabelText(bi('Repeat', '周期')), { target: { value: 'daily' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));

    await waitFor(() => expect(conn.createSchedule).toHaveBeenCalledTimes(1));
    const body = (conn.createSchedule as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0]![0];
    expect(body.name).toBe('巡检');
    expect(body.prompt).toBe('检查仓库');
    expect(body.recurrence).toEqual({ unit: 'day', every: 1, at: '09:30' });
    expect(body.startAt).toBe(new Date(2026, 10, 20, 9, 30, 0, 0).getTime());
    expect(onSaved).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir gui exec vitest run src/schedules/ScheduleConfig.test.tsx`
Expected: FAIL（module not found）。

- [ ] **Step 3: 实现 ScheduleConfig.tsx**

```tsx
// gui/src/schedules/ScheduleConfig.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Folder, Plus } from 'lucide-react';
import { t } from '../i18n';
import { errText, pathBasename } from '../ui-util';
import { usePopOutsideClose } from '../use-pop-outside-close';
import { useWelcomeWorkspaces } from '../welcome/use-welcome-workspaces';
import { WelcomeProjectPop } from '../welcome/welcome-project-pop';
import { DirPicker } from '../pages/DirPicker';
import { ComposerCard } from '../composer/ComposerCard';
import { EffortSlider, effortLabel } from '../effort-slider';
import type { Connection, ScheduleDraft, ScheduleJobView, ScheduleMode } from '../connection';
import { CYCLE_OPTIONS, cycleOf, recurrenceOf } from './cycle';
import type { ScheduleCycle } from '../connection';

export interface ScheduleConfigProps {
  readonly conn: Connection;
  readonly job?: ScheduleJobView;
  readonly defaultModel: string;
  readonly onSaved: (job: ScheduleJobView) => void;
}

const MODES: Array<{ id: ScheduleMode; en: string; zh: string }> = [
  { id: 'read-only', en: 'Read-only', zh: '只读' },
  { id: 'acceptEdits', en: 'Auto edit', zh: '自动编辑' },
  { id: 'full-access', en: 'Full access', zh: '完全访问' },
];

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): number {
  return new Date(v).getTime();
}

export function ScheduleConfig({ conn, job, defaultModel, onSaved }: ScheduleConfigProps): JSX.Element {
  const [name, setName] = useState(job?.name ?? '');
  const [prompt, setPrompt] = useState(job?.prompt ?? '');
  const [cycle, setCycle] = useState<ScheduleCycle>(job !== undefined ? cycleOf(job.recurrence) : 'daily');
  const [start, setStart] = useState(toLocalInput(job?.startAt ?? Date.now()));
  const [noUntil, setNoUntil] = useState(job?.until === undefined);
  const [until, setUntil] = useState(job?.until !== undefined ? toLocalInput(job.until) : '');
  const [effort, setEffort] = useState(job?.effort ?? 'high');
  const [mode, setMode] = useState<ScheduleMode>(job?.mode ?? 'full-access');
  const [picked, setPicked] = useState('');
  const [projOpen, setProjOpen] = useState(false);
  const [projQuery, setProjQuery] = useState('');
  const [hint, setHint] = useState('');
  const [dirOpen, setDirOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nextPreview, setNextPreview] = useState<number | null>(null);
  const projRef = useRef<HTMLDivElement>(null);
  const { rows, browseFolder, registerFolder } = useWelcomeWorkspaces(conn, job?.root, 0, { setPicked, setProjOpen, setHint, setDirOpen });
  usePopOutsideClose(projOpen, '.proj-pop', '.sx-schedule-ws-anchor', () => setProjOpen(false));
  usePopOutsideClose(modelOpen, '.sx-schedule-effort-pop', '.sx-schedule-model-pill', () => setModelOpen(false));
  usePopOutsideClose(modeOpen, '.sx-schedule-mode-pop', '.sx-schedule-mode-pill', () => setModeOpen(false));

  const startMs = fromLocalInput(start);
  const wsLabel = useMemo(() => {
    const r = picked.trim();
    if (r === '' || r === 'default') return t('Default workspace', '默认工作区');
    const b = pathBasename(r);
    return b === 'default' || b.startsWith('sunshinex-default') ? t('Default workspace', '默认工作区') : b;
  }, [picked]);

  useEffect(() => {
    if (!Number.isFinite(startMs)) { setNextPreview(null); return; }
    let alive = true;
    const timer = setTimeout(() => {
      const untilMs = !noUntil && until !== '' ? fromLocalInput(until) : undefined;
      conn.previewSchedule({
        recurrence: recurrenceOf(cycle, startMs),
        startAt: startMs,
        ...(untilMs !== undefined && Number.isFinite(untilMs) ? { until: untilMs } : {}),
      }).then((r) => { if (alive) setNextPreview(r.next[0] ?? null); }, () => { if (alive) setNextPreview(null); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [conn, cycle, startMs, noUntil, until]);

  const save = (): void => {
    if (busy) return;
    if (name.trim() === '' || prompt.trim() === '') { setError(t('Name and task are required', '名称和任务必填')); return; }
    if (!Number.isFinite(startMs)) { setError(t('Invalid start time', '开始时间无效')); return; }
    const untilMs = noUntil ? undefined : fromLocalInput(until);
    if (!noUntil && (!Number.isFinite(untilMs) || (untilMs as number) <= startMs)) { setError(t('End must be after start', '截止时间必须晚于开始')); return; }
    setBusy(true);
    setError('');
    const body: ScheduleDraft = {
      name: name.trim(),
      prompt: prompt.trim(),
      root: picked.trim() === '' ? 'default' : picked.trim(),
      effort,
      mode,
      recurrence: recurrenceOf(cycle, startMs),
      startAt: startMs,
      ...(untilMs !== undefined ? { until: untilMs } : {}),
    };
    const p = job !== undefined ? conn.updateSchedule(job.id, body) : conn.createSchedule(body);
    p.then((savedJob) => { setBusy(false); onSaved(savedJob); }, (e: unknown) => { setBusy(false); setError(errText(e)); });
  };

  const nextLabel = nextPreview !== null
    ? new Date(nextPreview).toLocaleString()
    : '—';

  return (
    <div className="sx-schedule-cfg">
      <div className="sx-schedule-row">
        <label className="sx-schedule-label" htmlFor="sx-schedule-name">{t('Name', '名称')}</label>
        <input id="sx-schedule-name" className="sx-schedule-input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>

      <div className="sx-schedule-row">
        <label className="sx-schedule-label" htmlFor="sx-schedule-cycle">{t('Schedule', '调度')}</label>
        <div>
          <div className="sx-schedule-schedule">
            <select id="sx-schedule-cycle" className="sx-schedule-input sx-schedule-select" aria-label={t('Repeat', '周期')} value={cycle} onChange={(e) => setCycle(e.target.value as ScheduleCycle)}>
              {CYCLE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{t(o.label.en, o.label.zh)}</option>)}
            </select>
            <label className="sx-schedule-inline">
              <span>{t('Starts at', '开始时间')}</span>
              <input type="datetime-local" className="sx-schedule-input sx-schedule-datetime" aria-label={t('Starts at', '开始时间')} value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="sx-schedule-nocut"><input type="checkbox" checked={noUntil} onChange={(e) => setNoUntil(e.target.checked)} />{t('No deadline', '无截止')}</label>
            <input type="datetime-local" className="sx-schedule-input sx-schedule-datetime" aria-label={t('Ends at', '截止时间')} value={until} disabled={noUntil} onChange={(e) => setUntil(e.target.value)} />
          </div>
          <div className="sx-schedule-hint">{t('The cycle anchors on the start time', '周期以开始时间为锚点')} · {t('Next', '接下来')} {nextLabel}</div>
        </div>
      </div>

      <div className="sx-schedule-row">
        <span className="sx-schedule-label">{t('Task', '任务')}</span>
        <ComposerCard
          label={t('Task', '任务')}
          value={prompt}
          onChange={setPrompt}
          placeholder={t('Write the full brief: context, goal, acceptance. Every new session starts fresh.', '写清背景、目标、验收标准；每个新会话从零开始')}
          rows={3}
          onKeyDown={() => undefined}
          className="sx-schedule-task-composer"
          footLeft={(
            <>
              <div className="pill-anchor sx-schedule-ws-anchor">
                <button type="button" className="composer-pill" onClick={() => { setProjQuery(''); setProjOpen((v) => !v); }}>
                  <Folder size={14} strokeWidth={1.75} /><span className="pill-label">{wsLabel}</span><ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} />
                </button>
                {projOpen && (
                  <WelcomeProjectPop rows={rows} picked={picked} query={projQuery} onQuery={setProjQuery} onPick={(r) => { setPicked(r); setProjOpen(false); }} onBrowse={() => void browseFolder()} hint={hint} projRef={projRef} />
                )}
                {dirOpen && (
                  <div className="modal-overlay" onClick={() => setDirOpen(false)}>
                    <div className="modal-body" onClick={(e) => e.stopPropagation()}>
                      <DirPicker conn={conn} showManual={false} onCancel={() => setDirOpen(false)} onConfirm={registerFolder} />
                    </div>
                  </div>
                )}
              </div>
              <button type="button" className="composer-pill composer-plus-btn" title={t('Add workspace', '新增工作目录')} onClick={() => void browseFolder()}><Plus size={14} strokeWidth={2} /></button>
              <div className="pill-anchor">
                <button type="button" className="composer-pill model-pill sx-schedule-model-pill" onClick={() => setModelOpen((v) => !v)}>
                  {defaultModel}<span className="model-effort-chip">{effortLabel(effort)}</span><ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} />
                </button>
                {modelOpen && (
                  <div className="sx-menu-pop sx-schedule-effort-pop">
                    <EffortSlider value={effort} onChange={setEffort} />
                  </div>
                )}
              </div>
              <div className="pill-anchor">
                <button
                  type="button"
                  className={`composer-pill sx-schedule-mode-pill${mode === 'full-access' ? ' mode-pill-warn' : ''}`}
                  title={mode === 'full-access' ? t('Unattended: no approvals, writes directly', '无人值守：不会弹审批，会直接写工作目录') : mode === 'acceptEdits' ? t('Unattended: may wait for approval', '无人值守：可能停在审批卡') : t('Read-only', '只读')}
                  onClick={() => setModeOpen((v) => !v)}
                >
                  {t(MODES.find((m) => m.id === mode)?.en ?? 'Full access', MODES.find((m) => m.id === mode)?.zh ?? '完全访问')}
                </button>
                {modeOpen && (
                  <div className="sx-menu-pop sx-schedule-mode-pop">
                    {MODES.map((m) => (
                      <button key={m.id} type="button" className="sx-menuitem" onClick={() => { setMode(m.id); setModeOpen(false); }}>{t(m.en, m.zh)}</button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          footRight={(
            <button type="button" className="send" aria-label={t('Save', '保存')} title={t('Save', '保存')} disabled={busy} onClick={save}>
              <Check size={16} strokeWidth={2} />
            </button>
          )}
        />
      </div>

      {error !== '' && <p className="sx-schedule-error" role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: 追加配置页 CSS**

```css
.sx-schedule-cfg { display: flex; flex-direction: column; gap: 18px; }
.sx-schedule-row { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 12px; align-items: start; }
.sx-schedule-label { padding-top: 8px; color: var(--fg-tertiary); font-size: calc(13px * var(--fz)); }
.sx-schedule-input { width: 100%; background: var(--surface-soft); border: 1px solid var(--border); border-radius: 10px; padding: 7px 10px; color: var(--fg); font: calc(13px * var(--fz))/1.4 var(--font-ui); outline: none; }
.sx-schedule-input:focus { border-color: var(--border-strong); }
.sx-schedule-schedule { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sx-schedule-select { width: 132px; }
.sx-schedule-datetime { width: 190px; }
.sx-schedule-inline { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-secondary); font-size: calc(12.5px * var(--fz)); }
.sx-schedule-inline .sx-schedule-input { width: 190px; }
.sx-schedule-nocut { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-secondary); font-size: calc(12.5px * var(--fz)); }
.sx-schedule-nocut input { accent-color: var(--accent); }
.sx-schedule-hint { margin-top: 7px; color: var(--fg-tertiary); font-size: calc(11.5px * var(--fz)); }
.sx-schedule-task-composer { width: 100%; }
.sx-schedule-task-composer .sx-composer-input { min-height: 96px; }
.sx-schedule-effort-pop { top: auto; bottom: calc(100% + 6px); right: 0; padding: 6px; }
.sx-schedule-mode-pop { top: auto; bottom: calc(100% + 6px); left: 0; min-width: 150px; }
.sx-schedule-ws-anchor .proj-pop { top: auto; bottom: calc(100% + 6px); left: 0; }
```

- [ ] **Step 5: 跑测试 + typecheck**

Run: `pnpm --dir gui exec vitest run src/schedules/ScheduleConfig.test.tsx`
Expected: PASS。
Run: `pnpm --dir gui run typecheck`
Expected: 零错误。

- [ ] **Step 6: 提交**

```bash
git add gui/src/schedules/ScheduleConfig.tsx gui/src/schedules/ScheduleConfig.test.tsx gui/src/app.css
git commit -m "feat(schedules): three-row config with composer dock"
```

---

## Task 9: 执行记录表

**Files:**
- Create: `gui/src/schedules/ScheduleRuns.tsx`
- Test: `gui/src/schedules/ScheduleRuns.test.tsx`

**Interfaces:**
- Consumes: `Connection.scheduleRuns`、`ScheduleJobView`、`ScheduleRunView`。
- Produces: `ScheduleRuns({ conn, job, onOpenSession })`；状态点用项目 `.tb-status-dot`；点击打开会话。

- [ ] **Step 1: 写失败测试**

```tsx
// gui/src/schedules/ScheduleRuns.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ScheduleRuns } from './ScheduleRuns';
import type { Connection, ScheduleJobView, ScheduleRunView } from '../connection';

const job = { id: 'j1', name: '仓库巡检', prompt: 'p', root: 'default', effort: 'high', mode: 'full-access', recurrence: { unit: 'day', every: 1, at: '09:00' }, startAt: 1, enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: 2, runCount: 2 } as ScheduleJobView;
const runs: ScheduleRunView[] = [
  { id: 'r1', trigger: 'schedule', startedAt: 1, endedAt: 2, status: 'succeeded', journalId: 'jid1', root: '/p', seconds: 3 },
  { id: 'r2', trigger: 'schedule', startedAt: 1, endedAt: 2, status: 'failed', journalId: 'jid2', root: '/p', error: '429' },
];
const conn = { scheduleRuns: vi.fn(async () => ({ runs })) } as unknown as Connection;

describe('ScheduleRuns', () => {
  it('项目状态点 + 打开会话', async () => {
    const onOpenSession = vi.fn();
    const { container } = render(<ScheduleRuns conn={conn} job={job} onOpenSession={onOpenSession} />);
    await waitFor(() => expect(conn.scheduleRuns).toHaveBeenCalledWith('j1'));
    const dots = container.querySelectorAll('.tb-status-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0]!.className).toContain('task-status-success');
    expect(dots[1]!.className).toContain('task-status-failed');
    fireEvent.click(screen.getAllByRole('button', { name: /Open session|打开会话/ })[0]!);
    expect(onOpenSession).toHaveBeenCalledWith('jid1', '/p');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir gui exec vitest run src/schedules/ScheduleRuns.test.tsx`
Expected: FAIL（module not found）。

- [ ] **Step 3: 实现 ScheduleRuns.tsx**

```tsx
// gui/src/schedules/ScheduleRuns.tsx
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { Connection, ScheduleJobView, ScheduleRunStatus, ScheduleRunView, ScheduleRunTrigger } from '../connection';

export interface ScheduleRunsProps {
  readonly conn: Connection;
  readonly job: ScheduleJobView;
  readonly onOpenSession: (journalId: string, root: string) => void;
}

const STATUS_CLASS: Record<ScheduleRunStatus, string> = {
  succeeded: 'task-status-success',
  failed: 'task-status-failed',
  skipped: 'task-status-cancelled',
  interrupted: 'task-status-cancelled',
  stopped: 'task-status-cancelled',
  running: 'task-status-running',
};
const STATUS_LABEL: Record<ScheduleRunStatus, { en: string; zh: string }> = {
  succeeded: { en: 'Succeeded', zh: '成功' },
  failed: { en: 'Failed', zh: '失败' },
  skipped: { en: 'Skipped', zh: '跳过' },
  interrupted: { en: 'Interrupted', zh: '已中断' },
  stopped: { en: 'Stopped', zh: '已停止' },
  running: { en: 'Running', zh: '运行中' },
};
const TRIGGER_LABEL: Record<ScheduleRunTrigger, { en: string; zh: string }> = {
  schedule: { en: 'Schedule', zh: '定时' },
  'catch-up': { en: 'Catch-up', zh: '补跑' },
  manual: { en: 'Manual', zh: '手动' },
};

function timeLabel(ts: number | undefined): string {
  if (ts === undefined) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleRuns({ conn, job, onOpenSession }: ScheduleRunsProps): JSX.Element {
  const [runs, setRuns] = useState<ScheduleRunView[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    conn.scheduleRuns(job.id).then(
      (r) => { if (alive) setRuns(r.runs); },
      (e: unknown) => { if (alive) setError(errText(e)); },
    );
    return () => { alive = false; };
  }, [conn, job.id]);
  return (
    <div className="sx-schedule-records">
      {error !== '' && <p className="sx-schedule-error" role="alert">{error}</p>}
      {runs === null ? <p className="sx-schedule-empty">{t('Loading…', '加载中…')}</p> : runs.length === 0 ? <p className="sx-schedule-empty">{t('No runs yet', '暂无执行记录')}</p> : (
        <table className="sx-schedule-table">
          <thead>
            <tr>
              <th>{t('Trigger', '触发方式')}</th>
              <th>{t('Scheduled', '计划时间')}</th>
              <th>{t('Started', '开始时间')}</th>
              <th>{t('Status', '状态')}</th>
              <th>{t('Duration', '耗时')}</th>
              <th>{t('Session', '会话')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{t(TRIGGER_LABEL[run.trigger].en, TRIGGER_LABEL[run.trigger].zh)}</td>
                <td className="num">{timeLabel(run.scheduledAt)}</td>
                <td className="num">{timeLabel(run.startedAt)}</td>
                <td>
                  <span className="sx-schedule-status"><span className={`tb-status-dot ${STATUS_CLASS[run.status]}`} />{t(STATUS_LABEL[run.status].en, STATUS_LABEL[run.status].zh)}</span>
                  {run.status === 'succeeded' && run.error === undefined && run.scheduledAt !== undefined && run.startedAt - run.scheduledAt > 60_000 ? (
                    <div className="sx-schedule-note">{t('Late', '延迟')} {Math.round((run.startedAt - run.scheduledAt) / 60_000)} {t('min', '分钟')}</div>
                  ) : null}
                  {run.error !== undefined && <div className="sx-schedule-err">{run.error}</div>}
                </td>
                <td className="num">{run.seconds !== undefined ? `${run.seconds} ${t('s', '秒')}` : '—'}</td>
                <td>{run.journalId !== undefined ? (
                  <button type="button" className="sx-schedule-open" onClick={() => onOpenSession(run.journalId!, run.root)}>
                    {t('Open session', '打开会话')} <ExternalLink size={12} strokeWidth={1.75} />
                  </button>
                ) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 追加记录表 CSS**

```css
.sx-schedule-records { background: var(--surface-elevated); border-radius: var(--radius-lg); padding: 2px 18px 6px; }
.sx-schedule-table { width: 100%; border-collapse: collapse; font-size: calc(12.5px * var(--fz)); }
.sx-schedule-table th { padding: 11px 10px 9px; text-align: left; font-weight: 500; color: var(--fg-tertiary); font-size: calc(11.5px * var(--fz)); border-bottom: 1px solid var(--border); white-space: nowrap; }
.sx-schedule-table td { padding: 10px; border-bottom: 1px solid var(--border-subtle); vertical-align: top; color: var(--fg-secondary); }
.sx-schedule-table tr:last-child td { border-bottom: none; }
.sx-schedule-table .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.sx-schedule-status { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-secondary); white-space: nowrap; }
.sx-schedule-err { margin-top: 3px; color: var(--err); font-size: calc(11.5px * var(--fz)); }
.sx-schedule-note { margin-top: 3px; color: var(--fg-tertiary); font-size: calc(11.5px * var(--fz)); }
.sx-schedule-open { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); font-size: calc(12px * var(--fz)); white-space: nowrap; }
.sx-schedule-open:hover { text-decoration: underline; }
```

- [ ] **Step 5: 跑测试 + typecheck**

Run: `pnpm --dir gui exec vitest run src/schedules/ScheduleRuns.test.tsx`
Expected: PASS。
Run: `pnpm --dir gui run typecheck`
Expected: 零错误。

- [ ] **Step 6: 提交**

```bash
git add gui/src/schedules/ScheduleRuns.tsx gui/src/schedules/ScheduleRuns.test.tsx gui/src/app.css
git commit -m "feat(schedules): run history with project status dots"
```

---

## Task 10: 列表页（两列三行卡片 + 开关 + 记录/配置切换）

**Files:**
- Create: `gui/src/schedules/ScheduleCard.tsx`
- Create: `gui/src/schedules/SchedulePage.tsx`
- Modify: `gui/src/app.css`（追加 `.sx-schedule-*` 块）
- Test: `gui/src/schedules/SchedulePage.test.tsx`

**Interfaces:**
- Consumes: `Connection.schedules/setScheduleEnabled/deleteSchedule/runScheduleNow/scheduleRuns`、`ScheduleJobView`。
- Produces:
  - `SchedulePage({ conn, onOpenSession, onExit })` — 列表/配置/记录三态、两列卡片、开关、菜单、Esc 层级。
  - `ScheduleCard({ job, now, busy, menuOpen, confirmDelete, focus, onOpen/onToggle/onMenu/onRun/onRecords/onEdit/onDelete })`
  - 切换消息：`onOpenSession(journalId, root)` 由 App 关层并打开会话。

- [ ] **Step 1: 写失败测试**

```tsx
// gui/src/schedules/SchedulePage.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SchedulePage } from './SchedulePage';
import type { Connection, ScheduleJobView } from '../connection';

const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

function job(over: Partial<ScheduleJobView> = {}): ScheduleJobView {
  return {
    id: 'j1', name: '仓库巡检', prompt: '检查昨天以来的提交与 CI', root: 'default', effort: 'high', mode: 'full-access',
    recurrence: { unit: 'day', every: 1, at: '09:00' }, startAt: Date.now(), enabled: true,
    createdAt: 1, updatedAt: 1, nextRunAt: Date.now() + 3_600_000, runCount: 0, ...over,
  };
}

function makeConn(jobs: ScheduleJobView[]) {
  return {
    schedules: vi.fn(async () => ({ now: Date.now(), defaultModel: 'DeepSeek', jobs })),
    setScheduleEnabled: vi.fn(async (id: string, enabled: boolean) => ({ ...job({ id }), enabled, nextRunAt: enabled ? Date.now() + 60_000 : null })),
    deleteSchedule: vi.fn(async () => ({ ok: true as const })),
    runScheduleNow: vi.fn(async () => ({ ok: true as const, runId: 'run-1' })),
    scheduleRuns: vi.fn(async () => ({ runs: [] })),
    workspaces: vi.fn(async () => [{ slug: 'default', root: 'default', sessionCount: 0 }]),
    createSchedule: vi.fn(async () => job({ id: 'new' })),
    updateSchedule: vi.fn(async () => job()),
    previewSchedule: vi.fn(async () => ({ next: [Date.now() + 60_000] })),
  } as unknown as Connection;
}

describe('SchedulePage 列表', () => {
  it('两列三行卡片：名称/内容/倒计时 + 首行开关；开关调 enabled', async () => {
    const conn = makeConn([job(), job({ id: 'j2', name: '依赖升级', enabled: false, nextRunAt: null })]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    expect(await screen.findByText('仓库巡检')).toBeDefined();
    expect(screen.getByText('检查昨天以来的提交与 CI')).toBeDefined();
    expect(screen.getAllByRole('switch')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('switch')[0]!);
    await waitFor(() => expect(conn.setScheduleEnabled).toHaveBeenCalledWith('j1', false));
  });

  it('卡片主体 → 执行记录；「…」菜单 → 编辑/立即执行/删除', async () => {
    const conn = makeConn([job()]);
    render(<SchedulePage conn={conn} onOpenSession={vi.fn()} onExit={vi.fn()} />);
    fireEvent.click(await screen.findByText('仓库巡检'));
    await waitFor(() => expect(conn.scheduleRuns).toHaveBeenCalledWith('j1'));

    fireEvent.click(screen.getByRole('button', { name: /Back|返回/ })); // 记录页返回
    const more = screen.getByRole('button', { name: bi('More', '更多') });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: bi('Run now', '立即执行') }));
    await waitFor(() => expect(conn.runScheduleNow).toHaveBeenCalledWith('j1'));
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: bi('Edit', '编辑') }));
    expect(screen.getByText(bi('Name', '名称'))).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir gui exec vitest run src/schedules/SchedulePage.test.tsx`
Expected: FAIL（module not found）。

- [ ] **Step 3: 实现 ScheduleCard.tsx**

```tsx
// gui/src/schedules/ScheduleCard.tsx
import { Clock3, History, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react';
import { t } from '../i18n';
import type { ScheduleJobView } from '../connection';

export interface ScheduleCardProps {
  readonly job: ScheduleJobView;
  readonly now: number;
  readonly busy: boolean;
  readonly menuOpen: boolean;
  readonly confirmDelete: boolean;
  readonly focus: boolean;
  readonly onOpen: () => void;
  readonly onToggle: () => void;
  readonly onMenu: () => void;
  readonly onRun: () => void;
  readonly onRecords: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

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

export function ScheduleCard(props: ScheduleCardProps): JSX.Element {
  const { job, now, busy, menuOpen, confirmDelete, focus } = props;
  return (
    <div
      className={`sx-schedule-card${job.enabled ? '' : ' is-off'}${focus ? ' is-focus' : ''}`}
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
          onClick={(e) => { e.stopPropagation(); props.onToggle(); }}
        >
          <span className="knob" />
        </button>
        <span className="sx-schedule-name">{job.name}</span>
        <button
          type="button"
          className="sx-iconbtn sx-schedule-more"
          aria-label={t('More', '更多')}
          onClick={(e) => { e.stopPropagation(); props.onMenu(); }}
        >
          <MoreHorizontal size={16} strokeWidth={1.75} />
        </button>
        {menuOpen && (
          <div className="sx-menu-pop" role="menu" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="sx-menuitem" onClick={props.onRun}><Play size={14} />{t('Run now', '立即执行')}</button>
            <button type="button" className="sx-menuitem" onClick={props.onRecords}><History size={14} />{t('Run history', '执行记录')}</button>
            <button type="button" className="sx-menuitem" onClick={props.onEdit}><Pencil size={14} />{t('Edit', '编辑')}</button>
            <button type="button" className={`sx-menuitem${confirmDelete ? ' sx-schedule-danger' : ''}`} onClick={props.onDelete}><Trash2 size={14} />{confirmDelete ? t('Confirm delete', '确认删除') : t('Delete', '删除')}</button>
          </div>
        )}
      </div>
      <p className="sx-schedule-prompt">{job.prompt}</p>
      <div className="sx-schedule-next">
        <Clock3 size={14} strokeWidth={1.75} />
        <span>{t('Next', '下次')}</span>
        <span className={`count${job.enabled ? '' : ' off'}`}>
          {job.ended === true ? t('Ended', '已结束') : !job.enabled ? t('Paused', '已暂停') : countdown((job.nextRunAt ?? now) - now)}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 实现 SchedulePage.tsx（配置/记录组件已在 Task 8/9 完成）**

```tsx
// gui/src/schedules/SchedulePage.tsx
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, PanelLeft, Plus, RefreshCw } from 'lucide-react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { usePopOutsideClose } from '../use-pop-outside-close';
import type { Connection, ScheduleJobView } from '../connection';
import { ScheduleCard } from './ScheduleCard';
import { ScheduleConfig } from './ScheduleConfig';
import { ScheduleRuns } from './ScheduleRuns';

export interface SchedulePageProps {
  readonly conn: Connection;
  readonly onOpenSession: (journalId: string, root: string) => void;
  readonly onExit: () => void;
  /** 左侧菜单开合（菜单收起时仍能从本页重开；App 传 toggleMenuStable） */
  readonly onToggleMenu?: () => void;
}

type View = { kind: 'list' } | { kind: 'config'; editingId?: string } | { kind: 'records'; jobId: string };

export function SchedulePage({ conn, onOpenSession, onExit, onToggleMenu }: SchedulePageProps): JSX.Element {
  const [jobs, setJobs] = useState<ScheduleJobView[] | null>(null);
  const [defaultModel, setDefaultModel] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [menuId, setMenuId] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [busyId, setBusyId] = useState('');
  const [focusName, setFocusName] = useState('');
  const reload = useCallback(() => setRefresh((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    conn.schedules().then(
      (r) => { if (alive) { setJobs(r.jobs); setDefaultModel(r.defaultModel); setError(''); } },
      (e: unknown) => { if (alive) setError(errText(e)); },
    );
    return () => { alive = false; };
  }, [conn, refresh]);
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, []);
  useEffect(() => { const h = setInterval(reload, 10_000); return () => clearInterval(h); }, [reload]);
  useEffect(() => { if (focusName === '') return; const h = setTimeout(() => setFocusName(''), 1600); return () => clearTimeout(h); }, [focusName]);
  useEffect(() => { if (notice === '') return; const h = setTimeout(() => setNotice(''), 2200); return () => clearTimeout(h); }, [notice]);
  usePopOutsideClose(menuId !== '', '.sx-menu-pop', '.sx-schedule-more', () => setMenuId(''));

  const jobOf = (id: string): ScheduleJobView | undefined => (jobs ?? []).find((j) => j.id === id);
  const backToList = (focus?: string): void => {
    if (focus !== undefined && focus !== '') setFocusName(focus);
    setView({ kind: 'list' });
  };

  const editing = view.kind === 'config' && view.editingId !== undefined ? jobOf(view.editingId) : undefined;
  const recordsJob = view.kind === 'records' ? jobOf(view.jobId) : undefined;
  const title = view.kind === 'list'
    ? t('Scheduled tasks', '定时任务')
    : view.kind === 'config'
      ? (editing !== undefined ? t('Edit scheduled task', '编辑定时任务') : t('New scheduled task', '新建定时任务'))
      : `${recordsJob?.name ?? ''} · ${t('Run history', '执行记录')}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (view.kind !== 'list') {
        backToList(view.kind === 'config' ? editing?.name : recordsJob?.name);
        return;
      }
      onExit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const toggle = (job: ScheduleJobView): void => {
    if (busyId !== '') return;
    setBusyId(job.id);
    conn.setScheduleEnabled(job.id, !job.enabled).then(
      (updated) => setJobs((list) => (list ?? []).map((j) => (j.id === updated.id ? updated : j))),
      (e: unknown) => setError(errText(e)),
    ).finally(() => setBusyId(''));
  };
  const runNow = (job: ScheduleJobView): void => {
    setMenuId('');
    conn.runScheduleNow(job.id).then(
      () => { setNotice(t('Triggered once', '已触发一次执行')); setTimeout(reload, 700); },
      (e: unknown) => setError(errText(e)),
    );
  };
  const remove = (job: ScheduleJobView): void => {
    if (confirmId !== job.id) {
      setConfirmId(job.id);
      setTimeout(() => setConfirmId(''), 2600);
      return;
    }
    setConfirmId('');
    setMenuId('');
    conn.deleteSchedule(job.id).then(
      () => setJobs((list) => (list ?? []).filter((j) => j.id !== job.id)),
      (e: unknown) => setError(errText(e)),
    );
  };
  const saved = (job: ScheduleJobView): void => {
    setJobs((list) => {
      const l = list ?? [];
      return l.some((j) => j.id === job.id) ? l.map((j) => (j.id === job.id ? job : j)) : [job, ...l];
    });
    setFocusName(job.name);
    setView({ kind: 'list' });
  };

  return (
    <div className="sx-schedule-page">
      <header className="chat-topbar sx-schedules-topbar">
        {onToggleMenu !== undefined && (
          <button type="button" className="sx-iconbtn sx-menu-toggle" aria-label={t('Menu', '菜单')} onClick={onToggleMenu}><PanelLeft size={16} strokeWidth={1.75} /></button>
        )}
        {view.kind !== 'list' && (
          <button type="button" className="back" onClick={() => backToList(view.kind === 'config' ? editing?.name : recordsJob?.name)}>
            <ArrowLeft size={14} strokeWidth={1.75} />{t('Back', '返回')}
          </button>
        )}
        <span className="chat-title">{title}</span>
        <span className="sx-schedules-spacer" data-drag-band />
        {view.kind === 'list' && (
          <>
            <button type="button" className="sx-iconbtn" aria-label={t('Refresh', '刷新')} onClick={reload}><RefreshCw size={16} strokeWidth={1.75} /></button>
            <button type="button" className="sx-iconbtn" aria-label={t('New task', '新建任务')} onClick={() => setView({ kind: 'config' })}><Plus size={16} strokeWidth={1.75} /></button>
          </>
        )}
      </header>
      {error !== '' && <p className="sx-schedule-error" role="alert">{error}</p>}
      {notice !== '' && <p className="sx-schedule-notice" role="status">{notice}</p>}
      <div className="sx-schedules-scroll">
        <div className="sx-schedules-content">
          {view.kind === 'list' && (jobs === null
            ? <p className="sx-schedule-empty">{t('Loading…', '加载中…')}</p>
            : jobs.length === 0
              ? <p className="sx-schedule-empty">{t('No scheduled tasks yet', '暂无定时任务')}</p>
              : (
                <div className="sx-schedule-grid">
                  {jobs.map((job) => (
                    <ScheduleCard
                      key={job.id}
                      job={job}
                      now={now}
                      busy={busyId === job.id}
                      menuOpen={menuId === job.id}
                      confirmDelete={confirmId === job.id}
                      focus={focusName === job.name}
                      onOpen={() => setView({ kind: 'records', jobId: job.id })}
                      onToggle={() => toggle(job)}
                      onMenu={() => { setConfirmId(''); setMenuId((v) => (v === job.id ? '' : job.id)); }}
                      onRun={() => runNow(job)}
                      onRecords={() => { setMenuId(''); setView({ kind: 'records', jobId: job.id }); }}
                      onEdit={() => { setMenuId(''); setView({ kind: 'config', editingId: job.id }); }}
                      onDelete={() => remove(job)}
                    />
                  ))}
                </div>
              ))}
          {view.kind === 'config' && (
            <ScheduleConfig conn={conn} job={editing} defaultModel={defaultModel} onSaved={saved} />
          )}
          {view.kind === 'records' && recordsJob !== undefined && (
            <ScheduleRuns conn={conn} job={recordsJob} onOpenSession={onOpenSession} />
          )}
        </div>
      </div>
    </div>
  );
}
```

> 本任务只接页面；`ScheduleConfig.tsx` / `ScheduleRuns.tsx` 已在 Task 8/9 实现。

- [ ] **Step 5: 追加 app.css 布局块**

```css
/* ===== 定时任务页（2026-11-20）===== */
.sx-schedules-layer { position: fixed; top: 0; left: var(--menu-occ, 0px); right: 0; bottom: 0; z-index: 60; background: var(--surface); display: flex; flex-direction: column; }
.sx-schedule-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.sx-schedules-topbar { padding-right: 126px; }
.sx-schedules-spacer { flex: 1; align-self: stretch; }
.sx-schedules-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.sx-schedules-content { max-width: 980px; margin: 0 auto; padding: 18px 24px 60px; }
.sx-schedule-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 760px) { .sx-schedule-grid { grid-template-columns: 1fr; } }
.sx-schedule-card { position: relative; display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 10px 12px; background: var(--surface-elevated); border-radius: var(--radius-md); cursor: pointer; }
.sx-schedule-card:hover { background: color-mix(in srgb, var(--surface-elevated) 94%, var(--fg) 6%); }
.sx-schedule-card.is-focus { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }
.sx-schedule-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sx-schedule-card-top .sx-switch { margin-left: 0; }
.sx-schedule-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(14px * var(--fz)); font-weight: 600; }
.sx-schedule-prompt { margin: 0; min-height: 39px; color: var(--fg-secondary); font-size: calc(12.5px * var(--fz)); line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sx-schedule-next { display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--fg-tertiary); font-size: calc(12px * var(--fz)); }
.sx-schedule-next .count { color: var(--fg-secondary); font-variant-numeric: tabular-nums; }
.sx-schedule-next .count.off { color: var(--fg-tertiary); }
.sx-schedule-card.is-off .sx-schedule-name { color: var(--fg-secondary); }
.sx-schedule-card.is-off .sx-schedule-prompt { color: var(--fg-tertiary); }
.sx-schedule-card .sx-menu-pop { top: 34px; right: 8px; }
.sx-schedule-danger, .sx-menu-pop .sx-menuitem.sx-schedule-danger { color: var(--err); }
.sx-schedule-empty { padding: 48px 0; text-align: center; color: var(--fg-tertiary); font-size: calc(13px * var(--fz)); }
.sx-schedule-error { margin: 8px 24px 0; color: var(--err); font-size: calc(12.5px * var(--fz)); }
.sx-schedule-notice { margin: 8px 24px 0; color: var(--fg-tertiary); font-size: calc(12.5px * var(--fz)); }
```

- [ ] **Step 6: 跑测试 + typecheck**

Run: `pnpm --dir gui exec vitest run src/schedules/SchedulePage.test.tsx`
Expected: PASS（两列卡片/开关/记录/编辑入口）。
Run: `pnpm --dir gui run typecheck`
Expected: 零错误。

- [ ] **Step 7: 提交**

```bash
git add gui/src/schedules/ScheduleCard.tsx gui/src/schedules/SchedulePage.tsx gui/src/schedules/SchedulePage.test.tsx gui/src/app.css
git commit -m "feat(schedules): two-column three-line task cards"
```

---

## Task 11: App / 侧栏入口 / 打开会话链

**Files:**
- Modify: `gui/src/sidebar/ProjectMenu.tsx`（prop + 入口）
- Modify: `gui/src/App.tsx`（schedulesMain、层、退出、打开会话、右栏隐藏、nav gate）
- Modify: `gui/src/app.css`（`.sx-schedules-layer` 已在 Task 10；补入口 active 态如需）
- Test: `gui/src/sidebar/project-menu.test.tsx`（新增一条入口用例）

**Interfaces:**
- `ProjectMenuProps.onOpenSchedules?: () => void`
- App `SchedulesMain` 层：点侧栏入口 → 开；点会话/新对话/设置/Esc 列表 → 关。
- `openJournalSession(journalId, root)`：关层 + `newSession(root)` + `attach` + `openSession`。

- [ ] **Step 1: 写失败测试（ProjectMenu 入口）**

```tsx
// 追加到 gui/src/sidebar/project-menu.test.tsx
it('「定时任务」入口在「新建 Sunx」下方，点击回调', () => {
  const onOpenSchedules = vi.fn();
  renderMenu(makeConn(), { onOpenSchedules });
  const btn = screen.getByRole('button', { name: 'scheduled tasks' });
  fireEvent.click(btn);
  expect(onOpenSchedules).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir gui exec vitest run src/sidebar/project-menu.test.tsx`
Expected: FAIL（`onOpenSchedules` 未接线 / 按钮不存在）。

- [ ] **Step 3: ProjectMenu 入口**

`ProjectMenuProps` 加：

```ts
/** 定时任务主区页（2026-11-20）：入口在「新建 Sunx」下方 */
readonly onOpenSchedules?: () => void;
```

解构行（`const { conn, activeSessionId, ..., onOpenSettings, ... } = props;`）加入 `onOpenSchedules`；imports 加 `CalendarClock`（lucide）。在「新建 Sunx」按钮之后、「搜索」之前插入（与 New Sunx 同 `dirView` guard）：

```tsx
{onOpenSchedules !== undefined && (dirView === undefined || dirView === null || onCloseDirView === undefined) ? (
  <button type="button" className="sx-new-chat" aria-label="scheduled tasks" onClick={onOpenSchedules}>
    <CalendarClock size={16} strokeWidth={1.75} />
    <span>{t('Scheduled tasks', '定时任务')}</span>
  </button>
) : null}
```

- [ ] **Step 4: App 接线**

`App.tsx` 状态（`settingsOpen` 附近）：

```ts
/** 定时任务主区层（2026-11-20）：固定层覆盖主区，左侧菜单保持；Chat 不卸载 */
const [schedulesMain, setSchedulesMain] = useState(false);
```

`openSession` 内把 `setSchedulesMain(false);` 放在最前（任何会话导航都关层）；`newChatFromMenu`、`composeInFromMenu`、`leaveToWelcome`、`openSettings` 同样加 `setSchedulesMain(false);`。

`useNavHistory` 传入 gate：

```ts
const { navControls, recordNav } = useNavHistory({ goWelcome: leaveToWelcome, openSession, settingsOpen: settingsOpen || schedulesMain });
```

回调（`openSettings` 附近）：

```tsx
const openSchedulesFromMenu = useStableCallback((): void => {
  closeMenuDrawer();
  setSchedulesMain(true);
});
const closeSchedulesStable = useStableCallback((): void => setSchedulesMain(false));
/** 记录 → 会话：关层 + 既有 newSession+attach 打开（daemon 在座会收编/复用） */
const openJournalSessionStable = useStableCallback((journalId: string, root: string): void => {
  setSchedulesMain(false);
  const conn = connRef.current;
  if (conn === null) return;
  void conn
    .newSession(root)
    .then(({ sessionId }) => conn.attach(sessionId, journalId))
    .then((r) => openSession(r.sessionId, r.root || root, journalId))
    .catch(showOpError);
});
```

`ProjectMenuMemo` props 加 `onOpenSchedules={openSchedulesFromMenu}`。

右栏隐藏：把 `{sidebarAnim.mounted && (` 改为 `{!schedulesMain && sidebarAnim.mounted && (`。

主区层：在 `.sx-main` 之后（`</main>` 之后）插入：

```tsx
{schedulesMain && connInstance !== null && (
  <div className="sx-schedules-layer">
    <SchedulePage conn={connInstance} onOpenSession={openJournalSessionStable} onExit={closeSchedulesStable} onToggleMenu={toggleMenuStable} />
  </div>
)}
```

imports 加 `import { SchedulePage } from './schedules/SchedulePage';`。

> `--menu-occ` 在 shell 内联样式已有：层 `left: var(--menu-occ,0px)` 保持左侧菜单可见；窄窗抽屉 z80 高于层 z60。

- [ ] **Step 5: 跑测试 + typecheck**

Run: `pnpm --dir gui exec vitest run src/sidebar/project-menu.test.tsx`
Expected: PASS（新入口用例 + 既有用例）。
Run: `pnpm --dir gui run typecheck`
Expected: 零错误。

- [ ] **Step 6: 手动 smoke（shell）**

Run: `pnpm shell:dev`
Expected：侧栏「新建 Sunx」下方出现「定时任务」；点击后左侧菜单仍在、主区显示定时任务；点新建/编辑/卡片/记录返回均正常；点侧栏会话即退出定时任务层。

- [ ] **Step 7: 提交**

```bash
git add gui/src/sidebar/ProjectMenu.tsx gui/src/sidebar/project-menu.test.tsx gui/src/App.tsx gui/src/app.css
git commit -m "feat(schedules): sidebar entry and main-area host wiring"
```

---

## Task 12: 收尾（运行时 LRU 已在 Task 5）与全量回归

**Files:**
- Modify: `MANUAL-GUI.md`（补一节「定时任务」：入口、三行配置、开关、记录、限制）
- Modify: `MANUAL.md`（若 CLI/服务面需要一段 API 说明）
- Test: 全量。

- [ ] **Step 1: 文档**

在 `MANUAL-GUI.md` 的侧栏/主区章节后追加：

```markdown
### 定时任务

- 入口：左侧菜单「新建 Sunx」下方「定时任务」；主区整页，左侧菜单保持。
- 列表：两列卡片，每卡三行（名称 / 任务内容 / 下次执行倒计时）；首行开关停/启；右上「…」= 立即执行 / 执行记录 / 编辑 / 删除。
- 新建/编辑：只有三行——名称 / 调度 / 任务。调度 = 周期下拉（每 15 分钟 / 每小时 / 每天 / 工作日 / 每周 / 每月 / 每年）+ 开始时间（默认当前，同时是周期锚点）+ 截止时间（默认无截止）。任务直接复用对话输入框，工作目录 / 模型（含强度）/ 权限在输入框底部。
- 每次触发 = 在所选工作目录新建一个普通会话并发送任务；会话出现在对应项目下，不归档，由用户自行处理。
- 应用完全退出时不会触发；启动时对到期任务补跑一次。最小粒度 1 分钟；同一任务上次未跑完时定时触发跳过。
```

- [ ] **Step 2: 全量回归**

Run: `pnpm test`
Expected: 全部 node:test 通过（含新 schedules 套件）。
Run: `pnpm --dir gui run typecheck && pnpm --dir gui exec vitest run`
Expected: typecheck 零错误；GUI 全量套件通过（含新 schedules 套件与既有 chat/settings 回归）。

- [ ] **Step 3: 对照 spec 自检**

逐条核对 `docs/superpowers/specs/2026-11-20-scheduled-tasks-design.md` §5–§12：

- [ ] 七档 recurrence 与 until/补跑/重叠/暂停/恢复/编辑/删除都有实现与测试。
- [ ] 执行=普通会话；标题 `名称 · MM-DD HH:mm`；effort/mode 生效；记录 journalId 可打开。
- [ ] 卡片两列三行、首行开关、无多余元信息；配置三行；composer 底部 dock 无单独强度 pill。
- [ ] 记录页状态点全部 `.tb-status-dot`；打开会话走 `newSession+attach`。
- [ ] 侧栏入口在「新建 Sunx」下方；左侧菜单保持；右栏在定时任务层期间隐藏；Chat 不卸载。
- [ ] 每任务记录 100 条；运行时 LRU 10 且跳过 active；坏档降级；启动对账 running→interrupted。

- [ ] **Step 4: 最终提交**

```bash
git add MANUAL-GUI.md MANUAL.md
git commit -m "docs(schedules): GUI manual and final regression notes"
```

---

## Self-Review（计划作者自检）

- **Spec coverage:** §4 数据模型 → Task 1/2；§5 调度语义 → Task 1/3；§6 执行管线 → Task 4/5/6；§7 策略 → Task 3/5/6；§8 API → Task 6；§9 GUI → Task 8/9/10/11；§10 权限 → Task 9（权限 pill）+ Task 5（mode 传入）；§11 限制 → 文档 Task 12；§12 测试 → 各任务测试 + Task 12 回归。
- **无占位符：** 每个代码步骤给出实际代码。GUI 执行顺序：Task 8（配置）/ Task 9（记录）先于 Task 10（列表页）——依赖关系已在文件结构与本注记明确。
- **类型一致：** `nextRunAt` / `validateDraft` / `jobView` / `ScheduleEngine.create|update|setEnabled|runNow` / `ScheduleExecutor.run` / `Connection.*` 在前后任务中签名一致；`RunRecord`/`ScheduleJobView` 字段名一致。
- **已知取舍：** GUI 只暴露七档周期预设（§2 非目标），开始时间同时是锚点；不做 per-job 时区、worktree 隔离、固定模型。

