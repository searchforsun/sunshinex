/** H4 拆件冒烟钉：四件（effort/usage/wire/router）各一条**直接 import 新路径**的钉，
 *  防 adapter.ts 原路径再导出遮蔽漂移（再导出面断线时此处先红，re-export 面由既有 adapter 系测试覆盖） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_ORDER, parseEffort, buildFallbackSequence, isUnsupportedEffortError } from './effort';
import { extractUsage, extractPromptTokens, extractCacheTokens } from './usage';
import { toWireMessages, toWireTools, parseChatResult } from './wire';
import { ModelRouter } from './router';
import { StubAdapter } from './adapter';

test('effort.ts 直连：档序/解析/降级序列/不支持识别', () => {
  assert.equal(EFFORT_ORDER.length, 7);
  assert.equal(parseEffort(' HIGH '), 'high');
  assert.equal(parseEffort('bogus'), undefined);
  assert.deepEqual(buildFallbackSequence('high'), ['high', 'medium', 'low']);
  assert.ok(isUnsupportedEffortError(new Error('OpenAI request failed: 422 Unsupported parameter: reasoning_effort')));
  assert.ok(!isUnsupportedEffortError(new Error('OpenAI request failed: 500 internal error')));
});

test('usage.ts 直连：三提取器', () => {
  assert.equal(extractUsage({ usage: { total_tokens: 7 } }), 7);
  assert.equal(extractPromptTokens({ usage: { prompt_tokens: 3 } }), 3);
  assert.equal(extractCacheTokens({ usage: { prompt_tokens_details: { cached_tokens: 2 } } }), 2);
  assert.equal(extractUsage({}), 0);
});

test('wire.ts 直连：消息/工具映射与非流式解析', () => {
  assert.deepEqual(toWireMessages([{ role: 'user', content: 'hi' }]), [{ role: 'user', content: 'hi' }]);
  const tools = toWireTools([{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }]);
  assert.equal((tools[0]?.function as { name?: string } | undefined)?.name, 'f');
  const r = parseChatResult({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  assert.equal(r.finish, 'stop');
  assert.equal(r.content, 'ok');
});

test('router.ts 直连：绑定/回退与提示感知选档', () => {
  const def = new StubAdapter();
  const r = new ModelRouter().bindDefault(def);
  assert.equal(r.resolve('small'), def);
  assert.equal(r.route({ complexity: 'high' }).tier, 'large');
  assert.equal(r.route({ role: 'critic' }).tier, 'large');
  assert.equal(r.route().tier, 'medium');
});
