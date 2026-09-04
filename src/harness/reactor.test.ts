import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reactor } from './reactor';
import { ScriptedAdapter } from '../model/adapter';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('Reactor 用 ScriptedAdapter 跑通端到端闭环', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-'));
  const store = new FileStore(tmp);
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard(new PolicyEngine(), 'manual');
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const adapter = new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo hi"},"done":false}', '{"done":true}']);
  const reactor = new Reactor({ registry, guard, sandbox, context, model: adapter });

  const r = await reactor.run({ goal: 'echo hi' });
  assert.equal(r.done, true);
  assert.ok(r.steps.length >= 1);
});

test('Reactor 达到 maxSteps 强制终止', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor2-'));
  const store = new FileStore(tmp);
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard(new PolicyEngine(), 'manual');
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const adapter = new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo x"},"done":false}']);
  const reactor = new Reactor({ registry, guard, sandbox, context, model: adapter });

  const r = await reactor.run({ goal: 'loop' }, { maxSteps: 2 });
  assert.equal(r.done, false);
  assert.equal(r.steps.length, 2);
});

test('模型输出非 JSON 时不误判完成，而是记录观察并重试', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor3-'));
  const store = new FileStore(tmp);
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard(new PolicyEngine(), 'manual');
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const adapter = new ScriptedAdapter(['这段不是 JSON，模型没理解协议']);
  const reactor = new Reactor({ registry, guard, sandbox, context, model: adapter });

  const r = await reactor.run({ goal: 'x' }, { maxSteps: 3 });
  assert.equal(r.done, false);
  assert.equal(r.steps.length, 3);
  assert.ok(r.steps.every((s) => s.observation.includes('非 JSON')));
});

test('模型调用异常时 done=false 并保留错误信息', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor4-'));
  const store = new FileStore(tmp);
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard(new PolicyEngine(), 'manual');
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const adapter = { provider: 'boom', complete: async () => { throw new Error('网络错误'); } };
  const reactor = new Reactor({ registry, guard, sandbox, context, model: adapter });

  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, false);
  assert.ok(r.reply && r.reply.includes('网络错误'));
});

test('Reactor prompt 经 Context.assemble 串起 SUNSHINE.md 指令', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor5-'));
  fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), '# 规范\n禁用 any 类型\n');
  const store = new FileStore(tmp);
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard(new PolicyEngine(), 'manual');
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);

  let captured = '';
  const adapter = { provider: 'capture', complete: async (p: string) => { captured = p; return '{"done":true}'; } };
  const reactor = new Reactor({ registry, guard, sandbox, context, model: adapter });

  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, true);
  assert.ok(captured.includes('禁用 any 类型'), 'prompt 应包含 SUNSHINE.md 指令');
});
