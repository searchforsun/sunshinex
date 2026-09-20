import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function flushKey(term: ReturnType<typeof render>): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function messageTexts(ctrl: SessionController): string {
  return ctrl.getState().messages.map((m) => m.text).join('\n');
}

test('App：审批卡选择器——↓+Enter=本会话放行（always），同主体后续操作不再询问', async () => {
  const tmp = tmpDir('sunshinex-appsel1-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"a.txt","content":"1"},"done":false}',
        '{"done":true,"reply":"first ok"}',
        '{"tool":"write","input":{"path":"a.txt","content":"2"},"done":false}',
        '{"done":true,"reply":"second ok"}',
      ]),
    });
    const p1 = ctrl.submit('第一个写任务');
    await waitFor(() => ctrl.getState().status === 'awaiting-approval');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('Approve once'), 3000);
    term.write('\u001B[B'); // ↓ → Allow for session
    await flushKey(term);
    term.write('\r');
    await p1;
    assert.equal(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8'), '1', '选择器路径应放行并落盘');
    await ctrl.submit('第二个写任务');
    await ctrl.waitIdle();
    assert.equal(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8'), '2', 'always 后同主体写不再询问');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：审批卡 y/a/n 单键快捷并存——y 即放行一次（回归钉）', async () => {
  const tmp = tmpDir('sunshinex-appsel2-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"q.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    const p = ctrl.submit('写个文件');
    await waitFor(() => ctrl.getState().status === 'awaiting-approval');
    term = render(<App controller={ctrl} />);
    term.write('y');
    await p;
    assert.equal(fs.readFileSync(path.join(tmp, 'q.txt'), 'utf8'), 'hi', 'y 快捷键路径保持不变');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：plan 确认选择器——Enter（首项）执行计划', async () => {
  const tmp = tmpDir('sunshinex-appsel3-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. write greeting to p.txt"}',
        '{"tool":"write","input":{"path":"p.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"step done"}',
      ]),
    });
    const p = ctrl.submit('/plan make greeting');
    await waitFor(() => ctrl.getState().status === 'awaiting-plan');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('Execute plan'), 3000);
    term.write('\r'); // 首项 = Execute plan
    await p;
    await ctrl.waitIdle();
    assert.equal(fs.readFileSync(path.join(tmp, 'p.txt'), 'utf8'), 'hi', 'Enter 首项应执行计划');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：plan 确认 n 快捷放弃（回归钉）', async () => {
  const tmp = tmpDir('sunshinex-appsel4-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"1. step one"}']),
    });
    const p = ctrl.submit('/plan anything');
    await waitFor(() => ctrl.getState().status === 'awaiting-plan');
    term = render(<App controller={ctrl} />);
    term.write('n');
    await p;
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle', 'n 放弃后回输入态');
    assert.ok(messageTexts(ctrl).includes('Plan discarded'), '放弃回执上屏');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
