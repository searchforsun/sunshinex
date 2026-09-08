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

function registryWithAllowlist(allowlist: string[]): { registry: ToolRegistry; safety: SafetyChain; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-webfetch-'));
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk', allowlist),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  return { registry, safety, root };
}

test('webfetch：白名单内域名抓取成功', async () => {
  const srv = await startServer('hello sunshine');
  try {
    const { registry, safety } = registryWithAllowlist(['127.0.0.1']);
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
    const { registry, safety } = registryWithAllowlist(['127.0.0.1']);
    const r = await registry.execute('webfetch', { url: srv.url }, safety);
    assert.ok(r.ok);
    assert.equal(r.value.stdout.length, 100_000);
  } finally {
    srv.close();
  }
});

test('webfetch：白名单外域名在 guard 拒绝，不发起网络请求', async () => {
  const { registry, safety } = registryWithAllowlist(['127.0.0.1']);
  const r = await registry.execute('webfetch', { url: 'http://example.com/x' }, safety);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, 'COMMAND_DENIED');
});

test('webfetch：空白名单全禁（缺省安全）', async () => {
  const srv = await startServer('no');
  try {
    const { registry, safety } = registryWithAllowlist([]);
    const r = await registry.execute('webfetch', { url: srv.url }, safety);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, 'COMMAND_DENIED');
  } finally {
    srv.close();
  }
});

test('Harness 装配：SUNSHINE.md 网络白名单注入 guard', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-harness-wl-'));
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), '# 网络白名单\n\n127.0.0.1\n');
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

test('Harness 装配：无 SUNSHINE.md 时 webfetch 全禁', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-harness-nowl-'));
  const srv = await startServer('no');
  try {
    const h = new Harness({ root, mode: 'dontAsk' });
    const r = await h.tools.execute('webfetch', { url: srv.url }, h.safety);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, 'COMMAND_DENIED');
  } finally {
    srv.close();
  }
});
