import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 挂起适配器：模型调用永挂直至外部 signal 中止（模拟长流式生成中用户按 Esc/Ctrl+C） */
class HangingAdapter implements ModelAdapter {
  readonly provider = 'hanging';
  lastSignal?: AbortSignal;
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.lastSignal = req.signal;
    const signal = req.signal;
    return new Promise((_, reject) => {
      if (signal?.aborted) return reject(new Error('Task interrupted'));
      signal?.addEventListener('abort', () => reject(new Error('Task interrupted')), { once: true });
    });
  }
}

test('会话中断：运行中 interrupt() → 中止模型调用、回执上屏、回 idle', async () => {
  const tmp = tmpdir('sunshinex-interrupt1-');
  try {
    const model = new HangingAdapter();
    const ctrl = new SessionController({ root: tmp, model });
    const pending = ctrl.submit('长任务');
    await waitFor(() => model.lastSignal !== undefined, 3000); // signal 已贯通到 adapter（模型调用已发起）
    assert.equal(ctrl.getState().status, 'running');
    assert.equal(ctrl.interrupt(), true, '运行态 interrupt 生效');
    await pending;
    const s = ctrl.getState();
    assert.equal(s.status, 'idle', '中断后回 idle');
    assert.ok(
      s.messages.some((m) => m.role === 'system' && m.text.includes('Task interrupted')),
      '中断回执上屏（warn 级）',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话中断：空闲态 interrupt() 为 no-op 返回 false', async () => {
  const tmp = tmpdir('sunshinex-interrupt2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new HangingAdapter() });
    assert.equal(ctrl.interrupt(), false, '空闲态无任务可中断');
    assert.equal(ctrl.getState().status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话中断：排队任务随中断一并丢弃并回执', async () => {
  const tmp = tmpdir('sunshinex-interrupt3-');
  try {
    const model = new HangingAdapter();
    const ctrl = new SessionController({ root: tmp, model });
    const first = ctrl.submit('任务一');
    await waitFor(() => model.lastSignal !== undefined, 3000);
    const second = ctrl.submit('任务二'); // running → 排队
    await waitFor(() => ctrl.getState().messages.some((m) => m.text.startsWith('Queued:')), 3000);
    assert.equal(ctrl.interrupt(), true);
    await Promise.all([first, second]);
    const s = ctrl.getState();
    assert.equal(s.status, 'idle');
    assert.ok(s.messages.some((m) => m.text.includes('Queued tasks dropped')), '排队丢弃回执上屏');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** 门控适配器：模型调用挂起直至外部 release()——释放后按 mode 正常返回或抛错（挂卡期状态出口的现场） */
class GatedAdapter implements ModelAdapter {
  readonly provider = 'gated';
  private gate: Promise<void>;
  release!: () => void;
  constructor(private mode: 'finish' | 'throw') {
    this.gate = new Promise((r) => { this.release = r; });
  }
  async chat(_req: ChatRequest): Promise<ChatResult> {
    await this.gate;
    if (this.mode === 'throw') throw new Error('boom');
    return { finish: 'stop', content: 'done', toolCalls: [] };
  }
}

test('暂停确认卡状态卫生：挂卡期任务自然收尾即清卡——残留卡会把空闲态 Ctrl+C 当「第二次确认」吞成死键', async () => {
  const tmp = tmpdir('sunshinex-pauseclear1-');
  try {
    const model = new GatedAdapter('finish');
    const ctrl = new SessionController({ root: tmp, model });
    const pending = ctrl.submit('长任务');
    await waitFor(() => ctrl.getState().status === 'running', 3000);
    assert.equal(ctrl.requestPause(), true, '运行中挂卡成功');
    model.release();
    await pending;
    assert.equal(ctrl.getState().status, 'idle', '任务自然完成回 idle');
    assert.equal(ctrl.getState().pauseConfirm, undefined, '卡随 closeTask 状态出口清除，不残留到空闲态');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('暂停确认卡状态卫生：适配器抛错被引擎收口回 idle，卡同样被清（任何收尾路径不留残卡）', async () => {
  const tmp = tmpdir('sunshinex-pauseclear2-');
  try {
    const model = new GatedAdapter('throw');
    const ctrl = new SessionController({ root: tmp, model });
    const pending = ctrl.submit('长任务');
    await waitFor(() => ctrl.getState().status === 'running', 3000);
    assert.equal(ctrl.requestPause(), true, '运行中挂卡成功');
    model.release();
    await pending;
    // 适配器异常被引擎收口为正常完结（session 层 error 粘滞仅限逃逸异常）——closeTask 同样是状态出口
    assert.equal(ctrl.getState().status, 'idle', '引擎收口异常回 idle');
    assert.equal(ctrl.getState().pauseConfirm, undefined, '卡随 closeTask 状态出口清除，任何收尾路径不留残卡');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
