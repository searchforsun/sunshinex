import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { OpenAIAdapter, ScriptedAdapter, StubAdapter } from './adapter';

/** 本地 SSE mock：按帧序列回放（不发真实外网），帧可为任意切分以验证跨 chunk 缓冲 */
function startSse(frames: string[], status = 200): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'text/event-stream' });
      for (const f of frames) res.write(f);
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, close: () => srv.close() });
    });
  });
}

test('ScriptedAdapter.chatStream：逐字吐出且回调拼接等于全文', async () => {
  const a = new ScriptedAdapter(['你好', '世界']);
  const deltas: string[] = [];
  const r1 = await a.chatStream({ messages: [{ role: 'user', content: 'p' }] }, (t) => deltas.push(t), { onUsage: (n) => assert.equal(n, 0) });
  assert.equal(r1.content, '你好');
  assert.equal(deltas.join(''), '你好');
  assert.ok(deltas.length > 1, '应多次回调（逐字）');
  assert.equal((await a.chatStream({ messages: [{ role: 'user', content: '' }] }, () => {})).content, '世界');
});

test('StubAdapter.chatStream：单次回调全文且不回显 prompt', async () => {
  const a = new StubAdapter();
  const deltas: string[] = [];
  const r = await a.chatStream({ messages: [{ role: 'user', content: 'PROMPT-MARK' }] }, (t) => deltas.push(t));
  assert.deepEqual(deltas, [r.content], '单次回调全文');
  assert.ok(r.content.includes('no real model wired'), '应给出未接线提示');
  assert.ok(!r.content.includes('PROMPT-MARK'), '回显 prompt 会把系统提示词泄露到界面');
});

test('OpenAIAdapter.chatStream：SSE delta 聚合 + usage 回传', async () => {
  const srv = await startSse([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'he' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'llo' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [], usage: { total_tokens: 42 } }) + '\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const a = new OpenAIAdapter({ provider: 'openai', baseURL: srv.url, apiKey: 'k', model: 'm' });
    const deltas: string[] = [];
    let usage = 0;
    const r = await a.chatStream({ messages: [{ role: 'user', content: 'p' }] }, (t) => deltas.push(t), { onUsage: (n) => (usage = n) });
    const full = r.content;
    assert.equal(full, 'hello');
    assert.deepEqual(deltas, ['he', 'llo']);
    assert.equal(usage, 42);
  } finally {
    srv.close();
  }
});

test('OpenAIAdapter.chatStream：跨 chunk 半帧正确缓冲', async () => {
  const srv = await startSse(['data: {"choices":[{"del', 'ta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
  try {
    const a = new OpenAIAdapter({ provider: 'openai', baseURL: srv.url, apiKey: 'k' });
    const full = (await a.chatStream({ messages: [{ role: 'user', content: 'p' }] }, () => {})).content;
    assert.equal(full, 'ok');
  } finally {
    srv.close();
  }
});

test('OpenAIAdapter.chatStream：非流式 HTTP 错误照常抛出', async () => {
  const srv = await startSse([], 500);
  try {
    const a = new OpenAIAdapter({ provider: 'openai', baseURL: srv.url, apiKey: 'k' });
    await assert.rejects(a.chatStream({ messages: [{ role: 'user', content: 'p' }] }, () => {}), /OpenAI request failed: 500/);
  } finally {
    srv.close();
  }
});

test('OpenAIAdapter.chatStream：reasoning_content/reasoning 经 onReasoning 回传，不混入 content', async () => {
  const srv = await startSse([
    'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '先想' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { reasoning: '一步' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '答复' } }] }) + '\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const a = new OpenAIAdapter({ provider: 'openai', baseURL: srv.url, apiKey: 'k', model: 'm' });
    const deltas: string[] = [];
    const reasons: string[] = [];
    const r = await a.chatStream({ messages: [{ role: 'user', content: 'p' }] }, (t) => deltas.push(t), { onReasoning: (t) => reasons.push(t) });
    const full = r.content;
    assert.equal(full, '答复');
    assert.deepEqual(deltas, ['答复']);
    assert.deepEqual(reasons, ['先想', '一步']);
  } finally {
    srv.close();
  }
});
