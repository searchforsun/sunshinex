import { textReplyToChatFace } from '../model/chat-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { CodedToolError } from './tools';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { makeDispatchTool, normalizeSpawnInput, SubagentRunner } from './subagent';
import { WAKE_HINT } from './tasks';
import type { ModelTier, SubagentSpawnInput } from '../types';

const SPAWN_ENVELOPE = JSON.stringify({ tool: 'spawn', input: { prompt: '子任务：产出报告', label: 'w' } });

test('spawn 端到端：同步报告 = 该轮工具观察，Runner 结论行入主链（full-access）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-e2e-'));
  try {
    const model = new ScriptedAdapter([
      SPAWN_ENVELOPE,
      JSON.stringify({ done: true, reply: '子任务报告' }),
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    const h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true);
    const spawnResultRow = r.steps.find((s) => s.action === 'tool-result' && s.observation.includes('子任务报告'));
    assert.ok(spawnResultRow, 'spawn 报告应作为该轮观察回流（role:tool 配对面）');
    const chain = h.context.chainView();
    assert.ok(
      chain.some((s) => s.action === 'node' && s.observation.startsWith('[w] ') && s.observation.includes('子任务报告')),
      `Runner 终态应回写一行 [label] 结论行，实际链：${JSON.stringify(chain)}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('spawn 免审批：acceptEdits 模式不弹审批卡照常派生（asker 零调用；子面无 spawn 防递归）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-acceptedits-'));
  try {
    const model = new ScriptedAdapter([
      SPAWN_ENVELOPE,
      JSON.stringify({ done: true, reply: '子任务报告' }),
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    const h = new Harness({ root: tmp, mode: 'acceptEdits', model, learnSkills: false });
    let asks = 0;
    h.security.setAsker(async () => {
      asks++;
      return 'deny';
    });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true, 'acceptEdits 下 spawn 免审批应照常完成');
    assert.equal(asks, 0, 'asker 不得被调用（spawn 无直接 IO 副作用）');
    // 子智能体工具面收口：Runner 子面恒无 spawn（Task 3 deriveChildRegistry 已测）；此处验证主链面 spawn 存在
    assert.ok(h.tools.has('spawn'), '主链工具面持有 spawn');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('read-only 模式：spawn 被只读闸门拦截（子智能体可产生写副作用，不属于只读面）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-readonly-'));
  try {
    const h = new Harness({ root: tmp, mode: 'read-only', model: new ScriptedAdapter([]), learnSkills: false });
    const r = await h.tools.execute('spawn', { prompt: 'x' }, h.safety);
    assert.ok(!r.ok && r.error.code === 'COMMAND_DENIED', `read-only 模式应拒绝 spawn，实际 ${JSON.stringify(r)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('spawn 输入校验：双缺 INVALID_ARG / background 两段式开通（D6）/ tools 未知名 INVALID_ARG', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-args-'));
  try {
    const h = new Harness({ root: tmp, mode: 'full-access', model: new ScriptedAdapter([]), learnSkills: false });
    const spawn = h.tools.get('spawn');
    assert.ok(spawn, 'spawn 应已注册');
    await assert.rejects(
      spawn!.executor({}),
      (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG',
    );
    // T2 起 background:true 走两段式（规格 D6）：不再 NOT_SUPPORTED，改为立即返回任务回执
    const bg = (await spawn!.executor({ prompt: 'x', background: true })) as { stdout: string };
    assert.match(bg.stdout, /^\S+ started in background/, '两段式立即返回任务回执（动态 id：业务-时间-随机方言；2026-11-17 根治裸 id 起头+携任务名）');
    // 2026-11-14 spawn tools 口封闭:模型传 tools 亦被 normalize 剥除(不校验不生效)
    const narrowed = (await spawn!.executor({ prompt: 'x', tools: ['ghost'] })) as { stdout: string };
    assert.ok(narrowed.stdout.length > 0, 'tools 幽灵名不再 INVALID_ARG——参数已从模型面撤除,归一即剥');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('同轮 8 个 spawn 并行：批上限与并发上限同量级对齐，8 个全部完成（护栏零误伤）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-conc-'));
  try {
    let gateResolve!: () => void;
    const gate = new Promise<void>((res) => {
      gateResolve = res;
    });
    let calls = 0;
    const model: ModelAdapter = {
      provider: 'probe',
      chat: textReplyToChatFace(async () => {
        calls++;
        if (calls === 1) {
          return JSON.stringify({
            tools: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ tool: 'spawn', input: { prompt: `p${i}`, label: 'w' } })),
            done: false,
          });
        }
        if (calls <= 9) {
          await gate;
          return JSON.stringify({ done: true, reply: '子完成' });
        }
        return JSON.stringify({ done: true, reply: '主链完成' });
      }),
    } as ModelAdapter;
    const h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false });
    const runP = h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    // 确定性等待：等主链 1 帧 + 8 个子智能体全部进入挂起（calls>=9）再放闸，替代固定 50ms 在高并发下的竞态窗口
    for (let i = 0; i < 200 && calls < 9; i++) await new Promise((res) => setTimeout(res, 10));
    gateResolve();
    const r = await runP;
    const obs = r.steps.map((s) => s.observation).join('\n');
    assert.ok(r.steps.some((s) => (s.action ?? '').includes('spawn') || s.observation.includes('spawn')), '并行 spawn 步应存在');
    assert.equal((obs.match(/子完成/g) ?? []).length, 8, '8 个并发子智能体应全部正常完成（上限提升后批内不触顶）');
    assert.ok(!/limit reached|已达上限/.test(obs), '批上限 8 = 并发上限 8，同量级下护栏不误伤');
    // 第 9 个并发的拒绝路径由 runner 缝专项用例锁定（subagent.test.ts 并发护栏），reactor 单批无法超过批上限 8
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── sunx 工具面（2026-11-15 P1 Task 3）：dispatch_task 分派即返回（spawn 家族同缝，恒后台两段式）──

test('dispatch_task executor：spec→spawnBackground 带 tier 覆盖透传；回执含 taskId 与 wakeHint；双缺 INVALID_ARG；schema 无 tools 参数', async () => {
  const calls: Array<{ input: SubagentSpawnInput; opts?: { tier?: ModelTier } }> = [];
  const stub = {
    validateSpawnInput: (raw: SubagentSpawnInput): void => {
      const i = normalizeSpawnInput(raw);
      if (!i.agent_id && !i.prompt) throw new CodedToolError('INVALID_ARG', 'agent_id and prompt are both missing');
    },
    spawnBackground: (input: SubagentSpawnInput, opts?: { tier?: ModelTier }) => {
      calls.push({ input, ...(opts !== undefined ? { opts } : {}) });
      return { taskId: 'task-x-ts01-ab12', outputFilePath: path.join('tmp', 'x.log'), wakeHint: WAKE_HINT };
    },
  } as unknown as SubagentRunner;
  const tool = makeDispatchTool(stub);
  assert.equal(tool.name, 'dispatch_task', '工具名单点：dispatch_task');
  // spawn tools 口已封闭（2026-11-14 裁定）：分派工具不携带 tools 参数（模型面无工具清单分叉口）
  const props = (tool.parameters?.properties ?? {}) as Record<string, unknown>;
  assert.equal(
    props.tools,
    undefined,
    'dispatch_task schema 不得有 tools 参数（spawn tools 口封闭）',
  );
  const r = await tool.executor({ spec: 'do the thing with acceptance', agent_id: null, label: 'w', tier: 'large', isolation: null });
  assert.equal(calls.length, 1, '分派即返回：恰一次 spawnBackground');
  assert.equal(calls[0]!.input.prompt, 'do the thing with acceptance', 'spec 承载自包含简报');
  assert.equal(calls[0]!.input.agent_id, undefined, 'JSON null 归一为缺席（normalizeSpawnInput 同缝）');
  assert.equal(calls[0]!.opts?.tier, 'large', 'tier 覆盖透传 spawnBackground');
  assert.match(r.stdout, /^task-x-ts01-ab12 started in background /, '回执与 spawn 后台分支同形：<id> started in background — <名> (output: <path>)（2026-11-17 根治:裸 id+携任务名）');
  assert.ok(r.stdout.includes('You need not wait for it'), '回执尾追 wakeHint（收轮等唤醒）');
  // tier 缺席（null/字面缺）→ 不覆盖（继承会话档）
  await tool.executor({ spec: 'second', tier: null });
  assert.equal(calls[1]!.opts?.tier, undefined, 'tier=null 归一缺席，零覆盖');
  // 双缺（spec 与 agent_id 均缺）→ INVALID_ARG fail-fast
  await assert.rejects(
    tool.executor({ spec: null, agent_id: null }),
    (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG',
  );
});
