import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 钩子适配器：reasoning/usage 可注入，token 逐字流式（验证会话归约对三类增量事件的消费） */
class HookAdapter implements ModelAdapter {
  readonly provider = 'hooks';
  constructor(
    private readonly text: string,
    private readonly opts: { reasoning?: string[]; usage?: number } = {},
  ) {}
  async complete(): Promise<string> {
    return this.text;
  }
  async completeStream(_prompt: string, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<string> {
    for (const r of this.opts.reasoning ?? []) hooks?.onReasoning?.(r);
    for (const ch of this.text) onDelta(ch);
    if (this.opts.usage) hooks?.onUsage?.(this.opts.usage);
    return this.text;
  }
}

test('会话归约：token 增量进 live.reply（协议骨架不上屏），done 以终稿收束且不重复', async () => {
  const tmp = tmpdir('sunshinex-stream1-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"流式答复"}']) });
    const snapshots: string[] = [];
    ctrl.onState((s) => {
      if (s.live?.kind === 'reply') snapshots.push(s.live.text);
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.equal(s.live, undefined, 'done 后实时区清空');
    assert.ok(snapshots.length > 0, '应观测到流式增量');
    assert.ok(
      snapshots.some((t) => t.length > 0 && t.length < '流式答复'.length),
      '应存在中间增量（非整段一次性）',
    );
    const assistant = s.messages.filter((m) => m.role === 'assistant').map((m) => m.text);
    assert.deepEqual(assistant, ['流式答复'], '终稿取 done 载荷且仅一条');
    assert.ok(!s.messages.some((m) => m.text.includes('"reply"')), '协议骨架不得泄漏进消息区');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：reasoning 实时区折叠为 Thought 摘要行', async () => {
  const tmp = tmpdir('sunshinex-stream2-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"答复"}', { reasoning: ['先想', '再想'] }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    const thinking = s.messages.filter((m) => m.role === 'thinking');
    assert.equal(thinking.length, 1, '思考实时区收束为一条摘要行');
    assert.match(thinking[0].text, /^Thought for \d+s$/);
    assert.equal(s.live, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：usage 事件驱动本轮 tokens（turnTotal 累计）', async () => {
  const tmp = tmpdir('sunshinex-stream3-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"ok"}', { usage: 7 }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().metrics.turnTokens, 7, '本轮 tokens 应取 usage.turnTotal');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：工具调用/结果两行形态（英文动词 + ✓/✗）', async () => {
  const tmp = tmpdir('sunshinex-stream4-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"a.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"写完"}',
      ]),
    });
    await ctrl.submit('写文件');
    await ctrl.waitIdle();
    const msgs = ctrl.getState().messages;
    const call = msgs.find((m) => m.role === 'tool' && m.kind === 'call');
    assert.equal(call?.text, 'WRITE a.txt', '工具调用行应为英文动词 + 路径');
    const result = msgs.find((m) => m.role === 'tool' && m.kind === 'result');
    assert.equal(result?.ok, true, 'write 成功结果应标记 ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：/plan 逐项执行落 Step 步骤行', async () => {
  const tmp = tmpdir('sunshinex-stream5-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. 建 a\\n2. 建 b"}',
        '{"done":true,"reply":"a 完成"}',
        '{"done":true,"reply":"b 完成"}',
      ]),
    });
    await ctrl.submit('/plan 建两个文件');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const steps = ctrl.getState().messages.filter((m) => m.role === 'step').map((m) => m.text);
    assert.deepEqual(steps, ['Step 1/2 — 建 a', 'Step 2/2 — 建 b']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
