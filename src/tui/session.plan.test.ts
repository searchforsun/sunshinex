import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

test('/plan：规划 → 确认 → 逐项执行 → 待办同步', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan1-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}',
        '{"done":true,"reply":"步骤A 完成"}',
        '{"done":true,"reply":"步骤B 完成"}',
      ]),
    });
    await ctrl.submit('/plan 做一件事');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    assert.match(ctrl.getState().messages.at(-1)?.text ?? '', /步骤A/);
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const todos = ctrl.getState().todos;
    assert.equal(todos.length, 2, '计划解析出两条待办');
    assert.ok(todos.every((t) => t.done), '逐项执行后全部完成');
    assert.equal(ctrl.getState().status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：拒绝确认 → 回 idle，不执行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan2-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"1. 只有一项"}']),
    });
    await ctrl.submit('/plan 另一件事');
    await ctrl.confirmPlan(false);
    assert.equal(ctrl.getState().status, 'idle');
    assert.equal(ctrl.getState().todos.length, 0, '拒绝后不产生待办');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
