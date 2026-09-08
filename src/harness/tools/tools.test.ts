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
import { ToolBackend } from '../../types';

test('execute 经安全链：dangerous 命令被拦截', async () => {
  const safety = new SafetyChain(new SecurityGuard(), new ProcessSandbox(), new DryRun(), process.cwd());
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, process.cwd())) registry.register(t);

  const r = await registry.execute('exec', { command: 'rm -rf /' }, safety);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'COMMAND_DENIED');
});

test('execute 经安全链：只读命令放行', async () => {
  const safety = new SafetyChain(new SecurityGuard(), new ProcessSandbox(), new DryRun(), process.cwd());
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, process.cwd())) registry.register(t);

  const r = await registry.execute('exec', { command: 'echo ok' }, safety);
  assert.equal(r.ok, true);
});

test('未注册工具返回 TOOL_NOT_FOUND', async () => {
  const registry = new ToolRegistry();
  const r = await registry.execute('nope', {}, new SafetyChain(new SecurityGuard(), new ProcessSandbox(), new DryRun(), process.cwd()));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'TOOL_NOT_FOUND');
});

test('read 敏感文件内容经 execute 出口已脱敏', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mask-'));
  fs.writeFileSync(path.join(root, 'secret.env'), 'TEST_API_KEY=sk-abcdefghijklmnopqrst1234\n');
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  const r = await registry.execute('read', { path: 'secret.env' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(!r.value.stdout.includes('sk-abcdefghijklmnopqrst1234'));
    assert.ok(r.value.stdout.includes('***'));
  }
});

test('exec 回显密钥经 execute 出口已脱敏', async () => {
  const safety = new SafetyChain(new SecurityGuard(), new ProcessSandbox(), new DryRun(), process.cwd());
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, process.cwd())) registry.register(t);
  const r = await registry.execute('exec', { command: 'echo token=sk-abcdefghijklmnopqrst1234' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(!r.value.stdout.includes('sk-abcdefghijklmnopqrst1234'));
    assert.ok(r.value.stdout.includes('***'));
  }
});

test('文件工具经统一后端执行（write 走 backend.writeFile）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-1d-'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), dir);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, dir)) registry.register(t);

  const r = await registry.execute('write', { path: 'out/x.txt', content: 'via backend' }, safety);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'x.txt'), 'utf8'), 'via backend');
});

test('D2 后端可替换：探针 stub 注入即换', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-1d-stub-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'real');
  const real = new ProcessSandbox();
  const calls: string[] = [];
  const probe: ToolBackend = {
    name: 'probe',
    exec: async (cmd, opts) => { calls.push(`exec:${cmd}`); return real.exec(cmd, opts); },
    readFile: (p) => { calls.push(`read:${p}`); return real.readFile(p); },
    writeFile: (p, c) => { calls.push(`write:${p}`); return real.writeFile(p, c); },
    listFiles: (root, pattern) => { calls.push(`glob:${pattern}`); return real.listFiles(root, pattern); },
  };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), probe, new DryRun(), dir);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, dir)) registry.register(t);

  const w = await registry.execute('write', { path: 'a.txt', content: 'x' }, safety);
  const g = await registry.execute('glob', { pattern: '*.txt' }, safety);
  assert.equal(w.ok, true);
  assert.equal(g.ok, true);
  assert.ok(calls.some((c) => c.startsWith('write:')), 'write 经后端');
  assert.ok(calls.some((c) => c.startsWith('glob:')), 'glob 经后端');
});
