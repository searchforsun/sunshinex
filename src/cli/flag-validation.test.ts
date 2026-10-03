import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveInvocation, assertValidFlagValues, usageText } from './index';
import { setLanguage, parseLanguage } from '../i18n';

test('flag 值校验：合法值四键全过、不抛', () => {
  assert.doesNotThrow(() => assertValidFlagValues(resolveInvocation(parseArgs(['--mode=dontAsk', '--language=zh', '--tier=large', '--effort=high']))));
  assert.doesNotThrow(() => assertValidFlagValues(parseArgs([])));
  assert.doesNotThrow(() => assertValidFlagValues(parseArgs(['--effort=MAX']))); // effort 大小写不敏感（沿 parseEffort 口径）
  assert.doesNotThrow(() => assertValidFlagValues(parseArgs(['--model=scripted', '--model=openai', '--model=stub']))); // J9a：--model 三白名单
});

test('flag 值校验：非法值 fail-fast 报错退出（含原值与 help 指引）', () => {
  for (const argv of [
    ['--mode=dontask'], // 小写静默回落 manual 的历史坑点
    ['--mode=auto'],
    ['--language=cn'],
    ['--model=typo'], // J9a：此前静默按 openai 装配，违背本函数 fail-fast 纪律
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

test('usageText 双语 flags 清单含 --model 白名单行（J9a：有实现无文档的旗标补列）', () => {
  assert.match(usageText(), /--model=openai\|scripted\|stub\s+model backend \(default openai\)/);
});

test('usageText --worktree 行覆盖 run 入口（D26 尾巴：run-loop 已接线 resolveWorktreeLaunchRoot，文档面同步）', () => {
  const prev = process.env.SUNSHINEX_LANGUAGE;
  try {
    setLanguage(parseLanguage('en'));
    assert.match(usageText(), /--worktree\[=<name>\]\s+TUI or run, launch in an isolated git worktree/);
    setLanguage(parseLanguage('zh'));
    assert.match(usageText(), /--worktree\[=<name>\]\s+TUI 或 run，在隔离 git worktree 中启动/);
  } finally {
    setLanguage(parseLanguage(prev ?? 'en'));
  }
});

test('flag 值校验：非法值一次报全（多个非法同轮列出）', () => {
  assert.throws(
    () => assertValidFlagValues(parseArgs(['--mode=x', '--tier=y'])),
    (e: Error) => /--mode=x.*--tier=y/.test(e.message),
  );
});
