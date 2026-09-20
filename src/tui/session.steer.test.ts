import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import type { ModelAdapter } from '../model/adapter';

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

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

/** 门控适配器：第 1 次模型调用阻塞在 gate 上（测试借此在任务运行中稳定插入穿插行，消除时序竞态） */
function gatedAdapter(responses: string[]): { adapter: ModelAdapter; gate: { promise: Promise<void>; release: () => void } } {
  let calls = 0;
  const gate = deferred();
  const adapter: ModelAdapter = {
    provider: 'gated-steer',
    complete: async () => {
      const i = calls++;
      if (i === 0) await gate.promise;
      return responses[Math.min(i, responses.length - 1)];
    },
  };
  return { adapter, gate };
}

test('运行中穿插：步边界同轮消费，穿插行入会话链（对标 CC queued messages）', async () => {
  const tmp = tmpdir('sunshinex-sess-steer1-');
  try {
    const { adapter, gate } = gatedAdapter([
      '{"tool":"exec","input":{"command":"echo hi"},"done":false}',
      '{"done":true,"reply":"ok"}',
    ]);
    const ctrl = new SessionController({ root: tmp, model: adapter });
    const run = ctrl.submit('先跑个任务');
    await waitFor(() => ctrl.getState().status === 'running');
    await ctrl.submit('User steer: also check the README');
    assert.equal(ctrl.steeringPending(), 1, '运行中提交即入穿插通道');
    gate.release();
    await run;
    await ctrl.waitIdle();
    assert.equal(ctrl.steeringPending(), 0, '穿插行已被步边界消费');
    const chain = ctrl.runtime.harness.context.chainView();
    const steerIdx = chain.findIndex((s) => s.action === 'task' && s.observation === 'User steer: also check the README');
    assert.ok(steerIdx >= 0, '穿插行以 task 行尾追进会话链');
    const replyIdx = chain.findIndex((s) => s.action === 'reply');
    assert.ok(replyIdx > steerIdx, '穿插在终稿 reply 之前入链（同轮生效而非收口补跑）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('收口兜底：未被消费的穿插行在任务收口后按入队序补跑', async () => {
  const tmp = tmpdir('sunshinex-sess-steer2-');
  try {
    const { adapter, gate } = gatedAdapter([
      '{"done":true,"reply":"first done"}',
      '{"done":true,"reply":"steered done"}',
    ]);
    const ctrl = new SessionController({ root: tmp, model: adapter });
    const run = ctrl.submit('第一个任务');
    await waitFor(() => ctrl.getState().status === 'running');
    await ctrl.submit('补跑这件事');
    gate.release();
    await run;
    await ctrl.waitIdle();
    assert.equal(ctrl.steeringPending(), 0);
    const assistant = ctrl.getState().messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('|');
    assert.ok(assistant.includes('first done') && assistant.includes('steered done'), '未消费穿插行收口后补跑为新任务');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('撤回取回：takeBackQueued 取回未投递穿插行，链上零残留', async () => {
  const tmp = tmpdir('sunshinex-sess-steer3-');
  try {
    const { adapter, gate } = gatedAdapter([
      '{"tool":"exec","input":{"command":"echo hi"},"done":false}',
      '{"done":true,"reply":"ok"}',
    ]);
    const ctrl = new SessionController({ root: tmp, model: adapter });
    const run = ctrl.submit('先跑个任务');
    await waitFor(() => ctrl.getState().status === 'running');
    await ctrl.submit('User steer: draft line');
    const taken = ctrl.takeBackQueued();
    assert.deepEqual(taken, ['User steer: draft line']);
    assert.equal(ctrl.steeringPending(), 0);
    gate.release();
    await run;
    await ctrl.waitIdle();
    const chain = ctrl.runtime.harness.context.chainView();
    assert.ok(!chain.some((s) => s.observation === 'User steer: draft line'), '被取回的穿插行不入链');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
