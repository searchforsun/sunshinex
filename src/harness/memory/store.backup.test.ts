import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryStore } from './store';

/** MemoryStore backup/restore/clearBackup 原语往返钉（D26/J10，收编自 consolidate 的 .bak 裸 fs 手术）：
 *  备份→破坏性写入→restore 逐字节恢复；成功路径清理；旧快照清退 */

function withStore(fn: (store: MemoryStore) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mem-bak-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    fn(new MemoryStore(root));
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 目录全景快照（文件名 → 逐字节内容），往返等价断言用；.bak-* 是瞬态原语产物，不入全景 */
function dirSnapshot(dir: string): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).sort()) {
    if (f.startsWith('.bak-')) continue;
    snap[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return snap;
}

test('backup→破坏性写入→restore：目录全景逐字节恢复（含 MEMORY.md 索引），备份目录被消费', () => {
  withStore((store) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    store.add({ type: 'user', description: 'fact two', body: 'body two' });
    const before = dirSnapshot(store.dir());

    const bak = store.backup();
    assert.ok(path.isAbsolute(bak) && path.basename(bak).startsWith('.bak-'), '返回 .bak-<ts> 备份目录句柄');
    assert.ok(fs.statSync(bak).isDirectory(), '备份目录已建立');

    // 破坏性写入：删一条 + 新写一条 + 索引全量重建
    store.remove('fact-one');
    store.put({ slug: 'invader', type: 'project', description: 'invader fact', body: 'invader body' });
    store.rebuildIndex();
    assert.notDeepEqual(dirSnapshot(store.dir()), before, '破坏确已发生');

    store.restore(bak);
    assert.deepEqual(dirSnapshot(store.dir()), before, '目录全景逐字节恢复');
    assert.ok(!fs.existsSync(bak), 'restore 消费备份目录');
  });
});

test('restore 清除异形条目：被目录占位的 MEMORY.md 一并强删后从备份还原', () => {
  withStore((store) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    const before = dirSnapshot(store.dir());
    const bak = store.backup();
    // 异形：索引被目录占位（整理失败路径的既有测试形态）
    fs.rmSync(path.join(store.dir(), 'MEMORY.md'), { force: true });
    fs.mkdirSync(path.join(store.dir(), 'MEMORY.md'));
    store.restore(bak);
    assert.deepEqual(dirSnapshot(store.dir()), before, '异形条目清除、原索引文件还原');
  });
});

test('clearBackup：成功路径清理不留 .bak 残渣，且不动当前目录写入成果', () => {
  withStore((store) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    const bak = store.backup();
    store.put({ slug: 'fact-one', type: 'project', description: 'fact one', body: 'body one updated' });
    store.clearBackup(bak);
    assert.equal(fs.readdirSync(store.dir()).filter((f) => f.startsWith('.bak')).length, 0, '不留备份目录');
    assert.equal(store.list()[0]!.body, 'body one updated', '写入成果保留');
  });
});

test('backup 清退旧快照：只保留本次一份', () => {
  withStore((store) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    const bak1 = store.backup();
    const bak2 = store.backup();
    assert.ok(!fs.existsSync(bak1), '旧快照被清退');
    assert.ok(fs.existsSync(bak2), '本次快照在场');
    store.clearBackup(bak2);
  });
});
