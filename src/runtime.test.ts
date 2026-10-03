import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { buildModel, buildTierRouter, modelTimeoutMsEnv, parseTier } from './runtime';

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
    assert.equal(router.resolve('large').label, 'gpt-large-x');
    const defLabel = buildModel({}).label;
    assert.equal(router.resolve('small').label, defLabel, '未配置档回退默认承载（同配置标签）');
    assert.equal(router.resolve('medium').label, defLabel);
  });
});

// ── J9b：LLMConfig.timeoutMs 死旋钮接线 SUNSHINEX_MODEL_TIMEOUT_MS ──
// 表值钉已随函数迁 config/termination-config.test.ts（2026-10-04 归口迁移）；此处保 re-export
// 委托钉——runtime 对外 API 面不破，误删转发即红
test('modelTimeoutMsEnv re-export 委托：runtime 对外面取到归口实现（termination-config 单点）', () => {
  assert.equal(modelTimeoutMsEnv({ SUNSHINEX_MODEL_TIMEOUT_MS: '30000' }), 30000);
  assert.equal(modelTimeoutMsEnv({ SUNSHINEX_MODEL_TIMEOUT_MS: 'abc' }), undefined);
});

test('buildModel 接线：SUNSHINEX_MODEL_TIMEOUT_MS 生效（挂起端点按 env 超时报错，非内建 600s）', async () => {
  const KEYS = ['SUNSHINEX_MODEL_TIMEOUT_MS', 'SUNSHINEX_API_KEY', 'SUNSHINEX_BASE_URL'] as const;
  const prev = KEYS.map((k) => [k, process.env[k]] as const);
  const srv = http.createServer((_req, _res) => {
    // 挂起不响应，触发客户端超时（adapter.test.ts 超时钉同款形态）
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    process.env.SUNSHINEX_MODEL_TIMEOUT_MS = '200';
    process.env.SUNSHINEX_API_KEY = 'k';
    process.env.SUNSHINEX_BASE_URL = `http://127.0.0.1:${port}/v1`;
    const a = buildModel({});
    await assert.rejects(() => a.chat({ messages: [{ role: 'user', content: 'hi' }] }), /Model call timed out/);
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    srv.close();
  }
});

// ── D27 收敛形态钉（guards.test.ts「唯一实现」同款源码形态断言先例）──
// 行为零变化的重构只能靠形态钉锁结构：交互面的 Harness 构造必须单点化——
// kb 即前车之鉴（双轨期 TUI 侧漏接 kb 为首个症状），双轨任何形式复发即红
test('共享装配单点（D27 形态钉）：runtime.ts 恰一处 Harness 构造（buildHarness 内），tui/runtime.ts 零直接构造/零 kb 自解析', () => {
  // 测试恒经 dist 执行（run-tests.js），源码定位沿用 guards.test.ts 先例：dist 相对回仓根再进 src
  const runtimeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime.ts'), 'utf8');
  const tuiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'tui', 'runtime.ts'), 'utf8');
  assert.equal(
    (runtimeSrc.match(/new Harness\(/g) ?? []).length,
    1,
    'runtime.ts 应恰有一处 Harness 构造（buildHarness 共享单点内；buildDeps 等调用方必须经它）',
  );
  assert.ok(!tuiSrc.includes('new Harness('), 'tui/runtime.ts 不得绕过共享装配单点直接构造 Harness（D27 双轨复发）');
  assert.ok(!tuiSrc.includes('resolveKnowledgeBase('), 'tui/runtime.ts 不得自行解析 kb（kb 调用点已归一 buildHarness，复发即两处漂移）');
  assert.ok(tuiSrc.includes('buildHarness('), 'tui/runtime.ts 应经共享装配单点取 Harness');
});
