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
  // 垫片 stdin 为同步 EventEmitter：写入后先让 ink 的输入监听回调与 React 状态更新落地，再继续分发
  await new Promise((r) => setTimeout(r, 30));
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function askController(root: string, input: Record<string, unknown>): { ctrl: SessionController; p: Promise<void> } {
  const ctrl = new SessionController({
    root,
    model: new ScriptedAdapter([
      `{"tool":"ask_question","input":${JSON.stringify(input)},"done":false}`,
      '{"done":true,"reply":"ok"}',
    ]),
  });
  return { ctrl, p: ctrl.submit('ask once') };
}

function messageTexts(ctrl: SessionController): string {
  return ctrl.getState().messages.map((m) => m.text).join('\n');
}

test('App：AskQuestion 卡渲染 + ↓/Enter 选择回填观察', async () => {
  const tmp = tmpDir('sunshinex-appask1-');
  const { ctrl, p } = askController(tmp, { question: 'Proceed with the plan?', options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Ask later' }] });
  let term: ReturnType<typeof render> | undefined;
  try {
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('Proceed with the plan?'), 3000);
    term.write('\u001B[B');
    await flushKey(term);
    term.write('\r');
    await p;
    assert.ok(messageTexts(ctrl).includes('answer: No'), '选择应回填为观察行');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：Esc 取消问询 → dismissed 观察且任务自然完成（不中止）', async () => {
  const tmp = tmpDir('sunshinex-appask2-');
  const { ctrl, p } = askController(tmp, { question: 'q?', options: [{ label: 'a' }, { label: 'b' }] });
  let term: ReturnType<typeof render> | undefined;
  try {
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    term.write('\u001B');
    await p;
    await ctrl.waitIdle();
    assert.ok(messageTexts(ctrl).includes('user dismissed the question (no selection)'));
    assert.equal(ctrl.getState().status, 'idle', 'dismiss 不应中止任务（任务自然完成）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：数字快选（单选即提交）', async () => {
  const tmp = tmpDir('sunshinex-appask3-');
  const { ctrl, p } = askController(tmp, { question: 'q?', options: [{ label: 'a' }, { label: 'b' }] });
  let term: ReturnType<typeof render> | undefined;
  try {
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    term.write('2');
    await p;
    assert.ok(messageTexts(ctrl).includes('answer: b'));
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：多选 Space 勾选 ×2 + Enter 提交全部勾选', async () => {
  const tmp = tmpDir('sunshinex-appask4-');
  const { ctrl, p } = askController(tmp, { question: 'q?', options: [{ label: 'a' }, { label: 'b' }], multiple: true });
  let term: ReturnType<typeof render> | undefined;
  try {
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    term.write(' ');
    await flushKey(term);
    term.write('\u001B[B');
    await flushKey(term);
    term.write(' ');
    await flushKey(term);
    term.write('\r');
    await p;
    assert.ok(messageTexts(ctrl).includes('answers: a; b'), `多选应提交全部勾选`);
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：Other… 行 Enter 切自由输入 → 文本回车提交 custom', async () => {
  const tmp = tmpDir('sunshinex-appask5-');
  const { ctrl, p } = askController(tmp, { question: 'q?', options: [{ label: 'a' }, { label: 'b' }], allowCustom: true });
  let term: ReturnType<typeof render> | undefined;
  try {
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    term.write('\u001B[B');
    term.write('\u001B[B');
    await flushKey(term);
    term.write('\r');
    term.write('my own answer');
    term.write('\r');
    await p;
    assert.ok(messageTexts(ctrl).includes('custom: my own answer'));
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
