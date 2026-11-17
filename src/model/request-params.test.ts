/** request-params 校验单点钉：自定义请求参数的宽容/严格两面共用同一实现——
 *  好键保留、坏键（非 JSON 值/非有限数值/空键/协议保留键/嵌套超限）剔出并记原因。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRequestParams, RESERVED_REQUEST_PARAM_KEYS } from './request-params';

test('sanitizeRequestParams：JSON 值全形态保留（string/number/boolean/null/数组/嵌套对象）', () => {
  const r = sanitizeRequestParams({
    prompt_cache_key: 'sess-1',
    temperature: 0.7,
    enable_thinking: true,
    seed: null,
    stop: ['\n\n', '<|end|>'],
    chat_template_kwargs: { enable_thinking: false, depth: { n: 2 } },
  });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.params, {
    prompt_cache_key: 'sess-1',
    temperature: 0.7,
    enable_thinking: true,
    seed: null,
    stop: ['\n\n', '<|end|>'],
    chat_template_kwargs: { enable_thinking: false, depth: { n: 2 } },
  });
});

test('sanitizeRequestParams：坏键逐条剔出、好键保留（坏参数不连坐其余参数）', () => {
  const r = sanitizeRequestParams({
    good: 1,
    bad_fn: () => 1,
    bad_nan: Number.NaN,
    '': 'empty-key',
    'model': 'hijack',
    'stream': false,
    bad_array: [1, undefined],
  });
  assert.deepEqual(r.params, { good: 1 });
  assert.equal(r.problems.length, 6);
  assert.ok(r.problems.some((p) => p.includes('bad_fn')), '函数值报出');
  assert.ok(r.problems.some((p) => p.includes('bad_nan')), '非有限数值报出');
  assert.ok(r.problems.some((p) => p.includes('键名不得为空')), '空键名报出');
  assert.ok(r.problems.some((p) => p.includes('params.model 是协议字段')), '保留键 model 报出');
  assert.ok(r.problems.some((p) => p.includes('params.stream 是协议字段')), '保留键 stream 报出');
  assert.ok(r.problems.some((p) => p.includes('bad_array')), '数组内坏元素整键报出');
});

test('sanitizeRequestParams：顶层非对象 → 空产物 + 一条问题；undefined → 空产物零问题', () => {
  assert.deepEqual(sanitizeRequestParams(undefined), { params: {}, problems: [] });
  for (const bad of [null, 'kv', 42, ['a', 1]]) {
    const r = sanitizeRequestParams(bad);
    assert.deepEqual(r.params, {});
    assert.deepEqual(r.problems, ['params 须为对象（键值对）']);
  }
});

test('sanitizeRequestParams：嵌套超限报出（防失控递归/循环引用）', () => {
  let deep: unknown = 1;
  for (let i = 0; i < 12; i++) deep = { n: deep };
  const r = sanitizeRequestParams({ deep });
  assert.deepEqual(r.params, {});
  assert.ok(r.problems[0]!.includes('嵌套超过'), '深度上限生效');
});

test('RESERVED_REQUEST_PARAM_KEYS：覆盖适配器装配的协议字段', () => {
  assert.deepEqual([...RESERVED_REQUEST_PARAM_KEYS], ['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options']);
});
