import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController, shouldPumpOnIdleBeat } from './session';
import { ScriptedAdapter } from '../model/adapter';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('askUser：挂起（awaiting-question + 问题卡）→ 裁决回填 → 恢复现场态', async () => {
  const tmp = tmpDir('sunshinex-sessask1-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const p = ctrl.askUser({ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    assert.equal(ctrl.getState().question?.question, 'Proceed?', '问题卡应上屏（TuiState.question）');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['No'] });
    const a = await p;
    assert.deepEqual(a, { type: 'selected', labels: ['No'] });
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle', '恢复挂起前状态（idle）');
    assert.equal(ctrl.getState().question, undefined, '问题卡随裁决清空');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shouldPumpOnIdleBeat：问询挂起不消费后台队列（第 4 参负向钉子），三参形态向后兼容', () => {
  assert.equal(shouldPumpOnIdleBeat('idle', false, 1), true);
  assert.equal(shouldPumpOnIdleBeat('idle', false, 1, true), false, '问询挂起不消费');
  assert.equal(shouldPumpOnIdleBeat('awaiting-question', false, 1), false);
});

test('端到端：模型调用 ask_question → 会话装配默认 seam → 卡片挂起 → 裁决回填 → 观察 answer 行', async () => {
  const tmp = tmpDir('sunshinex-sessask2-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"ask_question","input":{"question":"Proceed?","options":[{"label":"Yes"},{"label":"No"}]},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    const p = ctrl.submit('问一下再继续');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    assert.equal(ctrl.getState().question?.question, 'Proceed?', '会话装配默认把 seam 接到控制器问询管线');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['Yes'] });
    await p;
    await ctrl.waitIdle();
    const texts = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.ok(texts.includes('answer: Yes'), '裁决应作为观察行上屏');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('interrupt：问询挂起期间中断 → dismissed 回填 + 状态恢复（不遗留悬空 Promise）', async () => {
  const tmp = tmpDir('sunshinex-sessask3-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const p = ctrl.askUser({ question: 'q', options: [{ label: 'a' }, { label: 'b' }] });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    assert.equal(ctrl.interrupt(), true, 'awaiting-question 属可中断态');
    assert.deepEqual(await p, { type: 'dismissed' });
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
