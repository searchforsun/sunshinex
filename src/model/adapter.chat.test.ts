import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIAdapter, ScriptedAdapter, StubAdapter } from './adapter';
import type { ChatMessage, ChatTool, JsonSchema } from '../types';
/**
 * T2（原生 function calling 迁移）adapter 消息面红灯：
 * ①chat 请求体：messages 数组 + tools（注册表 parameters → OpenAI function 形态）+ tool_choice 缺省 auto；
 *   response_format 与 SUNSHINEX_STRUCTURED_OUTPUT 穿参不再出现（退役落 T4，adapter 侧请求体先行剔除）
 * ②chatStream：tool_calls 增量聚合（index 分片乱序 → name/arguments 拼装）、content 增量照旧、
 *   finish=tool_calls 产出 StructuredAction、finish=stop 收束 content 即 reply
 * ③argsJson 为模型出牌原文：非法 JSON 原样保留，由消费面回喂纠偏
 * ④ScriptedAdapter：脚本出牌从 JSON 信封文本扩为 tool_calls 序列（多调用/旁白/stop 收束），旧字符串脚本形态不回归
 */

/** mock 非流式 fetch：记录请求体、按脚本应答 */
function mockJson(script: Array<{ status: number; body: unknown }>): { bodies: Array<Record<string, unknown>>; restore: () => void } {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const step = script[Math.min(i, script.length - 1)];
    i++;
    return new Response(typeof step.body === 'string' ? step.body : JSON.stringify(step.body), {
      status: step.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = orig; } };
}

/** mock SSE fetch：逐帧入流（单帧可含多行 data），记录请求体 */
function mockSse(frames: string[]): { bodies: Array<Record<string, unknown>>; restore: () => void } {
  const bodies: Array<Record<string, unknown>> = [];
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = orig; } };
}

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

function adapter(): OpenAIAdapter {
  return new OpenAIAdapter({ provider: 'openai', apiKey: 'k', model: 'm', baseURL: 'http://x/v1', timeoutMs: 5000 });
}

const readParams: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: { path: { type: 'string' } },
};

const tools: ChatTool[] = [
  { type: 'function', function: { name: 'read', description: 'Read a file', parameters: readParams } },
];

test('chat 请求体：messages 数组 + tools（function 形态）+ tool_choice auto，且不再携带 response_format', async () => {
  const m = mockJson([{
    status: 200,
    body: {
      choices: [{
        message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { total_tokens: 10 },
    },
  }]);
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'go' },
    ];
    const r = await adapter().chat({ messages, tools });
    assert.equal(r.finish, 'tool_calls');
    assert.deepEqual(r.toolCalls, [{ id: 'c1', name: 'read', argsJson: '{"path":"a.ts"}' }]);
    const body = m.bodies[0];
    assert.equal(body.model, 'm');
    assert.deepEqual(body.messages, messages);
    assert.deepEqual(body.tools, tools);
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.response_format, undefined, 'response_format must not be sent on the chat surface');
  } finally {
    m.restore();
  }
});

test('chat 非流式：argsJson 保留模型出牌原文（非法 JSON 不在此层解析抛错）', async () => {
  const m = mockJson([{
    status: 200,
    body: {
      choices: [{
        message: {
          content: 'writing now',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'write', arguments: '{broken json' } },
            { id: 'c2', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    },
  }]);
  try {
    const r = await adapter().chat({ messages: [{ role: 'user', content: 'go' }], tools });
    assert.equal(r.content, 'writing now', 'content 旁白与 tool_calls 同轮共存');
    assert.equal(r.toolCalls[0].argsJson, '{broken json');
    assert.deepEqual(r.toolCalls[1], { id: 'c2', name: 'grep', argsJson: '{"pattern":"x"}' });
  } finally {
    m.restore();
  }
});

test('chatStream：tool_calls 增量聚合（index 分片乱序到达按 index 拼装）+ content 增量 + finish=tool_calls', async () => {
  const m = mockSse([
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'grep', arguments: '' } }] } }] }),
    frame({ choices: [{ delta: { content: 'reading files' } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"pattern":"x"}' } }] } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    frame({ choices: [], usage: { total_tokens: 42, prompt_tokens: 30 } }),
    'data: [DONE]\n\n',
  ]);
  try {
    const deltas: string[] = [];
    let usage = 0;
    const r = await adapter().chatStream({ messages: [{ role: 'user', content: 'go' }], tools }, (t) => deltas.push(t), {
      onUsage: (n) => { usage += n; },
    });
    assert.equal(r.finish, 'tool_calls');
    assert.equal(r.content, 'reading files');
    assert.equal(deltas.join(''), 'reading files');
    assert.equal(usage, 42);
    assert.deepEqual(r.toolCalls, [
      { id: 'c1', name: 'read', argsJson: '{"path":"a.ts"}' },
      { id: 'c2', name: 'grep', argsJson: '{"pattern":"x"}' },
    ]);
    const body = m.bodies[0];
    assert.equal(body.stream, true);
    assert.deepEqual(body.tools, tools);
    assert.equal(body.response_format, undefined);
  } finally {
    m.restore();
  }
});

test('chatStream：finish=stop → content 即 reply、toolCalls 空', async () => {
  const m = mockSse([
    frame({ choices: [{ delta: { content: 'final answer' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]);
  try {
    const r = await adapter().chatStream({ messages: [{ role: 'user', content: 'go' }] }, () => {});
    assert.equal(r.finish, 'stop');
    assert.equal(r.content, 'final answer');
    assert.deepEqual(r.toolCalls, []);
  } finally {
    m.restore();
  }
});

test('ScriptedAdapter：tool_calls 序列出牌（一轮多调用+旁白+stop 收束），旧字符串脚本形态不回归', async () => {
  const a = new ScriptedAdapter([
    { content: 'phase: reading', toolCalls: [{ name: 'read', args: { path: 'a.ts' } }, { name: 'grep', args: { pattern: 'x' } }] },
    { content: 'all done' },
  ]);
  const r1 = await a.chat({ messages: [{ role: 'user', content: 'go' }] });
  assert.equal(r1.finish, 'tool_calls');
  assert.equal(r1.content, 'phase: reading');
  assert.deepEqual(r1.toolCalls.map((t) => t.name), ['read', 'grep']);
  assert.equal(JSON.parse(r1.toolCalls[0].argsJson).path, 'a.ts');
  const r2 = await a.chat({ messages: [{ role: 'user', content: 'go' }] });
  assert.equal(r2.finish, 'stop');
  assert.equal(r2.content, 'all done');
  assert.deepEqual(r2.toolCalls, []);

  // 旧字符串脚本（JSON 信封文本）：chat 面按信封协议转译为结构化出牌（T4——47 处既有脚本用例的兼容关键）
  const legacy = new ScriptedAdapter(['{"tool":"read","input":{"path":"a"}}']);
  const r3 = await legacy.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r3.finish, 'tool_calls');
  assert.deepEqual(r3.toolCalls, [{ id: 'call_0', name: 'read', argsJson: '{"path":"a"}' }]);
});

test('ScriptedAdapter.chatStream：结构化步骤 content 增量投递，旧字符串逐字投递不回归', async () => {
  const a = new ScriptedAdapter([{ content: 'hello', toolCalls: [{ name: 'read', args: {} }] }]);
  const deltas: string[] = [];
  const r = await a.chatStream({ messages: [{ role: 'user', content: 'go' }] }, (t) => deltas.push(t));
  assert.equal(r.finish, 'tool_calls');
  assert.equal(deltas.join(''), 'hello');
  assert.deepEqual(r.toolCalls.map((t) => t.name), ['read']);

  const legacy = new ScriptedAdapter(['abc']);
  const ld: string[] = [];
  const r2 = await legacy.chatStream({ messages: [{ role: 'user', content: 'x' }] }, (t) => ld.push(t));
  assert.equal(ld.join(''), 'abc');
  assert.equal(r2.content, 'abc');
});

test('StubAdapter.chat：占位协议 JSON 以 stop 收束承载（不炸消费面）', async () => {
  const r = await new StubAdapter().chat({ messages: [{ role: 'user', content: 'go' }] });
  assert.equal(r.finish, 'stop');
  assert.deepEqual(r.toolCalls, []);
  assert.ok(r.content.includes('no real model wired'));
});
