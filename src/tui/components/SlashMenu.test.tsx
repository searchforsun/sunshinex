import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App, buildSlashMenu } from './App';
import { SlashMenu, SlashMenuEntry, slashMenuWindow, SLASH_MENU_MAX_ROWS } from './SlashMenu';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';
import { readSkillUsage, recordSkillUsage } from '../skill-usage';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function settle(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/* ---------- 纯函数 ---------- */

test('buildSlashMenu：内置固定序在前 + 技能按最近使用降序（平局字典序），前缀动态过滤', () => {
  const skills = [
    { id: 'alpha', description: 'A' },
    { id: 'zeta', description: 'Z', lastUsedAt: 200 },
    { id: 'beta', description: 'B', lastUsedAt: 300 },
    { id: 'gamma', description: 'G', lastUsedAt: 300 },
  ];
  const all = buildSlashMenu('/', skills);
  assert.equal(all[0]!.cmd, '/help', '内置首项固定 /help');
  const skillCmds = all.filter((e) => e.kind === 'skill').map((e) => e.cmd);
  assert.deepEqual(skillCmds, ['/beta', '/gamma', '/zeta', '/alpha'], '最近使用在前（300 平局字典序），未使用殿后');
  // 前缀过滤：/he 命中内置 /help 与技能 /zeta（无）——只 /help
  assert.deepEqual(buildSlashMenu('/he', skills).map((e) => e.cmd), ['/help']);
  // 带参（含空格）一律不出现菜单
  assert.deepEqual(buildSlashMenu('/help me', skills), []);
  // 非 / 前缀空表
  assert.deepEqual(buildSlashMenu('xyz', skills), []);
  // 描述挂载：内置描述来自描述表
  assert.equal(buildSlashMenu('/help', []).length, 1);
  assert.equal(buildSlashMenu('/help', [])[0]!.description.length > 0, true, '内置描述非空');
});

test('slashMenuWindow：总量内全显；超量按光标分页平移，光标行恒在窗口', () => {
  assert.deepEqual(slashMenuWindow(5, 0, 20), { start: 0, count: 5 }, '总量不足一页全显');
  const p1 = slashMenuWindow(50, 5, 20);
  assert.deepEqual(p1, { start: 0, count: 20 }, '第一页');
  const p2 = slashMenuWindow(50, 20, 20);
  assert.deepEqual(p2, { start: 20, count: 20 }, '光标跨页窗口平移');
  const p3 = slashMenuWindow(50, 49, 20);
  assert.deepEqual(p3, { start: 40, count: 10 }, '末页部分窗口');
  assert.equal(SLASH_MENU_MAX_ROWS, 20, '上限 20（用户裁决）');
});

/* ---------- SlashMenu 渲染 ---------- */

test('SlashMenu：一行一命令、右侧描述、选中行 ❯ 指示；maxRows 截窗 + 溢出计数行', () => {
  const entries: SlashMenuEntry[] = [
    { cmd: '/help', description: 'show commands', kind: 'builtin' },
    { cmd: '/init', description: 'write SUNSHINE.md', kind: 'builtin' },
    { cmd: '/demo-skill', description: 'demo skill body', kind: 'skill' },
  ];
  const r1 = render(<SlashMenu entries={entries} cursor={0} columns={80} />);
  const f1 = r1.lastFrame() ?? '';
  assert.ok(f1.includes('❯ /help'), '首行选中带 ❯ 指示');
  assert.ok(f1.includes('show commands'), '描述显示在命令右侧');
  assert.ok(f1.includes('/demo-skill'), '技能命令与内置同列呈现');
  assert.ok(!f1.includes('还有'), '总量三行无溢出计数');
  r1.unmount();
  const r2 = render(<SlashMenu entries={entries} cursor={1} columns={80} />);
  const f2 = r2.lastFrame() ?? '';
  assert.ok(f2.includes('❯ /init'), '光标 1 时第二行选中');
  assert.ok(!f2.includes('❯ /help'), '未选中行无指示符');
  r2.unmount();
  // maxRows 截窗：5 条上限 2——窗口 2 行 + 计数行
  const five: SlashMenuEntry[] = Array.from({ length: 5 }, (_, i) => ({ cmd: `/c${i}`, description: `d${i}`, kind: 'builtin' as const }));
  const r3 = render(<SlashMenu entries={five} cursor={0} columns={80} maxRows={2} />);
  const f3 = r3.lastFrame() ?? '';
  assert.ok(f3.includes('/c0') && f3.includes('/c1'), '窗口内首两行');
  assert.ok(!f3.includes('/c2'), '窗口外行不渲染');
  assert.ok(f3.includes('3'), '溢出计数行提示剩余条数');
  r3.unmount();
});

/* ---------- App 集成：纵向菜单 + 过滤 + Tab + Enter ---------- */

test('App：输入 / 出纵向命令面板（一行一命令+描述），逐键动态过滤', async () => {
  const tmp = tmpDir('sunshinex-slashmenu1-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await settle(200);
    term.write('/');
    await settle();
    const f1 = term.lastFrame() ?? '';
    assert.ok(f1.includes('❯ /help'), '菜单首行选中 /help');
    assert.ok(f1.includes('/init'), '内置命令纵向逐行呈现');
    assert.ok(f1.includes('/memory'), '深位命令在窗口内（/model-tier 加入后 24 行终端滑窗 18 行，/memory 居窗内）');
    assert.ok(/more|还有/.test(f1), '窗口溢出计数行在场（清单超出滑窗时提示剩余条数）');
    assert.ok(!f1.includes('/memory-add'), '窗口外长尾不渲染（经过滤可达，下滑窗口径）');
    assert.ok(!/\/help {2}\/init/.test(f1), '不再横向单行拼接');
    term.write('mem');
    await settle();
    const f2 = term.lastFrame() ?? '';
    assert.ok(f2.includes('/memory-add'), '/mem 命中 memory 族（长尾经过滤在场）');
    assert.ok(!f2.includes('/help'), '未命中命令不渲染（动态过滤）');
    // 退格回 '/'：控制键必须逐键 write（假 stdin 整串分发会绕过键解析）
    for (let i = 0; i < 3; i++) { term.write('\u007F'); await settle(40); }
    await settle();
    assert.ok((term.lastFrame() ?? '').includes('/help'), '删字回宽词全量回归');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：菜单 ↑↓ 移动选区、Tab 补全选中项、Enter 提交选中命令（半 typing 直跑）', async () => {
  const tmp = tmpDir('sunshinex-slashmenu2-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await settle(200);
    term.write('/mem');
    await settle();
    // ↓ 移到第二个 memory 族命令（/memory-add）
    term.write('\u001B[B');
    await settle();
    assert.ok((term.lastFrame() ?? '').includes('❯ /memory-add'), '↓ 后选区移到第二项');
    // ↑ 回首项后 Tab：补全选中项 + 空格
    term.write('\u001B[A');
    await settle();
    term.write('\t');
    await settle();
    assert.match(term.lastFrame() ?? '', /\/memory /, 'Tab 应补全选中项 /memory + 空格');
    // 退格 4 次回到 '/mem'（控制键逐键 write），Enter 直接执行选中的 /memory（无记忆时输出引导文案，不再落无法识别）
    for (let i = 0; i < 4; i++) { term.write('\u007F'); await settle(40); }
    await settle();
    assert.match(term.lastFrame() ?? '', /❯ \/mem/, '退格回半 typing 词');
    term.write('\r');
    await settle(250);
    const sys = ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
    assert.ok(/No memories yet|暂无记忆/.test(sys), 'Enter 应提交选中命令 /memory（回执上屏）');
    assert.ok(!/Unrecognized command|无法识别/.test(sys), '不再落无法识别文案');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：技能命令入面板（描述上屏），最近使用排前', async () => {
  const tmp = tmpDir('sunshinex-slashmenu3-');
  let term: ReturnType<typeof render> | undefined;
  try {
    // id 共享 '/tool' 前缀：两技能同屏可比序（内置 22 条占满首屏窗口，无共同前缀则技能在窗口外）
    for (const [id, desc] of [['tool-alpha', 'Alpha tool skill'], ['tool-zeta', 'Zeta tool skill']] as const) {
      const dir = path.join(tmp, '.sunshinex', 'skills', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${desc}\nversion: 1.0.0\n---\n\nBody.`);
    }
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"x"}']) });
    // 预置最近使用：zeta 用过、alpha 没用过 → 面板 zeta 在前
    recordSkillUsage(tmp, 'tool-zeta', Date.now());
    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await settle(200);
    term.write('/tool');
    await settle();
    const f = term.lastFrame() ?? '';
    const zi = f.indexOf('/tool-zeta');
    const ai = f.indexOf('/tool-alpha');
    assert.ok(zi >= 0 && ai >= 0, '两个技能命令都在面板');
    assert.ok(f.includes('Zeta tool skill'), '技能描述随行显示');
    assert.ok(zi < ai, '最近使用的 zeta 排在未使用的 alpha 之前');
    // 新挂载直打 '/tool'：首选即最近使用的 zeta，Tab 补全选中项
    term.unmount();
    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await settle(200);
    term.write('/tool');
    await settle();
    term.write('\t');
    await settle();
    assert.match(term.lastFrame() ?? '', /\/tool-zeta /, 'Tab 补全选中的技能命令');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ---------- 会话层：最近使用落盘与菜单源排序 ---------- */

test('skill-usage：record/read 往返；loadSkill 成功与去重两径记录、failed 不记；skillMenuEntries 最近在前', async () => {
  const tmp = tmpDir('sunshinex-slashmenu4-');
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    assert.deepEqual(readSkillUsage(tmp), {}, '初读空表');
    recordSkillUsage(tmp, 'a-skill', 111);
    recordSkillUsage(tmp, 'b-skill', 222);
    assert.deepEqual(readSkillUsage(tmp), { 'a-skill': 111, 'b-skill': 222 }, '往返保序保值');
    for (const id of ['one-skill', 'two-skill']) {
      const dir = path.join(tmp, '.sunshinex', 'skills', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: d ${id}\nversion: 1.0.0\n---\n\nBody.`);
    }
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit('/two-skill'); // 加载成功 → 记录
    await ctrl.submit('/two-skill'); // 去重回执 → 也记录
    const usage = readSkillUsage(tmp);
    assert.ok(typeof usage['two-skill'] === 'number', 'loadSkill 成功路径记录最近使用');
    const menu = ctrl.skillMenuEntries();
    assert.deepEqual(menu.map((m) => m.id), ['two-skill', 'one-skill'], '最近使用的技能排前，未使用殿后');
    assert.equal(menu[0]!.description, 'd two-skill', '描述随菜单源透出');
    assert.equal(menu[1]!.lastUsedAt, undefined, '未使用无时间戳');
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
