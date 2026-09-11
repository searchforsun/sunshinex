import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { createRuntime } from './runtime';
import { ScriptedAdapter } from '../model/adapter';
import { Reactor, ReactorOpts } from '../harness/reactor';
import { LONG_TASK_TIMEOUT_MS } from '../loop/templates';

test('/plan：规划（经主链长任务模板）→ 确认 → 逐项执行 → 待办同步', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan1-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        // 规划轮：经主链长任务模板（Loop 内嵌 Reactor）+ Reactor JSON 协议产出计划（reply 携带编号步骤）
        '{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}',
        // 执行轮：逐项 run
        '{"done":true,"reply":"步骤A 完成"}',
        '{"done":true,"reply":"步骤B 完成"}',
      ]),
    });
    await ctrl.submit('/plan 做一件事');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    assert.ok(ctrl.getState().metrics.turnStartedAt > 0, '规划阶段应重置本轮计时起点');
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

test('会话层：/plan 规划段经主链产出编号步骤并进确认卡', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-'));
  try {
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"1. 改 A 文件\\n2. 跑测试"}']),
    });
    const ctrl = new SessionController({ root: tmp, runtime: rt });
    await ctrl.submit('/plan 修一个 bug');
    // 偏离 brief 模板：原模板此处调 ctrl.waitIdle()，但 /plan 按设计停在 awaiting-plan（非 idle），
    // waitIdle 会空等到 10s 超时抛错，与「规划段是否经主链」无关；submit 已 await 完整规划流程，故直接断言。
    const s = ctrl.getState();
    assert.equal(s.status, 'awaiting-plan');
    assert.deepEqual(
      s.todos.map((t) => t.text),
      [],
      '确认前不应建待办（待办在确认后由 runPlanItems 建立）',
    );
    const texts = s.messages.map((m) => m.text).join('\n');
    assert.match(texts, /计划确认卡/);
    assert.match(texts, /改 A 文件/);
    assert.equal(rt.harness.ledger.summary().runs, 1, '规划 run 同样落账本（换通道不丢成本观测）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 判别性加固：证明规划段确实经主链（Loop 长任务模板），而非 graph 角色节点裸调 ──
// 背景：上一条用例的断言（状态/待办/确认卡/ledger runs）在**旧形态下同样全绿**，无判别力——
// 旧路径已把 onEvent 与 ledger 交给角色节点，runs 都为 1。故补本用例做红/绿对照。
// 旧形态实测：goal 含「你的角色：规划师」（graph 角色框定）、deadlineAt = startedAt + 600_000
// （装饰性 GraphContext.termination）、maxSteps = 6（会话层硬填）。
test('会话层：/plan 规划段经主链——探针证明不走 graph 角色框定，且继承 Loop 长任务模板限额', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-probe-'));
  const orig = Reactor.prototype.run;
  const calls: Array<{ self: Reactor; goal: string; opts: ReactorOpts | undefined; at: number }> = [];
  // 仓内两处之一（另见 src/tui/runtime.test.ts）类型逃逸（局限在此函数表达式）：原型补丁的 this 语义 TS 不保留，故断言回原方法签名；未引入 any
  Reactor.prototype.run = function (this: Reactor, ...args: Parameters<Reactor['run']>): ReturnType<Reactor['run']> {
    calls.push({ self: this, goal: String(args[0].goal), opts: args[1], at: Date.now() });
    return orig.call(this, ...args);
  } as Reactor['run'];
  try {
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"1. 改 A 文件\\n2. 跑测试"}']),
    });
    const ctrl = new SessionController({ root: tmp, runtime: rt });
    await ctrl.submit('/plan 修一个 bug');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    assert.equal(calls.length, 1, '规划期应恰有一次 Reactor.run（单次模型调用）');
    const c = calls[0];
    assert.ok(
      !/你的角色：规划师/.test(c.goal),
      '规划段不得再走 graph 角色节点框定（旧形态 goal 含「你的角色：规划师」；角色框定已降为提示词级）',
    );
    assert.match(c.goal, /编号步骤计划/, '规划指令应经主链下发（主链提示词级角色框定）');
    assert.equal(c.opts?.maxSteps, undefined, '会话层不再硬填 maxSteps:6（旧形态为 6）');
    const ttl = c.opts?.deadlineAt !== undefined ? c.opts.deadlineAt - c.at : NaN;
    assert.ok(
      ttl > LONG_TASK_TIMEOUT_MS - 60_000 && ttl <= LONG_TASK_TIMEOUT_MS,
      `规划期 deadlineAt 应继承 Loop 长任务模板 4h 兜底（旧形态取自装饰性 GraphContext = 600_000）：实得 ${ttl}`,
    );
  } finally {
    Reactor.prototype.run = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
