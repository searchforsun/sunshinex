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
