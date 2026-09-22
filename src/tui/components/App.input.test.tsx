import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App, slashCandidates, nextSlashCompletion, SLASH_COMMANDS } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';
import { initialRetained } from '../ui-state';

test('slashCandidates：/ 前缀匹配命令清单，非 / 前缀返回空', () => {
  assert.deepEqual(slashCandidates('/'), SLASH_COMMANDS);
  assert.ok(SLASH_COMMANDS.includes('/resume'), '/resume 已登记补全清单');
  assert.ok(SLASH_COMMANDS.includes('/goal'), '/goal 已登记补全清单');
  assert.ok(SLASH_COMMANDS.includes('/skill'), '/skill 已登记补全清单');
  assert.deepEqual(slashCandidates('/sk'), ['/skill']);
  assert.deepEqual(slashCandidates('/ne'), ['/new']);
  assert.deepEqual(slashCandidates('xyz'), []);
  assert.deepEqual(slashCandidates('/xyz'), []);
});

test('slashCandidates：extra 合并内置在前（技能命令池，规格 D7）', () => {
  assert.deepEqual(slashCandidates('/he', ['/hello-world']), ['/help', '/hello-world'], '内置在前、extra 按序追加');
  const withExtra = slashCandidates('/', ['/hello-world']);
  assert.equal(withExtra.length, SLASH_COMMANDS.length + 1, '合并池全量');
  assert.deepEqual(withExtra.slice(0, SLASH_COMMANDS.length), SLASH_COMMANDS, '缺省段逐字节等价（A9 钉）');
  assert.deepEqual(slashCandidates('/hel', ['/hello-world']), ['/help', '/hello-world'], 'hel 同时命中 /help 与 /hello-world');
  assert.deepEqual(slashCandidates('/xyz', ['/hello-world']), []);
});

test('nextSlashCompletion：合并池 Tab 循环推演（纯函数，规格 D7）', () => {
  const pool = [...SLASH_COMMANDS, '/hello-world'];
  assert.equal(nextSlashCompletion('/hello-world', pool), '/help ', '池末位 exact 回环首位（A11）');
  assert.equal(nextSlashCompletion('/new', pool), '/resume ', '内置 exact → 池内下一位（既有邻位钉）');
  assert.equal(nextSlashCompletion('/ne', pool), '/new ', '前缀候选首项 + 空格');
  assert.equal(nextSlashCompletion('/xyz', pool), undefined, '无候选');
  assert.equal(nextSlashCompletion('xyz', pool), undefined, '非 / 前缀');
  assert.equal(nextSlashCompletion('/new', SLASH_COMMANDS), '/resume ', '缺省池与既有 SLASH_COMMANDS 行为等价');
});

test('App：Tab 斜杠补全为完整命令 + 空格，再次 Tab 循环到下一命令', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inp1-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"x"}']) });
    const { lastFrame, write, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await new Promise((r) => setTimeout(r, 200));
    write('/ne');
    await new Promise((r) => setTimeout(r, 150));
    write('\t');
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /\/new /, 'Tab 应补全 /ne 为 /new ');
    write('\t'); // 已是完整命令，循环到下一命令
    await new Promise((r) => setTimeout(r, 150));
    // /resume 登记在 /new 之后：循环邻位由 /compact 变为 /resume（SLASH_COMMANDS 序 /new → /resume → /compact）
    assert.match(lastFrame() ?? '', /\/resume /, '再次 Tab 应循环到下一命令');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：↑↓ 历史导航回填已提交输入', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inp2-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"x"}']) });
    const { lastFrame, write, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await new Promise((r) => setTimeout(r, 200));
    write('任务甲');
    await new Promise((r) => setTimeout(r, 150));
    write('\r');
    await new Promise((r) => setTimeout(r, 200));
    write('任务乙');
    await new Promise((r) => setTimeout(r, 150));
    write('\r');
    await new Promise((r) => setTimeout(r, 200));
    write('\u001B[A'); // ↑ 回填上一条
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ 任务乙/, '↑ 应回填最近一条历史');
    write('\u001B[A'); // 再 ↑ 更早一条
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ 任务甲/, '再 ↑ 应回填更早历史');
    write('\u001B[B'); // ↓ 前进
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ 任务乙/, '↓ 应前进到下一条');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：行尾反斜杠续行（Enter 不提交而是换行）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inp3-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"x"}']) });
    const { write, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await new Promise((r) => setTimeout(r, 200));
    write('第一行\\');
    await new Promise((r) => setTimeout(r, 150));
    write('\r'); // 续行，不提交
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ctrl.getState().messages.filter((m) => m.role === 'user').length, 0, '续行 Enter 不应提交');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：←→ 光标移动，输入落在光标处', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inp4-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"x"}']) });
    const { lastFrame, write, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await new Promise((r) => setTimeout(r, 200));
    write('ab');
    await new Promise((r) => setTimeout(r, 150));
    write('\u001B[D'); // ← 到 b 前
    await new Promise((r) => setTimeout(r, 150));
    write('X');
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ aX▊b/, '← 后输入应插在光标处（▊ 为光标）');
    write('\u001B[C'); // → 回到末尾
    await new Promise((r) => setTimeout(r, 150));
    write('C');
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ aXbC/, '→ 后输入应接在末尾');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：Home/End 序列与 Ctrl+A/E 定位首尾', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inp5-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"x"}']) });
    const { lastFrame, write, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await new Promise((r) => setTimeout(r, 200));
    write('abc');
    await new Promise((r) => setTimeout(r, 150));
    write('\u001B[H'); // Home
    await new Promise((r) => setTimeout(r, 150));
    write('Z');
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ Z▊abc/, 'Home 后输入应落在行首');
    write('\u001B[F'); // End
    await new Promise((r) => setTimeout(r, 150));
    write('D');
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ ZabcD/, 'End 后输入应接在行尾');
    write('\u0005'); // Ctrl+E（同 End）
    await new Promise((r) => setTimeout(r, 150));
    write('W');
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ ZabcDW/, 'Ctrl+E 后输入应接在行尾');
    write('\u0001'); // Ctrl+A（同 Home）
    await new Promise((r) => setTimeout(r, 150));
    write('Y');
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ Y▊ZabcDW/, 'Ctrl+A 后输入应落在行首');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：⌦ 删除光标处字符，退格删除光标前字符', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inp6-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"x"}']) });
    const { lastFrame, write, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await new Promise((r) => setTimeout(r, 200));
    write('abc');
    await new Promise((r) => setTimeout(r, 150));
    write('\u001B[D');
    await new Promise((r) => setTimeout(r, 150));
    write('\u001B[D'); // 光标在 b 前
    await new Promise((r) => setTimeout(r, 150));
    write('\u001B[3~'); // ⌦ 删 b，光标不动
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ a▊c/, '⌦ 应删除光标处字符');
    write('\u007F'); // 退格删 a
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /❯ ▊c/, '退格应删除光标前字符');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：retain 现场跨重挂保留（输入缓冲与历史不丢）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inp7-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"x"}']) });
    const retain = initialRetained();
    const first = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} retain={retain} />);
    await new Promise((r) => setTimeout(r, 200));
    first.write('携带内容');
    await new Promise((r) => setTimeout(r, 150));
    first.write('\r');
    await new Promise((r) => setTimeout(r, 200));
    first.write('草稿');
    await new Promise((r) => setTimeout(r, 150));
    first.unmount();
    // 模拟 resize 重挂：同一 retain 传入新实例
    const second = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} retain={retain} />);
    await new Promise((r) => setTimeout(r, 200));
    assert.match(second.lastFrame() ?? '', /❯ 草稿/, '重挂后输入缓冲应从 retain 恢复');
    second.write('\u001B[A');
    await new Promise((r) => setTimeout(r, 150));
    assert.match(second.lastFrame() ?? '', /❯ 携带内容/, '重挂后输入历史应从 retain 恢复');
    second.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
