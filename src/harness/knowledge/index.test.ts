import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileStore } from '../../storage/adapter';
import { EmbeddingProvider } from '../../types';
import { LocalJsonVectorStore } from './store';
import { KnowledgeBase } from './index';

/** 确定性桩：字符桶词袋向量（同字共享桶 → 余弦可分），不发真实网络 */
class BucketEmbedding implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(8).fill(0);
      for (const ch of t) v[(ch.codePointAt(0) ?? 0) % 8] += 1;
      return v;
    });
  }
}

function makeKb(): KnowledgeBase {
  const store = new LocalJsonVectorStore(new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kb-store-'))));
  return new KnowledgeBase(store, new BucketEmbedding());
}

test('indexDir：递归索引 md/txt，返回块数，stats 反映文件/块计数', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kb-'));
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), '# 部署\n\n采用分散部署策略。\n');
  fs.writeFileSync(path.join(dir, 'sub', 'inner.md'), '# 检索\n\n向量检索入口说明。\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), '无关内容而已。\n');

  const kb = makeKb();
  const n = await kb.indexDir(dir);
  assert.ok(n >= 3, `应至少 3 块，实际 ${n}`);
  const st = kb.stats();
  assert.equal(st.files, 3);
  assert.equal(st.chunks, n);
});

test('search：已知查询的 top 命中包含该词的文档块', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kb-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '采用分散部署策略。\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), '无关内容而已。\n');
  const kb = makeKb();
  await kb.indexDir(dir);

  const hits = await kb.search('分散部署', 3);
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].text.includes('分散部署'), `top 命中应为含词块，实际：${hits[0].text}`);
});

test('search：topK 生效（1 = 仅一条）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kb-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '分散部署第一条。\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), '分散部署第二条。\n');
  const kb = makeKb();
  await kb.indexDir(dir);
  assert.equal((await kb.search('分散部署', 1)).length, 1);
});

test('空目录：indexDir 返回 0，search 返回空数组', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kb-empty-'));
  const kb = makeKb();
  assert.equal(await kb.indexDir(dir), 0);
  assert.deepEqual(await kb.search('任意', 3), []);
});

test('非 md/txt 文件不索引（.log 含同词也不计入）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kb-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '分散部署正文字段。\n');
  fs.writeFileSync(path.join(dir, 'noise.log'), '分散部署日志噪声。\n');
  const kb = makeKb();
  const n = await kb.indexDir(dir);
  assert.equal(kb.stats().files, 1, '仅 a.md 计入文件数');
  const hits = await kb.search('分散部署', 5);
  assert.equal(hits.length, n);
  assert.ok(hits.every((h) => h.text.includes('正文')), '命中不应含 .log 内容');
});
