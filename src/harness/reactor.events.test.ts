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

test('事件流：正常单步 run 发射 step→token*→route→done，无 onEvent 零副作用', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ev1-'));
  try {
    const events: SessionEvent[] = [];
    const r1 = await makeReactor(tmp, new ScriptedAdapter(['{"done":true,"reply":"ok"}'])).run({ goal: 'g1' }, { maxSteps: 2 });
    assert.equal(r1.done, true, '无 onEvent 缺省零副作用');
    const r2 = await makeReactor(tmp, new ScriptedAdapter(['{"done":true,"reply":"ok"}']), (e) => events.push(e)).run({ goal: 'g2' }, { maxSteps: 2 });
    assert.equal(r2.done, true);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('step') && types.includes('token') && types.includes('route'), `应含 step/token/route，实际 ${types.join(',')}`);
    assert.equal(events[events.length - 1].type, 'done', '收尾必发 done');
    // scripted 走 completeStream 逐字投递：token 为增量，消费端拼接后应含完整输出
    const tokenText = events.filter((e) => e.type === 'token').map((e) => e.text ?? '').join('');
    assert.ok(tokenText.includes('"reply":"ok"'), 'token 事件流拼接应含完整输出');
    const route = events.find((e) => e.type === 'route');
    assert.ok(route?.payload && typeof route.payload.tier === 'string', 'route 事件携带档位');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('事件流：工具调用发射 tool-call→tool-result，事件 ts 单调', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ev2-'));
  try {
    const events: SessionEvent[] = [];
    const r = await makeReactor(tmp, new ScriptedAdapter([
      '{"tool":"read","input":{"path":"a.txt"},"done":false}',
      '{"done":true,"reply":"ok"}',
    ]), (e) => events.push(e)).run({ goal: '读文件' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    const types = events.map((e) => e.type);
    const callAt = types.indexOf('tool-call');
    const resultAt = types.indexOf('tool-result');
    assert.ok(callAt > -1 && resultAt > callAt, `tool-call 先于 tool-result，实际 ${types.join(',')}`);
    assert.ok(events.every((e, i) => i === 0 || e.ts >= events[i - 1].ts), '事件 ts 单调不减');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('事件流：模型失败路径发 error 再 done（error 仅失败出现）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ev3-'));
  try {
    const events: SessionEvent[] = [];
    const boom: ModelAdapter = {
      provider: 'boom',
      complete: async () => {
        throw new Error('模型炸了');
      },
    };
    const r = await makeReactor(tmp, boom, (e) => events.push(e)).run({ goal: 'g' }, { maxSteps: 2 });
    assert.equal(r.done, false);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('error'), '失败路径应发 error');
    assert.equal(types[types.length - 1], 'done', 'error 后仍收尾 done');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('事件流：usage/reasoning 事件随流式调用发射（载荷 turnTotal 累计）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ev4-'));
  try {
    const events: SessionEvent[] = [];
    const probe: ModelAdapter & {
      completeStream: (p: string, onDelta: (t: string) => void, hooks?: UsageHooks) => Promise<string>;
    } = {
      provider: 'probe',
      complete: async () => '{"done":true,"reply":"ok"}',
      completeStream: async (_p, onDelta, hooks) => {
        hooks?.onReasoning?.('想一想');
        const text = '{"done":true,"reply":"ok"}';
        for (const ch of text) onDelta(ch);
        hooks?.onCache?.(3);
        hooks?.onPrompt?.(9);
        hooks?.onUsage?.(7);
        return text;
      },
    };
    const r = await makeReactor(tmp, probe, (e) => events.push(e)).run({ goal: 'g' }, { maxSteps: 2 });
    assert.equal(r.done, true);
    assert.equal(r.tokensUsed, 7, 'run 结果应累计 usage');
    const usage = events.filter((e) => e.type === 'usage');
    assert.equal(usage.length, 1, 'usage 事件应随模型调用发射');
    assert.deepEqual(usage[0]?.payload, { tokens: 7, turnTotal: 7, cacheHitTotal: 3, promptTotal: 9 }, 'usage 载荷含单次用量/累计/缓存命中累计/prompt 累计');
    assert.deepEqual(
      events.filter((e) => e.type === 'reasoning').map((e) => e.text),
      ['想一想'],
      'reasoning 增量应透传为事件',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('事件流：tool-result 载荷含 full（完整 observation），text 仍 200 截断', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ev5-'));
  try {
    const longContent = 'L'.repeat(250);
    const filePath = path.join(tmp, 'long.txt');
    fs.writeFileSync(filePath, longContent, 'utf8');
    const events: SessionEvent[] = [];
    const r = await makeReactor(tmp, new ScriptedAdapter([
      `{"tool":"read","input":{"path":"${filePath}"},"done":false}`,
      '{"done":true,"reply":"ok"}',
    ]), (e) => events.push(e)).run({ goal: '读长文件' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    const result = events.find((e) => e.type === 'tool-result');
    assert.ok(result, '应存在 tool-result 事件');
    assert.equal((result.text ?? '').length, 200, 'text 应为 200 字符截断摘要');
    assert.equal(result.payload?.full, longContent, 'payload.full 应为完整 observation');
    assert.equal(result.payload?.ok, true, 'payload.ok 保持既有语义');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
