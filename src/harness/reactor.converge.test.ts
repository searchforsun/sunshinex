import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import { ScriptedAdapter } from '../model/adapter';
import { ERROR_CONVERGENCE_LINE } from './prompts/shared';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';

process.env.SUNSHINEX_DATA_DIR = process.env.SUNSHINEX_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-converge-data-'));
process.env.SUNSHINEX_USER_SKILLS_DIR = process.env.SUNSHINEX_USER_SKILLS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-converge-uskills-'));

function makeReactor(tmp: string, steps: string[]): Reactor {
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: new ScriptedAdapter(steps) });
}

test('稳定段含异常收敛行（参数性失败立刻换参、原样重试上限两次、超限换路/跳步/收束判断权在模型）', () => {
  assert.match(ERROR_CONVERGENCE_LINE, /at most twice/);
  assert.match(ERROR_CONVERGENCE_LINE, /fixed parameters/);
  assert.match(ERROR_CONVERGENCE_LINE, /skip the step/);
  assert.match(ERROR_CONVERGENCE_LINE, /conclude with an answer — you decide/, '收束仅作模型可选动作之一，无程序性停止指令');
});

const glob = (pattern: string): string => JSON.stringify({ tool: 'glob', input: { pattern }, done: false });

test('批次兜底：同一批次集合最多执行 2 次（首次+重试一次），第 3 次整批拒绝（仅现象）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-converge-'));
  try {
    const SAME = [glob('x*'), glob('x*'), glob('x*'), '{"done":true,"reply":"收束"}'];
    const r = await makeReactor(tmp, SAME).run({ goal: 'g' }, { maxSteps: 10 });
    const rejected = r.steps.filter((s) => s.observation.includes('Repeated identical batch rejected'));
    assert.ok(rejected.length >= 1, '同批次第 3 次应整批拒绝');
    assert.match(rejected[0]!.observation, /already ran 2 times and was skipped this round/);
    assert.doesNotMatch(rejected[0]!.observation, /conclude|change the arguments/i, '拒绝行不指挥模型');
    assert.equal(r.reply, '收束');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('参数变化不计入同参计数：换参后照常执行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-converge2-'));
  try {
    const DIFF = [
      JSON.stringify({ tool: 'exec', input: { command: 'echo a' } }),
      JSON.stringify({ tool: 'exec', input: { command: 'echo b' } }),
      JSON.stringify({ tool: 'exec', input: { command: 'echo c' } }),
      JSON.stringify({ done: true, reply: 'ok' }),
    ];
    const r = await makeReactor(tmp, DIFF).run({ goal: 'g' }, { maxSteps: 10 });
    assert.ok(!r.steps.some((s) => s.observation.includes('Repeated identical tool call rejected')), '不同参数不应触发拒绝');
    assert.ok(r.steps.some((s) => s.observation.trim() === 'c'), '换参调用照常执行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('批次计数过期：拉开 4 步后同一批次重新计数，不再拒绝', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-converge3-'));
  try {
    const sameCall = JSON.stringify({ tool: 'exec', input: { command: 'echo hi' } });
    const fillers = ['a', 'b', 'c', 'd'].map((x) =>
      JSON.stringify({ tool: 'exec', input: { command: `echo ${x}` } }),
    );
    const steps = [sameCall, sameCall, ...fillers, sameCall, JSON.stringify({ done: true, reply: 'ok' })];
    const r = await makeReactor(tmp, steps).run({ goal: 'g' }, { maxSteps: 20 });
    const hiCount = r.steps.filter((s) => s.observation.trim() === 'hi').length;
    assert.equal(hiCount, 3, `过期后同批次应重新计数、第 3 次照常执行，实际 ${hiCount}`);
    assert.ok(!r.steps.some((s) => s.observation.includes('Repeated identical batch rejected')), '拉开 4 步后不应拒绝');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('整批全拒不终结任务：只跳过执行并回写现象观察行，模型换参/换路后可继续', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-converge-block-'));
  try {
    const sameCall = JSON.stringify({ tool: 'exec', input: { command: 'echo hi' } });
    // 前 2 次正常执行，第 3 轮起整批全拒（仅跳过不终结）；随后模型换参，任务继续推进
    const SCRIPT = [
      sameCall, sameCall,
      sameCall, sameCall,
      JSON.stringify({ tool: 'exec', input: { command: 'echo recovered' }, done: false }),
      JSON.stringify({ done: true, reply: '换参后完成' }),
    ];
    const r = await makeReactor(tmp, SCRIPT).run({ goal: 'g' }, { maxSteps: 50 });
    const rejected = r.steps.filter((s) => s.observation.includes('Repeated identical batch rejected'));
    assert.equal(rejected.length, 2, '第 3、4 轮整批全拒各回写一条现象观察行');
    for (const s of rejected) {
      assert.match(s.observation, /already ran 2 times and was skipped this round \(not executed\)/, '拒绝行只陈述现象（已达上限、本轮跳过未执行）');
      assert.doesNotMatch(s.observation, /conclude|stop|terminate/i, '拒绝行不指挥模型收束/停止');
    }
    const okCount = r.steps.filter((s) => s.observation.trim() === 'hi').length;
    assert.equal(okCount, 2, '仅前 2 次真实执行，被拒轮次不执行');
    assert.ok(r.steps.some((s) => s.observation.trim() === 'recovered'), '模型换参后任务继续，不被程序终结');
    assert.equal(r.reply, '换参后完成');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
