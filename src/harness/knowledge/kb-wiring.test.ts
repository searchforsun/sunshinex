import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Harness } from '../index';
import { buildDeps } from '../../runtime';
import { createRuntime } from '../../tui/runtime';
import { resolveKbEnv } from '../../config/env';
import { KnowledgeBase, assembleKnowledgeBase } from './index';
import { LocalJsonVectorStore } from './store';
import { FileStore } from '../../storage/adapter';
import { EmbeddingProvider } from '../../types';

/**
 * D18 接线钉：kb 从装配根流到 kb_search 全链。
 * - Harness 级：opts.kb 注入 stub（kb-search.test.ts 夹具形态）→ registry.execute('kb_search') 命中，不再 kb_not_configured
 * - composition root 级：buildDeps 在 KB env 配置齐全时同样接通（resolveKbEnv → assembleKnowledgeBase → Harness opts）
 */

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

function stubKb(): KnowledgeBase {
  return new KnowledgeBase(new LocalJsonVectorStore(new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbwire-')))), new BucketEmbedding());
}

function writeDocs(): string {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbwire-docs-'));
  fs.writeFileSync(path.join(docs, 'a.md'), '采用分散部署策略。\n');
  return docs;
}

test('Harness 接线：opts.kb 注入 → kb_search 经 registry 全链命中（不再 kb_not_configured）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbwire-root-'));
  const kb = stubKb();
  await kb.indexDir(writeDocs());
  const h = new Harness({ root, kb });
  const r = await h.tools.execute('kb_search', { query: '分散部署', topK: 2 }, h.safety);
  assert.ok(r.ok, `kb_search 应成功：${r.ok ? '' : r.error.code}`);
  const hits = JSON.parse(r.value.stdout) as Array<{ text: string; score: number }>;
  assert.ok(hits.length >= 1 && hits.length <= 2);
  assert.ok(hits[0].text.includes('分散部署'), `top 命中应为含词块：${hits[0].text}`);
});

test('Harness 缺省：kb 未注入 → kb_not_configured 确定降级（既有语义保持）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbwire-nokb-'));
  const h = new Harness({ root });
  const r = await h.tools.execute('kb_search', { query: '任意' }, h.safety);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'kb_not_configured');
});

/** 本地 OpenAI 兼容 /embeddings mock（buildDeps 级真实 OpenAICompatEmbeddings 通道，零外网） */
function startEmbedServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as { input: string[] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: body.input.map((t, i) => {
            const v = new Array(8).fill(0);
            for (const ch of t) v[(ch.codePointAt(0) ?? 0) % 8] += 1;
            return { index: i, embedding: v };
          }),
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, close: () => srv.close() });
    });
  });
}

test('buildDeps 装配根：KB env 配置齐全 → kb_search 经 deps.registry 全链命中（composition root 接线钉）', async () => {
  const srv = await startEmbedServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbwire-deps-'));
  const kbDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbwire-data-'));
  process.env.SUNSHINEX_EMBEDDING_BASE_URL = srv.url;
  process.env.SUNSHINEX_EMBEDDING_API_KEY = 'k-test';
  process.env.SUNSHINEX_EMBEDDING_MODEL = 'embed-m';
  process.env.SUNSHINEX_KB_DATA_DIR = kbDataDir;
  try {
    // 先经同一配置装配建索引（同落显式数据目录），buildDeps 装配应挂接既有索引
    await assembleKnowledgeBase(resolveKbEnv(process.env as Record<string, string | undefined>), root)?.indexDir(writeDocs());
    const deps = buildDeps(root, {});
    const r = await deps.registry.execute('kb_search', { query: '分散部署', topK: 2 }, deps.safety);
    assert.ok(r.ok, `buildDeps 接线后 kb_search 应成功：${r.ok ? '' : r.error.code}`);
    const hits = JSON.parse(r.value.stdout) as Array<{ text: string }>;
    assert.ok(hits.length >= 1 && hits[0].text.includes('分散部署'), 'composition root 装配的 kb 应可检索到已索引内容');
  } finally {
    delete process.env.SUNSHINEX_EMBEDDING_BASE_URL;
    delete process.env.SUNSHINEX_EMBEDDING_API_KEY;
    delete process.env.SUNSHINEX_EMBEDDING_MODEL;
    delete process.env.SUNSHINEX_KB_DATA_DIR;
    srv.close();
  }
});

test('共享装配单点（D27）：buildDeps 与 createRuntime 两路构造 kb 装配同源——同 env 两路 kb_search 均命中同一索引', async () => {
  const srv = await startEmbedServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbwire-dual-'));
  const kbDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbwire-dualdata-'));
  process.env.SUNSHINEX_EMBEDDING_BASE_URL = srv.url;
  process.env.SUNSHINEX_EMBEDDING_API_KEY = 'k-test';
  process.env.SUNSHINEX_EMBEDDING_MODEL = 'embed-m';
  process.env.SUNSHINEX_KB_DATA_DIR = kbDataDir;
  try {
    // 同一 env/数据目录先建索引：两路装配（各自 load 挂接显式数据目录）都应检索到同一内容
    await assembleKnowledgeBase(resolveKbEnv(process.env as Record<string, string | undefined>), root)?.indexDir(writeDocs());
    const deps = buildDeps(root, {});
    const rt = createRuntime({ root });
    const r1 = await deps.registry.execute('kb_search', { query: '分散部署', topK: 2 }, deps.safety);
    const r2 = await rt.harness.tools.execute('kb_search', { query: '分散部署', topK: 2 }, rt.harness.safety);
    assert.ok(r1.ok && r2.ok, `CLI/TUI 两路装配的 kb_search 都应命中（单点 kb 接线若丢失任一路即 kb_not_configured）：CLI=${r1.ok} TUI=${r2.ok}`);
    assert.ok(
      JSON.parse(r1.value.stdout).some((h: { text: string }) => h.text.includes('分散部署')) &&
        JSON.parse(r2.value.stdout).some((h: { text: string }) => h.text.includes('分散部署')),
      '两路命中同一已索引内容（同 env 同数据目录 = 装配同源）',
    );
  } finally {
    delete process.env.SUNSHINEX_EMBEDDING_BASE_URL;
    delete process.env.SUNSHINEX_EMBEDDING_API_KEY;
    delete process.env.SUNSHINEX_EMBEDDING_MODEL;
    delete process.env.SUNSHINEX_KB_DATA_DIR;
    srv.close();
  }
});
