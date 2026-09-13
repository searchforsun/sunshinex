import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './index';

test('parseArgs：无参数回退 tui（裸命令 sunshinex 直接进终端，对标 claude）', () => {
  assert.equal(parseArgs([]).command, 'tui');
});

test('parseArgs：裸命令带 flag 直进 TUI（sunshinex --mode=manual 形态）', () => {
  const a = parseArgs(['--mode=manual']);
  assert.equal(a.command, 'tui');
  assert.equal(a.flags.mode, 'manual');
  assert.deepEqual(a.positional, []);
});

test('parseArgs：显式 help 子命令保持 help（打印 USAGE，不进 TUI）', () => {
  assert.equal(parseArgs(['help']).command, 'help');
});

test('parseArgs：--help 交由 main 拦截打印 USAGE', () => {
  assert.equal(parseArgs(['--help']).flags.help, true);
});

test('parseArgs：positional 与布尔 flag', () => {
  const a = parseArgs(['selfcheck', '--json']);
  assert.equal(a.command, 'selfcheck');
  assert.equal(a.flags.json, true);
});

test('parseArgs：--flag=value 与裸 positional 混排', () => {
  const a = parseArgs(['run', 'tests/fixtures/demo', '--template', 'test-loop', '--mode', 'dontAsk']);
  assert.equal(a.command, 'run');
  assert.deepEqual(a.positional, ['tests/fixtures/demo']);
  assert.equal(a.flags.template, 'test-loop');
  assert.equal(a.flags.mode, 'dontAsk');
});
