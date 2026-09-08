import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from './index';
import { ContextItem } from '../../types';
import { FileStore } from '../../storage/adapter';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cpt-'));
  const cm = new ContextManager(root, new FileStore(root));
  return { root, cm };
}

async function compactOf(cm: ContextManager, content: string) {
  const items: ContextItem[] = [{ kind: 'history', content }];
  return cm.window.compact(items);
}

test('trackFile 去重且 LRU 上限 5', () => {
  const { cm } = setup();
  for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) cm.trackFile(f);
  cm.trackFile('c');
  assert.deepEqual(cm.recentFiles(), ['b', 'd', 'e', 'f', 'c']);
});

test('applyCompaction 注入摘要与重读条目，位于 goal 之后 history 之前', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'notes.md'), 'line1\nline2');
  cm.trackFile('notes.md');

  const chunks = await compactOf(cm, '很长的旧上下文 '.repeat(50));
  await cm.applyCompaction(chunks);

  const items = cm.assemble('目标G', [{ kind: 'history', content: '新步骤' }]);
  const goalIdx = items.findIndex((i) => i.content === '目标G');
  const histIdx = items.findIndex((i) => i.content === '新步骤');
  const sumIdx = items.findIndex((i) => i.content.startsWith('[压缩摘要'));
  const reIdx = items.findIndex((i) => i.content.startsWith('[重读] notes.md'));
  assert.ok(sumIdx > goalIdx && sumIdx < histIdx, '摘要应位于 goal 与 history 之间');
  assert.ok(reIdx > goalIdx && reIdx < histIdx, '重读应位于 goal 与 history 之间');
  assert.ok(items[reIdx].content.includes('line1'));
  assert.match(items[sumIdx].content, /^\[压缩摘要 checksum=[0-9a-f]{16}\]/);
  assert.ok(cm.memory.index().some((l) => l.startsWith('compaction: 摘要 checksum=')));
});

test('重复 applyCompaction 相同 chunks 幂等：不重复注入、不重复记录', async () => {
  const { cm } = setup();
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await cm.applyCompaction(chunks);
  await cm.applyCompaction(chunks);
  assert.equal(cm.assemble('g').filter((i) => i.content.startsWith('[压缩摘要')).length, 1);
  assert.equal(cm.memory.index().filter((l) => l.startsWith('compaction:')).length, 1);
});

test('重读失败（文件缺失）跳过该文件，注入不受影响', async () => {
  const { cm } = setup();
  cm.trackFile('ghost.md');
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await assert.doesNotReject(() => cm.applyCompaction(chunks));
  const items = cm.assemble('g');
  assert.ok(!items.some((i) => i.content.startsWith('[重读] ghost.md')));
  assert.ok(items.some((i) => i.content.startsWith('[压缩摘要')));
  assert.ok(cm.memory.index().some((l) => l.includes('重读 0 个文件')));
});

test('重读截断为每文件前 500 行', async () => {
  const { root, cm } = setup();
  const lines = Array.from({ length: 600 }, (_, i) => `line${i}`);
  fs.writeFileSync(path.join(root, 'big.md'), lines.join('\n'));
  cm.trackFile('big.md');
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await cm.applyCompaction(chunks);
  const reread = cm.assemble('g').find((i) => i.content.startsWith('[重读] big.md'));
  assert.ok(reread);
  assert.ok(reread.content.includes('line499'));
  assert.ok(!reread.content.includes('line500'));
});

test('重读条目内容过凭据脱敏（密钥不进上下文）', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'secret.env'), 'TEST_API_KEY=sk-abcdefghijklmnopqrst1234\n普通内容');
  cm.trackFile('secret.env');
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await cm.applyCompaction(chunks);
  const reread = cm.assemble('g').find((i) => i.content.startsWith('[重读] secret.env'));
  assert.ok(reread, '重读条目应存在');
  assert.ok(!reread.content.includes('sk-abcdefghijklmnopqrst1234'), '密钥明文不得进入重读条目');
  assert.ok(reread.content.includes('***'), '命中片段应替换为 ***');
  assert.ok(reread.content.includes('普通内容'), '非敏感内容应保留');
});

test('重读预算化：超限按 LRU 最旧先丢整文件', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'old.md'), 'O'.repeat(2000)); // 重读 ≈ 506 tok
  fs.writeFileSync(path.join(root, 'new.md'), 'N'.repeat(200));  // ≈ 56 tok
  cm.trackFile('old.md');
  cm.trackFile('new.md');
  const chunks = await cm.window.compact([{ kind: 'history', content: '旧上下文要点'.repeat(10) }]);
  await cm.applyCompaction(chunks, { rereadTokenBudget: 200 });
  const items = cm.assemble('完成任务');
  const texts = items.map((i) => i.content);
  assert.ok(!texts.some((t) => t.startsWith('[重读] old.md')), '最旧文件整条被丢');
  assert.ok(texts.some((t) => t.startsWith('[重读] new.md')), '预算内新文件保留');
});

test('重读预算化：预算内全部保留（与未传参数行为一致）', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'a.md'), 'a'.repeat(100));
  cm.trackFile('a.md');
  const chunks = await cm.window.compact([{ kind: 'history', content: '旧上下文要点'.repeat(10) }]);
  await cm.applyCompaction(chunks, { rereadTokenBudget: 100000 });
  const items = cm.assemble('完成任务');
  assert.ok(items.map((i) => i.content).some((t) => t.startsWith('[重读] a.md')));
});
