import { randomBytes } from 'node:crypto';
import { jobView } from './model';
import type { ScheduleDraft, ScheduleJob, ScheduleJobView, RunTrigger } from './model';
import { nextRunAt } from './recurrence';
import type { ScheduleStore } from './store';

const MAX_TIMER_MS = 2 ** 31 - 1;

interface ScheduleEngineDeps {
  store: ScheduleStore;
  execute: (job: ScheduleJob, trigger: RunTrigger, plannedAt?: number) => string | undefined;
  now?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (h: unknown) => void;
}

function newJobId(): string {
  return `sch-${randomBytes(4).toString('hex')}`;
}

/** 「下一次（含当前时刻）」：仅 create 用 now-1，让此刻的锚点也能成为第一次 */
function nextAtOrAfter(rec: ScheduleJob['recurrence'], startAt: number, now: number, until?: number): number | null {
  return nextRunAt(rec, startAt, now - 1, until);
}

export class ScheduleEngine {
  private readonly store: ScheduleStore;
  private readonly execute: ScheduleEngineDeps['execute'];
  private readonly now: () => number;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (h: unknown) => void;
  private readonly timers = new Map<string, unknown>();
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
    // 目标切换清残留（2026-11-21 三种落点）：改了类型就不得带旧类型的 id（spread 只覆盖
    // draft 里出现的键，旧 targetJournalId/channel 两段会残留）
    if (job.target !== 'sunx') delete job.targetJournalId;
    if (job.target !== 'channel') {
      delete job.targetChannelId;
      delete job.targetChatId;
    }
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
    // 恢复时严格晚于 now（恢复不立即触发）；创建沿用 nextAtOrAfter 允许此刻锚点。
    const next = enabled ? nextRunAt(job.recurrence, job.startAt, now, job.until) : null;
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
    // 停摆竞态（终审 minor）：stop() 之后到达的 create/update/setEnabled 请求不得再布防——
    // started 是引擎生命周期唯一闸，重启由下次 start() 统一补布防
    if (!this.started) return;
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
    if (latest.runs.some((r) => r.status === 'running')) {
      // 跳过原因（spec §9.5）：记录表灰字 reason 非空——不填则 GUI 只能显示空注记
      this.store.addRun(id, { id: `run-${randomBytes(4).toString('hex')}`, trigger: 'schedule', scheduledAt: planned, startedAt: now, endedAt: now, status: 'skipped', root: job.root, error: 'previous run still running' });
    } else {
      this.execute(latest, 'schedule', planned);
    }
    if (next !== null && latest.enabled) this.arm(this.store.get(id)!);
  }
}
