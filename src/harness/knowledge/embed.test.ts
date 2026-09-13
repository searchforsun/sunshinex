import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { OpenAICompatEmbeddings } from './embed';

/** 本地 mock：捕获请求并回放响应（不发真实外网） */
function startEmbedServer(
  handler: () => { status?: number; body: unknown },
): Promise<{ url: string; seen: { auth?: string; path?: string; body: string }; close: () => void }> {
  return new Promise((resolve) => {
    const seen: { auth?: string; path?: string; body: string } = { body: '' };
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.auth = req.headers.authorization;
        seen.path = req.url;
        seen.body = raw;
        const r = handler();
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, seen, close: () => srv.close() });
    });
  });
}

function provider(baseURL: string): OpenAICompatEmbeddings {
  return new OpenAICompatEmbeddings({ baseURL, apiKey: 'k-test', model: 'embed-m' });
}

test('embed：POST {baseURL}/embeddings，Bearer 鉴权与批量 input 体', async () => {
  const srv = await startEmbedServer(() => ({
    body: { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }] },
  }));
  try {
    const vecs = await provider(srv.url).embed(['甲', '乙']);
    assert.equal(srv.seen.path, '/v1/embeddings');
    assert.equal(srv.seen.auth, 'Bearer k-test');
    const sent = JSON.parse(srv.seen.body ?? '{}') as { model: string; input: string[] };
    assert.equal(sent.model, 'embed-m');
    assert.deepEqual(sent.input, ['甲', '乙']);
    assert.deepEqual(vecs, [[1, 0], [0, 1]]);
  } finally {
    srv.close();
  }
});

test('embed：按 index 归位（服务端乱序回放）', async () => {
  const srv = await startEmbedServer(() => ({
    body: { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] },
  }));
  try {
    const vecs = await provider(srv.url).embed(['甲', '乙']);
    assert.deepEqual(vecs, [[1, 0], [0, 1]]);
  } finally {
    srv.close();
  }
});

test('embed：HTTP 非 2xx 抛出并带状态码', async () => {
  const srv = await startEmbedServer(() => ({ status: 503, body: { error: 'unavailable' } }));
  try {
    await assert.rejects(provider(srv.url).embed(['x']), /Embedding 请求失败：503/);
  } finally {
    srv.close();
  }
});

test('embed：非法响应（data 缺失/非数组）抛出明确错误', async () => {
  const srv = await startEmbedServer(() => ({ body: { object: 'list' } }));
  try {
    await assert.rejects(provider(srv.url).embed(['x']), /Embedding 响应格式非法/);
  } finally {
    srv.close();
  }
});
