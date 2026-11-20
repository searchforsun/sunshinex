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
  const far = clock.now() + 2 ** 31 - 1 + 60_000;
  const engine = new ScheduleEngine({ store: tmpStore(), execute: (_j, trigger) => { calls.push(trigger); return 'run'; }, now: clock.now, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl });
  engine.start();
  const job = engine.create(draft({ startAt: far }));
  assert.equal(engine.get(job.id)!.nextRunAt, far);
  clock.advance(2 ** 31 - 1);
  assert.equal(calls.length, 0);
  assert.equal(clock.pending(), 1);
  clock.advance(60_000);
  assert.deepEqual(calls, ['schedule']);
  engine.stop();
});
