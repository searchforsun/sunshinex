import { textReplyToChatFace } from '../model/chat-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';
import { SessionEvent } from '../types';

function makeReactor(tmp: string, adapter: ModelAdapter, onEvent?: (e: SessionEvent) => void): Reactor {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: adapter, ...(onEvent ? { onEvent } : {}) });
}

test('三态事件面：model-start 先于工具事件、tool-call/tool-result 携带 callId 与 status', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ts1-'));
  try {
    const events: SessionEvent[] = [];
    const r = await makeReactor(tmp, new ScriptedAdapter([
      '{"tool":"read","input":{"path":"a.txt"}}',
      '{"done":true,"reply":"ok"}',
    ]), (e) => events.push(e)).run({ goal: '读文件' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    const types = events.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'model-start').length, 2, '两个模型轮各发一次 model-start');
    assert.ok(types.indexOf('model-start') < types.indexOf('tool-call'), 'model-start 先于 tool-call');
    const call = events.find((e) => e.type === 'tool-call');
    assert.equal(call?.payload?.status, 'pending');
    assert.equal(call?.payload?.callId, 'step:1-idx:0');
    const result = events.find((e) => e.type === 'tool-result');
    assert.equal(result?.payload?.callId, 'step:1-idx:0', 'tool-result 与 tool-call 同 callId 配对');
    assert.ok(result?.payload?.status === 'completed' || result?.payload?.status === 'failed');
    const ends = events.filter((e) => e.type === 'model-end');
    assert.equal(ends.length, 2, '两个模型轮各发一次 model-end');
    assert.equal(ends[0]?.payload?.step, 1);
    assert.ok(typeof ends[0]?.payload?.ms === 'number');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('三态事件面：并行批 callId 逐项独立', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ts2-'));
  try {
    const events: SessionEvent[] = [];
    await makeReactor(tmp, new ScriptedAdapter([
      '{"tools":[{"tool":"read","input":{"path":"a.txt"}},{"tool":"glob","input":{"pattern":"*.ts"}}]}',
      '{"done":true,"reply":"ok"}',
    ]), (e) => events.push(e)).run({ goal: '并行读' }, { maxSteps: 3 });
    const callIds = events.filter((e) => e.type === 'tool-call').map((e) => e.payload?.callId);
    assert.deepEqual(callIds, ['step:1-idx:0', 'step:1-idx:1']);
    const resultIds = events.filter((e) => e.type === 'tool-result').map((e) => e.payload?.callId);
    assert.deepEqual(resultIds, ['step:1-idx:0', 'step:1-idx:1'], '结果按调用序与 callId 成对');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('三态事件面：超上限被拒的调用 status=failed、callId 仍在', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ts3-'));
  try {
    const calls = Array.from({ length: 9 }, (_, i) => `{"tool":"glob","input":{"pattern":"t${i}.ts"}}`).join(',');
    const events: SessionEvent[] = [];
    await makeReactor(tmp, new ScriptedAdapter([
      `{"tools":[${calls}]}`,
      '{"done":true,"reply":"ok"}',
    ]), (e) => events.push(e)).run({ goal: '超上限批' }, { maxSteps: 3 });
    const pairs = events.filter((e) => e.type === 'tool-result');
    assert.equal(pairs.length, 9);
    for (const p of pairs) {
      assert.equal(p.payload?.status, 'failed', '超限拒绝一律 failed');
      assert.ok(typeof p.payload?.callId === 'string' && String(p.payload?.callId).startsWith('step:1-idx:'));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
