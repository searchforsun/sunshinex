import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IMAGE_HISTORY_LIMIT, resolveImageHistoryLimit } from './image-history';

/** imageHistoryLimit 结构化语义键解析钉（终审 Fix 2：spec §3.2 与 computer-use README 的 settings 键承诺落地）。
 *  settingsReader 注入整文档对象（null = 该级缺档）沿 loadEffectivePlugins 先例，测试免真写 HOME。 */

test('缺省：两级均未配置 → 缺省 3、零告警', () => {
  const r = resolveImageHistoryLimit(undefined, { settingsReader: () => null });
  assert.equal(r.value, DEFAULT_IMAGE_HISTORY_LIMIT);
  assert.equal(r.value, 3);
  assert.deepEqual(r.warnings, []);
});

test('合法值：全局生效；项目级合法值遮蔽全局（项目后读覆盖）；0 与 50 边界合法', () => {
  const globalOnly = resolveImageHistoryLimit('proj', {
    settingsReader: (scope) => (scope === 'global' ? { imageHistoryLimit: 5 } : null),
  });
  assert.equal(globalOnly.value, 5);
  assert.deepEqual(globalOnly.warnings, []);
  const projectWins = resolveImageHistoryLimit('proj', {
    settingsReader: (scope) => (scope === 'global' ? { imageHistoryLimit: 5 } : { imageHistoryLimit: 10 }),
  });
  assert.equal(projectWins.value, 10, '项目遮蔽全局（与 plugins 语义键同裁定）');
  const zero = resolveImageHistoryLimit(undefined, { settingsReader: () => ({ imageHistoryLimit: 0 }) });
  assert.equal(zero.value, 0, '0 = 全部剥图，边界合法');
  const fifty = resolveImageHistoryLimit(undefined, { settingsReader: () => ({ imageHistoryLimit: 50 }) });
  assert.equal(fifty.value, 50);
});

test('非法值（越界/非整数/类型不符）→ 告警点名 + 回缺省 3，不 fail-fast', () => {
  for (const bad of [51, -1, 2.5, '5', true, {}]) {
    const r = resolveImageHistoryLimit(undefined, { settingsReader: () => ({ imageHistoryLimit: bad }) });
    assert.equal(r.value, DEFAULT_IMAGE_HISTORY_LIMIT, `非法值 ${JSON.stringify(bad)} 回缺省`);
    assert.ok(r.warnings.some((w) => w.includes('imageHistoryLimit') && w.includes('0-50')), `非法值 ${JSON.stringify(bad)} 告警点名`);
  }
});

test('项目非法 + 全局合法：非法级告警忽略，回落全局合法值（不直接掉缺省）', () => {
  const r = resolveImageHistoryLimit('proj', {
    settingsReader: (scope) => (scope === 'global' ? { imageHistoryLimit: 7 } : { imageHistoryLimit: 99 }),
  });
  assert.equal(r.value, 7, '非法级跳过 → 保留前级合法值');
  assert.ok(r.warnings.some((w) => w.includes('project') && w.includes('imageHistoryLimit')));
});
