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

test('会话中断：队列保留转暂停(不丢弃),恢复后自动发送队首', async () => {
  const tmp = tmpdir('sunshinex-interrupt3-');
  try {
    const model = new HangingAdapter();
    const ctrl = new SessionController({ root: tmp, model });
    const first = ctrl.submit('任务一');
    await waitFor(() => model.lastSignal !== undefined, 3000);
    ctrl.submit('任务二'); // running → 排队(静默,零上屏)
    await waitFor(() => ctrl.steeringPending() === 1, 3000);
    assert.ok(!ctrl.getState().messages.some((m) => m.text.includes('任务二')), '排队行零上屏(与 GUI 对齐)');
    assert.equal(ctrl.interrupt(), true);
    await first; // T1 中止收口
    const s = ctrl.getState();
    assert.equal(s.status, 'idle');
    assert.equal(s.queuePaused, true, '中断转暂停(不丢弃队列)');
    assert.equal(ctrl.steeringPending(), 1, '队列保留(底层取数仍在册)');
    assert.ok(
      s.messages.some((m) => m.role === 'system' && /Queue paused|队列已暂停/.test(m.text)),
      '暂停回执上屏(模式变更提示,非队列操作回显)',
    );
    // 恢复 → 队首自动发送为新轮
    ctrl.queueResume();
    await waitFor(() => ctrl.getState().status === 'running', 3000);
    assert.equal(ctrl.steeringPending(), 0, '恢复即消费队首');
    assert.equal(ctrl.getState().queuePaused, undefined, '暂停态解除');
    // 再中断:队列空,无暂停回执,正常收口
    assert.equal(ctrl.interrupt(), true);
    await ctrl.waitIdle();
    assert.equal(ctrl.steeringPending(), 0);
    assert.ok(!ctrl.getState().messages.some((m) => /Queue paused: 0|队列已暂停：0/.test(m.text)), '空队列不弹暂停回执');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('队列暂停:暂停中新提交直接发送、队列不自跑;恢复后按序补跑', async () => {
  const tmp = tmpdir('sunshinex-interrupt4-');
  try {
    // 三段独立门:T1 挂门 A(永不放行,abort 收口)、T3(暂停中直接发送)挂门 B、T2(恢复后补跑)挂门 C——
    // 论证「暂停中直接发送/恢复后补跑」互不混序。适配器必须响应 abort(signal 中止即拒,模拟真模型调用收口)
    const deferred = (): { promise: Promise<void>; release: () => void } => {
      let release!: () => void;
      const promise = new Promise<void>((r) => { release = r; });
      return { promise, release };
    };
    const gateA = deferred();
    const gateB = deferred();
    const gateC = deferred();
    class SequencedAdapter implements ModelAdapter {
      readonly provider = 'sequenced';
      calls: string[] = [];
      private count = 0;
      async chat(req: ChatRequest): Promise<ChatResult> {
        this.count += 1;
        this.calls.push(req.messages[req.messages.length - 1]?.content ?? ''); // 进入即记(waitFor 观测点)
        const gate = this.count === 1 ? gateA.promise : this.count === 2 ? gateB.promise : gateC.promise;
        const signal = req.signal;
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => reject(new Error('Task interrupted'));
          if (signal?.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
          gate.then(() => { signal?.removeEventListener('abort', onAbort); resolve(); });
        });
        return { finish: 'stop', content: `${this.count === 2 ? 'T3' : 'T2'} done`, toolCalls: [] };
      }
    }
    const model = new SequencedAdapter();
    const ctrl = new SessionController({ root: tmp, model });
    const first = ctrl.submit('任务一');
    await waitFor(() => model.calls.length === 1, 3000); // T1 在跑
    ctrl.submit('任务二'); // 排队
    await waitFor(() => ctrl.steeringPending() === 1, 3000);
    assert.equal(ctrl.interrupt(), true, '中断 T1,队列保留转暂停');
    await first;
    assert.equal(ctrl.getState().queuePaused, true);
    // 暂停中提交任务三:idle 直接发送(不经队列),与队列内 T2 并存
    const third = ctrl.submit('任务三');
    await waitFor(() => ctrl.getState().status === 'running', 3000);
    assert.equal(ctrl.steeringPending(), 1, '队列仍挂起(暂停中不自跑)');
    assert.equal(ctrl.getState().queuePaused, true, '直接发送不改暂停态');
    gateB.release();
    await third;
    await ctrl.waitIdle();
    assert.equal(ctrl.steeringPending(), 1, 'T3 收口不自动补跑 T2(暂停门)');
    assert.ok(!model.calls.some((c) => c.includes('任务二')), 'T2 未被自动发送');
    // 恢复 → T2 按序补跑
    ctrl.queueResume();
    await waitFor(() => model.calls.some((c) => c.includes('任务二')), 3000);
    gateC.release();
    await ctrl.waitIdle();
    const assistant = ctrl.getState().messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('|');
    assert.ok(assistant.includes('T2 done'), '恢复后 T2 补跑完成');
    assert.equal(ctrl.steeringPending(), 0);
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
