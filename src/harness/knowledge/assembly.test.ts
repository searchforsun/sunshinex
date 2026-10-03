import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { assembleKnowledgeBase } from './index';
import { resolveDataDir } from '../../config/data-dir';
import type { KbEnv } from '../../config/env';

/**
 * 装配函数三态钉子（D18）：未配置 → undefined；缺省 local-json / 显式 sqlite-vec → KnowledgeBase。
 * embedding 走本地 OpenAI 兼容 mock（零外网，与 embed.test.ts 同协议形态）：按字符桶词袋回向量，
 * 与 kb-search 夹具同款确定性口径——含词查询在余弦空间可分。
 */

function bucketVec(text: string): number[] {
  const v = new Array(8).fill(0);
  for (const ch of text) v[(ch.codePointAt(0) ?? 0) % 8] += 1;
  // 归一化：local-json 内部本就归一（余弦），sqlite-vec 是原始向量欧氏距离——归一后两者单调等价，钉同一「含词应靠前」口径
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

function startEmbedServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as { input: string[] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: body.input.map((t, i) => ({ index: i, embedding: bucketVec(t) })) }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, close: () => srv.close() });
    });
  });
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kb-asm-'));
}

function writeDocs(): string {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kb-asm-docs-'));
  fs.writeFileSync(path.join(docs, 'a.md'), '采用分散部署策略。\n');
  fs.writeFileSync(path.join(docs, 'b.txt'), '无关内容而已。\n');
  return docs;
}

function fullCfg(srvUrl: string, overrides: Partial<KbEnv> = {}): KbEnv {
  return { backend: 'local-json', embeddingBaseUrl: srvUrl, embeddingApiKey: 'k-test', embeddingModel: 'embed-m', ...overrides };
}

test('装配三态：embedding 未配置（空配置 / base+key 缺 model）→ undefined（kb_not_configured 合法确定态）', () => {
  const root = tmpRoot();
  assert.equal(assembleKnowledgeBase({ backend: 'local-json' }, root), undefined, '全缺 → 未配置');
  assert.equal(
    assembleKnowledgeBase({ backend: 'local-json', embeddingBaseUrl: 'http://x/v1', embeddingApiKey: 'k' }, root),
    undefined,
    '缺 model 同属未配置（embeddings 调用必须携带 model，无缺省可回退）',
  );
});

test('装配：未注册后端名装配期 fail-fast（禁静默回退 local-json）', () => {
  const root = tmpRoot();
  assert.throws(() => assembleKnowledgeBase(fullCfg('http://127.0.0.1:1/v1', { backend: 'no-such-backend' }), root), /Unregistered vector backend/);
});

test('装配：缺省 local-json——索引/检索全链 + 数据落 resolveDataDir(root)/kb（对齐 memoryDir 先例口径）', async () => {
  const srv = await startEmbedServer();
  const root = tmpRoot();
  try {
    const kb = assembleKnowledgeBase(fullCfg(srv.url), root);
    assert.ok(kb, '配置齐全应装配出 KnowledgeBase');
    const docs = writeDocs();
    const n = await kb.indexDir(docs);
    assert.ok(n >= 2, `应至少 2 块，实际 ${n}`);
    const hits = await kb.search('分散部署', 3);
    assert.ok(hits[0].text.includes('分散部署'), `top 命中应为含词块，实际：${hits[0].text}`);
    assert.ok(
      fs.existsSync(path.join(resolveDataDir(root), 'kb', 'kb.vectors.json')),
      '缺省后端索引应落 <dataDir>/kb（kb.vectors.json）',
    );
  } finally {
    srv.close();
  }
});

test('装配：kbDataDir 显式覆盖优先于 resolveDataDir(root)/kb', async () => {
  const srv = await startEmbedServer();
  const root = tmpRoot();
  const override = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kb-override-'));
  try {
    const kb = assembleKnowledgeBase(fullCfg(srv.url, { kbDataDir: override }), root);
    assert.ok(kb);
    await kb.indexDir(writeDocs());
    assert.ok(fs.existsSync(path.join(override, 'kb.vectors.json')), '索引应落显式覆盖目录');
  } finally {
    srv.close();
  }
});

test('装配：二次装配经 load 挂接既有索引——无需重索引即可检索', async () => {
  const srv = await startEmbedServer();
  const root = tmpRoot();
  const override = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kb-remount-'));
  try {
    await assembleKnowledgeBase(fullCfg(srv.url, { kbDataDir: override }), root)?.indexDir(writeDocs());
    const kb2 = assembleKnowledgeBase(fullCfg(srv.url, { kbDataDir: override }), root);
    assert.ok(kb2);
    const hits = await kb2.search('分散部署', 3);
    assert.ok(hits.length >= 1 && hits[0].text.includes('分散部署'), '二次装配应挂接既有索引（assemble 内含 load）');
  } finally {
    srv.close();
  }
});

test('装配：显式 sqlite-vec——装配即开库挂接（vectors.db 在位）且索引/检索全链', async () => {
  const srv = await startEmbedServer();
  const root = tmpRoot();
  try {
    const kb = assembleKnowledgeBase(fullCfg(srv.url, { backend: 'sqlite-vec' }), root);
    assert.ok(kb);
    assert.ok(fs.existsSync(path.join(resolveDataDir(root), 'kb', 'vectors.db')), '装配即 load：sqlite-vec 后端应已开库文件');
    const n = await kb.indexDir(writeDocs());
    assert.ok(n >= 2);
    const hits = await kb.search('分散部署', 3);
    assert.ok(hits[0].text.includes('分散部署'), `sqlite-vec 全链检索应命中，实际：${hits[0]?.text}`);
  } finally {
    srv.close();
  }
});
