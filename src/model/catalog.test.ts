/** ModelSwitcher 钉（/model 多源多模型单点）：转发外壳身份面（provider/label 随内芯）、
 *  切换/复位/未知 id 幂等、chat/chatStream 转发与流式回落、resolvedEffort 透传、每模型窗口透传 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelSwitcher, choiceAdapterConfig } from './catalog';
import { ScriptedAdapter, StubAdapter, OpenAIAdapter } from './adapter';
import type { ModelAdapter } from './adapter';
import type { ModelChoice } from '../config/providers';

const CHOICES: ModelChoice[] = [
  { id: 'deepseek/deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_DEEPSEEK' },
  { id: 'bigmodel/glm-4.7', provider: 'bigmodel', model: 'glm-4.7', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'SUNSHINEX_API_KEY_BIGMODEL' },
];

test('缺省态：provider/label 透传主适配器，currentId undefined，choices 原样可读', () => {
  const def = new ScriptedAdapter(['{"done":true,"reply":"r"}']);
  const sw = new ModelSwitcher({ choices: CHOICES, default: def, explicitDefault: true });
  assert.equal(sw.currentId(), undefined);
  assert.equal(sw.provider, 'scripted', 'provider 透传主适配器');
  assert.equal(sw.label, 'scripted', 'label 回退 provider（内芯无标签时，与单模型形态一致）');
  assert.deepEqual(sw.choices(), CHOICES);
  assert.equal(sw.hasExplicitDefault(), true);
});

test('切换与复位：switchTo 换内芯（label = 源/模型 id）；undefined 回缺省；未知 id 幂等 false 不动现状', () => {
  const sw = new ModelSwitcher({ choices: CHOICES, default: new StubAdapter() });
  assert.equal(sw.switchTo('deepseek/deepseek-chat'), true);
  assert.equal(sw.currentId(), 'deepseek/deepseek-chat');
  assert.equal(sw.label, 'deepseek/deepseek-chat', '选择在场 label 为 源/模型 id');
  assert.equal(sw.provider, 'openai', '内芯换为 OpenAI 协议适配器');
  assert.equal(sw.switchTo('nope/nope'), false, '未知 id 幂等 false');
  assert.equal(sw.currentId(), 'deepseek/deepseek-chat', '失败切换不动现状');
  assert.equal(sw.switchTo(undefined), true);
  assert.equal(sw.currentId(), undefined);
  assert.equal(sw.provider, 'stub', '复位回缺省主适配器');
});

test('chat/chatStream 转发：走当前内芯；内芯无流式实现时回落非流式 chat', async () => {
  // ScriptedAdapter 实现了 chatStream——先钉直转；再用仅 chat 的桩钉回落
  const scripted = new ScriptedAdapter(['{"done":true,"reply":"from-scripted"}']);
  const sw = new ModelSwitcher({ choices: [], default: scripted });
  const r = await sw.chat({ messages: [] });
  assert.equal(r.content, 'from-scripted');
  let streamed = '';
  const r2 = await sw.chatStream({ messages: [] }, (t) => { streamed += t; });
  assert.equal(r2.content, 'from-scripted');
  assert.equal(streamed, 'from-scripted', 'chatStream 直转内芯流式');

  const chatOnly = {
    provider: 'chat-only',
    label: 'chat-only',
    chat: async () => ({ finish: 'stop' as const, content: 'plain', toolCalls: [] }),
  };
  const sw2 = new ModelSwitcher({ choices: [], default: chatOnly });
  const r3 = await sw2.chatStream({ messages: [] }, () => { throw new Error('不可达：回落路径不走 onDelta 前置断言'); });
  assert.equal(r3.content, 'plain', '内芯无 chatStream 时回落非流式 chat');
});

test('resolvedEffort 透传：内芯未实现回 undefined（调用方回退请求档，与直连内芯同语义）', () => {
  const sw = new ModelSwitcher({ choices: [], default: new StubAdapter() });
  assert.equal(sw.resolvedEffort('high'), undefined);
});

test('每模型窗口：choice.contextWindow 进内芯 cfg（cfg > env）；switcher.contextWindow 随当前内芯走', () => {
  const prev = process.env.SUNSHINEX_CONTEXT_WINDOW;
  try {
    delete process.env.SUNSHINEX_CONTEXT_WINDOW;
    // OpenAIAdapter 解析钉：cfg > env > 未声明
    assert.equal(new OpenAIAdapter({ provider: 'openai', model: 'm', contextWindow: 128000 }).contextWindow, 128000, 'cfg 窗口直达');
    assert.equal(new OpenAIAdapter({ provider: 'openai', model: 'm' }).contextWindow, undefined, '未声明且 env 未配置 = undefined');
    process.env.SUNSHINEX_CONTEXT_WINDOW = '1000000';
    assert.equal(new OpenAIAdapter({ provider: 'openai', model: 'm' }).contextWindow, 1_000_000, '未声明回退 env');
    assert.equal(new OpenAIAdapter({ provider: 'openai', model: 'm', contextWindow: 128000 }).contextWindow, 128000, 'cfg 优先于 env');

    // switcher 透传钉：选择在场随内芯、未选透传缺省内芯
    const withWindow: ModelChoice = { id: 'x/m1', provider: 'x', model: 'm1', baseUrl: 'https://x/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_X', contextWindow: 64000 };
    const windowless: ModelChoice = { id: 'x/m2', provider: 'x', model: 'm2', baseUrl: 'https://x/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_X' };
    const sw = new ModelSwitcher({ choices: [withWindow, windowless], default: new ScriptedAdapter([]) });
    assert.equal(sw.contextWindow, undefined, '未选 = 缺省内芯（无窗口声明）');
    sw.switchTo('x/m1');
    assert.equal(sw.contextWindow, 64000, '每模型窗口随内芯');
    sw.switchTo('x/m2');
    assert.equal(sw.contextWindow, 1_000_000, '无窗口声明回退 env（OpenAIAdapter 构造期兜底）');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_CONTEXT_WINDOW;
    else process.env.SUNSHINEX_CONTEXT_WINDOW = prev;
  }
});

test('切换后调用走新内芯（持有者引用不变即生效——外壳转发语义的本证）', async () => {
  // 假内芯注入（protected 工厂覆写）：每个 choice 一个只答自身名字的脚本适配器，免真实网络
  const fakes = new Map<string, ScriptedAdapter>();
  class FakeSwitcher extends ModelSwitcher {
    protected buildAdapter(choice: ModelChoice): ModelAdapter {
      const a = new ScriptedAdapter([`{"done":true,"reply":"via-${choice.id}"}`]);
      fakes.set(choice.id, a);
      return a;
    }
  }
  const sw = new FakeSwitcher({ choices: CHOICES, default: new ScriptedAdapter(['{"done":true,"reply":"via-default"}']) });
  const holderRef = sw; // 持有者（reactor/子代理/压缩）拿到的就是外壳引用，切换后不换引用
  assert.equal((await holderRef.chat({ messages: [] })).content, 'via-default');
  assert.equal(sw.switchTo('bigmodel/glm-4.7'), true);
  assert.equal((await holderRef.chat({ messages: [] })).content, 'via-bigmodel/glm-4.7', '同一引用换内芯即换答复');
  assert.equal(sw.switchTo('deepseek/deepseek-chat'), true);
  assert.equal((await holderRef.chat({ messages: [] })).content, 'via-deepseek/deepseek-chat');
  sw.switchTo(undefined);
  assert.equal((await holderRef.chat({ messages: [] })).content, 'via-default', '复位回缺省内芯');
});

test('choiceAdapterConfig：缺省思考强度两级（条目 reasoningEffort > 装配级全局缺省）+ 窗口/密钥槽同源', () => {
  const base = { id: 'x/m', provider: 'x', model: 'm', baseUrl: 'https://x/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_X' } as const;
  assert.deepEqual(
    choiceAdapterConfig({ ...base, reasoningEffort: 'low' }, { reasoningEffort: 'high' }),
    { provider: 'openai', baseURL: 'https://x/v1', apiKey: undefined, model: 'm', reasoningEffort: 'low' },
    '条目级强度压装配级缺省',
  );
  assert.deepEqual(
    choiceAdapterConfig({ ...base }, { reasoningEffort: 'high' }),
    { provider: 'openai', baseURL: 'https://x/v1', apiKey: undefined, model: 'm', reasoningEffort: 'high' },
    '无条目级强度回装配级缺省（--effort/env 全局）',
  );
  assert.deepEqual(
    choiceAdapterConfig({ ...base }, {}),
    { provider: 'openai', baseURL: 'https://x/v1', apiKey: undefined, model: 'm' },
    '两级均未配置 = cfg 零穿参（适配器构造期回退 SUNSHINEX_REASONING_EFFORT）',
  );
  assert.equal(choiceAdapterConfig({ ...base, contextWindow: 128000 }, {}).contextWindow, 128000, '窗口透传');
});

// ── D26 尾巴（2026-10-04）：/model 切换路径接超时旋钮（buildAdapter 装配期经 modelTimeoutMsEnv
//    解析后由此穿透；env 解析表值钉在 config/termination-config.test.ts）──
test('choiceAdapterConfig 旋钮穿透钉：defs.timeoutMs 落 LLMConfig.timeoutMs（/model 各源内芯吃到 SUNSHINEX_MODEL_TIMEOUT_MS）', () => {
  const base = { id: 'x/m', provider: 'x', model: 'm', baseUrl: 'https://x/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_X' } as const;
  assert.equal(choiceAdapterConfig({ ...base }, { timeoutMs: 1500 }).timeoutMs, 1500, '装配级旋钮穿透进 cfg');
  assert.equal(choiceAdapterConfig({ ...base }, {}).timeoutMs, undefined, '未设旋钮不落字段（适配器回内建 600s）');
});
