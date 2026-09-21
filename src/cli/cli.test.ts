import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveInvocation, resolveDirArg, isPathForm } from './index';

test('parseArgs：无参数回退空命令（裸命令 sunshinex 由 resolveInvocation 归一为 tui）', () => {
  assert.equal(parseArgs([]).command, '');
});

test('parseArgs：裸命令带 flag 直进 TUI（sunshinex --mode=manual 形态）', () => {
  const a = resolveInvocation(parseArgs(['--mode=manual']));
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
  const a = parseArgs(['run', 'tests/fixtures/demo', '--goal', 'g', '--mode', 'dontAsk']);
  assert.equal(a.command, 'run');
  assert.deepEqual(a.positional, ['tests/fixtures/demo']);
  assert.equal(a.flags.goal, 'g');
  assert.equal(a.flags.mode, 'dontAsk');
});

test('resolveInvocation：裸命令归一为 tui（当前工作区）', () => {
  const a = resolveInvocation(parseArgs([]));
  assert.equal(a.command, 'tui');
  assert.deepEqual(a.positional, []);
});

test('resolveInvocation：路径形态位置参数归一为 tui 指定目录', () => {
  for (const dir of ['/abs/proj', '../my-project', './x', '.', 'a/b', 'D:\\work\\p']) {
    const a = resolveInvocation(parseArgs([dir]));
    assert.equal(a.command, 'tui');
    assert.deepEqual(a.positional, [dir]);
  }
});

test('resolveInvocation：裸词不识别（含 tui 首词形态）', () => {
  for (const word of ['foo', 'my-project', 'tui']) {
    assert.equal(resolveInvocation(parseArgs([word])).command, 'unrecognized');
  }
});

test('resolveInvocation：已知子命令透传、flag 直通', () => {
  assert.equal(resolveInvocation(parseArgs(['selfcheck'])).command, 'selfcheck');
  assert.equal(resolveInvocation(parseArgs(['help'])).command, 'help');
  const a = resolveInvocation(parseArgs(['../my-project', '--mode=plan']));
  assert.equal(a.command, 'tui');
  assert.deepEqual(a.positional, ['../my-project']);
  assert.equal(a.flags.mode, 'plan');
  assert.equal(resolveInvocation(parseArgs(['../my-project', '--language=zh'])).flags.language, 'zh');
});

test('isPathForm 判据：绝对/./..开头/含分隔符为真，裸词与点前缀文件名为假', () => {
  for (const p of ['/a/b', '../a', './a', '.', 'a/b', 'D:\\w', 'D:/w']) assert.ok(isPathForm(p));
  for (const p of ['proj', '', '.env', 'help']) assert.ok(!isPathForm(p));
});

test('resolveDirArg：--workdir 优先于位置路径并登记 ignored（run 子命令形态）', () => {
  const d = resolveDirArg(parseArgs(['run', '../a', '--workdir=/b']));
  assert.equal(d.dir, '/b');
  assert.equal(d.ignored, '../a');
});

test('resolveDirArg：仅 flag / 仅路径 / 皆缺 / 裸词四态；tui 归一形态组合', () => {
  assert.equal(resolveDirArg(parseArgs(['run', '--workdir=/b'])).dir, '/b');
  assert.equal(resolveDirArg(parseArgs(['run', '../a'])).dir, '../a');
  assert.equal(resolveDirArg(parseArgs(['run'])).dir, undefined);
  assert.equal(resolveDirArg(parseArgs(['run', 'proj'])).unrecognized, 'proj');
  // 顶层 tui 形态：resolveInvocation 已把路径形态首词归一回 positional
  assert.equal(resolveDirArg(resolveInvocation(parseArgs(['../a']))).dir, '../a');
});

test('parseArgs：裸 --continue 解析为 true 并随 tui 调用透传', () => {
  const args = parseArgs(['--continue']);
  assert.equal(args.flags['continue'], true);
  assert.equal(args.command, '');
  const inv = resolveInvocation(args);
  assert.equal(inv.command, 'tui');
  assert.equal(inv.flags['continue'], true);
});
