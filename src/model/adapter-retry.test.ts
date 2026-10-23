import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIAdapter } from './adapter';

/** O2 主链模型调用自动重试（HARNESS-BACKLOG P1 清偿）：瞬时网络错/5xx/429 指数退避重试
 *  （判据侧 MAX_JUDGE_RETRIES=3 同口径）；fatal 4xx 与本端超时不重试。判别力锚——换回无重试
 *  旧 doFetch（单发直返）时，「错两次再成功」与「429 后成功」两例即红。retryDelayMs=1 旋钮
 *  使退避零负担（生产恒缺省 1000ms）。全局 fetch 以可编程桩置换（save/restore 对称复原）。 */

type FetchStub = (url: string | URL, init?: RequestInit) => Promise<Response> | Response;

function withFetchStub(stub: FetchStub): () => void {
  const prev = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  return () => {
    globalThis.fetch = prev;
  };
}

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const CFG = { provider: 'openai' as const, baseURL: 'https://mock/v1', apiKey: 'k', model: 'm', retryDelayMs: 1 };
const REQ = { messages: [{ role: 'user' as const, content: 'hi' }] };

test('O2:瞬时网络错两次后成功——重试到位且结果逐字(chat 单点)', async () => {
  let calls = 0;
  const restore = withFetchStub(() => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return chatResponse('ok');
  });
  try {
    const r = await new OpenAIAdapter(CFG).chat(REQ);
    assert.equal(r.content, 'ok');
    assert.equal(calls, 3, '初次+两次重试');
  } finally {
    restore();
  }
});

test('O2:429 一次后成功重试;401 fatal 不重试直抛', async () => {
  let calls = 0;
  const restore = withFetchStub(() => {
    calls += 1;
    return calls === 1 ? new Response('rate limited', { status: 429 }) : chatResponse('ok');
  });
  try {
    const r = await new OpenAIAdapter(CFG).chat(REQ);
    assert.equal(r.content, 'ok');
    assert.equal(calls, 2);
  } finally {
    restore();
  }
  let fatalCalls = 0;
  const restore2 = withFetchStub(() => {
    fatalCalls += 1;
    return new Response('unauthorized', { status: 401 });
  });
  try {
    await assert.rejects(() => new OpenAIAdapter(CFG).chat(REQ), /401/);
    assert.equal(fatalCalls, 1, 'fatal 4xx 不重试');
  } finally {
    restore2();
  }
});

test('O2:5xx 连续超上限——重试 3 次后如实抛最终状态(错误面保留 detail 语义)', async () => {
  let calls = 0;
  const restore = withFetchStub(() => {
    calls += 1;
    return new Response('bad gateway', { status: 502 });
  });
  try {
    await assert.rejects(() => new OpenAIAdapter(CFG).chat(REQ), /502/);
    assert.equal(calls, 4, '初次+3 次重试上限');
  } finally {
    restore();
  }
});
