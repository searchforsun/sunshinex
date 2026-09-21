import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectRestorePlan, applyRestorePlan } from './session-snapshots';
import { sessionsDir } from './session-journal';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
/** 造档：header(1) / user a→v1(2) / msg(3) / user a→v2+b→deleted(4) / msg(5) */
function makeJournal(dataDir: string, id: string): void {
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  const lines = [
    '{"t":"header","v":1,"id":"' + id + '","createdAt":"x"}',
    '{"t":"user","text":"t1","files":[{"path":"a.txt","hash":"h-v1"}]}',
    '{"t":"msg","item":{"role":"assistant","text":"r1","ts":0,"seq":1}}',
    '{"t":"user","text":"t2","files":[{"path":"a.txt","hash":"h-v2"},{"path":"b.txt","hash":"","deleted":true}]}',
    '{"t":"msg","item":{"role":"assistant","text":"r2","ts":0,"seq":2}}',
  ];
  fs.writeFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), lines.join('\n') + '\n', 'utf8');
}

test('collectRestorePlan: 每文件取锚点起最早一条（a 取行 2 的 v1 而非行 4 的 v2），b 带入 deleted', () => {
  const dataDir = tmpdir('snap-collect-');
  try {
    makeJournal(dataDir, 'j1');
    const file = path.join(sessionsDir(dataDir), 'j1.jsonl');
    const plan = collectRestorePlan(file, 2);
    assert.deepEqual(plan, [
      { path: 'a.txt', hash: 'h-v1' },
      { path: 'b.txt', hash: '', deleted: true },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('collectRestorePlan: 锚点行自身清单参与（含当轮写入回退）', () => {
  const dataDir = tmpdir('snap-collect2-');
  try {
    makeJournal(dataDir, 'j2');
    const file = path.join(sessionsDir(dataDir), 'j2.jsonl');
    const plan = collectRestorePlan(file, 4); // 锚=行 4 自身 → 只含行 4 清单
    assert.deepEqual(plan, [
      { path: 'a.txt', hash: 'h-v2' },
      { path: 'b.txt', hash: '', deleted: true },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('collectRestorePlan: snapshots 事件并入收集（user.files 与 snapshots 两载体合并，行序每路径取最早）', () => {
  const dataDir = tmpdir('snap-collect3-');
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    const file = path.join(sessionsDir(dataDir), 'j3.jsonl');
    // 行 2 user.files a→v1 / 行 4 snapshots a→v1b / 行 6 user b→v0 / 行 8 snapshots a→v2
    fs.writeFileSync(file, [
      '{"t":"header","v":1,"id":"j3","createdAt":"x"}',
      '{"t":"user","text":"t1","files":[{"path":"a.txt","hash":"h-v1"}]}',
      '{"t":"snapshots","files":[{"path":"a.txt","hash":"h-v1b"}]}',
      '{"t":"msg","item":{"role":"assistant","text":"r1","ts":0,"seq":1}}',
      '{"t":"user","text":"t2","files":[{"path":"b.txt","hash":"h-v0"}]}',
      '{"t":"msg","item":{"role":"assistant","text":"r2","ts":0,"seq":2}}',
      '{"t":"snapshots","files":[{"path":"a.txt","hash":"h-v2"}]}',
      '{"t":"msg","item":{"role":"assistant","text":"r3","ts":0,"seq":3}}',
    ].join('\n') + '\n', 'utf8');
    const plan = collectRestorePlan(file, 2);
    assert.deepEqual(plan, [
      { path: 'a.txt', hash: 'h-v1' },
      { path: 'b.txt', hash: 'h-v0' },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('collectRestorePlan: 纯 snapshots 档（无任何 user.files）照常收集', () => {
  const dataDir = tmpdir('snap-collect4-');
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    const file = path.join(sessionsDir(dataDir), 'j4.jsonl');
    fs.writeFileSync(file, [
      '{"t":"header","v":1,"id":"j4","createdAt":"x"}',
      '{"t":"user","text":"t1"}',
      '{"t":"snapshots","files":[{"path":"c.txt","hash":"h-c","deleted":true}]}',
      '{"t":"msg","item":{"role":"assistant","text":"r1","ts":0,"seq":1}}',
    ].join('\n') + '\n', 'utf8');
    const plan = collectRestorePlan(file, 2);
    assert.deepEqual(plan, [{ path: 'c.txt', hash: 'h-c', deleted: true }]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('applyRestorePlan: 写回/删除/缺 blob skipped 三态', () => {
  const root = tmpdir('snap-apply-');
  try {
    const blobs = path.join(root, 'blobs');
    fs.mkdirSync(blobs, { recursive: true });
    fs.writeFileSync(path.join(blobs, 'h-v1'), 'content-v1');
    fs.writeFileSync(path.join(root, 'a.txt'), 'dirty');
    fs.writeFileSync(path.join(root, 'b.txt'), 'created-later');
    const r = applyRestorePlan(root, [
      { path: 'a.txt', hash: 'h-v1' },
      { path: 'b.txt', hash: '', deleted: true },
      { path: 'c.txt', hash: 'h-missing' },
    ], blobs);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt')).toString(), 'content-v1');
    assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
    assert.deepEqual(r, { restored: ['a.txt'], removed: ['b.txt'], skipped: ['c.txt'] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyRestorePlan: 越界路径拒绝计入 skipped', () => {
  const root = tmpdir('snap-apply2-');
  try {
    const r = applyRestorePlan(root, [{ path: '../escape.txt', hash: '' }], path.join(root, 'blobs'));
    assert.deepEqual(r.skipped, ['../escape.txt']);
    assert.equal(fs.existsSync(path.join(root, '..', 'escape.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
