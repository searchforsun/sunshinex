import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installInkOutputGuard } from './ink-output-guard';

test('ink Output 护盾：画布宽异常（NaN/天文数字）钳制自愈不抛 RangeError（真机「Invalid string length」终修）', () => {
  installInkOutputGuard();
  const Output = (require('ink/build/output.js') as any).default;
  // NaN 宽：旧实现 repeat(NaN) 即 RangeError；护盾原位钳制 this.width=120
  const nan = new Output({ width: undefined as never, height: 5 });
  const out1 = nan.get();
  assert.equal(nan.width, 120, 'NaN 宽自愈降级 120 列');
  assert.ok(typeof out1.output === 'string');
  // 天文数字宽：旧实现 repeat(>512M) 即 Invalid string length；护盾钳制到 4000
  const huge = new Output({ width: 6e8, height: 5 });
  const out2 = huge.get();
  assert.equal(huge.width, 4000, '天文数字宽钳制 ≤4000');
  assert.ok(typeof out2.output === 'string');
  // 正常宽零劣化
  const ok = new Output({ width: 80, height: 5 });
  ok.write(0, 0, 'hello', { transformers: [] });
  assert.match(ok.get().output, /hello/, '正常宽零劣化');
});
