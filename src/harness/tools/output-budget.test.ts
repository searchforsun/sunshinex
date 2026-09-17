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
import { createToolOutputArchive, PREVIEW_CHARS, TOOL_OUTPUT_CHAR_LIMIT } from './output-archive';
import { Harness } from '../index';
import { resolveDataDir } from '../../config/data-dir';

function safetyFor(root: string): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
}

function registryWith(root: string, dir: string): ToolRegistry {
  const archive = createToolOutputArchive(() => dir);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safetyFor(root), root, undefined, undefined, archive)) registry.register(t);
  return registry;
}

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

test('A-2 read：超预算输出截断并全文落盘，小文件逐字节不变', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-budget-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-budget-arch-'));
  const registry = registryWith(root, dir);
  fs.writeFileSync(path.join(root, 'big.txt'), 'r'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 5_000));
  fs.writeFileSync(path.join(root, 'small.txt'), 'hi');
  const big = await registry.execute('read', { path: 'big.txt' }, safetyFor(root));
  assert.ok(big.ok);
  if (big.ok) {
    assert.ok(big.value.stdout.startsWith('r'.repeat(PREVIEW_CHARS)));
    const m = big.value.stdout.match(/\[truncated · full output: (.+)\]/);
    assert.ok(m, '含落盘路径提示');
    assert.equal(fs.readFileSync(m![1], 'utf8'), 'r'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 5_000));
  }
  const small = await registry.execute('read', { path: 'small.txt' }, safetyFor(root));
  assert.ok(small.ok);
  if (small.ok) assert.equal(small.value.stdout, 'hi');
});

test('A-2 exec：stdout 超预算截断落盘，退出码形态保持', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-budget-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-budget-arch-'));
  const registry = registryWith(root, dir);
  const r = await registry.execute('exec', { command: `node -e "process.stdout.write('e'.repeat(${TOOL_OUTPUT_CHAR_LIMIT + 5_000}))"` }, safetyFor(root));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.exitCode, 0);
    assert.ok(r.value.stdout.startsWith('e'.repeat(PREVIEW_CHARS)));
    assert.match(r.value.stdout, /\[truncated · full output: (.+)\]/);
  }
});

test('A-2 glob：超预算文件列表截断落盘', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-budget-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-budget-arch-'));
  const registry = registryWith(root, dir);
  for (let i = 0; i < 1_200; i++) fs.writeFileSync(path.join(root, `nnnnnnnnnnnnnnnnnnnn-${i}.txt`), 'x');
  const r = await registry.execute('glob', { pattern: '*.txt' }, safetyFor(root));
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.value.stdout.length < TOOL_OUTPUT_CHAR_LIMIT + PREVIEW_CHARS);
    assert.match(r.value.stdout, /\[truncated/);
  }
});

test('A-2 webfetch：超预算正文截断落盘（统一预算取代 100k slice）', async () => {
  const body = 'w'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 10_000);
  const srv = await startServer(body);
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-budget-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-budget-arch-'));
    const registry = registryWith(root, dir);
    const r = await registry.execute('webfetch', { url: srv.url }, safetyFor(root));
    assert.ok(r.ok);
    if (r.ok) {
      assert.ok(r.value.stdout.startsWith('w'.repeat(PREVIEW_CHARS)));
      const m = r.value.stdout.match(/\[truncated · full output: (.+)\]/);
      assert.ok(m, '含落盘路径提示');
      assert.equal(fs.readFileSync(m![1], 'utf8').length, body.length);
    }
  } finally {
    srv.close();
  }
});

test('A-2 装配契约：Harness 缺省装配含出口预算（防漏接）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-harness-budget-'));
  const harness = new Harness({ root: tmp, mode: 'dontAsk' });
  fs.writeFileSync(path.join(tmp, 'huge.txt'), 'h'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 5_000));
  const r = await harness.tools.execute('read', { path: 'huge.txt' }, harness.safety);
  assert.ok(r.ok);
  if (r.ok) assert.match(r.value.stdout, /\[truncated · full output: (.+)\]/);
  const outDir = path.join(resolveDataDir(tmp), 'tool-outputs');
  assert.ok(fs.existsSync(outDir), 'tool-outputs 目录已产生');
  assert.ok(fs.readdirSync(outDir).length >= 1);
});

test('A-2 工具描述登记截断落盘语义（模型自清单学会恢复路径）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-budget-'));
  const tools = builtinTools(safetyFor(root), root);
  for (const name of ['read', 'exec', 'glob', 'webfetch']) {
    const d = tools.find((t) => t.name === name)!.description;
    assert.match(d, /truncat/i, `${name} 描述含截断语义`);
  }
});
