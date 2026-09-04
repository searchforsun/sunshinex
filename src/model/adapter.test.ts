import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedAdapter, StubAdapter, OpenAIAdapter } from './adapter';

test('ScriptedAdapter 依次回放脚本', async () => {
  const a = new ScriptedAdapter(['{"tool":"read","done":false}', '{"done":true}']);
  assert.equal(await a.complete('p'), '{"tool":"read","done":false}');
  assert.equal(await a.complete('p'), '{"done":true}');
});

test('StubAdapter 返回标记文本', async () => {
  const a = new StubAdapter();
  assert.match(await a.complete('hi'), /stub/);
});

test('OpenAIAdapter 无 key 时 complete 抛错', async () => {
  const a = new OpenAIAdapter({ provider: 'openai', baseURL: 'http://127.0.0.1:1/v1' });
  await assert.rejects(() => a.complete('hi'));
});
