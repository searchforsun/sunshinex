import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { initialRetained } from '../ui-state';
import { ModelAdapter } from '../../model/adapter';
import type { ChatRequest, ChatResult } from '../../types';

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

/** 挂起适配器：模型调用永挂直至外部 signal 中止（运行态现场） */
class HangingAdapter implements ModelAdapter {
  readonly provider = 'hanging';
  async chat(req: ChatRequest): Promise<ChatResult> {
    const signal = req.signal;
    return new Promise((_, reject) => {
      if (signal?.aborted) return reject(new Error('Task interrupted'));
      signal?.addEventListener('abort', () => reject(new Error('Task interrupted')), { once: true });
    });
  }
}

function runningCtrl(root: string): { ctrl: SessionController; pending: Promise<void> } {
  const ctrl = new SessionController({ root, model: new HangingAdapter() });
  return { ctrl, pending: ctrl.submit('长任务') };
}

test('App：两次 Ctrl+C 确认暂停——第一次挂卡任务不停，第二次真正中断回 idle', async () => {
  const tmp = tmpDir('sunshinex-apppause1-');
  const { ctrl, pending } = runningCtrl(tmp);
  let term: ReturnType<typeof render> | undefined;
  try {
    await waitFor(() => ctrl.getState().status === 'running');
    term = render(<App controller={ctrl} />);
    term.write('\x03');
    await flushKey(term);
    assert.equal(ctrl.getState().pauseConfirm, true, '第一次 Ctrl+C 挂确认卡');
    assert.equal(ctrl.getState().status, 'running', '任务继续跑不被中断');
    await waitFor(() => (term?.lastFrame() ?? '').includes('ctrl+c again'), 3000);
    assert.ok((term?.lastFrame() ?? '').includes('esc to keep running'), '一行提示上屏（简化版非模态卡）');
    term.write('\x03');
    await flushKey(term);
    await pending;
    assert.equal(ctrl.getState().status, 'idle', '第二次 Ctrl+C 真正中断');
    assert.equal(ctrl.getState().pauseConfirm, undefined, '中断即清卡');
    assert.ok(
      ctrl.getState().messages.some((m) => m.text.includes('Task interrupted')),
      '中断回执上屏',
    );
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：确认卡上 Esc 撤卡继续跑（任务零影响），此后 Ctrl+C 仍可再挂卡', async () => {
  const tmp = tmpDir('sunshinex-apppause2-');
  const { ctrl, pending } = runningCtrl(tmp);
  let term: ReturnType<typeof render> | undefined;
  try {
    await waitFor(() => ctrl.getState().status === 'running');
    term = render(<App controller={ctrl} />);
    term.write('\x03');
    await flushKey(term);
    assert.equal(ctrl.getState().pauseConfirm, true);
    term.write('\u001B');
    // 裸 ESC 经 use-input 40ms 拼合窗口延迟派发：waitFor 而非固定 flush（早断言假红先例）
    await waitFor(() => ctrl.getState().pauseConfirm === undefined, 3000);
    assert.equal(ctrl.getState().pauseConfirm, undefined, 'Esc 撤卡');
    assert.equal(ctrl.getState().status, 'running', '任务不受影响继续跑');
    term.write('\x03');
    await flushKey(term);
    assert.equal(ctrl.getState().pauseConfirm, true, '可再次挂卡（两段式不一次性）');
    term.write('\x03');
    await flushKey(term);
    await pending;
    assert.equal(ctrl.getState().status, 'idle');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：子代理全屏视图内两次 Ctrl+C 同口径——此前该分支吞键无法暂停（真机病根）', async () => {
  const tmp = tmpDir('sunshinex-apppause3-');
  const { ctrl, pending } = runningCtrl(tmp);
  let term: ReturnType<typeof render> | undefined;
  try {
    await waitFor(() => ctrl.getState().status === 'running');
    const retain = { ...initialRetained(), inspect: { kind: 'live' as const, label: 'Research' } };
    term = render(<App controller={ctrl} retain={retain} />);
    await flushKey(term);
    term.write('\x03');
    await flushKey(term);
    assert.equal(ctrl.getState().pauseConfirm, true, '全屏视图内第一次 Ctrl+C 挂卡（不再被吞）');
    term.write('\x03');
    await flushKey(term);
    await pending;
    assert.equal(ctrl.getState().status, 'idle', '全屏视图内第二次 Ctrl+C 真正中断（主链连带子代理）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
