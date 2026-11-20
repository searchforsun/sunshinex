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
  /** 每次 setTimeoutImpl 请求的绝对落点，用于核验封顶与重布防 */
  readonly scheduled: number[] = [];
  now = (): number => this.t;
  setTimeoutImpl = (fn: () => void, ms: number): number => {
    const id = ++this.id;
    const at = this.t + ms;
    this.scheduled.push(at);
    this.timers.set(id, { at, fn });
    return id;
  };
  clearTimeoutImpl = (h: unknown): void => { this.timers.delete(h as number); };
  pending(): number {
    return this.timers.size;
  }
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
  engine.start();
  const job = engine.create(draft());
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
  engine.start();
  const job = engine.create(draft());
  store.addRun(job.id, { id: 'r', trigger: 'schedule', startedAt: clock.now(), status: 'running', root: 'default' });
  clock.advance(60_000);
  assert.equal(engine.get(job.id)!.runs[0]!.status, 'skipped');
  engine.stop();
});

test('进行中的旧记录不在队首时仍判重（runs.some，连续两次 skipped）', () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const store = tmpStore();
  const engine = new ScheduleEngine({ store, execute: (_j, trigger) => { calls.push(trigger); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  engine.start();
  const job = engine.create(draft());
  store.addRun(job.id, { id: 'r', trigger: 'schedule', startedAt: clock.now(), status: 'running', root: 'default' });
  clock.advance(60_000);
  assert.equal(engine.get(job.id)!.runs[0]!.status, 'skipped');
  assert.equal(engine.get(job.id)!.runs.filter((r) => r.status === 'skipped').length, 1);
  clock.advance(60_000);
  const after = engine.get(job.id)!;
  assert.equal(after.runs[0]!.status, 'skipped');
  assert.equal(after.runs.filter((r) => r.status === 'skipped').length, 2);
  assert.deepEqual(calls, []);
  engine.stop();
});

test('enabled 关=清表，开=以 now 重算', () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const engine = new ScheduleEngine({ store: tmpStore(), execute: (_j, t) => { calls.push(t); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  engine.start();
  const job = engine.create(draft());
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
  engine.start();
  const job = engine.create(draft({ until: 1_000_000 + 30_000 }));
  clock.advance(30_000);
  const after = engine.get(job.id)!;
  assert.equal(after.ended, true);
  assert.equal(after.enabled, false);
  assert.equal(after.nextRunAt, null);
  engine.stop();
});

test('runNow 手动运行不受进行中的运行阻塞', () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const store = tmpStore();
  const engine = new ScheduleEngine({ store, execute: (_j, trigger) => { calls.push(trigger); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  engine.start();
  const job = engine.create(draft());
  store.addRun(job.id, { id: 'r', trigger: 'schedule', startedAt: clock.now(), status: 'running', root: 'default' });
  assert.equal(engine.runNow(job.id), 'run');
  assert.deepEqual(calls, ['manual']);
  engine.stop();
});

test('超长间隔按 2^31-1 封顶并在早醒后重新布防', () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const start = clock.now();
  const far = start + 2 ** 31 - 1 + 60_000;
  const engine = new ScheduleEngine({ store: tmpStore(), execute: (_j, trigger) => { calls.push(trigger); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  engine.start();
  const job = engine.create(draft({ startAt: far }));
  assert.equal(engine.get(job.id)!.nextRunAt, far);
  assert.deepEqual(clock.scheduled, [start + 2 ** 31 - 1]);
  clock.advance(2 ** 31 - 1);
  assert.equal(calls.length, 0);
  assert.equal(clock.pending(), 1);
  assert.deepEqual(clock.scheduled, [start + 2 ** 31 - 1, far]);
  clock.advance(60_000);
  assert.deepEqual(calls, ['schedule']);
  engine.stop();
});

test('update 改频率后重算 nextRunAt 并按新间隔重新布防', () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const store = tmpStore();
  const engine = new ScheduleEngine({ store, execute: (_j, trigger) => { calls.push(trigger); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  engine.start();
  const job = engine.create(draft());
  clock.advance(60_000);
  assert.deepEqual(calls, ['schedule']);
  const updated = engine.update(job.id, draft({ recurrence: { unit: 'minute', every: 5 } }))!;
  assert.equal(updated.recurrence.every, 5);
  assert.equal(updated.nextRunAt, 1_000_000 + 300_000);
  assert.equal(clock.pending(), 1);
  assert.equal(clock.scheduled[clock.scheduled.length - 1], 1_000_000 + 300_000);
  clock.advance(240_000);
  assert.deepEqual(calls, ['schedule', 'schedule']);
  assert.equal(engine.get(job.id)!.nextRunAt, 1_600_000);
  clock.advance(299_999);
  assert.equal(calls.length, 2);
  clock.advance(1);
  assert.equal(calls.length, 3);
  engine.stop();
});

test('先推进 nextRunAt 再 execute（执行时看到的是下一次）', () => {
  const clock = new FakeClock();
  const store = tmpStore();
  const seen: Array<number | null> = [];
  const engine = new ScheduleEngine({ store, execute: (job) => { seen.push(store.get(job.id)!.nextRunAt); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  engine.start();
  engine.create(draft());
  clock.advance(60_000);
  assert.deepEqual(seen, [1_120_000]);
  engine.stop();
});

test('runNow 不改变 nextRunAt', () => {
  const clock = new FakeClock();
  const store = tmpStore();
  const engine = new ScheduleEngine({ store, execute: () => 'run', now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  engine.start();
  const job = engine.create(draft());
  const before = engine.get(job.id)!.nextRunAt;
  assert.equal(before, 1_000_000);
  assert.equal(engine.runNow(job.id), 'run');
  assert.equal(engine.get(job.id)!.nextRunAt, before);
  engine.stop();
});

test('start 把上次 running 标为 interrupted 且不触发补跑', () => {
  const clock = new FakeClock();
  const store = tmpStore();
  const seeded = { ...draft(), id: 'job', createdAt: 1, updatedAt: 1, enabled: true, nextRunAt: 1_000_000 + 60_000, runs: [] } as ScheduleJob;
  store.upsert(seeded);
  store.addRun('job', { id: 'r', trigger: 'schedule', startedAt: 1_000_000 - 60_000, status: 'running', root: 'default' });
  const calls: string[] = [];
  const engine = new ScheduleEngine({ store, execute: (_j, trigger) => { calls.push(trigger); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  engine.start();
  const run = engine.get('job')!.runs[0]!;
  assert.equal(run.status, 'interrupted');
  assert.equal(run.endedAt, clock.now());
  assert.match(run.error ?? '', /restart/i);
  assert.deepEqual(calls, []);
  assert.equal(clock.pending(), 1);
  engine.stop();
});
