import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { assembleKnowledgeBase, indexKnowledgeDir } from './index';
import type { KbEnv } from '../../config/env';

/**
 * D28 索引构建入口单点钉子（CLI kb-index 子命令与 TUI /kb-index 的共用底座）：
 * - 未配置 → not-configured + 缺失 env 名（引导文案数据源）；非法目录 → bad-dir
 * - 成功 → backend/数据目录/块数统计，数据真实落盘（进程形态：下次装配 load 可检索）
 * - 活性实例优先：同进程先装配的 KnowledgeBase 在索引后立即可检（local-json 内存视图不静默过期）
 * embedding 走本地 OpenAI 兼容 mock（零外网，assembly.test 同款协议形态）。
 */

function bucketVec(text: string): number[] {
  const v = new Array(8).fill(0);
  for (const ch of text) v[(ch.codePointAt(0) ?? 0) % 8] += 1;
  return v;
}

function startEmbedServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as { input: string[] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: body.input.map((t, i) => ({ index: i, embedding: bucketVec(t) })),
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, close: () => srv.close() });
    });
  });
}

function tmpRoot(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sunshinex-kbidx-${tag}-`));
}

function writeDocs(tag: string): string {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), `sunshinex-kbidx-docs-${tag}-`));
  fs.writeFileSync(path.join(docs, 'a.md'), '采用分散部署策略。\n');
  return docs;
}

function fullCfg(srvUrl: string, dataDir: string): KbEnv {
  return { backend: 'local-json', embeddingBaseUrl: srvUrl, embeddingApiKey: 'k-test', embeddingModel: 'embed-m', kbDataDir: dataDir };
}

test('indexKnowledgeDir：未配置 → not-configured + 缺失 env 名（含回退源口径）', async () => {
  const r = await indexKnowledgeDir({ backend: 'local-json' }, tmpRoot('off'), writeDocs('off'));
  assert.ok(!r.ok);
  if (!r.ok && r.reason === 'not-configured') {
    assert.ok(r.missing.some((m) => m.includes('SUNSHINEX_EMBEDDING_BASE_URL')), `应指 base url 键，实际：${JSON.stringify(r.missing)}`);
    assert.ok(r.missing.some((m) => m.includes('SUNSHINEX_EMBEDDING_MODEL')), '应指 model 键');
    // 缺 model 但 base/key 在场：只报 model（部分配置如实指缺）
    const r2 = await indexKnowledgeDir(
      { backend: 'local-json', embeddingBaseUrl: 'http://x/v1', embeddingApiKey: 'k' },
      tmpRoot('off2'), writeDocs('off2'),
    );
    assert.ok(!r2.ok && r2.reason === 'not-configured');
    if (!r2.ok && r2.reason === 'not-configured') assert.equal(r2.missing.length, 1);
  } else {
    assert.fail('未配置应返回 not-configured');
  }
});

test('indexKnowledgeDir：非法目录（不存在 / 指向文件）→ bad-dir', async () => {
  const root = tmpRoot('bad');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbidx-baddata-'));
  const cfg = fullCfg('http://127.0.0.1:9/v1', dataDir);
  const missingDir = path.join(root, 'no-such-dir');
  const r1 = await indexKnowledgeDir(cfg, root, missingDir);
  assert.ok(!r1.ok && r1.reason === 'bad-dir', '不存在目录应 bad-dir');
  const aFile = path.join(root, 'plain.txt');
  fs.writeFileSync(aFile, 'x');
  const r2 = await indexKnowledgeDir(cfg, root, aFile);
  assert.ok(!r2.ok && r2.reason === 'bad-dir', '指向文件应 bad-dir');
});

test('indexKnowledgeDir：成功 → 统计三件套 + 数据落盘（新装配 load 后可检索，CLI 进程形态）', async () => {
  const srv = await startEmbedServer();
  const root = tmpRoot('ok');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbidx-okdata-'));
  try {
    const docs = writeDocs('ok');
    const r = await indexKnowledgeDir(fullCfg(srv.url, dataDir), root, docs);
    assert.ok(r.ok, `应成功：${JSON.stringify(r)}`);
    if (r.ok) {
      assert.equal(r.backend, 'local-json');
      assert.equal(r.dataDir, dataDir);
      assert.ok(r.chunks >= 1, `应至少 1 块，实际 ${r.chunks}`);
    }
    assert.ok(fs.existsSync(path.join(dataDir, 'kb.vectors.json')), '索引应落盘（kb.vectors.json）');
    // 进程外/新装配形态：另一次装配经 load 挂接既有索引，无需重索引即可检索
    const kb2 = assembleKnowledgeBase(fullCfg(srv.url, dataDir), root);
    assert.ok(kb2);
    const hits = await kb2.search('分散部署', 3);
    assert.ok(hits.length >= 1 && hits[0].text.includes('分散部署'), '新装配应检索到已索引内容');
    assert.equal(hits[0].file, 'a.md', '命中应带来源 file');
  } finally {
    srv.close();
  }
});

test('indexKnowledgeDir：同进程已装配实例 → 经同一实例写入，索引后立即可检（无活实例登记的旧实现必红）', async () => {
  const srv = await startEmbedServer();
  const root = tmpRoot('live');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbidx-livedata-'));
  try {
    // 会话装配形态：先装配（注册活实例），此后索引入口必须经它写入——否则 local-json 实例内存视图静默过期
    const kb1 = assembleKnowledgeBase(fullCfg(srv.url, dataDir), root);
    assert.ok(kb1);
    const r = await indexKnowledgeDir(fullCfg(srv.url, dataDir), root, writeDocs('live'));
    assert.ok(r.ok);
    const hits = await kb1.search('分散部署', 3);
    assert.ok(hits.length >= 1 && hits[0].text.includes('分散部署'), '已装配实例应立即可检（不经重启/重装配）');
  } finally {
    srv.close();
  }
});
