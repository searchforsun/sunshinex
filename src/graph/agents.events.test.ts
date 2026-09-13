import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeRoleAgent, ROLE_PRESETS } from './agents';
import { GraphEngine } from './engine';
import { ProcessSandbox } from '../harness/security/sandbox';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { SafetyChain } from '../harness/security/chain';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { ScriptedAdapter } from '../model/adapter';
import { SessionEvent } from '../types';

test('Graph 角色节点透传 onEvent：事件贯通到 deps 注入者', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-graphev-'));
  try {
    const store = new FileStore(path.join(tmp, '.data'));
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, tmp)) registry.register(t);
    const context = new ContextManager(tmp, store);
    const events: SessionEvent[] = [];
    const node = makeRoleAgent('planner', {
      safety,
      registry,
      context,
      model: new ScriptedAdapter(['{"done":true,"reply":"规划完成"}']),
      onEvent: (e) => events.push(e),
    }, { maxSteps: 2 });
    const engine = new GraphEngine([node], {
      safety,
      registry,
      context,
      model: new ScriptedAdapter(['{"done":true,"reply":"规划完成"}']),
      onEvent: (e) => events.push(e),
    }, { maxNodes: 10, maxTokens: 100000, timeoutMs: 60000 });
    const result = await engine.run('规划一件事');
    assert.equal(result.status, 'done', `Graph 应正常完成，实际 ${result.status}`);
    assert.ok(events.some((e) => e.type === 'done'), 'done 事件应贯通到 onEvent 注入者');
    assert.ok(events.some((e) => e.type === 'token'), 'token 事件应贯通（流式面连通）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Graph 不注入 onEvent：角色节点零副作用照常完成', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-graphev2-'));
  try {
    const store = new FileStore(path.join(tmp, '.data'));
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, tmp)) registry.register(t);
    const context = new ContextManager(tmp, store);
    const node = makeRoleAgent('developer', {
      safety,
      registry,
      context,
      model: new ScriptedAdapter(['{"done":true,"reply":"开发完成"}']),
    }, { maxSteps: 2 });
    const engine = new GraphEngine([node], {
      safety,
      registry,
      context,
      model: new ScriptedAdapter(['{"done":true,"reply":"开发完成"}']),
    }, { maxNodes: 10, maxTokens: 100000, timeoutMs: 60000 });
    const result = await engine.run('做一件事');
    assert.equal(result.status, 'done', '无 onEvent 缺省零副作用');
    assert.equal(result.results['developer']?.status, 'pass');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ROLE_PRESETS 框定不变（透传不改变角色语义）', () => {
  assert.ok(ROLE_PRESETS.planner.label.length > 0);
  assert.ok(ROLE_PRESETS.developer.framing.length > 0);
});
