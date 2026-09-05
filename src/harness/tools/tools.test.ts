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
  fs.writeFileSync(path.join(root, 'secret.env'), 'DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrst1234\n');
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
