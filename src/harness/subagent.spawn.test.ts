import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { CodedToolError } from './tools';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';

const SPAWN_ENVELOPE = JSON.stringify({ tool: 'spawn', input: { prompt: '子任务：产出报告', label: 'w' } });

test('spawn 端到端：同步报告 = 该轮工具观察，Runner 结论行入主链（dontAsk）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-e2e-'));
  try {
    const model = new ScriptedAdapter([
      SPAWN_ENVELOPE,
      JSON.stringify({ done: true, reply: '子任务报告' }),
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    const h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false });
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

test('spawn 免审批：manual 模式不弹审批卡照常派生（asker 零调用；子面无 spawn 防递归）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-manual-'));
  try {
    const model = new ScriptedAdapter([
      SPAWN_ENVELOPE,
      JSON.stringify({ done: true, reply: '子任务报告' }),
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    const h = new Harness({ root: tmp, mode: 'manual', model, learnSkills: false });
    let asks = 0;
    h.security.setAsker(async () => {
      asks++;
      return 'deny';
    });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true, 'manual 下 spawn 免审批应照常完成');
    assert.equal(asks, 0, 'asker 不得被调用（spawn 无直接 IO 副作用）');
    // 子代理工具面收口：Runner 子面恒无 spawn（Task 3 deriveChildRegistry 已测）；此处验证主链面 spawn 存在
    assert.ok(h.tools.has('spawn'), '主链工具面持有 spawn');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('plan 模式：spawn 被只读闸门拦截（子代理可产生写副作用，不属于只读面）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-plan-'));
  try {
    const h = new Harness({ root: tmp, mode: 'plan', model: new ScriptedAdapter([]), learnSkills: false });
    const r = await h.tools.execute('spawn', { prompt: 'x' }, h.safety);
    assert.ok(!r.ok && r.error.code === 'COMMAND_DENIED', `plan 模式应拒绝 spawn，实际 ${JSON.stringify(r)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('spawn 输入校验：双缺 INVALID_ARG / background NOT_SUPPORTED / tools 未知名 INVALID_ARG', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-args-'));
  try {
    const h = new Harness({ root: tmp, mode: 'dontAsk', model: new ScriptedAdapter([]), learnSkills: false });
    const spawn = h.tools.get('spawn');
    assert.ok(spawn, 'spawn 应已注册');
    await assert.rejects(
      spawn!.executor({}),
      (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG',
    );
    await assert.rejects(
      spawn!.executor({ prompt: 'x', background: true }),
      (e: unknown) => e instanceof CodedToolError && e.code === 'NOT_SUPPORTED',
    );
    await assert.rejects(
      spawn!.executor({ prompt: 'x', tools: ['ghost'] }),
      (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('同轮 5 个 spawn 并行：第 5 个并发拒绝、其余 4 个完成（护栏不排队）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-conc-'));
  try {
    let gateResolve!: () => void;
    const gate = new Promise<void>((res) => {
      gateResolve = res;
    });
    let calls = 0;
    const model: ModelAdapter = {
      provider: 'probe',
      complete: async () => {
        calls++;
        if (calls === 1) {
          return JSON.stringify({
            tools: [1, 2, 3, 4, 5].map((i) => ({ tool: 'spawn', input: { prompt: `p${i}`, label: 'w' } })),
            done: false,
          });
        }
        if (calls <= 5) {
          await gate;
          return JSON.stringify({ done: true, reply: '子完成' });
        }
        return JSON.stringify({ done: true, reply: '主链完成' });
      },
    } as ModelAdapter;
    const h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false });
    const runP = h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    await new Promise((res) => setTimeout(res, 50)); // 等 4 个子代理进入挂起（在飞计数 4）
    gateResolve();
    const r = await runP;
    const obs = r.steps
      .filter((s) => (s.action ?? '').includes('spawn'))
      .map((s) => s.observation)
      .join('\n');
    assert.ok(obs, '并行 spawn 步应存在');
    assert.equal((obs.match(/子完成/g) ?? []).length, 4, '4 个在飞子代理应正常完成');
    assert.ok(/limit reached|已达上限/.test(obs), `第 5 个应被并发护栏拒绝，实际：${obs}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
