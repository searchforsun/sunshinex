import { textReplyToChatFace } from '../model/chat-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PLAN_TASK_LABEL, SessionController } from './session';
import { parseJournalFile, sessionsDir } from './session-journal';
import { resolveDataDir } from '../config/data-dir';
import { getLanguage, setLanguage } from '../i18n';
import { createKernelRuntime } from '../session/runtime';
import type { KernelRuntime, RunOutcome } from '../session/runtime';
import { ScriptedAdapter } from '../model/adapter';
import { Reactor, ReactorOpts } from '../harness/reactor';
import { LONG_TASK_TIMEOUT_MS } from '../loop/templates';

/** 轮询等待辅助（拒绝重入/修订轮为多轮异步流程,状态非单步可达;submit 在 awaiting-plan 放行后流程仍在途） */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout: ' + what);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function chainOf(ctrl: SessionController): { action?: string; observation: string }[] {
  return ctrl.context.chainView() as unknown as { action?: string; observation: string }[];
}

function messageTexts(ctrl: SessionController): string {
  return ctrl.getState().messages.map((m) => m.text).join('\n');
}

test('/plan：规划（planFlow 规划轮）→ 确认 → 逐项执行 → 待办同步', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan1-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        // 规划轮：planFlow 规划提示词 + Reactor JSON 协议产出计划书（reply 正文编号行兜底,todos 空）
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
    // 确认卡=计划书全文形态（spec §4.3）：doc + 分隔线 + 编号步骤 + 键位提示
    const card = ctrl.getState().messages.at(-1)?.text ?? '';
    assert.match(card, /Plan confirmation/, '确认卡标题');
    assert.match(card, /y approve \/ n reject with feedback \/ Esc discard|y 批准 \/ n 拒绝（附反馈）/, '确认卡键位提示（n=拒绝附反馈）');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    assert.equal(
      ctrl.getState().messages.filter((m) => m.role === 'assistant' && m.text.includes('步骤A 完成')).length,
      1,
      '步骤正文只随流式管线入档一次（runPlanItems 不再重复上屏）',
    );
    const todos = ctrl.getState().todos;
    assert.equal(todos.length, 2, '计划解析出两条待办');
    assert.ok(todos.every((t) => t.status === 'completed'), '逐项执行后全部完成');
    assert.equal(ctrl.getState().status, 'idle');
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
    const texts = messageTexts(ctrl);
    assert.ok(
      /changed since the plan was drafted|起草后会话常量已变化/.test(texts),
      '确认时点探测回执（用户面，过期/冲突说明）',
    );
    assert.ok(chainOf(ctrl).some((s) => s.action === 'notice'), '过期/冲突说明已尾追进链（模型面）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：缺目标给用法提示；非 idle 拒绝并发规划', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan3-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      mode: 'acceptEdits',
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
    await waitFor(() => ctrl.getState().status === 'awaiting-approval', '审批挂起');
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
    const rt = createKernelRuntime({
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
    const texts = messageTexts(ctrl);
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
  // 仓内两处之一（另见 src/session/runtime.test.ts）类型逃逸（局限在此函数表达式）：原型补丁的 this 语义 TS 不保留，故断言回原方法签名；未引入 any
  Reactor.prototype.run = function (this: Reactor, ...args: Parameters<Reactor['run']>): ReturnType<Reactor['run']> {
    calls.push({ self: this, goal: String(args[0].goal), opts: args[1], at: Date.now() });
    return orig.call(this, ...args);
  } as Reactor['run'];
  try {
    const rt = createKernelRuntime({
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

test('/plan：轮窗=run(P9 内核口径)——每步骤各自 turn 窗,会话累计跨步骤持续', async () => {
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
      chat: textReplyToChatFace(async (
        _p: string,
        hooks?: { onUsage?: (t: number) => void; onCache?: (t: number) => void; onPrompt?: (t: number) => void },
      ) => {
        hooks?.onPrompt?.(1000);
        hooks?.onCache?.(500);
        hooks?.onUsage?.(30);
        return replies[Math.min(call++, replies.length - 1)];
      }),
    };
    const ctrl = new SessionController({ root: tmp, model });
    await ctrl.submit('/plan 做一件事');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const m = ctrl.getState().metrics;
    // P9 统计面口径:turn 窗=run(每步骤 done 后新开轮即重置),会话累计跨步骤持续——
    // 任务整场总量由任务收尾统计行(会话累计差值基线)承载
    assert.equal(m.turnPromptTokens, 1000, 'turn 窗=末个 run:最后一步的 prompt 轮窗(前步骤已随 done 收窗)');
    assert.equal(m.turnCacheTokens, 500, '缓存命中同样末轮窗');
    assert.equal(m.sessionPromptTokens, 3000, '会话累计跨步骤持续(三次调用求和)');
    assert.equal(m.sessionCacheTokens, 1500, '会话缓存累计跨步骤持续');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：执行段上下文=已批准计划书全文+当前指令（spec §4.4 收编旧「上下文最小化」裁定）', async () => {
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
      chat: textReplyToChatFace(async (p: string) => {
        prompts.push(p);
        return replies[Math.min(call++, replies.length - 1)];
      }),
    };
    const ctrl = new SessionController({ root: tmp, model });
    await ctrl.submit('/plan 做一件事');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    // spec §4.4：批准后计划书全文入链（ChainAction 'plan'）——执行段第一步上下文天然携带完整计划书，
    // 「上下文最小化」的清单不可见边界自旧裁定（不见计划清单）上移为「不见未批准的计划」（§4.4 立面）
    const step1 = prompts[1];
    const step2 = prompts[2];
    assert.ok(step1.includes('1. 步骤A') && step1.includes('2. 步骤B'), '执行段上下文应携带已批准计划书全文');
    assert.ok(!step1.includes('Step 1/2') && !step1.includes('1/2'), '指令行不得携带阶段编号');
    // 步号改为 \d+ 容忍（规格 §3.1：收口说明行在后台完成时尾追，链行编号可能因 notice 行插入而后移；断言语义不变）
    assert.match(step1, /Current instruction: 步骤A/, '当前指令以链行进入 history（缺省链基）');
    assert.match(step2, /步骤A 完成/, '前序结论行经收尾回写入链');
    assert.match(step2, /Current instruction: 步骤B/, '下一指令继续尾部追加');
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
      chat: textReplyToChatFace(async (p: string) => {
        prompts.push(p);
        return replies[Math.min(call++, replies.length - 1)];
      }),
    };
    const ctrl = new SessionController({ root: tmp, model });
    await ctrl.submit('/plan 做一件事');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    assert.match(prompts[1], /Current instruction: 步骤A/, 'zh 下当前指令链行仍英文单语（写链面恒英文，步骤文本是数据）');
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
    const chain = chainOf(ctrl);
    assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('步骤A')), '步骤指令行入链');
    assert.ok(chain.some((s) => s.action === 'tool-call' && s.observation.includes('[tool] exec')), '步骤 1 的工具观察行仍在链上（不再裁剪）');
    assert.ok(chain.some((s) => s.action === 'tool-result' && s.observation.includes('a')), '步骤 1 的结果行同链回写');
    assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('步骤B')), '步骤 2 指令行尾追');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('规划轮不进链：verbose 提示词与规划结论零主链回写（fork 隔离;批准前链上无计划书行）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-fork-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}']),
    });
    await ctrl.submit('/plan 做一件事');
    const text = chainOf(ctrl).map((s) => s.observation).join('\n');
    assert.ok(!text.includes(PLAN_TASK_LABEL), '规划轮 verbose 提示词不得入链');
    assert.ok(!chainOf(ctrl).some((s) => s.action === 'reply'), '规划轮结论行不回主链（fork 隔离）');
    assert.ok(!chainOf(ctrl).some((s) => s.action === 'plan'), '批准前链上无计划书行（chainAppendPlan 只在批准后一次）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan 步骤推进：todos 事件序列记录 in_progress→completed 全轨迹（规格 D7）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-todo-'));
  // 现场校正：test-env 按测试文件钉共享数据目录（readdir 会捞到同文件早前用例的档案），故本用例按仓内既有模式
  // （同文件「/plan 规划段经主链」用例）把数据目录钉到 tmp 内并在 finally 恢复，使 journal 检索零歧义。
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
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
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const todos = ctrl.getState().todos;
    assert.deepEqual(todos, [
      { text: '步骤A', status: 'completed' },
      { text: '步骤B', status: 'completed' },
    ]);
    // journal todos 事件流：种子(全 pending) → A in_progress → A completed → B in_progress → B completed
    const dir = sessionsDir(resolveDataDir(tmp));
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    assert.ok(file, '会话 journal 已建档');
    const parsed = parseJournalFile(path.join(dir, file!));
    const seq = parsed.events.filter((e) => e.t === 'todos').map((e) => e.items);
    assert.ok(seq.length >= 5, '种子+逐步推进均落 todos 事件');
    assert.deepEqual(seq[0], [{ text: '步骤A', status: 'pending' }, { text: '步骤B', status: 'pending' }], '种子全 pending');
    assert.deepEqual(
      seq.find((items) => items.some((it) => it.text === '步骤A' && it.status === 'in_progress')),
      [{ text: '步骤A', status: 'in_progress' }, { text: '步骤B', status: 'pending' }],
      '步骤A 开始即 in_progress',
    );
    assert.deepEqual(seq[seq.length - 1], todos, '末条与最终状态一致');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 以下为 spec §4.2-4.4 重造新增五例 + rider 边界钉 ──

test('/plan：批准后计划书全文入链（ChainAction plan，先于执行段指令行）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-chainplan-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"# 计划\\n背景说明\\n1. 步骤A"}',
        '{"done":true,"reply":"步骤A 完成"}',
      ]),
    });
    await ctrl.submit('/plan 做一件事');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const chain = chainOf(ctrl);
    const planIdx = chain.findIndex((s) => s.action === 'plan');
    assert.ok(planIdx >= 0, '计划书行入链（ChainAction plan，批准后一次）');
    assert.ok(
      chain[planIdx].observation.includes('# 计划') && chain[planIdx].observation.includes('背景说明'),
      '计划书全文（含正文段落,非仅编号行）随行入链',
    );
    const step1Idx = chain.findIndex((s) => s.action === 'task' && s.observation.includes('步骤A'));
    assert.ok(step1Idx > planIdx, '计划书行先于执行段指令行——执行段首步经链读到计划书（同链 seedHistory 语义）');
    assert.equal(chain.filter((s) => s.action === 'plan').length, 1, '计划书行恰一次（不随轮次/步骤重复）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：规划轮挂 read-only——模型调 write 被拒且不影响规划产出（判别力锚）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-ro-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        // ScriptedAdapter DSL 实际协议形态（parseScriptStep 单工具出牌）——brief 示意的 tool_calls JSON 不适配
        '{"tool":"write","input":{"path":"pwned.txt","content":"x"}}',
        '{"done":true,"reply":"# 计划\\n背景…\\n1. 唯一步骤"}',
        '{"done":true,"reply":"完成"}',
      ]),
    });
    await ctrl.submit('/plan 写个文件');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    assert.ok(!fs.existsSync(path.join(tmp, 'pwned.txt')), '规划轮绝不能产生文件副作用');
    const todos = ctrl.getState().todos;
    assert.equal(todos.length, 1);
    assert.equal(todos[0]?.status, 'completed', '计划照常产出并执行');
    assert.equal(ctrl.getState().status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：拒绝附反馈 → 修订轮重入（前轮计划书+反馈进规划提示词）→ 批准执行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-rev-'));
  try {
    const prompts: string[] = [];
    const replies = [
      '{"done":true,"reply":"# 计划一\\n1. 步骤A"}',
      '{"done":true,"reply":"# 计划二\\n1. 步骤B\\n2. 步骤C"}',
      '{"done":true,"reply":"步骤B 完成"}',
      '{"done":true,"reply":"步骤C 完成"}',
    ];
    let call = 0;
    const model = {
      provider: 'revise-script',
      chat: textReplyToChatFace(async (p: string) => {
        prompts.push(p);
        return replies[Math.min(call++, replies.length - 1)];
      }),
    };
    const ctrl = new SessionController({ root: tmp, model });
    await ctrl.submit('/plan 做一件事');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    assert.match(ctrl.pendingPlan?.doc ?? '', /计划一/, 'pendingPlan 携带计划书全文（doc 字段）');
    await ctrl.confirmPlan(false, '换个方案');
    // 修订轮：状态回 running → 第二张确认卡（修订版计划书）
    await waitFor(() => ctrl.getState().status === 'awaiting-plan' && (ctrl.pendingPlan?.doc ?? '').includes('计划二'), '修订轮确认卡');
    assert.match(
      messageTexts(ctrl),
      /Revising plan with your feedback \(round 2\/3\)|按反馈修订计划中（第 2\/3 轮）/,
      '修订轮回执上屏',
    );
    assert.equal((ctrl.pendingPlan?.items ?? []).join(','), '步骤B,步骤C', 'pendingPlan 更新为修订版步骤');
    // 修订轮规划提示词：前轮计划书（宿主接缝拼装,spec §4.3 rider）+ 反馈文本都在场
    assert.ok(
      prompts[1]?.includes('计划一') && prompts[1]?.includes('换个方案'),
      '修订轮 prompt 应携带前轮计划书与用户反馈',
    );
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const chain = chainOf(ctrl);
    const planRows = chain.filter((s) => s.action === 'plan');
    assert.equal(planRows.length, 1, '计划书只以最终批准版入链一次');
    assert.ok(planRows[0].observation.includes('计划二'), '入链的是修订批准版');
    assert.ok(!planRows[0].observation.includes('计划一'), '被拒版本不入链');
    const todos = ctrl.getState().todos;
    assert.deepEqual(todos.map((t) => t.text), ['步骤B', '步骤C'], '按修订版逐项执行');
    assert.ok(todos.every((t) => t.status === 'completed'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：3 轮拒绝超限回 idle 不执行（驳回环收口）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-exhaust-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"1. 只有一项"}']),
    });
    await ctrl.submit('/plan 另一件事');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    for (let i = 0; i < 3; i++) {
      await ctrl.confirmPlan(false);
      if (i < 2) await waitFor(() => ctrl.getState().status === 'awaiting-plan', `第 ${i + 2} 轮确认卡`);
    }
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle', '超限收尾回输入态');
    assert.equal(ctrl.getState().todos.length, 0, '拒绝超限不产生待办');
    assert.match(
      messageTexts(ctrl),
      /Plan rejected 3 times — stopped, nothing executed|计划已被拒 3 轮——已停止，未执行任何步骤/,
      '超限如实回执',
    );
    assert.ok(!chainOf(ctrl).some((s) => s.action === 'plan'), '未批准不注入计划书');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：批准后落 acceptEdits——基档真切换+回执上屏+asker 接线补位（spec §4.4 绑定,审查推翻「只回执」旧裁定）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-mode-'));
  try {
    // 缺省 mode → harness 缺省基档 full-access：批准后应真切换到 acceptEdits
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. 步骤A"}',
        '{"done":true,"reply":"步骤A 完成"}',
      ]),
    });
    type GuardFace = {
      mode: string;
      preToolUse(t: string, i: unknown): { allowed: boolean; ask?: boolean };
      nextApprovalId(): string;
      resolveAsk(req: { id: string; kind: 'write'; subject: string; reason?: string }): Promise<'allow' | 'always' | 'deny' | null>;
    };
    const guard = (ctrl as unknown as { runtime: { harness: { security: GuardFace } } }).runtime.harness.security;
    assert.equal(guard.mode, 'full-access', '批准前基档=缺省 full-access');
    await ctrl.submit('/plan 做一件事');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    assert.match(
      messageTexts(ctrl),
      /Switched to workspace edit mode|已切换到工作区编辑档/,
      '批准后落 acceptEdits 回执（spec §4.4）',
    );
    assert.equal(guard.mode, 'acceptEdits', '批准后基档真切换（不再只回执）');
    // acceptEdits 语义判别：非只读 Bash 从 full-access 自动放行变为 ask 标记（后续任务 guard 判定按新档）
    const d = guard.preToolUse('Bash', { command: 'curl example.com' });
    assert.ok(d.allowed === false && d.ask === true, `非只读命令应转 ask（acceptEdits 语义）,实得 ${JSON.stringify(d)}`);
    // asker 接线判别（终审修复）：非 acceptEdits 启动的会话构造器不挂 asker——批准实切后必须补挂
    // suspendAsker,否则 ask 分支宁停硬拒（resolveAsk null）、批准续段写步骤必停。可观测面沿
    // guard.boundary 先例:接线后 resolveAsk 不再 null 直返,而是经 asker 挂起等回填（挂起登记可观测）
    let decided: 'allow' | 'always' | 'deny' | null | 'unset' = 'unset';
    const askP = guard.resolveAsk({ id: guard.nextApprovalId(), kind: 'write', subject: path.join(tmp, 'a.txt'), reason: 'r' }).then((r) => { decided = r; });
    await waitFor(() => (ctrl as unknown as { pendingApproval?: unknown }).pendingApproval !== undefined, 'asker 挂起登记（接线生效,非 null 硬拒）');
    await ctrl.resolveApproval('deny');
    await askP;
    assert.equal(decided, 'deny', 'ask 决策经 asker 解析回传（不再 null）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：等待批准中中断——流程中止回 idle,产物不注入不执行,后续任务正文不被归档抑制位吞掉', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-int-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"# 计划\\n1. 步骤A"}',
        '{"done":true,"reply":"新任务完成"}',
      ]),
    });
    await ctrl.submit('/plan 做一件事');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    assert.equal(ctrl.interrupt(), true);
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle', '中断后回输入态');
    assert.equal(ctrl.getState().todos.length, 0, '中断后不执行不建待办');
    assert.match(messageTexts(ctrl), /Planning interrupted|规划已中断/, '中断如实回执（planFlow aborted-interrupted）');
    assert.ok(!chainOf(ctrl).some((s) => s.action === 'plan'), '中断路径产物不注入链（rider:signal 边界）');
    assert.ok(!messageTexts(ctrl).includes('Plan discarded'), '在途中断不走旧式放弃回执');
    // planReplyNoArchive 复位验证：中断后新任务的正文正常入档（不被抑制位吞掉）
    await ctrl.submit('新任务');
    await ctrl.waitIdle();
    assert.ok(
      ctrl.getState().messages.some((m) => m.role === 'assistant' && m.text.includes('新任务完成')),
      '中断后新任务正文应正常入档',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：执行段中断检查在循环顶——被跳过步骤的指令行不入链（竞窗:步骤完成后信号落地,终审修复）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-abort-top-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}', // 规划包:两步
        '{"done":true,"reply":"步骤A 完成"}', // 执行包 A
        '{"done":true,"reply":"步骤B 完成"}', // 执行包 B(竞窗中止后不应到达)
      ]),
    });
    // 竞窗注入:runTask 返回后（reactor 末次信号检查已过、stopReason 仍 done）信号才落地——
    // 复现「上一步完成后中断」的真实窗口;第 1 次调用是规划轮,第 2 次是执行段步骤 A
    const orig = ctrl.runtime.runTask.bind(ctrl.runtime);
    let calls = 0;
    ctrl.runtime.runTask = (goal: string, opts?: Parameters<KernelRuntime['runTask']>[1]): Promise<RunOutcome> =>
      (orig(goal, opts) as Promise<RunOutcome>).then((r) => {
        calls += 1;
        if (calls === 2) (ctrl as unknown as { taskAbort?: AbortController }).taskAbort?.abort();
        return r;
      });
    await ctrl.submit('/plan 做一件事');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const chain = chainOf(ctrl);
    assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('步骤A')), '步骤 A 指令行入链（已执行）');
    assert.ok(!chain.some((s) => s.action === 'task' && s.observation.includes('步骤B')), '被跳过步骤 B 的指令行不入链（检查在循环顶,旧形态留孤儿链行）');
    assert.deepEqual(
      ctrl.getState().todos.map((t) => ({ text: t.text, status: t.status })),
      [{ text: '步骤A', status: 'completed' }, { text: '步骤B', status: 'pending' }],
      '步骤 B 保持 pending（旧形态先标 in_progress 再查中断）',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
