import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSessionMeta } from '../session/journal';
import { listSunxDataDirs, listWorkspaceDataDirs } from './sessions-list-handlers';
import { readRetentionState, resolveRetentionDays, RetentionSweeper, selectExpiredArchived, sweepArchivedExpired } from './retention';

const DAY = 86_400_000;

/** 测试会话档(sessions 目录 <id>.jsonl + meta 旁车;writeSessionMeta 走生产写面) */
const mkSession = (dataDir: string, id: string, meta: Record<string, unknown>): void => {
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'sessions', `${id}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(dataDir, 'sessions', `${id}.meta.json`), JSON.stringify(meta));
};

const withEnv = (vars: Record<string, string>, fn: () => void): void => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test('resolveRetentionDays:未设/空/非数值→30;0/负值→0;正数向下取整', () => {
  assert.equal(resolveRetentionDays(undefined), 30);
  assert.equal(resolveRetentionDays(''), 30);
  assert.equal(resolveRetentionDays('   '), 30);
  assert.equal(resolveRetentionDays('abc'), 30);
  assert.equal(resolveRetentionDays('0'), 0);
  assert.equal(resolveRetentionDays('-5'), 0);
  assert.equal(resolveRetentionDays(' 15 '), 15);
  assert.equal(resolveRetentionDays('7.9'), 7);
});

test('selectExpiredArchived:严格大于边界;archivedAt 缺失/未归档跳过;days<=0 全跳', () => {
  const rows = [
    { id: 'a', archived: true, archivedAt: 1_000 },
    { id: 'b', archived: true, archivedAt: 5_000 },
    { id: 'c', archived: true },
    { id: 'd', archivedAt: 0 },
  ];
  assert.deepEqual(selectExpiredArchived(rows, 4_000 + 3 * DAY, 3), ['a']); // 恰满 3 天不清
  assert.deepEqual(selectExpiredArchived(rows, 5_000 + 3 * DAY + 1, 3).sort(), ['a', 'b']); // b 也越过 3 天线
  assert.deepEqual(selectExpiredArchived(rows, Number.MAX_SAFE_INTEGER, 0), []);
  assert.deepEqual(selectExpiredArchived(rows, Number.MAX_SAFE_INTEGER, -1), []);
});

test('sweepArchivedExpired:过期归档真清全家(side 级联),未过期跳过,逐域扫描', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-retention-'));
  const dataDir = path.join(tmp, 'ws', 'data');
  const sunxDir = path.join(tmp, 'sunx-journal', 'data');
  try {
    mkSession(dataDir, '20260101T000000Z-old', { archived: true, archivedAt: 0 });
    mkSession(dataDir, '20260102T000000Z-side', { side: true, sideOf: '20260101T000000Z-old' });
    mkSession(dataDir, '20260103T000000Z-keep', { archived: true, archivedAt: 40 * DAY });
    mkSession(sunxDir, '20260104T000000Z-sunx', { archived: true, archivedAt: 0 });
    const r = sweepArchivedExpired({
      now: () => 41 * DAY,
      days: 30,
      dataDirs: [
        { slug: 'ws', dataDir },
        { slug: 'sunx-journal', dataDir: sunxDir },
      ],
    });
    assert.deepEqual(
      r.purged.map((p) => p.id).sort(),
      ['20260101T000000Z-old', '20260104T000000Z-sunx'], // side 随父清,不单列
    );
    assert.equal(fs.existsSync(path.join(dataDir, 'sessions', '20260101T000000Z-old.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'sessions', '20260102T000000Z-side.meta.json')), false);
    assert.equal(readSessionMeta(dataDir, '20260103T000000Z-keep').archived, true);
    assert.equal(r.failed, 0);
    assert.equal(r.scanned, 3); // side 行被 listSessions 滤除,只计主档(old/keep/sunx)
  } finally {
    fs.rmSync(tmp, { force: true, recursive: true });
  }
});

test('sweepArchivedExpired:days=0 轮空;在座会话(isKnownSession)跳过', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-retention-'));
  const dataDir = path.join(tmp, 'ws', 'data');
  try {
    mkSession(dataDir, '20260105T000000Z-live', { archived: true, archivedAt: 0 });
    mkSession(dataDir, '20260106T000000Z-gone', { archived: true, archivedAt: 0 });
    assert.equal(sweepArchivedExpired({ now: () => DAY, days: 0, dataDirs: [{ slug: 'ws', dataDir }] }).purged.length, 0);
    const r = sweepArchivedExpired({
      now: () => DAY + 60_000,
      days: 1,
      isKnownSession: (jid) => jid === '20260105T000000Z-live',
      dataDirs: [{ slug: 'ws', dataDir }],
    });
    assert.deepEqual(r.purged.map((p) => p.id), ['20260106T000000Z-gone']);
    assert.equal(readSessionMeta(dataDir, '20260105T000000Z-live').archived, true);
  } finally {
    fs.rmSync(tmp, { force: true, recursive: true });
  }
});

test('RetentionSweeper:错过窗口(≥24h)即刻补扫并落 state;未到期 5 分钟首扫;到点再布防 24h;stop 摘除', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-sweeper-'));
  const stateFile = path.join(tmp, 'retention-state.json');
  try {
    interface FakeTimer {
      fn: () => void;
      fired: boolean;
    }
    const arms: number[] = [];
    const live = new Set<FakeTimer>();
    const setTimeoutImpl = (fn: () => void, ms: number): unknown => {
      arms.push(ms);
      const h: FakeTimer = { fn, fired: false };
      live.add(h);
      return h;
    };
    const clearTimeoutImpl = (h: unknown): void => {
      live.delete(h as FakeTimer);
    };
    const fireFirst = (): void => {
      const h = [...live].find((x) => !x.fired);
      assert.ok(h !== undefined);
      h.fired = true;
      h.fn();
    };
    // ① 上次清扫 25h 前:start 即刻补扫(state 落盘),下一轮 24h
    fs.writeFileSync(stateFile, JSON.stringify({ lastRunAt: Date.now() - 25 * 60 * 60_000 }));
    const s1 = new RetentionSweeper({ stateFile, setTimeoutImpl, clearTimeoutImpl });
    s1.start();
    assert.equal(typeof readRetentionState(stateFile).lastRunAt, 'number');
    assert.deepEqual(arms, [24 * 60 * 60_000]);
    s1.stop();
    assert.equal([...live].some((h) => !h.fired), false);
    // ② 上次刚扫过:5 分钟首扫;到点触发清一轮再布防 24h
    arms.length = 0;
    fs.writeFileSync(stateFile, JSON.stringify({ lastRunAt: Date.now() - 1_000 }));
    const s2 = new RetentionSweeper({ stateFile, setTimeoutImpl, clearTimeoutImpl });
    s2.start();
    assert.deepEqual(arms, [5 * 60_000]);
    fireFirst();
    assert.deepEqual(arms, [5 * 60_000, 24 * 60 * 60_000]);
    s2.stop();
    assert.equal([...live].some((h) => !h.fired), false); // stop 摘除在途句柄
  } finally {
    fs.rmSync(tmp, { force: true, recursive: true });
  }
});

test('listWorkspaceDataDirs/listSunxDataDirs:按 env 重定向枚举,目录不可读=空表', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-dirs-'));
  try {
    fs.mkdirSync(path.join(tmp, 'projects', 'slug-a', 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'projects', 'loose.txt'), 'x'); // 非目录项
    fs.mkdirSync(path.join(tmp, 'sunx', 'dom-b', 'data'), { recursive: true });
    withEnv(
      {
        SUNSHINEX_PROJECTS_DIR: path.join(tmp, 'projects'),
        SUNSHINEX_SUNX_DIR: path.join(tmp, 'sunx'),
      },
      () => {
        assert.deepEqual(listWorkspaceDataDirs(), [{ slug: 'slug-a', dataDir: path.join(tmp, 'projects', 'slug-a', 'data') }]);
        assert.deepEqual(listSunxDataDirs(), [{ slug: 'dom-b', dataDir: path.join(tmp, 'sunx', 'dom-b', 'data') }]);
      },
    );
    withEnv(
      {
        SUNSHINEX_PROJECTS_DIR: path.join(tmp, 'missing'),
        SUNSHINEX_SUNX_DIR: path.join(tmp, 'missing-sunx'),
      },
      () => {
        assert.deepEqual(listWorkspaceDataDirs(), []);
        assert.deepEqual(listSunxDataDirs(), []);
      },
    );
  } finally {
    fs.rmSync(tmp, { force: true, recursive: true });
  }
});
