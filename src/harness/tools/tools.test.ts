import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { ProcessSandbox } from '../security/sandbox';
import { builtinTools } from './builtin';

test('execute 经安全链：dangerous 命令被拦截', async () => {
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard();
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox, process.cwd())) registry.register(t);

  const r = await registry.execute('exec', { command: 'rm -rf /' }, guard, sandbox);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'COMMAND_DENIED');
});

test('execute 经安全链：只读命令放行', async () => {
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard();
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox, process.cwd())) registry.register(t);

  const r = await registry.execute('exec', { command: 'echo ok' }, guard, sandbox);
  assert.equal(r.ok, true);
});

test('未注册工具返回 TOOL_NOT_FOUND', async () => {
  const registry = new ToolRegistry();
  const r = await registry.execute('nope', {}, new SecurityGuard(), new ProcessSandbox());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'TOOL_NOT_FOUND');
});
