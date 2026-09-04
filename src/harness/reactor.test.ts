import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reactor } from './reactor';
import { ScriptedAdapter } from '../model/adapter';
import { ProcessSandbox } from '../security/sandbox';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ToolRegistry } from '../tools';
import { builtinTools } from '../tools/builtin';
import { ContextManager } from '../context';
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
  for (const t of builtinTools(sandbox)) registry.register(t);
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
  for (const t of builtinTools(sandbox)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const adapter = new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo x"},"done":false}']);
  const reactor = new Reactor({ registry, guard, sandbox, context, model: adapter });

  const r = await reactor.run({ goal: 'loop' }, { maxSteps: 2 });
  assert.equal(r.done, false);
  assert.equal(r.steps.length, 2);
});
