import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager, runCompaction } from './index';
import { FileStore } from '../../storage/adapter';
import type { ArchiveStore } from '../../storage/archive';
import { ContextItem } from '../../types';

/** 压缩归档/重读经接缝钉（D26/J10）：spy 归档注入 ContextManager 第三参——裸 fs 旧实现不经此接缝，
 *  本组用例对旧实现必红（判别力锚）；命名法与载荷期望值按旧实现逐字节推导（等价性锚）。 */

interface SpyArchive extends ArchiveStore {
  writes: Array<{ id: string; content: string; returned: string }>;
  reads: string[];
}

function spyArchive(): SpyArchive {
  const writes: SpyArchive['writes'] = [];
  const reads: string[] = [];
  return {
    writes,
    reads,
    write(id, content) {
      const returned = path.join(os.tmpdir(), 'sunshinex-spy-archives', id); // 伪落点：只验证指针行取 write 返回值
      writes.push({ id, content, returned });
      return returned;
    },
    list: () => [],
    read(file) {
      reads.push(file);
      return fs.readFileSync(file, 'utf8'); // 读侧真实透传：重读机制行为不变
    },
  };
}

function setup(archive?: ArchiveStore) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cpt-seam-'));
  return { root, cm: new ContextManager(root, new FileStore(root), archive) };
}

const ITEMS = (): ContextItem[] => [{ kind: 'history', content: '很长的旧上下文 '.repeat(50) }];

test('折链归档经接缝：write 恰好一次，id/内容与旧命名法/载荷逐字节一致，Full trace 指针 = write 返回值', async () => {
  const spy = spyArchive();
  const { cm } = setup(spy);
  cm.appendChain([
    { action: 'note', observation: '第一步观察' },
    { action: 'note', observation: '第二步观察' },
    { action: 'note', observation: '第三步观察' },
  ]);
  const rows = cm.chainView().slice(0, 2); // 折链前取行，期望值按旧实现公式推导
  const res = await runCompaction(cm, ITEMS(), { summaryTokenBudget: 2000, rereadTokenBudget: 500, chainFoldedCount: 2 });
  assert.ok(res.via !== 'replay');
  assert.equal(spy.writes.length, 1, '归档写恰好经接缝一次');
  const w = spy.writes[0]!;
  const digest = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 8);
  assert.equal(w.id, `compaction-2-${digest}.jsonl`, '命名法迁移钉：compaction-<行数>-<sha256 前 8 hex>.jsonl');
  assert.equal(w.content, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', '内容为链行 JSONL + 尾换行');
  const compacted = cm.assemble().find((i) => i.content.startsWith('[Compacted summary'));
  assert.ok(compacted, '压缩块在场');
  assert.ok(compacted!.content.includes(`Full trace: ${w.returned}`), '指针行取 write 返回值（非裸拼路径）');
});

test('无折链：archive.write 零调用（不建归档）', async () => {
  const spy = spyArchive();
  const { cm } = setup(spy);
  await runCompaction(cm, ITEMS(), { summaryTokenBudget: 2000, rereadTokenBudget: 500 });
  assert.equal(spy.writes.length, 0);
});

test('replay 幂等：同一压缩事件二次 runCompaction 不再写归档', async () => {
  const spy = spyArchive();
  const { cm } = setup(spy);
  cm.appendChain([{ action: 'note', observation: '一' }, { action: 'note', observation: '二' }]);
  const items = ITEMS();
  await runCompaction(cm, items, { summaryTokenBudget: 2000, rereadTokenBudget: 500, chainFoldedCount: 2 });
  await runCompaction(cm, items, { summaryTokenBudget: 2000, rereadTokenBudget: 500, chainFoldedCount: 2 });
  assert.equal(spy.writes.length, 1, 'replay（链已折空）不重复写归档');
});

test('压缩重读经接缝：apply 重读最近文件走 archive.read（项目根解析出的绝对路径）', async () => {
  const spy = spyArchive();
  const { root, cm } = setup(spy);
  fs.writeFileSync(path.join(root, 'notes.md'), 'line1\nline2');
  cm.trackFile('notes.md');
  const chunks = await cm.window.compact([{ kind: 'history', content: '旧上下文要点'.repeat(10) }]);
  await cm.applyCompaction(chunks);
  assert.deepEqual(spy.reads, [path.resolve(root, 'notes.md')], '重读恰好经 archive.read 一次');
  assert.ok(cm.assemble().some((i) => i.content.startsWith('[re-read] notes.md')), '重读条目照常注入');
});
