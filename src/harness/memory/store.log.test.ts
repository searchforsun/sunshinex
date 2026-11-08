import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryStore, LOG_NAME, MemoryLogEvent, MemoryLogSource } from './store';

/** MemoryStore 变更历史 log.jsonl（OKF log 件）钉：五写原语单点收口各产一条事件（摘要指纹粒度），
 *  list/count 不计 log，backup/restore 保护 log 不入快照不被清退，追加失败旁路不阻断主写路径 */

function withStore(fn: (store: MemoryStore, dir: string) => void, source?: MemoryLogSource): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mem-log-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const store = new MemoryStore(root, source === undefined ? undefined : { source });
    fn(store, store.dir());
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readLog(dir: string): MemoryLogEvent[] {
  return fs
    .readFileSync(path.join(dir, LOG_NAME), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as MemoryLogEvent);
}

test('add 产一条 add 事件：slug + newDigest，digest 随正文变化', () => {
  withStore((store, dir) => {
    const add = store.add({ type: 'project', description: 'fact one', body: 'body one' });
    assert.ok(add.ok);
    const events = readLog(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.op, 'add');
    assert.equal(events[0]!.slug, 'fact-one');
    assert.ok(events[0]!.newDigest && /^[0-9a-f]{12}$/.test(events[0]!.newDigest), 'newDigest 为 12 位指纹');
    assert.equal(events[0]!.prevDigest, undefined);
    assert.ok(events[0]!.ts.length > 0);

    store.put({ slug: 'fact-one', type: 'project', description: 'fact one', body: 'body one changed' });
    const events2 = readLog(dir);
    assert.equal(events2.length, 2);
    assert.equal(events2[1]!.op, 'put');
    assert.notEqual(events2[1]!.newDigest, events[0]!.newDigest, '正文变化 → 指纹变化');
    assert.equal(events2[1]!.prevDigest, events[0]!.newDigest, 'put 的 prevDigest 接续上一次指纹');
  });
});

test('remove 产 remove 事件带 prevDigest；不存在的 slug 不产事件', () => {
  withStore((store, dir) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    store.remove('fact-one');
    const notFound = store.remove('fact-one');
    assert.ok(!notFound.ok, '不存在报 MEMORY_NOT_FOUND');
    const events = readLog(dir);
    assert.equal(events.length, 2, 'NOT_FOUND 不产事件');
    assert.equal(events[1]!.op, 'remove');
    assert.equal(events[1]!.slug, 'fact-one');
    assert.ok(events[1]!.prevDigest, 'remove 带 prevDigest');
    assert.equal(events[1]!.newDigest, undefined);
  });
});

test('backup/restore 各产一条事件；log 不入快照、不被 restore 清退', () => {
  withStore((store, dir) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    const bak = store.backup();
    store.remove('fact-one');
    store.restore(bak);
    const events = readLog(dir);
    assert.equal(events.filter((e) => e.op === 'backup').length, 1);
    assert.equal(events.filter((e) => e.op === 'restore').length, 1);
    assert.ok(fs.existsSync(path.join(dir, LOG_NAME)), 'restore 保留 log（追加只增不回卷）');
    assert.ok(!fs.existsSync(bak), '备份目录被消费');
    assert.ok(fs.existsSync(path.join(dir, 'fact-one.md')), '记录文件已还原');
  });
});

test('list/count 不计 log.jsonl；MEMORY.md 索引不因 log 存在而变化', () => {
  withStore((store, dir) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    store.add({ type: 'project', description: 'fact two', body: 'body two' });
    assert.equal(store.count(), 2, 'log 在场但计数仍为记录数');
    assert.ok(!store.indexText().includes('log'), '索引不含 log 条目');
    assert.equal(readLog(dir).length, 2);
  });
});

test('source 标注随构造透传：缺省 system，tool/extractor/consolidate 各自落账', () => {
  withStore((store, dir) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    assert.equal(readLog(dir)[0]!.source, 'system');
  });
  withStore((store, dir) => {
    store.add({ type: 'project', description: 'fact two', body: 'body two' });
    assert.equal(readLog(dir)[0]!.source, 'consolidate');
  }, 'consolidate');
});

test('log 追加失败旁路：log.jsonl 被目录占位时主写路径仍成功', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mem-logfail-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const store = new MemoryStore(root);
    // 异形：log.jsonl 被目录占位 → appendFileSync 必失败
    fs.mkdirSync(path.join(store.dir(), LOG_NAME));
    const add = store.add({ type: 'project', description: 'fact one', body: 'body one' });
    assert.ok(add.ok, '主写路径不受 log 失败阻断');
    assert.ok(fs.existsSync(path.join(store.dir(), 'fact-one.md')), '记录文件已落盘');
    assert.ok(store.indexText().includes('fact-one'), '索引照常重建');
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
