import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { ScriptedAdapter, StubAdapter, OpenAIAdapter, extractUsage, extractPromptTokens, extractCacheTokens } from './adapter';
import { ModelRouter } from './adapter';
import { ModelTier } from '../types';

test('ScriptedAdapter 依次回放脚本', async () => {
  const a = new ScriptedAdapter(['{"tool":"read","done":false}', '{"done":true}']);
  assert.equal(await a.complete('p'), '{"tool":"read","done":false}');
  assert.equal(await a.complete('p'), '{"done":true}');
});

test('StubAdapter：回协议 JSON（done+reply），不回显提示词', async () => {
  const a = new StubAdapter();
  const out = await a.complete('PROMPT-SECRET');
  const parsed = JSON.parse(out) as { done: boolean; reply: string };
  assert.equal(parsed.done, true);
  assert.ok(parsed.reply.length > 0, '应给出可读提示');
  assert.ok(!out.includes('PROMPT-SECRET'), '回显 prompt 会把系统提示词泄露到界面');
});

test('OpenAIAdapter 无 key 时 complete 抛错', async () => {
  const a = new OpenAIAdapter({ provider: 'openai', baseURL: 'http://127.0.0.1:1/v1' });
  await assert.rejects(() => a.complete('hi'));
});

test('OpenAIAdapter 超时时抛「模型调用超时」', async () => {
  const srv = http.createServer((_req, res) => {
    // 挂起不响应，触发客户端超时
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const a = new OpenAIAdapter({ provider: 'openai', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'k', timeoutMs: 300 });
  await assert.rejects(() => a.complete('hi'), /模型调用超时/);
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
