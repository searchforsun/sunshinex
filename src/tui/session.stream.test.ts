import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import type { ChatRequest, ChatResult } from '../types';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';
import { stripAnsi } from './md-ansi';

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
  async chat(_req: ChatRequest, _hooks?: UsageHooks): Promise<ChatResult> {
    return { finish: 'stop', content: this.text, toolCalls: [] };
  }
  async chatStream(_req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult> {
    for (const r of this.opts.reasoning ?? []) hooks?.onReasoning?.(r);
    for (const ch of this.text) onDelta(ch);
    if (this.opts.usage) hooks?.onUsage?.(this.opts.usage);
    return { finish: 'stop', content: this.text, toolCalls: [] };
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
    assert.deepEqual(
      assistant.map((t) => stripAnsi(t).replace(/\n+$/, '')),
      ['流式答复'],
      '终稿取 done 载荷且仅一条（ansi 条目承载，尾随单换行为流式规范）',
    );
    assert.ok(!s.messages.some((m) => stripAnsi(m.text).includes('"reply"')), '协议骨架不得泄漏进消息区');
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

test('会话归约：工具边界旁白封口——无空行结尾的叙述段先于工具行定格为 assistant 消息（2026-09-30 phase 通道退役配套：旁白唯一承载是正文，旧 closeLive 丢弃即蒸发；CC 交错形态）', async () => {
  const tmp = tmpdir('sunshinex-sess-seal-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: {
        provider: 'seal-stub',
        chat: async () => ({ finish: 'stop' as const, content: '', toolCalls: [] }),
        chatStream: async (_req: ChatRequest, _onDelta: (t: string) => void) => {
          return { finish: 'stop' as const, content: '', toolCalls: [] };
        },
      } as never,
    });
    const fire = (e: { type: string; text?: string; payload?: Record<string, unknown> }): void =>
      (ctrl as unknown as { onEventForTest(e: never): void }).onEventForTest(e as never);
    // 首轮：旁白 delta（无空行、无尾随换行）→ 出工具牌
    fire({ type: 'token', text: '先核对配置层再读仓库结构。' });
    fire({ type: 'tool-call', text: 'READ', payload: { callId: 'c1', input: { path: 'a.ts' } } });
    fire({ type: 'tool-result', text: '42 lines', payload: { ok: true, callId: 'c1' } });
    // 旁白已封口为 assistant ansi 消息，且先于工具行（条目 text 为渲染态：剥 ANSI 后比对文案）
    const msgs = ctrl.getState().messages;
    const narrIdx = msgs.findIndex((m) => m.role === 'assistant' && stripAnsi(m.text).replace(/\n+$/, '') === '先核对配置层再读仓库结构。');
    const callIdx = msgs.findIndex((m) => m.kind === 'call');
    assert.ok(narrIdx >= 0, '无空行旁白在工具边界封口入档（不再被 closeLive 丢弃）');
    assert.ok(callIdx > narrIdx, '旁白先于其后的工具行（CC 交错形态）');
    // 次轮终稿：done 收口照旧，且封口过的旁白不重复（pushMsg 不可变替换数组，须重取状态）
    fire({ type: 'token', text: '核对完成。' });
    fire({ type: 'done', text: '核对完成。', payload: {} });
    const assistant = ctrl.getState().messages.filter((m) => m.role === 'assistant').map((m) => stripAnsi(m.text).replace(/\n+$/, ''));
    assert.ok(assistant.includes('核对完成。'), '终稿照常入档');
    assert.equal(assistant.filter((t) => t === '先核对配置层再读仓库结构。').length, 1, '封口旁白恰一份');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：逐行入档打字机（markdansi）——行级块为 ansi 条目、源内容经 stripAnsi 可寻、无丢无重', async () => {
  const tmp = tmpdir('sunshinex-stream-cont-');
  try {
    // 三行流式：行1、行2、空行、第二段——逐行切块入档（空行片段由条目 margin 承载、不入档）
    const ctrl = new SessionController({ root: tmp, model: new HookAdapter('第一行\n第二行\n\n第二段') });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const items = ctrl.getState().messages.filter((m) => m.role === 'assistant');
    assert.ok(items.length >= 2, `逐行/收口多块入档（got ${items.length} 块）`);
    assert.ok(items.every((m) => m.ansi === true), '流式条目全部 ansi');
    const joined = items.map((m) => stripAnsi(m.text)).join('');
    for (const probe of ['第一行', '第二行', '第二段']) assert.ok(joined.includes(probe), `内容不丢：${probe}`);
    assert.equal(joined.replace(/\n+$/, ''), '第一行\n第二行\n第二段', '剥 ANSI 拼接与源一致（无丢无重）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：流式正文 markdansi 行级入档——散文行即发、表格缓冲至闭合整块（ansi 条目）', async () => {
  const tmp = tmpdir('sunshinex-stream-md-');
  try {
    const text = '第一行\n第二行\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n收尾。';
    const ctrl = new SessionController({ root: tmp, model: new HookAdapter(text) });
    const ansiSeen: string[] = [];
    ctrl.onState((s) => {
      for (const m of s.messages) if (m.role === 'assistant' && m.ansi && !ansiSeen.includes(m.text)) ansiSeen.push(m.text);
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const items = ctrl.getState().messages.filter((m) => m.role === 'assistant');
    assert.ok(items.length >= 2, '行级/段级多块入档');
    assert.ok(items.every((m) => m.ansi === true), '流式条目全部 ansi');
    const table = items.find((m) => m.text.includes('│'));
    assert.ok(table, '表格块含框线（闭合后整块）');
    assert.ok(items.some((m) => m.text.includes('第一行')), '散文行入档');
    // 源不丢不重：剥 ANSI 拼接含全部内容
    const joined = items.map((m) => m.text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')).join('');
    for (const probe of ['第一行', '第二行', '收尾']) assert.ok(joined.includes(probe), `内容不丢：${probe}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：工具边界旁白封口走 finish 冲刷（未闭合围栏渲染为完整框线块）', async () => {
  const tmp = tmpdir('sunshinex-stream-md2-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        // 结构化步骤承载工具批 + 旁白正文（字符串 DSL 的 tools 形态丢弃 reply，narration 无从流式）
        { toolCalls: [{ name: 'read', args: { path: 'a.ts' } }], content: '前言\n\n```ts\ncode\nmore' },
        JSON.stringify({ done: true, reply: 'ok' }),
      ]),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const msgs = ctrl.getState().messages;
    const fence = msgs.find((m) => m.ansi && m.text.includes('┌'));
    assert.ok(fence, '未闭合围栏经 finish 冲刷为框线块（旁白封口）');
    const callIdx = msgs.findIndex((m) => m.kind === 'call');
    const fenceIdx = msgs.findIndex((m) => m === fence);
    assert.ok(fenceIdx < callIdx, '旁白先于工具行（CC 交错形态保持）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
