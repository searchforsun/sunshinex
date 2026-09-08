import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, OpenAIAdapter, StubAdapter } from './adapter';

test('route：无提示按 medium 兜底并留痕', () => {
  const r = new ModelRouter().bindDefault(new StubAdapter());
  const d = r.route();
  assert.equal(d.tier, 'medium');
  assert.match(d.reason, /default:medium/);
  assert.equal(d.adapterProvider, 'stub');
  assert.equal(d.bound, false);
});

test('route：复杂度映射 low→small / mid→medium / high→large', () => {
  const r = new ModelRouter().bindDefault(new StubAdapter());
  assert.equal(r.route({ complexity: 'low' }).tier, 'small');
  assert.equal(r.route({ complexity: 'mid' }).tier, 'medium');
  assert.equal(r.route({ complexity: 'high' }).tier, 'large');
  assert.match(r.route({ complexity: 'low' }).reason, /complexity:low/);
});

test('route：角色显式指定优先于复杂度', () => {
  const r = new ModelRouter().bindDefault(new StubAdapter());
  const d = r.route({ role: 'critic', complexity: 'low' });
  assert.equal(d.tier, 'large');
  assert.match(d.reason, /role:critic/);
});

test('route：显式绑定档 bound=true 且 provider 留痕', () => {
  const r = new ModelRouter().bindDefault(new StubAdapter());
  r.bind('large', new OpenAIAdapter({ provider: 'openai', apiKey: 'k' }));
  const d = r.route({ complexity: 'high' });
  assert.equal(d.bound, true);
  assert.equal(d.adapterProvider, 'openai');
});

test('route：未绑定档回退默认并留痕 fallback', () => {
  const r = new ModelRouter().bindDefault(new StubAdapter());
  const d = r.route({ complexity: 'low' });
  assert.equal(d.tier, 'small');
  assert.equal(d.bound, false);
  assert.match(d.reason, /fallback:default/);
});

test('resolve：绑定默认后未绑定档回退（既有语义不回归）', () => {
  const stub = new StubAdapter();
  const r = new ModelRouter().bindDefault(stub);
  assert.equal(r.resolve('small'), stub);
});
