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
import { Harness } from '../index';

/** 本地随机端口 mock server：不发真实外网 */
function startServer(body: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/`, close: () => srv.close() });
    });
  });
}

function registryFor(): { registry: ToolRegistry; safety: SafetyChain; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-webfetch-'));
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk'),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  return { registry, safety, root };
}

test('webfetch：http 端点抓取成功', async () => {
  const srv = await startServer('hello sunshine');
  try {
    const { registry, safety } = registryFor();
    const r = await registry.execute('webfetch', { url: srv.url }, safety);
    assert.ok(r.ok);
    assert.equal(r.value.stdout, 'hello sunshine');
  } finally {
    srv.close();
  }
});

test('webfetch：正文超 10 万字符截断', async () => {
  const srv = await startServer('x'.repeat(150_000));
  try {
    const { registry, safety } = registryFor();
    const r = await registry.execute('webfetch', { url: srv.url }, safety);
    assert.ok(r.ok);
    assert.equal(r.value.stdout.length, 100_000);
  } finally {
    srv.close();
  }
});

test('webfetch：非法 scheme 在 guard 拒绝', async () => {
  const { registry, safety } = registryFor();
  const r = await registry.execute('webfetch', { url: 'ftp://example.com/x' }, safety);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'COMMAND_DENIED');
});

test('webfetch：URL 非法拒绝', async () => {
  const { registry, safety } = registryFor();
  const r = await registry.execute('webfetch', { url: 'not-a-url' }, safety);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'COMMAND_DENIED');
});

test('Harness 装配：无 SUNSHINE.md 时 webfetch 开箱可用', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-harness-nowl-'));
  const srv = await startServer('ok-data');
  try {
    const h = new Harness({ root, mode: 'dontAsk' });
    const r = await h.tools.execute('webfetch', { url: srv.url }, h.safety);
    assert.ok(r.ok);
    assert.equal(r.value.stdout, 'ok-data');
  } finally {
    srv.close();
  }
});
