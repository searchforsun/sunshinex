import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIAdapter, buildFallbackSequence, isUnsupportedEffortError, parseEffort } from './adapter';

/** mock fetch：按脚本逐次应答，并记录每次请求体 */
function mockFetch(script: Array<{ status: number; body: unknown }>): { bodies: Array<Record<string, unknown>>; restore: () => void } {
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

function adapter(): OpenAIAdapter {
  return new OpenAIAdapter({ provider: 'openai', apiKey: 'k', model: 'm', baseURL: 'http://x/v1', timeoutMs: 5000 });
}

test('effort 降级序列（对标用户口径）：高于 low 向下逐档取到 low；低于等于 low 向上逐档取到 max', () => {
  assert.deepEqual(buildFallbackSequence('high'), ['high', 'medium', 'low']);
  assert.deepEqual(buildFallbackSequence('xhigh'), ['xhigh', 'high', 'medium', 'low']);
  assert.deepEqual(buildFallbackSequence('max'), ['max', 'xhigh', 'high', 'medium', 'low']);
  assert.deepEqual(buildFallbackSequence('medium'), ['medium', 'low']);
  assert.deepEqual(buildFallbackSequence('low'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(buildFallbackSequence('minimal'), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(buildFallbackSequence('none'), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('parseEffort：七档合法归一，非法返回 undefined', () => {
  for (const v of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(parseEffort(v), v);
  }
  assert.equal(parseEffort('bogus'), undefined);
  assert.equal(parseEffort(''), undefined);
});

test('isUnsupportedEffortError：只认 400/422 且消息指向 reasoning_effort 参数', () => {
  assert.ok(isUnsupportedEffortError(new Error('OpenAI request failed: 400 {"error":{"message":"Unrecognized request argument: reasoning_effort"}}')));
  assert.ok(isUnsupportedEffortError(new Error('OpenAI request failed: 422 {"error":{"message":"Unsupported parameter: reasoning_effort"}}')));
  assert.ok(!isUnsupportedEffortError(new Error('OpenAI request failed: 500 {"error":{"message":"internal error"}}')));
  assert.ok(!isUnsupportedEffortError(new Error('OpenAI request failed: 400 {"error":{"message":"context length exceeded"}}')));
  assert.ok(!isUnsupportedEffortError(new Error('Model call timed out')));
});

test('effort 穿参：显式档位随请求体下发（reasoning_effort 字段）', async () => {
  const m = mockFetch([{ status: 200, body: { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } } }]);
  try {
    const out = await adapter().complete('p', undefined, undefined, 'high');
    assert.equal(out, 'ok');
    assert.equal(m.bodies[0].reasoning_effort, 'high');
  } finally {
    m.restore();
  }
});

test('effort 降级：high 不支持→逐档降 medium→low 成功；探测缓存后同请求直发生效档', async () => {
  const m = mockFetch([
    { status: 400, body: { error: { message: 'Unrecognized request argument: reasoning_effort' } } },
    { status: 400, body: { error: { message: 'Unrecognized request argument: reasoning_effort' } } },
    { status: 200, body: { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } } },
    { status: 200, body: { choices: [{ message: { content: 'ok2' } }], usage: { total_tokens: 1 } } },
  ]);
  try {
    const a = adapter();
    const out = await a.complete('p', undefined, undefined, 'high');
    assert.equal(out, 'ok');
    assert.equal(m.bodies[0].reasoning_effort, 'high');
    assert.equal(m.bodies[1].reasoning_effort, 'medium', '逐档向下：第二试 medium');
    assert.equal(m.bodies[2].reasoning_effort, 'low');
    // 探测缓存：high/medium 已判不支持，同请求直发生效档 low
    const out2 = await a.complete('p2', undefined, undefined, 'high');
    assert.equal(out2, 'ok2');
    assert.equal(m.bodies.length, 4, '缓存生效：不再重试已判不支持的档位');
    assert.equal(m.bodies[3].reasoning_effort, 'low');
  } finally {
    m.restore();
  }
});

test('effort 全序列不支持：省略参数用模型默认，并缓存端点不支持事实', async () => {
  const m = mockFetch([
    { status: 400, body: { error: { message: 'Unrecognized request argument: reasoning_effort' } } },
    { status: 400, body: { error: { message: 'Unrecognized request argument: reasoning_effort' } } },
    { status: 400, body: { error: { message: 'Unrecognized request argument: reasoning_effort' } } },
    { status: 200, body: { choices: [{ message: { content: 'default' } }], usage: { total_tokens: 1 } } },
    { status: 200, body: { choices: [{ message: { content: 'default2' } }], usage: { total_tokens: 1 } } },
  ]);
  try {
    const a = adapter();
    const out = await a.complete('p', undefined, undefined, 'high');
    assert.equal(out, 'default');
    assert.equal(m.bodies[0].reasoning_effort, 'high');
    assert.equal(m.bodies[1].reasoning_effort, 'medium');
    assert.equal(m.bodies[2].reasoning_effort, 'low');
    assert.ok(!('reasoning_effort' in m.bodies[3]), '全档不支持后省略参数直发');
    // 缓存后同请求一次直发无参
    const out2 = await a.complete('p2', undefined, undefined, 'high');
    assert.equal(out2, 'default2');
    assert.equal(m.bodies.length, 5, '缓存生效：不再重复探测');
    assert.ok(!('reasoning_effort' in m.bodies[4]));
  } finally {
    m.restore();
  }
});

test('effort 请求档变化：探测缓存按请求档记账，新请求档按序列头直发', async () => {
  const m = mockFetch([
    { status: 400, body: { error: { message: 'Unrecognized request argument: reasoning_effort' } } },
    { status: 200, body: { choices: [{ message: { content: 'low-ok' } }], usage: { total_tokens: 1 } } },
    { status: 200, body: { choices: [{ message: { content: 'max-ok' } }], usage: { total_tokens: 1 } } },
  ]);
  try {
    const a = adapter();
    await a.complete('p', undefined, undefined, 'high');
    // 首请求：high(400)→medium(200) 即成功，生效档 medium
    assert.equal(m.bodies[1].reasoning_effort, 'medium');
    // 换请求档 max：high 的探测记录只作用于 high 序列——max 未探测过，按序列首档直发且不再重试已判不支持的档
    const out = await a.complete('p2', undefined, undefined, 'max');
    assert.equal(out, 'max-ok');
    assert.equal(m.bodies.length, 3, 'max 序列首档即成功，不重试 high/medium');
    assert.equal(m.bodies[2].reasoning_effort, 'max');
  } finally {
    m.restore();
  }
});

test('effort 缺省链路：cfg 优先于 env，非法值忽略不生效；未配置零穿参', async () => {
  const prev = process.env.SUNSHINEX_REASONING_EFFORT;
  const m = mockFetch([{ status: 200, body: { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } } }]);
  try {
    process.env.SUNSHINEX_REASONING_EFFORT = 'max';
    assert.equal(adapter().resolveEffort(), 'max', 'env 缺省生效');
    assert.equal(new OpenAIAdapter({ provider: 'openai', apiKey: 'k', baseURL: 'http://x/v1', reasoningEffort: 'low' }).resolveEffort(), 'low', 'cfg 覆盖 env');
    process.env.SUNSHINEX_REASONING_EFFORT = 'bogus';
    assert.equal(adapter().resolveEffort(), undefined, '非法值忽略');
    const out = await adapter().complete('p');
    assert.equal(out, 'ok');
    assert.ok(!('reasoning_effort' in m.bodies[0]), '未配置零穿参（请求体形态不变）');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_REASONING_EFFORT;
    else process.env.SUNSHINEX_REASONING_EFFORT = prev;
    m.restore();
  }
});

test('effort 网络/服务端错误不降级：非参数类错误照常抛出', async () => {
  const m = mockFetch([{ status: 500, body: { error: { message: 'internal error' } } }]);
  try {
    await assert.rejects(
      adapter().complete('p', undefined, undefined, 'high'),
      /failed: 500/,
    );
    assert.equal(m.bodies.length, 1, '500 不进入降级序列');
  } finally {
    m.restore();
  }
});
