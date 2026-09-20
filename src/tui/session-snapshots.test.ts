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
