import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScheduleStore, schedulesFile } from './store';
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

test('schedulesFile：SUNSHINEX_DATA_DIR 优先，否则 userConfigDir', () => {
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const prevHome = process.env.HOME;
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-data-'));
    process.env.SUNSHINEX_DATA_DIR = dataDir;
    assert.equal(schedulesFile(), path.join(dataDir, 'schedules.json'));

    delete process.env.SUNSHINEX_DATA_DIR;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-home-'));
    process.env.HOME = home;
    assert.equal(schedulesFile(), path.join(home, '.sunshinex', 'schedules.json'));
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test('不支持版本同样改名降级为空库', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ version: 2, jobs: [] }), 'utf8');
  const s = new ScheduleStore(file);
  assert.deepEqual(s.list(), []);
  const corrupt = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('schedules.corrupt-'));
  assert.equal(corrupt.length, 1);
  assert.equal(corrupt[0]!.endsWith('.json'), true);
});

test('不可读档（EISDIR）改名降级为空库', () => {
  const file = tmpFile();
  fs.mkdirSync(file);
  const s = new ScheduleStore(file);
  assert.deepEqual(s.list(), []);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).some((n) => n.startsWith('schedules.corrupt-')), true);
});

test('patch/patchRun/remove 落盘', () => {
  const file = tmpFile();
  const s = new ScheduleStore(file);
  s.upsert(job('a'));
  s.patch('a', { name: 'renamed', enabled: false });
  s.addRun('a', { id: 'r', trigger: 'manual', startedAt: 1, status: 'running', root: 'default' });
  s.patchRun('a', 'r', { status: 'succeeded', endedAt: 5 });

  const reread = new ScheduleStore(file).get('a')!;
  assert.equal(reread.name, 'renamed');
  assert.equal(reread.enabled, false);
  assert.equal(reread.runs[0]!.status, 'succeeded');
  assert.equal(reread.runs[0]!.endedAt, 5);

  assert.equal(s.remove('a'), true);
  assert.equal(s.remove('a'), false);
  assert.deepEqual(new ScheduleStore(file).list(), []);
});
