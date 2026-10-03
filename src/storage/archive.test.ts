import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createFsArchiveStore } from './archive';

/** ArchiveStore fs 实现单元（D26/J10 IO 收敛）：write/list/read 往返 + 落点 <dataDir>/archives/ 路径钉 */

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-arch-'));
}

test('write：落点 <dataDir>/archives/<id>（返回完整路径），内容逐字节一致，目录幂等创建', () => {
  const dataDir = tmpDataDir();
  try {
    const store = createFsArchiveStore(dataDir);
    const p = store.write('compaction-3-0123abcd.jsonl', '{"step":1}\n{"step":2}\n');
    assert.equal(p, path.join(dataDir, 'archives', 'compaction-3-0123abcd.jsonl'), '落点路径钉');
    assert.equal(fs.readFileSync(p, 'utf8'), '{"step":1}\n{"step":2}\n', '内容逐字节一致（含尾部换行）');
    assert.doesNotThrow(() => store.write('again.jsonl', 'x'), '目录已存在时再写不抛（mkdir 幂等）');
    assert.equal(fs.readFileSync(path.join(dataDir, 'archives', 'again.jsonl'), 'utf8'), 'x');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('list：目录缺失为空表（读侧不建目录）；写入后列全量（id + 绝对路径）', () => {
  const dataDir = tmpDataDir();
  try {
    const store = createFsArchiveStore(dataDir);
    assert.deepEqual(store.list(), [], '未写入前目录缺失 → 空表不抛');
    store.write('a.jsonl', 'A');
    store.write('b.jsonl', 'B');
    const listed = store.list().sort((x, y) => x.id.localeCompare(y.id));
    assert.deepEqual(listed, [
      { id: 'a.jsonl', path: path.join(dataDir, 'archives', 'a.jsonl') },
      { id: 'b.jsonl', path: path.join(dataDir, 'archives', 'b.jsonl') },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('read：按绝对路径读回全文（write→read 往返）；文件不存在抛错由调用方兜（与裸 fs 同语义）', () => {
  const dataDir = tmpDataDir();
  try {
    const store = createFsArchiveStore(dataDir);
    const p = store.write('c.jsonl', 'line1\nline2\n');
    assert.equal(store.read(p), 'line1\nline2\n');
    assert.throws(() => store.read(path.join(dataDir, 'archives', 'ghost.jsonl')));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('写失败冒泡：archives 被普通文件占位 → mkdir 抛（runCompaction 据此降级无指针行）', () => {
  const dataDir = tmpDataDir();
  try {
    fs.writeFileSync(path.join(dataDir, 'archives'), 'this is a file, not a directory');
    const store = createFsArchiveStore(dataDir);
    assert.throws(() => store.write('x.jsonl', 'x'));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
