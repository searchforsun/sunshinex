import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { ModelRouter, ScriptedAdapter, StubAdapter, OpenAIAdapter, extractUsage, extractPromptTokens, extractCacheTokens } from './adapter';
import { ChatRequest, ModelTier } from '../types';
import type { RequestParams } from './request-params';

test('ScriptedAdapter 依次回放脚本', async () => {
  const a = new ScriptedAdapter(['{"tool":"read","done":false}', '{"done":true}']);
  const req = (): ChatRequest => ({ messages: [{ role: 'user', content: 'p' }] });
  const r1 = await a.chat(req());
  assert.equal(r1.finish, 'tool_calls');
  assert.equal(r1.toolCalls[0]?.name, 'read');
  const r2 = await a.chat(req());
  assert.equal(r2.finish, 'stop');
});

test('StubAdapter：stop 收束回未接线提示，不回显提示词', async () => {
  const a = new StubAdapter();
  const r = await a.chat({ messages: [{ role: 'user', content: 'PROMPT-SECRET' }] });
  assert.equal(r.finish, 'stop');
  assert.ok(r.content.length > 0, '应给出可读提示');
  assert.ok(!r.content.includes('PROMPT-SECRET'), '回显 prompt 会把系统提示词泄露到界面');
});

test('OpenAIAdapter 无 key 时 chat 抛错', async () => {
  const a = new OpenAIAdapter({ provider: 'openai', baseURL: 'http://127.0.0.1:1/v1' });
  await assert.rejects(() => a.chat({ messages: [{ role: 'user', content: 'hi' }] }));
});

test('OpenAIAdapter 超时时抛「Model call timed out」', async () => {
  const srv = http.createServer((_req, _res) => {
    // 挂起不响应，触发客户端超时
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const a = new OpenAIAdapter({ provider: 'openai', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'k', timeoutMs: 300 });
  await assert.rejects(() => a.chat({ messages: [{ role: 'user', content: 'hi' }] }), /Model call timed out/);
  srv.close();
});

test('ModelRouter 未绑定档位回退默认 adapter', () => {
  const def = new StubAdapter();
  const r = new ModelRouter();
  r.bindDefault(def);
  assert.equal(r.resolve('small'), def);
  assert.equal(r.resolve('large'), def);
});

test('ModelRouter 无默认且档位未绑定 → 抛错', () => {
  const r = new ModelRouter();
  assert.throws(() => r.resolve('small'), /no adapter/);
});

test('boundTiers 返回显式绑定快照（不含默认）', () => {
  const r = new ModelRouter();
  r.bindDefault(new StubAdapter());
  r.bind('large', new StubAdapter());
  assert.deepEqual(r.boundTiers(), ['large']);
});

test('ModelTier 自 types 登记且 adapter 侧可用', () => {
  const tiers: ModelTier[] = ['small', 'medium', 'large'];
  assert.equal(tiers.length, 3);
});

test('extractUsage 有 usage → 返回 total_tokens', () => {
  assert.equal(extractUsage({ usage: { total_tokens: 42 } }), 42);
});

test('extractPromptTokens 有 usage → 返回 prompt_tokens', () => {
  assert.equal(extractPromptTokens({ usage: { prompt_tokens: 30 } }), 30);
});

test('extractPromptTokens 无 usage/非数字 → 返回 0', () => {
  assert.equal(extractPromptTokens({}), 0);
  assert.equal(extractPromptTokens({ usage: { prompt_tokens: 'x' } }), 0);
  assert.equal(extractPromptTokens(null), 0);
});

test('extractUsage 无 usage/非数字 → 返回 0', () => {
  assert.equal(extractUsage({}), 0);
  assert.equal(extractUsage({ usage: { total_tokens: 'abc' } }), 0);
  assert.equal(extractUsage(null), 0);
});

test('extractCacheTokens：OpenAI 标准 prompt_tokens_details.cached_tokens', () => {
  assert.equal(extractCacheTokens({ usage: { prompt_tokens_details: { cached_tokens: 64 } } }), 64);
});

test('extractCacheTokens：三方私有字段（如 DeepSeek prompt_cache_hit_tokens）不识别，一律回 0', () => {
  assert.equal(extractCacheTokens({ usage: { prompt_cache_hit_tokens: 128 } }), 0);
});

test('extractCacheTokens：缺失/非法回 0', () => {
  assert.equal(extractCacheTokens({}), 0);
  assert.equal(extractCacheTokens({ usage: {} }), 0);
  assert.equal(extractCacheTokens(null), 0);
});

test('OpenAIAdapter：外部 signal 中止 → 抛「Task interrupted」（区别于超时）', async () => {
  const srv = http.createServer((_req, _res) => {
    // 挂起不响应：等客户端经外部 signal 主动中止
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const a = new OpenAIAdapter({ provider: 'openai', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'k', timeoutMs: 10_000 });
  const ctrl = new AbortController();
  const pending = a.chat({ messages: [{ role: 'user', content: 'hi' }], signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 80);
  await assert.rejects(() => pending, /Task interrupted/);
  srv.close();
});

/** 请求体捕获桩：最小合法 chat/SSE 响应；body() 取最近一次请求体供断言（真 http 面,不走 fetch 替身） */
async function captureAdapter(cfg: { params?: RequestParams }): Promise<{
  body: () => Record<string, unknown>;
  chat: () => Promise<void>;
  chatWith: (req: ChatRequest) => Promise<void>;
  chatStream: () => Promise<void>;
  close: () => void;
}> {
  const state: { body: Record<string, unknown> } = { body: {} };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      state.body = JSON.parse(raw) as Record<string, unknown>;
      if (state.body['stream'] === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"total_tokens":1}}\n\ndata: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }));
      }
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const a = new OpenAIAdapter({ provider: 'openai', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'k', ...cfg });
  const req = (): ChatRequest => ({ messages: [{ role: 'user', content: 'hi' }] });
  return {
    body: () => state.body,
    chat: async () => {
      await a.chat(req());
    },
    chatWith: async (r: ChatRequest) => {
      await a.chat(r);
    },
    chatStream: async () => {
      await a.chatStream(req(), () => {});
    },
    close: () => srv.close(),
  };
}

test('OpenAIAdapter 自定义请求参数：chat/chatStream 请求体并入顶层键值，协议字段不被覆盖', async () => {
  for (const stream of [false, true]) {
    const cap = await captureAdapter({ params: { prompt_cache_key: 'sess-a', enable_thinking: false, model: 'hijack', stream: false } });
    try {
      if (stream) await cap.chatStream();
      else await cap.chat();
      const body = cap.body();
      assert.equal(body['prompt_cache_key'], 'sess-a', '自定义键原样并入');
      assert.equal(body['enable_thinking'], false, '布尔值原样（非字符串化）');
      assert.equal(body['model'], 'gpt-4o-mini', 'params 同名的协议字段以协议为准（结构兜底）');
      assert.equal(body['stream'], stream, 'stream 由协议面决定（params 的 stream:false 不生效）');
    } finally {
      cap.close();
    }
  }
});

test('OpenAIAdapter 协议字段面：请求体只带协议键+自动缓存路由键（无自定义参数时零多余键）', async () => {
  const cap = await captureAdapter({});
  try {
    await cap.chat();
    assert.deepEqual(Object.keys(cap.body()).sort(), ['messages', 'model', 'prompt_cache_key', 'tool_choice'], '协议键 + 自动缓存键，其余零穿参');
  } finally {
    cap.close();
  }
});

test('自动缓存路由键：同稳定前缀恒同键、前缀不同即换键（会话配置相同 → 同缓存分组）', async () => {
  const cap = await captureAdapter({});
  try {
    const mk = (system: string): ChatRequest => ({ messages: [{ role: 'system', content: system }, { role: 'user', content: 'hi' }] });
    await cap.chatWith(mk('SYS-A'));
    const keyA = String(cap.body()['prompt_cache_key']);
    await cap.chatWith(mk('SYS-A'));
    assert.equal(String(cap.body()['prompt_cache_key']), keyA, '同前缀恒同键');
    await cap.chatWith(mk('SYS-B'));
    assert.notEqual(String(cap.body()['prompt_cache_key']), keyA, '前缀不同即换键');
    assert.match(keyA, /^gpt-4o-mini:[0-9a-f]{32}$/, '键=模型+前缀摘要（非明文）');
  } finally {
    cap.close();
  }
});

test('用户显式 params.prompt_cache_key 优先：自动派生让位，请求体用声明值', async () => {
  const cap = await captureAdapter({ params: { prompt_cache_key: 'user-key-1' } });
  try {
    await cap.chat();
    assert.equal(cap.body()['prompt_cache_key'], 'user-key-1', '自定义参数值原样，不被自动键覆盖');
  } finally {
    cap.close();
  }
});

test('端点拒收 prompt_cache_key：400 点名该参数 → 自动降级省略键重发成功，后续请求不再携带', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      if (body['prompt_cache_key'] !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: prompt_cache_key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const a = new OpenAIAdapter({ provider: 'openai', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'k' });
  try {
    const r1 = await a.chat({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }] });
    assert.equal(r1.finish, 'stop', '降级重发成功（用户无感）');
    assert.equal(bodies.length, 2, '首发带键被拒 + 去键重发');
    assert.equal(bodies[0]!['prompt_cache_key'] !== undefined, true);
    assert.equal(bodies[1]!['prompt_cache_key'], undefined);
    await a.chat({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'again' }] });
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2]!['prompt_cache_key'], undefined, '不支持记忆位生效：后续请求恒省略');
  } finally {
    srv.close();
  }
});
