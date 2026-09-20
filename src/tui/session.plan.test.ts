import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PLAN_TASK_LABEL, SessionController } from './session';
import { getLanguage, setLanguage } from '../i18n';
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
    assert.ok(
      ctrl.getState().messages.some((m) => m.role === 'user' && m.text === '/plan 做一件事'),
      '用户斜杠输入应回显上屏（此前 /plan 整行蒸发）',
    );
    assert.equal(
      ctrl.getState().messages.filter((m) => m.text.includes('步骤A')).length,
      1,
      '计划正文只以确认卡上屏一次（规划轮流式/终稿不重复入档）',
    );
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    assert.equal(
      ctrl.getState().messages.filter((m) => m.role === 'assistant' && m.text.includes('步骤A 完成')).length,
      1,
      '步骤正文只随流式管线入档一次（runPlanItems 不再重复上屏）',
    );
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

test('/plan：确认裁决时点主动探测——起草后 SUNSHINE.md 变化 → 尾追过期/冲突说明（模型面+用户面）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-drift-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. 步骤A"}',
        '{"done":true,"reply":"步骤A 完成"}',
      ]),
    });
    await ctrl.submit('/plan 做一件事');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    // 起草后、确认前：磁盘 SUNSHINE.md 被外部修改（会话常量中途变化）
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), '# 项目\n\n新增的规范条目。\n');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const texts = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.ok(
      /changed since the plan was drafted|起草后会话常量已变化/.test(texts),
      '确认时点探测回执（用户面，过期/冲突说明）',
    );
    const chain = (
      ctrl as unknown as { runtime: { harness: { context: { chainView(): { action?: string }[] } } } }
    ).runtime.harness.context.chainView();
    assert.ok(chain.some((s) => s.action === 'notice'), '过期/冲突说明已尾追进链（模型面）');
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
      ctrl.getState().messages.some((m) => m.role === 'system' && m.text.includes('Usage: /plan')),
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
      ctrl.getState().messages.some((m) => m.role === 'system' && m.text.includes('planning unavailable now')),
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
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
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
    assert.match(texts, /Plan confirmation/);
    assert.match(texts, /改 A 文件/);
    assert.equal(rt.harness.ledger.summary().runs, 1, '规划 run 同样落账本（换通道不丢成本观测）');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
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
      !/你的角色：规划师|Your role: Planner/.test(c.goal),
      '规划段不得再走 graph 角色节点框定（旧形态 goal 含角色行；角色框定已降为提示词级，且角色行为英文单语）',
    );
    assert.ok(c.goal.includes(PLAN_TASK_LABEL), '规划指令应经主链下发（主链提示词级角色框定）');
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

test('/plan：tokens 与命中率窗口整场累计——步骤间不重置（规划+各步共用一个窗口）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-planusage-'));
  try {
    const replies = [
      '{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}',
      '{"done":true,"reply":"步骤A 完成"}',
      '{"done":true,"reply":"步骤B 完成"}',
    ];
    let call = 0;
    const model = {
      provider: 'usage-script',
      complete: async (
        _p: string,
        hooks?: { onUsage?: (t: number) => void; onCache?: (t: number) => void; onPrompt?: (t: number) => void },
      ) => {
        hooks?.onPrompt?.(1000);
        hooks?.onCache?.(500);
        hooks?.onUsage?.(30);
        return replies[Math.min(call++, replies.length - 1)];
      },
    };
    const ctrl = new SessionController({ root: tmp, model });
    await ctrl.submit('/plan 做一件事');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const m = ctrl.getState().metrics;
    assert.equal(m.turnPromptTokens, 3000, '三次模型调用（规划+两步）prompt 本轮累计，步骤间不重置');
    assert.equal(m.turnCacheTokens, 1500, '缓存命中同样本轮累计');
    assert.equal(m.sessionPromptTokens, 3000, '会话累计分母与本轮同步（单任务会话）');
    assert.equal(m.sessionCacheTokens, 1500, '会话累计分子与本轮同步（单任务会话）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：模型上下文最小化——不见计划清单与阶段编号，每轮只见前序结论+当前指令', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-planminimal-'));
  try {
    const prompts: string[] = [];
    const replies = [
      '{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}',
      '{"done":true,"reply":"步骤A 完成"}',
      '{"done":true,"reply":"步骤B 完成"}',
    ];
    let call = 0;
    const model = {
      provider: 'minimal-script',
      complete: async (p: string) => {
        prompts.push(p);
        return replies[Math.min(call++, replies.length - 1)];
      },
    };
    const ctrl = new SessionController({ root: tmp, model });
    await ctrl.submit('/plan 做一件事');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    // 两个执行轮的 prompt 不得包含计划清单全文（编号行「2. 步骤B」是清单形态）
    const step1 = prompts[1];
    const step2 = prompts[2];
    assert.ok(!step1.includes('2. 步骤B'), 'Step1 上下文不得出现后续步骤（模型只做当前指令）');
    assert.ok(!step1.includes('Step 1/2') && !step1.includes('1/2'), '指令行不得携带阶段编号');
    // 步号改为 \d+ 容忍（规格 §3.1：收口说明行在后台完成时尾追，链行编号可能因 notice 行插入而后移；断言语义不变）
    assert.match(step1, /\d+: task -> Current instruction: 步骤A/, '当前指令以链行进入 history（缺省链基）');
    assert.match(step2, /\d+: reply -> 步骤A 完成/, '前序结论行经收尾回写入链');
    assert.match(step2, /\d+: task -> Current instruction: 步骤B/, '下一指令继续尾部追加');
    // fork 模型前缀连续：稳定段+链前缀冻结，相邻步骤差异只在尾部新链行（§11 相邻步严格前缀）
    assert.ok(step2.startsWith(step1), '相邻步骤 prompt 严格逐字节前缀连续');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：zh 语言——链行仍英文单语（§15：写链面不进语言轴；用后复原）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-planminimal-zh-'));
  const prev = getLanguage();
  try {
    setLanguage('zh');
    const prompts: string[] = [];
    const replies = [
      '{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}',
      '{"done":true,"reply":"步骤A 完成"}',
      '{"done":true,"reply":"步骤B 完成"}',
    ];
    let call = 0;
    const model = {
      provider: 'minimal-script-zh',
      complete: async (p: string) => {
        prompts.push(p);
        return replies[Math.min(call++, replies.length - 1)];
      },
    };
    const ctrl = new SessionController({ root: tmp, model });
    await ctrl.submit('/plan 做一件事');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    assert.match(prompts[1], /task -> Current instruction: 步骤A/, 'zh 下当前指令链行仍英文单语（写链面恒英文，步骤文本是数据）');
    // fork 模型：goal 槽取消（runTask 首参=当前步骤文本，不再有恒定协议段 goal），前缀连续升级为相邻步严格逐字节前缀
    assert.ok(prompts[2].startsWith(prompts[1]), 'zh 下相邻步骤 prompt 严格逐字节前缀连续');
  } finally {
    setLanguage(prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('plan 步骤全量轨迹入链（废除只留结论行）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-chain-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}',
        '{"tool":"exec","input":{"command":"echo a"},"done":false}',
        '{"done":true,"reply":"步骤A 完成"}',
        '{"done":true,"reply":"步骤B 完成"}',
      ]),
    });
    await ctrl.submit('/plan 做一件事');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const chain = ctrl.context.chainView();
    assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('步骤A')), '步骤指令行入链');
    assert.ok(chain.some((s) => s.action === 'tool-call' && s.observation.includes('[tool] exec')), '步骤 1 的工具观察行仍在链上（不再裁剪）');
    assert.ok(chain.some((s) => s.action === 'tool-result' && s.observation.includes('a')), '步骤 1 的结果行同链回写');
    assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('步骤B')), '步骤 2 指令行尾追');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('规划轮不进链：verbose 提示词与规划结论零主链回写', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-fork-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}']),
    });
    await ctrl.submit('/plan 做一件事');
    const text = ctrl.context.chainView().map((s) => s.observation).join('\n');
    assert.ok(!text.includes(PLAN_TASK_LABEL), '规划轮 verbose 提示词不得入链');
    assert.ok(!ctrl.context.chainView().some((s) => s.action === 'reply'), '规划轮结论行不回主链（fork 隔离）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
