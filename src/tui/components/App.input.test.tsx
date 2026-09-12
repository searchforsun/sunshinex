import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App, slashCandidates, SLASH_COMMANDS } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

test('slashCandidates：/ 前缀匹配命令清单，非 / 前缀返回空', () => {
  assert.deepEqual(slashCandidates('/'), SLASH_COMMANDS);
  assert.deepEqual(slashCandidates('/ne'), ['/new']);
  assert.deepEqual(slashCandidates('xyz'), []);
  assert.deepEqual(slashCandidates('/xyz'), []);
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
    assert.match(lastFrame() ?? '', /\/compact /, '再次 Tab 应循环到下一命令');
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
