import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reactorMaxStepsEnv,
  loopIterationsEnv,
  graphNodesEnv,
  mainTokenCapEnv,
  subagentTokenCapEnv,
  contextWindowTokens,
  CONTEXT_WINDOW_DEFAULT,
  resolveRunWindow,
} from './termination-config';

test('未设/空串回 undefined，消费点取内置缺省', () => {
  assert.equal(reactorMaxStepsEnv({}), undefined);
  assert.equal(reactorMaxStepsEnv({ SUNSHINEX_MAX_STEPS: '  ' }), undefined);
  assert.equal(loopIterationsEnv({}), undefined);
  assert.equal(graphNodesEnv({}), undefined);
  assert.equal(mainTokenCapEnv({}), undefined);
  assert.equal(subagentTokenCapEnv({}), undefined);
});

test('合法正整数生效', () => {
  assert.equal(reactorMaxStepsEnv({ SUNSHINEX_MAX_STEPS: '120' }), 120);
  assert.equal(loopIterationsEnv({ SUNSHINEX_MAX_LOOP_ITERATIONS: '300' }), 300);
  assert.equal(graphNodesEnv({ SUNSHINEX_MAX_GRAPH_NODES: '2500' }), 2500);
  assert.equal(mainTokenCapEnv({ SUNSHINEX_MAX_TOKENS: '2000000' }), 2_000_000);
  assert.equal(subagentTokenCapEnv({ SUNSHINEX_SUBAGENT_TOKEN_CAP: '500000' }), 500_000);
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
  assert.throws(() => mainTokenCapEnv({ SUNSHINEX_MAX_TOKENS: '0' }), /SUNSHINEX_MAX_TOKENS/);
  assert.throws(
    () => subagentTokenCapEnv({ SUNSHINEX_SUBAGENT_TOKEN_CAP: '-5' }),
    /SUNSHINEX_SUBAGENT_TOKEN_CAP/,
  );
});

test('resolveRunWindow：当前模型窗口 > SUNSHINEX_CONTEXT_WINDOW > 200k 缺省（run 级窗口解析单点）', () => {
  const prev = process.env.SUNSHINEX_CONTEXT_WINDOW;
  try {
    delete process.env.SUNSHINEX_CONTEXT_WINDOW;
    assert.equal(contextWindowTokens(), CONTEXT_WINDOW_DEFAULT, 'env 未配置回 200k');
    assert.equal(resolveRunWindow(), CONTEXT_WINDOW_DEFAULT, '无适配器回 200k');
    assert.equal(resolveRunWindow({ contextWindow: 128000 }), 128000, '适配器窗口优先');
    assert.equal(resolveRunWindow({ contextWindow: -1 }), CONTEXT_WINDOW_DEFAULT, '非法窗口视同未配置（防御）');
    assert.equal(resolveRunWindow({ contextWindow: Number.NaN }), CONTEXT_WINDOW_DEFAULT, 'NaN 视同未配置');
    process.env.SUNSHINEX_CONTEXT_WINDOW = '1000000';
    assert.equal(resolveRunWindow(), 1_000_000, 'env 生效');
    assert.equal(resolveRunWindow({ contextWindow: 128000 }), 128000, '适配器窗口仍优先于 env');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_CONTEXT_WINDOW;
    else process.env.SUNSHINEX_CONTEXT_WINDOW = prev;
  }
});
