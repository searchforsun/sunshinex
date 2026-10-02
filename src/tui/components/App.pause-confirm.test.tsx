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

async function flushKey(): Promise<void> {
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
    await flushKey();
    assert.equal(ctrl.getState().pauseConfirm, true, '第一次 Ctrl+C 挂确认卡');
    assert.equal(ctrl.getState().status, 'running', '任务继续跑不被中断');
    await waitFor(() => (term?.lastFrame() ?? '').includes('ctrl+c again'), 3000);
    assert.ok((term?.lastFrame() ?? '').includes('keep running'), '暂停确认灰底提示条上屏（KeyHints emphasized 承载）');
    term.write('\x03');
    await flushKey();
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
    await flushKey();
    assert.equal(ctrl.getState().pauseConfirm, true);
    term.write('\u001B');
    // 裸 ESC 经 use-input 40ms 拼合窗口延迟派发：waitFor 而非固定 flush（早断言假红先例）
    await waitFor(() => ctrl.getState().pauseConfirm === undefined, 3000);
    assert.equal(ctrl.getState().pauseConfirm, undefined, 'Esc 撤卡');
    assert.equal(ctrl.getState().status, 'running', '任务不受影响继续跑');
    term.write('\x03');
    await flushKey();
    assert.equal(ctrl.getState().pauseConfirm, true, '可再次挂卡（两段式不一次性）');
    term.write('\x03');
    await flushKey();
    await pending;
    assert.equal(ctrl.getState().status, 'idle');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：子代理全屏视图内两次 Ctrl+C=停【此】子代理（作用域本视图）——主任务不连带中断（真机「4 子代理全完成后主链被杀」病根）', async () => {
  const tmp = tmpDir('sunshinex-apppause3-');
  const { ctrl, pending } = runningCtrl(tmp);
  let term: ReturnType<typeof render> | undefined;
  try {
    await waitFor(() => ctrl.getState().status === 'running');
    // 真实在跑子代理夹具：账本登记任务 + 事件驱动建立 children（subagentTaskId 锚随事件携带）
    const task = ctrl.runtime.harness.tasks.submit({ kind: 'subagent', label: 'research' });
    ctrl.onEventForTest({ type: 'token', text: '调查中\n', payload: { subagent: 'Research', subagentTaskId: task.id } } as never);
    const retain = { ...initialRetained(), inspect: { kind: 'live' as const, label: 'Research' } };
    term = render(<App controller={ctrl} retain={retain} />);
    await flushKey();
    term.write('\x03');
    await flushKey();
    assert.equal(ctrl.getState().pauseConfirm, true, '全屏视图内第一次 Ctrl+C 挂卡（无 running 门槛——后台子代理跨回合存续仍可停）');
    assert.equal(ctrl.getState().status, 'running', '挂卡不中断任何任务');
    term.write('\x03');
    await flushKey();
    assert.equal(ctrl.runtime.harness.tasks.get(task.id)?.status, 'stopped', '第二次 Ctrl+C 停止该子代理（账本终态 stopped，task_stop 同款单点）');
    assert.equal(ctrl.getState().children.find((c) => c.label === 'Research')?.done, true, '面板即时置终态');
    assert.equal(ctrl.getState().pauseConfirm, undefined, '确认后清卡');
    assert.equal(ctrl.getState().status, 'running', '主任务继续跑——不再「主链连带子代理」整个 interrupt（旧语义实锤病根）');
    assert.equal(ctrl.interrupt(), true, '收尾中断挂起主任务');
    await pending;
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：全屏视图内 Esc 撤卡不退视图，无卡再 Esc 才退出（真机「Ctrl+C 后 Esc 退出子代理、卡悬空带回主视图一按即杀」病根）', async () => {
  const tmp = tmpDir('sunshinex-apppause4-');
  const { ctrl, pending } = runningCtrl(tmp);
  let term: ReturnType<typeof render> | undefined;
  try {
    await waitFor(() => ctrl.getState().status === 'running');
    const retain = { ...initialRetained(), inspect: { kind: 'live' as const, label: 'Research' } };
    term = render(<App controller={ctrl} retain={retain} />);
    await flushKey();
    term.write('\x03');
    await flushKey();
    assert.equal(ctrl.getState().pauseConfirm, true, '全屏视图内挂卡');
    term.write('\u001B');
    // 裸 ESC 经 use-input 40ms 拼合窗口延迟派发：waitFor 而非固定 flush（早断言假红先例）
    await waitFor(() => ctrl.getState().pauseConfirm === undefined, 3000);
    assert.deepEqual(retain.inspect, { kind: 'live', label: 'Research' }, 'Esc 撤卡不退全屏（提示条「Esc 继续运行」承诺兑现，卡不再悬空带回主视图）');
    assert.equal(ctrl.getState().status, 'running', '任务零影响继续跑');
    term.write('\u001B');
    await waitFor(() => retain.inspect === undefined, 3000);
    assert.equal(retain.inspect, undefined, '无卡再按 Esc 才退出全屏');
    assert.equal(ctrl.interrupt(), true, '收尾中断挂起任务');
    await pending;
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
