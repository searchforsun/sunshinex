import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveInvocation } from './index';

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

test('resolveInvocation：sunshinex [dir] 目录直进终端，归一为 tui（对标 claude <dir>）', () => {
  const a = resolveInvocation(parseArgs(['../my-project']));
  assert.equal(a.command, 'tui');
  assert.deepEqual(a.positional, ['../my-project']);
});

test('resolveInvocation：目录与权限模式混排（sunshinex ../my-project --mode=plan 形态）', () => {
  const a = resolveInvocation(parseArgs(['../my-project', '--mode=plan']));
  assert.equal(a.command, 'tui');
  assert.deepEqual(a.positional, ['../my-project']);
  assert.equal(a.flags.mode, 'plan');
});

test('resolveInvocation：已知子命令原样透传（tui/run/selfcheck/help 不受影响）', () => {
  assert.equal(resolveInvocation(parseArgs(['tui', '../my-project'])).command, 'tui');
  assert.deepEqual(resolveInvocation(parseArgs(['tui', '../my-project'])).positional, ['../my-project']);
  assert.equal(resolveInvocation(parseArgs(['run', 'demo'])).command, 'run');
  assert.equal(resolveInvocation(parseArgs(['selfcheck'])).command, 'selfcheck');
  assert.equal(resolveInvocation(parseArgs(['help'])).command, 'help');
});

test('resolveInvocation：--language 直通 flags，不影响目录直进语义', () => {
  const a = resolveInvocation(parseArgs(['../my-project', '--language=zh']));
  assert.equal(a.command, 'tui');
  assert.deepEqual(a.positional, ['../my-project']);
  assert.equal(a.flags.language, 'zh');
});

test('parseArgs：裸 --continue 解析为 true 并随 tui 调用透传', () => {
  const args = parseArgs(['--continue']);
  assert.equal(args.flags['continue'], true);
  assert.equal(args.command, 'tui');
  const inv = resolveInvocation(args);
  assert.equal(inv.command, 'tui');
  assert.equal(inv.flags['continue'], true);
});
