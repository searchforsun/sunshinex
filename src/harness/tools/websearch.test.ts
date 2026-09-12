import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';
import { SafetyChain } from '../security/chain';
import { DryRun } from '../security/dryrun';
import { builtinTools } from './builtin';
import { parseDuckDuckGoHtml, WebSearchHit, WebSearchProvider } from './websearch';

/** DDG HTML 结构样例（覆盖 uddg 跳转链接、直链、实体转义、加粗摘要） */
const FIXTURE = [
  '<!DOCTYPE html>',
  '<div class="result results_links">',
  '  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.dev%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>',
  '  <a class="result__snippet" href="#">has &amp; symbols &amp; <b>bold</b></a>',
  '</div>',
  '<div class="result results_links">',
  '  <a rel="nofollow" class="result__a" href="https://direct.example.net/">Direct Link</a>',
  '  <a class="result__snippet" href="#">second snippet</a>',
  '</div>',
].join('\n');

test('parseDuckDuckGoHtml：标题/URL/摘要解析与 uddg 跳转还原', () => {
  const hits = parseDuckDuckGoHtml(FIXTURE, 5);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].title, 'Example Docs');
  assert.equal(hits[0].url, 'https://example.dev/docs');
  assert.equal(hits[0].snippet, 'has & symbols & bold');
  assert.equal(hits[1].title, 'Direct Link');
  assert.equal(hits[1].url, 'https://direct.example.net/');
  assert.equal(hits[1].snippet, 'second snippet');
});

test('parseDuckDuckGoHtml：count 截断与结构漂移返回空列表', () => {
  assert.equal(parseDuckDuckGoHtml(FIXTURE, 1).length, 1);
  assert.deepEqual(parseDuckDuckGoHtml('<div>no results</div>', 5), []);
});

/** 本地随机端口 mock 搜索引擎：不发真实外网 */
function startEngine(body: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/`, close: () => srv.close() });
    });
  });
}

/** 测试内临时替换 env，结束后逐键还原 */
async function withEnv(patch: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

class StubProvider implements WebSearchProvider {
  calls: { query: string; count: number }[] = [];
  constructor(private hits: WebSearchHit[]) {}
  async search(query: string, count: number): Promise<WebSearchHit[]> {
    this.calls.push({ query, count });
    return this.hits.slice(0, count);
  }
}

function registryFor(provider?: WebSearchProvider): { registry: ToolRegistry; safety: SafetyChain } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-websearch-'));
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk'),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root, undefined, provider)) registry.register(t);
  return { registry, safety };
}

test('websearch：行式输出、count 钳制与空结果降级（stub 不发网络）', async () => {
  {
    const stub = new StubProvider([
      { title: 'A', url: 'https://a.dev', snippet: 's1' },
      { title: 'B', url: 'https://b.dev', snippet: 's2' },
    ]);
    const { registry, safety } = registryFor(stub);

    const r = await registry.execute('websearch', { query: '部署', count: 99 }, safety);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.stdout, '1. A\n   https://a.dev\n   s1\n2. B\n   https://b.dev\n   s2');
    assert.equal(stub.calls[0]?.count, 10);

    const r2 = await registry.execute('websearch', { query: 'x', count: 'abc' }, safety);
    assert.ok(r2.ok);
    assert.equal(stub.calls[1]?.count, 5);
  }
});

test('websearch：端点非 http/https 在 guard 拒绝（协议底线保留）', async () => {
  await withEnv({ WEBSEARCH_ENDPOINT: 'ftp://127.0.0.1/q' }, async () => {
    const { registry, safety } = registryFor(new StubProvider([]));
    const r = await registry.execute('websearch', { query: 'x' }, safety);
    assert.ok(!r.ok);
    if (!r.ok) assert.match(r.error.message, /http\/https/);
  });
});

test('websearch：Harness 零配置 + 端点覆盖，全链路走本地 mock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-harness-ws-'));
  const srv = await startEngine(FIXTURE);
  try {
    await withEnv({ WEBSEARCH_ENDPOINT: srv.url }, async () => {
      const { Harness } = await import('../index');
      const h = new Harness({ root, mode: 'dontAsk' });
      const r = await h.tools.execute('websearch', { query: 'sunshine' }, h.safety);
      assert.ok(r.ok);
      if (r.ok) {
        assert.match(r.value.stdout, /1\. Example Docs/);
        assert.match(r.value.stdout, /https:\/\/example\.dev\/docs/);
      }
    });
  } finally {
    srv.close();
  }
});
