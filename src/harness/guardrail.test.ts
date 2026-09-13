import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardrailStop } from './guardrail';

/** 最小输入：三个上限都不给＝不设限 */
const base = { now: 1_000, tokensUsed: 0, iteration: 0 };

test('guardrailStop：不设限时不干预', () => {
  assert.equal(guardrailStop({ ...base }), null);
});

test('guardrailStop：时间优先——三者同时越限报 deadline', () => {
  assert.equal(
    guardrailStop({
      now: 5_000,
      deadlineAt: 5_000,
      tokensUsed: 100,
      tokenCap: 100,
      iteration: 9,
      maxIterations: 3,
    }),
    'deadline',
  );
});

test('guardrailStop：预算次之——预算与步数同时越限报 budget', () => {
  assert.equal(
    guardrailStop({ now: 1_000, tokensUsed: 10, tokenCap: 10, iteration: 4, maxIterations: 4 }),
    'budget',
  );
});

test('guardrailStop：各维度一律按 >= 判定（与两引擎既有比较语义一致）', () => {
  assert.equal(guardrailStop({ now: 999, deadlineAt: 1_000, tokensUsed: 0, iteration: 0 }), null);
  assert.equal(guardrailStop({ now: 1_000, deadlineAt: 1_000, tokensUsed: 0, iteration: 0 }), 'deadline');
  assert.equal(guardrailStop({ now: 0, tokensUsed: 0, tokenCap: 0, iteration: 0 }), 'budget');
  assert.equal(guardrailStop({ now: 0, tokensUsed: 0, iteration: 200, maxIterations: 200 }), 'max-steps');
});
