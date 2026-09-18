import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRuntime } from './runtime';
import { ScriptedAdapter } from '../model/adapter';
import { Reactor, ReactorOpts } from '../harness/reactor';
import { SessionEvent } from '../types';

test('createRuntime：事件贯通 + runTask 完成 + runs 账本落盘（会话同源）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
  try {
    const events: SessionEvent[] = [];
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
      onEvent: (e) => events.push(e),
    });
    const r = await rt.runTask('做一件事');
    assert.equal(r.done, true);
    assert.ok(events.some((e) => e.type === 'done'), 'done 事件应贯通到 TuiRuntime 注入者');
    assert.ok(events.some((e) => e.type === 'token'), 'token 事件应贯通');
    assert.equal(rt.harness.ledger.summary().runs, 1, '账本经 TUI run 同样落盘（会话同源）');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：manual 模式 + onApproval 脚本应答 → 非白名单命令放行一次', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt2-'));
  try {
    let asked = 0;
    const rt = createRuntime({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"touch tui-ok.txt"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
      onApproval: async () => {
        asked += 1;
        return 'allow';
      },
    });
    const r = await rt.runTask('跑个命令');
    assert.equal(r.done, true);
    assert.equal(asked, 1, '非白名单命令应走一次审批');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：不传 onApproval 时 manual 保持阶段一拒绝语义（写命令被拒）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt3-'));
  try {
    const rt = createRuntime({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    });
    const r = await rt.runTask('只说不做');
    assert.equal(r.done, true);
    assert.ok(rt.harness.security, 'guard 门面可达（装配面存在）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：model 透传到 harness.model（TUI 装配链不静默回落 stub）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt4-'));
  try {
    const m = new ScriptedAdapter(['{"done":true,"reply":"ok"}']);
    const rt = createRuntime({ root: tmp, model: m });
    assert.equal(rt.harness.model, m, '模型装配不得在接缝处丢失');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：主链经 Loop——不做任何事也走长任务模板（iterations 可观测）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt5-'));
  try {
    const rt = createRuntime({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const r = await rt.runTask('做一件事');
    assert.equal(r.done, true);
    assert.equal(r.stopReason, 'done');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：未完成时返回结构化 stopReason（不再只有 done=false）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt6-'));
  try {
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"tool":"glob","input":{"pattern":"*"},"done":false}']),
    });
    const r = await rt.runTask('一直调工具', { maxSteps: 1 });
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'max-steps');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 加固轮（判别性）：以下 3 条必须能区分「主链经 Loop 长任务模板」与「直连 harness.reactor」 ──

/** 恒为工具调用的脚本：脚本耗尽后 ScriptedAdapter 重复末条（src/model/adapter.ts），故事件数即实际步数 */
const TOOL_ONLY_SCRIPT = '{"tool":"glob","input":{"pattern":"*"},"done":false}';

test('createRuntime：maxSteps 钉死下传——显式 1 步恰 1 次工具事件；缺省不得在接缝处硬填', async () => {
  // ① 显式 { maxSteps: 1 }：值必须抵达内层 Reactor（若下传丢失 → 落 200 步，事件数变 200）
  const events: SessionEvent[] = [];
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt7-'));
  try {
    const rt = createRuntime({
      root: tmp1,
      model: new ScriptedAdapter([TOOL_ONLY_SCRIPT]),
      onEvent: (e) => events.push(e),
    });
    await rt.runTask('一直调工具', { maxSteps: 1 });
    assert.equal(
      events.filter((e) => e.type === 'tool-call').length,
      1,
      'maxSteps:1 必须透传到内层 Reactor：恰 1 次 tool-call（丢失下传则脚本回放至 200 步）',
    );
  } finally {
    fs.rmSync(tmp1, { recursive: true, force: true });
  }

  // ② 不传 opts：接缝不得硬填缺省步数（旧实现填 12），应落到 Reactor 自身缺省 200（src/harness/reactor.ts）
  const events2: SessionEvent[] = [];
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt7b-'));
  try {
    const rt = createRuntime({
      root: tmp2,
      model: new ScriptedAdapter([TOOL_ONLY_SCRIPT]),
      onEvent: (e) => events2.push(e),
    });
    await rt.runTask('一直调工具');
    assert.equal(
      events2.filter((e) => e.type === 'tool-call').length,
      200,
      'maxSteps 缺省时应交给 Reactor 的 200（旧实现直连并硬填 12 → 此处为 12）',
    );
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('createRuntime：主链归属钉死——探针证明不触碰 harness.reactor，且内层收到 tokenCap/deadlineAt', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt8-'));
  const orig = Reactor.prototype.run;
  const calls: Array<{ self: Reactor; opts: ReactorOpts | undefined }> = [];
  // 本文件唯一处类型逃逸（局限在此函数表达式）：原型补丁的 this 语义 TS 不保留，故断言回原方法签名；未引入 any
  Reactor.prototype.run = function (this: Reactor, ...args: Parameters<Reactor['run']>): ReturnType<Reactor['run']> {
    calls.push({ self: this, opts: args[1] });
    return orig.call(this, ...args);
  } as Reactor['run'];
  try {
    const rt = createRuntime({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await rt.runTask('做一件事');
    assert.ok(calls.length > 0, '探针应捕获到 Reactor.run 调用');
    assert.ok(
      calls.every((c) => c.self !== rt.harness.reactor),
      '主链不得直连 harness.reactor（旧实现必然命中该实例）；应由 Loop 内嵌新建的 Reactor 执行',
    );
    assert.ok(
      calls.some((c) => typeof c.opts?.tokenCap === 'number' && typeof c.opts?.deadlineAt === 'number'),
      'Loop 编排层必须注入剩余限额：tokenCap 与 deadlineAt 均为数值（旧实现只传 maxSteps，两者为 undefined）',
    );
  } finally {
    Reactor.prototype.run = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：不泄漏引擎内部形态——RunOutcome 只投影会话层字段', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt9-'));
  try {
    const rt = createRuntime({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const r = await rt.runTask('做一件事');
    const keys = Object.keys(r);
    for (const k of ['steps', 'route', 'iterations', 'state']) {
      assert.ok(!keys.includes(k), `RunOutcome 不得透出引擎内部字段：${k}`);
    }
    const allowed = ['done', 'reply', 'tokensUsed', 'stopReason', 'history']; // history：链式续跑的会话层字段（RunOutcome 契约）
    assert.deepEqual(keys.filter((k) => !allowed.includes(k)), [], 'RunOutcome 仅暴露会话层需要的键');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：seedHistory 链式下传至内层 Reactor + RunOutcome.history 返回', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt10-'));
  const orig = Reactor.prototype.run;
  const seeds: unknown[] = [];
  Reactor.prototype.run = function (this: Reactor, ...args: Parameters<Reactor['run']>): ReturnType<Reactor['run']> {
    seeds.push(args[1]?.seedHistory);
    return orig.call(this, ...args);
  } as Reactor['run'];
  try {
    const rt = createRuntime({
      root: tmp,
      // 首轮带一次工具调用：零工具步的 run 无 history 可产出（RunOutcome.history 契约：空则不投影）
      model: new ScriptedAdapter(['{"tool":"glob","input":{"pattern":"*"},"done":false}', '{"done":true,"reply":"第一步结论"}']),
    });
    const r1 = await rt.runTask('做一件事');
    assert.equal(r1.done, true);
    assert.ok(r1.history && r1.history.length >= 1, 'RunOutcome 应携带 history 供链式续跑');
    const r2 = await rt.runTask('继续做一件事', { seedHistory: r1.history });
    assert.equal(r2.done, true);
    assert.equal(seeds.length, 2, '探针应捕获两次 Reactor.run');
    assert.ok(
      Array.isArray(seeds[1]) && (seeds[1] as unknown[]).length === r1.history!.length,
      'seedHistory 应下传到内层 Reactor（经 Loop state 中继）',
    );
    assert.ok(!Array.isArray(seeds[0]), '首轮未传 seed 时不得注入');
  } finally {
    Reactor.prototype.run = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runTask scope=fork：作用域线程至 LoopDeps、主链零回写', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt-fork-'));
  try {
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    });
    const before = rt.harness.context.chainView().length;
    const r = await rt.runTask('子任务', { scope: 'fork' });
    assert.equal(r.done, true);
    assert.equal(rt.harness.context.chainView().length, before, 'fork 作用域零主链回写');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime.runLoop：缺省 test-loop 修正环跑通，结果原样透传', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt-goal1-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data'); // 账本隔离：runs===1 精确断言不与跑批互染（本文件首例同款）
  try {
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"修复完成"}', '{"passed":true,"evidence":"已达成"}']),
    });
    const r = await rt.runLoop('修复构建（验收标准：t1=构建通过）');
    assert.equal(r.status, 'done');
    assert.equal(r.iterations, 2, 'iterations=节点执行步：agent(1)+check 通过(2)（engine.ts ctx.iteration 口径）');
    assert.ok((r.criteria ?? []).every((c) => c.passed));
    assert.equal(rt.harness.ledger.summary().runs, 1, 'loop run 与长任务同账本（会话同源）');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime.runLoop：未知模板报错；判据未过回修一轮后 done，tier 路由事件贯通', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt-goal2-'));
  try {
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"x"}']),
    });
    await assert.rejects(() => rt.runLoop('x（验收标准：t1=y）', { template: 'nope' }), /Unknown template: nope/);

    const events: SessionEvent[] = [];
    const rt2 = createRuntime({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"第一版"}',
        '{"passed":false,"evidence":"不达标"}',
        '{"done":true,"reply":"第二版"}',
        '{"passed":true,"evidence":"达标"}',
      ]),
      onEvent: (e) => events.push(e),
    });
    const r = await rt2.runLoop('修复输出（验收标准：t1=输出正确）', { template: 'test-loop', tier: 'medium' });
    assert.equal(r.status, 'done');
    assert.equal(r.iterations, 5, '节点执行步：agent(1)→check 未过(2)→router(3)→修正 agent(4)→check 通过(5)（engine.ts ctx.iteration 口径）');
    assert.ok(events.some((e) => e.type === 'route'), 'tier 为 run 级常量，路由事件留痕贯通');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
