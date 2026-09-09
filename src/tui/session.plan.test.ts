import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

test('/plan：规划（planner 节点）→ 确认 → 逐项执行 → 待办同步', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan1-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        // 规划轮：planner 节点经 Reactor JSON 协议产出计划（reply 携带编号步骤）
        '{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}',
        // 执行轮：逐项 run
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
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    await ctrl.confirmPlan(false);
    assert.equal(ctrl.getState().status, 'idle');
    assert.equal(ctrl.getState().todos.length, 0, '拒绝后不产生待办');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：缺目标给用法提示；非 idle 拒绝并发规划', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan3-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"touch p.txt"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    await ctrl.submit('/plan');
    assert.ok(
      ctrl.getState().messages.some((m) => m.role === 'system' && m.text.includes('用法')),
      '缺目标应给用法提示',
    );
    // 运行中（审批挂起）拒绝并发规划
    const p = ctrl.submit('跑个命令');
    const deadline = Date.now() + 5000;
    while (ctrl.getState().status !== 'awaiting-approval') {
      if (Date.now() > deadline) throw new Error('审批挂起超时');
      await new Promise((r) => setTimeout(r, 20));
    }
    await ctrl.submit('/plan 并发规划');
    assert.ok(
      ctrl.getState().messages.some((m) => m.role === 'system' && m.text.includes('暂不能开始规划')),
      '非 idle 应拒绝并发规划',
    );
    await ctrl.resolveApproval('deny');
    await p;
    await ctrl.waitIdle();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
