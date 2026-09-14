import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, buildTierRouter, parseTier } from './runtime';

const TIER_ENV_KEYS = ['SUNSHINEX_MODEL_SMALL', 'SUNSHINEX_MODEL_MEDIUM', 'SUNSHINEX_MODEL_LARGE'] as const;

function withTierEnv(fn: () => void): void {
  const prev = TIER_ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const [k] of prev) delete process.env[k];
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('parseTier：仅 small|medium|large 生效，其余与缺省一律 undefined', () => {
  assert.equal(parseTier('small'), 'small');
  assert.equal(parseTier('medium'), 'medium');
  assert.equal(parseTier('large'), 'large');
  assert.equal(parseTier('huge'), undefined);
  assert.equal(parseTier(true), undefined);
  assert.equal(parseTier(undefined), undefined);
});

test('buildTierRouter：未配置按档模型返回 undefined（单模型装配零新概念）', () => {
  withTierEnv(() => {
    assert.equal(buildTierRouter({}), undefined);
  });
});

test('buildTierRouter：按档绑定 + 缺省兜底，显式档解析到绑定模型', () => {
  withTierEnv(() => {
    process.env.SUNSHINEX_MODEL_LARGE = 'gpt-large-x';
    const router = buildTierRouter({});
    assert.ok(router, '配置任一按档模型即启用 router');
    assert.deepEqual(router.boundTiers(), ['large']);
    assert.equal(router.resolve('large').label, 'openai · gpt-large-x');
    const defLabel = buildModel({}).label;
    assert.equal(router.resolve('small').label, defLabel, '未配置档回退默认承载（同配置标签）');
    assert.equal(router.resolve('medium').label, defLabel);
  });
});
