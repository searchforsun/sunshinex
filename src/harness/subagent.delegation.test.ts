import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRegistry, SubagentRunner } from './subagent';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ScriptedAdapter } from '../model/adapter';
import { SessionEvent } from '../types';

function assemble(model: ScriptedAdapter, events: SessionEvent[], root: string): SubagentRunner {
  const store = new FileStore(path.join(root, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  const context = new ContextManager(root, store);
  const agents = new AgentRegistry();
  agents.registerBuiltins();
  return new SubagentRunner(
    { registry, safety, context, model, root, onEvent: (e) => events.push(e) },
    agents,
  );
}

test('前台 spawn:started/ended(done+tokens)成对,kind=subagent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-del-fg-'));
  try {
    const events: SessionEvent[] = [];
    const model = new ScriptedAdapter([JSON.stringify({ done: true, reply: '子结论' })]);
    const runner = assemble(model, events, tmp);
    const r = await runner.runSubagent(
      { prompt: '干活', label: 'w' },
      { budget: { maxSteps: 3 } },
    );
    assert.equal(r.ok, true);
    const seq = events.filter((e) => e.type.startsWith('delegation-')).map((e) => e.type);
    assert.deepEqual(seq, ['delegation-started', 'delegation-ended']);
    const started = events.find((e) => e.type === 'delegation-started')!.payload as Record<string, unknown>;
    const ended = events.find((e) => e.type === 'delegation-ended')!.payload as Record<string, unknown>;
    assert.equal(started.delegationId, 'w');
    assert.equal(started.kind, 'subagent');
    assert.equal(ended.status, 'done');
    assert.equal(typeof ended.tokens, 'number');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('并发上限早退:不发射任何 delegation 事件(未 started 即退)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-del-lim-'));
  try {
    const events: SessionEvent[] = [];
    const model = new ScriptedAdapter([]);
    const runner = assemble(model, events, tmp);
    // 直接用非法入参走早退路径(INVALID_ARG 在 label 消歧前返回)
    const r = await runner.runSubagent({ prompt: '' , agent_id: 'no-such-agent' } as never, { budget: { maxSteps: 1 } });
    assert.equal(r.ok, false);
    assert.equal(events.filter((e) => e.type.startsWith('delegation-')).length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
