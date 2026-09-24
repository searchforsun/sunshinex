import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveInvocation, assertValidFlagValues } from './index';

test('flag 值校验：合法值四键全过、不抛', () => {
  assert.doesNotThrow(() => assertValidFlagValues(resolveInvocation(parseArgs(['--mode=dontAsk', '--language=zh', '--tier=large', '--effort=high']))));
  assert.doesNotThrow(() => assertValidFlagValues(parseArgs([])));
  assert.doesNotThrow(() => assertValidFlagValues(parseArgs(['--effort=MAX']))); // effort 大小写不敏感（沿 parseEffort 口径）
});

test('flag 值校验：非法值 fail-fast 报错退出（含原值与 help 指引）', () => {
  for (const argv of [
    ['--mode=dontask'], // 小写静默回落 manual 的历史坑点
    ['--mode=auto'],
    ['--language=cn'],
    ['--tier=big'],
    ['--effort=ultra'],
  ]) {
    assert.throws(
      () => assertValidFlagValues(parseArgs(argv)),
      (e: Error) => /Invalid flag value/.test(e.message) && /sunshinex help/.test(e.message),
      `${argv.join(' ')} 应 fail-fast`,
    );
  }
});

test('flag 值校验：非法值一次报全（多个非法同轮列出）', () => {
  assert.throws(
    () => assertValidFlagValues(parseArgs(['--mode=x', '--tier=y'])),
    (e: Error) => /--mode=x.*--tier=y/.test(e.message),
  );
});
