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

/** 挂起适配器：模型调用永挂直至外部 signal 中止（两次 Ctrl+C 语义钉：第一次挂卡不得触发 abort） */
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

test('暂停确认：运行中 requestPause 挂卡——任务不停（signal 未 abort）、status 保持 running', async () => {
  const tmp = tmpdir('sunshinex-pause1-');
  try {
    const model = new HangingAdapter();
    const ctrl = new SessionController({ root: tmp, model });
    const pending = ctrl.submit('长任务');
    await waitFor(() => model.lastSignal !== undefined, 3000);
    assert.equal(ctrl.requestPause(), true, '运行中首次请求暂停生效');
    const s = ctrl.getState();
    assert.equal(s.pauseConfirm, true, '确认卡挂起');
    assert.equal(s.status, 'running', 'status 不变——任务继续跑');
    assert.equal(model.lastSignal!.aborted, false, '第一次 Ctrl+C 不触发 abort（子代理不受影响）');
    ctrl.interrupt(); // 收尾：解除挂起适配器，不留悬空任务
    await pending;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('暂停确认：cancelPause 撤卡回运行现场；重复 requestPause 幂等 false；interrupt 清卡并真正中断', async () => {
  const tmp = tmpdir('sunshinex-pause2-');
  try {
    const model = new HangingAdapter();
    const ctrl = new SessionController({ root: tmp, model });
    const pending = ctrl.submit('长任务');
    await waitFor(() => model.lastSignal !== undefined, 3000);
    assert.equal(ctrl.requestPause(), true);
    ctrl.cancelPause();
    assert.equal(ctrl.getState().pauseConfirm, undefined, '撤卡后现场清空');
    assert.equal(ctrl.getState().status, 'running', '任务不受影响');
    assert.equal(ctrl.requestPause(), true, '可再次挂卡');
    assert.equal(ctrl.requestPause(), false, '已挂卡重复请求为 false（App 层回落确认分支）');
    assert.equal(ctrl.interrupt(), true, '第二次 Ctrl+C（确认）真正中断');
    await pending;
    const s = ctrl.getState();
    assert.equal(s.pauseConfirm, undefined, '中断即清卡');
    assert.equal(s.status, 'idle');
    assert.ok(model.lastSignal!.aborted, '确认后 abort 贯通模型调用');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('暂停确认：非运行态 requestPause 为 no-op false', async () => {
  const tmp = tmpdir('sunshinex-pause3-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new HangingAdapter() });
    assert.equal(ctrl.requestPause(), false, '空闲态无可暂停任务');
    assert.equal(ctrl.getState().pauseConfirm, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
