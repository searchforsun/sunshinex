import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
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
