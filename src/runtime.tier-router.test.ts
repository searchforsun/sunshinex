/** 档位路由改造钉（2026-10-28 spec §15 散键退役）：tier 路由唯一事实源 = providers choices 的
 *  tier 标注——SUNSHINEX_MODEL_SMALL/MEDIUM/LARGE env 三键路径退役（buildTierRouter 删除），
 *  buildTierRouterFromChoices(choices, flags) 按标注绑档；无标注/无匹配档回缺省 choices[0]；
 *  choices 空 → undefined（调用方退单模型装配沿现状）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTierRouterFromChoices } from './runtime';
import type { ModelChoice } from './config/providers';

function choice(id: string, model: string, tier?: 'small' | 'medium' | 'large'): ModelChoice {
  return {
    id,
    provider: 'p',
    model,
    baseUrl: 'https://p.example/v1',
    apiKeyEnv: 'SUNSHINEX_API_KEY_P',
    ...(tier !== undefined ? { tier } : {}),
  };
}

test('buildTierRouterFromChoices：tier 标注命中绑定档，未标注档回缺省 choices[0] 适配器', () => {
  const router = buildTierRouterFromChoices(
    [choice('p/a', 'model-a', 'small'), choice('p/b', 'model-b')],
    {},
  );
  assert.ok(router, 'choices 非空恒出 router（缺省恒 choices[0]，不再依赖 env 显式配置）');
  assert.deepEqual(router!.boundTiers(), ['small'], '仅标注档入绑定表');
  assert.equal(router!.resolve('small').label, 'model-a', 'small 命中标注 choice');
  assert.equal(router!.resolve('large').label, 'model-a', 'large 未绑定 → 回缺省绑定 choices[0]');
  assert.equal(router!.resolve('medium').label, 'model-a', 'medium 未绑定 → 同回 choices[0]');
});

test('buildTierRouterFromChoices：同档多个取第一个（choices 序 = providers 序 × models 序即默认序）', () => {
  const router = buildTierRouterFromChoices(
    [choice('p/m1', 'm-one', 'medium'), choice('p/m2', 'm-two', 'medium'), choice('p/m3', 'm-three', 'medium')],
    {},
  );
  assert.ok(router);
  assert.equal(router!.resolve('medium').label, 'm-one', '同档取首个标注条目');
  assert.deepEqual(router!.boundTiers(), ['medium']);
});

test('buildTierRouterFromChoices：choices 空 → undefined（调用方退单模型装配，单模型用户零新概念）', () => {
  assert.equal(buildTierRouterFromChoices([], {}), undefined);
});
