import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configureWindowsTerminal, shiftEnterBinding, altEnterUnbind, wtSettingsCandidates } from './terminal-setup';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tsetup-'));

test('configureWindowsTerminal：actions 数组补双键位（Shift+Enter 绑定 + Alt+Enter 解绑）、幂等、写前备份', () => {
  const dir = tmp();
  try {
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({ actions: [{ command: 'copy', keys: 'ctrl+c' }] }));
    const r1 = configureWindowsTerminal(p);
    assert.equal(r1.ok, true);
    assert.equal(r1.changed, true);
    assert.ok(r1.backup !== undefined && fs.existsSync(r1.backup), '写前备份存在');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const acts = cfg.actions as Array<Record<string, unknown>>;
    assert.ok(acts.some((e) => JSON.stringify(e) === JSON.stringify(shiftEnterBinding())), 'Shift+Enter sendInput 绑定在');
    assert.ok(acts.some((e) => JSON.stringify(e) === JSON.stringify(altEnterUnbind())), 'Alt+Enter 解绑在');
    assert.ok(acts.some((e) => e['command'] === 'copy'), '原有键位保留');
    const bound = acts.find((e) => e['keys'] === 'shift+enter') as { command: { input: string } };
    assert.equal(bound.command.input, '\u001b\r', 'input 为真实 ESC+CR 字节');
    const r2 = configureWindowsTerminal(p);
    assert.equal(r2.changed, false, '二次执行幂等跳过');
    assert.equal((JSON.parse(fs.readFileSync(p, 'utf-8')) as { actions: unknown[] }).actions.length, acts.length, '幂等不重复追加');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configureWindowsTerminal：无 actions 键创建之；legacy keybindings 数组原地扩展', () => {
  const dir = tmp();
  try {
    const p1 = path.join(dir, 'a.json');
    fs.writeFileSync(p1, '{"colorScheme":"One Half"}');
    const r1 = configureWindowsTerminal(p1);
    assert.equal(r1.changed, true);
    const cfg1 = JSON.parse(fs.readFileSync(p1, 'utf-8')) as { actions: unknown[] };
    assert.equal(cfg1.actions.length, 2, '缺 actions 键时新建数组并写入双键位');
    const p2 = path.join(dir, 'b.json');
    fs.writeFileSync(p2, '{"keybindings":[{"command":"closePane","keys":"ctrl+shift+w"}]}');
    const r2 = configureWindowsTerminal(p2);
    assert.equal(r2.changed, true);
    const cfg2 = JSON.parse(fs.readFileSync(p2, 'utf-8')) as { keybindings: unknown[] };
    assert.equal(cfg2.keybindings.length, 3, 'legacy keybindings 数组原地扩展（不新建 actions）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configureWindowsTerminal：JSONC 行注释宽松解析；重度损坏不动盘报手动指引', () => {
  const dir = tmp();
  try {
    const p1 = path.join(dir, 'c.json');
    fs.writeFileSync(p1, '{\n// 全局配色\n"actions": []\n}');
    const r1 = configureWindowsTerminal(p1);
    assert.equal(r1.ok, true, '行注释剥除后解析成功');
    assert.equal(r1.changed, true);
    const p2 = path.join(dir, 'd.json');
    fs.writeFileSync(p2, '{ actions: /* 块注释未闭合');
    const r2 = configureWindowsTerminal(p2);
    assert.equal(r2.ok, false);
    assert.equal(r2.changed, false, '解析失败不动盘');
    assert.ok(r2.message.includes('sendInput'), '失败信息带手动键位指引');
    assert.equal(fs.readFileSync(p2, 'utf-8'), '{ actions: /* 块注释未闭合', '原文件未被半改写');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wtSettingsCandidates：商店版/Preview/非打包三候选；空串=无 LOCALAPPDATA 返回空（undefined 回退环境）', () => {
  const cands = wtSettingsCandidates('C:/Users/x/AppData/Local');
  assert.equal(cands.length, 3);
  assert.ok(cands[0]!.includes('Microsoft.WindowsTerminal_8wekyb3d8bbwe'));
  assert.ok(cands[2]!.includes('Microsoft') && cands[2]!.endsWith('settings.json'));
  assert.deepEqual(wtSettingsCandidates(''), []);
  assert.equal(wtSettingsCandidates(undefined).length, 3, 'undefined 回退 process.env.LOCALAPPDATA');
});
