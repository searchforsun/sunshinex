import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { TuiRuntime, RunOutcome } from './runtime';
import { Harness } from '../harness';
import { ScriptedAdapter } from '../model/adapter';

/** 假运行时：只兑现会话层真正消费的契约 */
function fakeRuntime(harness: Harness, outcome: RunOutcome): TuiRuntime {
  return { harness, runTask: async () => outcome };
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('会话层：未完成终止必须上屏（R3）', async () => {
  const tmp = tmpdir('sunshinex-inc-');
  try {
    const harness = new Harness({ root: tmp, mode: 'dontAsk' });
    const ctrl = new SessionController({
      root: tmp,
      runtime: fakeRuntime(harness, { done: false, tokensUsed: 0, stopReason: 'deadline' }),
    });
    await ctrl.submit('做一件事');
    await ctrl.waitIdle();
    const texts = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(texts, /未完成终止/, '未完成终止必须对用户可见，不得静默');
    assert.match(texts, /时间上限/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话层：完成后不追加未完成提示', async () => {
  const tmp = tmpdir('sunshinex-inc2-');
  try {
    const harness = new Harness({ root: tmp, mode: 'dontAsk' });
    const ctrl = new SessionController({
      root: tmp,
      runtime: fakeRuntime(harness, { done: true, reply: '好了', tokensUsed: 3, stopReason: 'done' }),
    });
    await ctrl.submit('做一件事');
    await ctrl.waitIdle();
    const texts = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.ok(!/未完成终止/.test(texts));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话层：规划项未完成不得报成功（runPlanItems）', async () => {
  const tmp = tmpdir('sunshinex-inc3-');
  try {
    // 规划通道走真实 planner（ScriptedAdapter 回放编号计划），仅计划项执行由假 runtime 兑现
    const harness = new Harness({
      root: tmp,
      mode: 'dontAsk',
      model: new ScriptedAdapter(['{"done":true,"reply":"1. 第一步\\n2. 第二步"}']),
    });
    const ctrl = new SessionController({
      root: tmp,
      runtime: fakeRuntime(harness, { done: false, tokensUsed: 0, stopReason: 'budget' }),
    });
    await ctrl.submit('/plan 做两件事');
    assert.equal(ctrl.getState().status, 'awaiting-plan', '应先产出计划确认卡');
    await ctrl.confirmPlan(true);
    const st = ctrl.getState();
    const texts = st.messages.map((m) => m.text).join('\n');
    assert.match(texts, /未完成终止：token 预算耗尽/);
    assert.match(texts, /步骤未完成：第一步/);
    assert.ok(!/已完成：/.test(texts), '未完成的规划项不得被报成功');
    assert.equal(st.todos[0]?.done, false, '未完成项不得勾选待办');
    assert.equal(st.todos[1]?.done, false, '剩余步骤保持未完成');
    assert.equal(st.status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
