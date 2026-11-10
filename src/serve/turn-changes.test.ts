import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { restoreTurnFile, turnDiffContent } from './turn-changes';
import type { TurnFileChange } from '../types';
import { kernelEventRows, reduceSegRows } from '../session/seglog';
import type { RunMeta } from '../session/entry';
import * as crypto from 'crypto';

/** 轮次 checkpoint 服务面(2026-11-10 用户裁定「每轮精确看到自己的改动、能撤销」):
 *  staleness 闸门回写 + 冻结前后像 diff 读侧 + runmeta.turn 落档/重放往返 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sx-turn-'));
}

test('restoreTurnFile: 回写前像(修改面)/删新建面/越界拒', () => {
  const root = tmpRoot();
  try {
    const blobs = new Map<string, Buffer>();
    const read = (h: string): Buffer | null => blobs.get(h) ?? null;
    const store = (b: Buffer): string => {
      const h = crypto.createHash('sha256').update(b).digest('hex');
      blobs.set(h, b);
      return h;
    };
    // 修改面:前像 x → 改成 y → 撤销回 x
    fs.writeFileSync(path.join(root, 'a.txt'), 'y');
    const beforeHash = store(Buffer.from('x'));
    const mod: TurnFileChange = { path: 'a.txt', before: beforeHash, after: store(Buffer.from('y')) };
    assert.deepEqual(restoreTurnFile(root, mod, read), { path: 'a.txt', ok: true });
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x');

    // staleness:磁盘又改成 z(≠after) → stale 拒绝
    fs.writeFileSync(path.join(root, 'a.txt'), 'z');
    const staleRes = restoreTurnFile(root, mod, read);
    assert.equal(staleRes.ok, false);
    assert.equal(staleRes.stale, true);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'z');

    // 新建面:beforeDeleted → 撤销=删文件;被后续改过(≠after)即 stale
    const created: TurnFileChange = { path: 'new.txt', beforeDeleted: true, after: store(Buffer.from('n')) };
    fs.writeFileSync(path.join(root, 'new.txt'), 'changed later');
    assert.equal(restoreTurnFile(root, created, read).stale, true);
    fs.writeFileSync(path.join(root, 'new.txt'), 'n');
    const res2 = restoreTurnFile(root, created, read);
    assert.deepEqual(res2, { path: 'new.txt', ok: true });
    assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);

    // 删除面:afterDeleted → 轮末已删,现在不在场 → 撤销=前像回写(复活)
    const removed: TurnFileChange = { path: 'gone.txt', before: store(Buffer.from('g')), afterDeleted: true, after: '' };
    assert.deepEqual(restoreTurnFile(root, removed, read), { path: 'gone.txt', ok: true });
    assert.equal(fs.readFileSync(path.join(root, 'gone.txt'), 'utf8'), 'g');

    // 无前像(bash 改动)→ noCheckpoint 不动盘
    fs.writeFileSync(path.join(root, 'b.txt'), 'bash');
    const bash: TurnFileChange = { path: 'b.txt', after: store(Buffer.from('bash')) };
    const res3 = restoreTurnFile(root, bash, read);
    assert.equal(res3.ok, false);
    assert.equal(res3.noCheckpoint, true);
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'bash');

    // 越界路径拒绝
    const evil: TurnFileChange = { path: '../evil.txt', before: beforeHash, after: store(Buffer.from('e')) };
    assert.equal(restoreTurnFile(root, evil, read).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('turnDiffContent: 冻结前后像读侧(截断/删除面/新建面)', () => {
  const blobs = new Map<string, Buffer>([
    ['old', Buffer.from('a\nb')],
    ['new', Buffer.from('a\nb\nc')],
  ]);
  const read = (h: string): Buffer | null => blobs.get(h) ?? null;
  assert.deepEqual(turnDiffContent({ path: 'f', before: 'old', after: 'new' }, read, 1024), {
    oldContent: 'a\nb', newContent: 'a\nb\nc', truncated: false, deleted: false,
  });
  // 新建面:无前像 → oldContent 缺场
  assert.deepEqual(turnDiffContent({ path: 'f', beforeDeleted: true, after: 'new' }, read, 1024), {
    newContent: 'a\nb\nc', truncated: false, deleted: false,
  });
  // 删除面:afterDeleted → deleted=true, newContent 空
  assert.deepEqual(turnDiffContent({ path: 'f', before: 'old', afterDeleted: true, after: '' }, read, 1024), {
    oldContent: 'a\nb', newContent: '', truncated: false, deleted: true,
  });
  // 截断:1 字节帽
  const cut = turnDiffContent({ path: 'f', before: 'old', after: 'new' }, read, 1);
  assert.equal(cut.truncated, true);
  assert.equal(cut.oldContent, 'a');
  assert.equal(cut.newContent, 'a');
  // 后像 blob 缺场降级删除面(不空差)
  assert.deepEqual(turnDiffContent({ path: 'f', before: 'old', after: 'missing' }, read, 1024), {
    oldContent: 'a\nb', newContent: '', truncated: false, deleted: true,
  });
});

test('runmeta.turn 落档/重放往返:kernelEventRows 带出 → runMetaOf 绑回末个 run 条', () => {
  const turn = [
    { path: 'a.ts', before: 'h1', after: 'h2' },
    { path: 'b.ts', beforeDeleted: true, after: 'h3' },
    { path: 'c.ts', after: 'h4' }, // bash 改动:无前像
  ];
  const meta: RunMeta = { seconds: 3, steps: 5, turn };
  const rows = kernelEventRows({ t: 'runmeta', entry: { seq: 7, ts: 1, kind: 'run', md: '', meta } });
  const replayed = reduceSegRows([{ t: 'run-open', ts: 1, seq: 7 }, ...rows]);
  const runEntry = replayed.find((e) => e.kind === 'run');
  assert.ok(runEntry);
  assert.deepEqual(runEntry.meta?.turn, turn);
  assert.equal(runEntry.meta?.steps, 5);

  // 行面字段不予信任:坏行净化弃置(path/after 缺场)
  const bad = reduceSegRows([{ t: 'run-open', ts: 1, seq: 1 }, { t: 'runmeta', turn: [{ path: '', after: 'x' }, 'junk', { path: 'ok.ts', after: 'y' }] }]);
  const runBad = bad.find((e) => e.kind === 'run');
  assert.deepEqual(runBad?.meta?.turn, [{ path: 'ok.ts', after: 'y' }]);
});
