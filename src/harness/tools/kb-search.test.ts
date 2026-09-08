import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';
import { SafetyChain } from '../security/chain';
import { DryRun } from '../security/dryrun';
import { builtinTools } from './builtin';
import { FileStore } from '../../storage/adapter';
import { EmbeddingProvider } from '../../types';
import { LocalJsonVectorStore } from '../knowledge/store';
import { KnowledgeBase } from '../knowledge/index';

/** 确定性桩：字符桶词袋向量（同字共享桶 → 余弦可分），零网络 */
class BucketEmbedding implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(8).fill(0);
      for (const ch of t) v[(ch.codePointAt(0) ?? 0) % 8] += 1;
      return v;
    });
  }
}

function setup(kb?: KnowledgeBase): { registry: ToolRegistry; safety: SafetyChain; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbtool-'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root, kb)) registry.register(t);
  return { registry, safety, root };
}

test('kb_search：category=read 且已注册', () => {
  const { registry } = setup();
  const spec = registry.get('kb_search');
  assert.ok(spec, 'kb_search 应注册（未配置也可见，调用时降级）');
  assert.equal(spec.category, 'read');
});

test('kb_search：未配置知识库 → Result.fail(kb_not_configured) 降级不阻塞', async () => {
  const { registry, safety } = setup();
  const r = await registry.execute('kb_search', { query: '任意' }, safety);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'kb_not_configured');
});

test('kb_search：配置齐（桩注入）返回 topK 命中，stdout 为可解析 JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbtool-docs-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '采用分散部署策略。\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), '无关内容而已。\n');
  const store = new LocalJsonVectorStore(new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbtool-store-'))));
  const kb = new KnowledgeBase(store, new BucketEmbedding());
  await kb.indexDir(dir);

  const { registry, safety } = setup(kb);
  const r = await registry.execute('kb_search', { query: '分散部署', topK: 2 }, safety);
  assert.ok(r.ok);
  const hits = JSON.parse(r.value.stdout) as Array<{ text: string; score: number }>;
  assert.ok(hits.length >= 1 && hits.length <= 2);
  assert.ok(hits[0].text.includes('分散部署'), `top 命中应为含词块：${hits[0].text}`);
  assert.equal(typeof hits[0].score, 'number');
});

test('kb_search：topK 缺省有合理默认（不抛错）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbtool-docs-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '分散部署内容。\n');
  const store = new LocalJsonVectorStore(new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbtool-store-'))));
  const kb = new KnowledgeBase(store, new BucketEmbedding());
  await kb.indexDir(dir);

  const { registry, safety } = setup(kb);
  const r = await registry.execute('kb_search', { query: '分散部署' }, safety);
  assert.ok(r.ok);
  assert.ok(JSON.parse(r.value.stdout).length >= 1);
});
