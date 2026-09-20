import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactorMaxStepsEnv, loopIterationsEnv, graphNodesEnv } from './termination-config';

test('未设/空串回 undefined，消费点取内置缺省', () => {
  assert.equal(reactorMaxStepsEnv({}), undefined);
  assert.equal(reactorMaxStepsEnv({ SUNSHINEX_MAX_STEPS: '  ' }), undefined);
  assert.equal(loopIterationsEnv({}), undefined);
  assert.equal(graphNodesEnv({}), undefined);
});

test('合法正整数生效', () => {
  assert.equal(reactorMaxStepsEnv({ SUNSHINEX_MAX_STEPS: '120' }), 120);
  assert.equal(loopIterationsEnv({ SUNSHINEX_MAX_LOOP_ITERATIONS: '300' }), 300);
  assert.equal(graphNodesEnv({ SUNSHINEX_MAX_GRAPH_NODES: '2500' }), 2500);
});

test('零/负/小数/非法文本 fail-fast 抛错且 message 带槽名', () => {
  for (const bad of ['0', '-1', '2.5', 'abc']) {
    assert.throws(() => reactorMaxStepsEnv({ SUNSHINEX_MAX_STEPS: bad }), /SUNSHINEX_MAX_STEPS/);
  }
  assert.throws(
    () => loopIterationsEnv({ SUNSHINEX_MAX_LOOP_ITERATIONS: 'x' }),
    /SUNSHINEX_MAX_LOOP_ITERATIONS/,
  );
  assert.throws(
    () => graphNodesEnv({ SUNSHINEX_MAX_GRAPH_NODES: '0' }),
    /SUNSHINEX_MAX_GRAPH_NODES/,
  );
});
