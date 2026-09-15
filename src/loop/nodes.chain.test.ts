import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentNode } from './nodes';
import { LoopDeps } from './engine';
import { LoopContext, LoopTermination } from '../types';
import { ModelAdapter, ScriptedAdapter } from '../model/adapter';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';

/** 装配样板（对齐 engine.test.ts makeDeps）：真实安全链/注册表/上下文 + 注入模型桩 */
function makeDeps(tmp: string, model: ModelAdapter): LoopDeps & { context: ContextManager } {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  return { safety, registry, context, model };
}

/** 记录型适配器：透传桩应答，捕获每次 prompt 供断言 */
class RecordingAdapter implements ModelAdapter {
  readonly provider: string;
  prompts: string[] = [];
  constructor(private inner: ModelAdapter) {
    this.provider = inner.provider;
  }
  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.inner.complete(prompt);
  }
}

/** 节点级 LoopContext（单节点直调用，不经过引擎） */
function ctxOf(state: Record<string, unknown>, over: Partial<LoopTermination> = {}): LoopContext {
  return {
    iteration: 0,
    state,
    tokensUsed: 0,
    startedAt: Date.now(),
    termination: { maxIterations: 4, maxTokens: 1000, timeoutMs: 60_000, ...over },
  };
}

test('修正要求走链：deficits 以链行入链并经缺省链基进入模型 prompt', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-loop-chain-'));
  try {
    const recording = new RecordingAdapter(new ScriptedAdapter([JSON.stringify({ done: true, reply: '修复完成' })]));
    const deps = makeDeps(tmp, recording);
    const ctx = ctxOf({ goal: '修复登录', deficits: [{ id: 'c1', desc: '边界未覆盖' }] });
    const out = await agentNode(deps).run(ctx, null);
    assert.equal(out.status, 'done');
    const chain = deps.context.chainView();
    const fixLine = chain.find((s) => s.action === 'deficit');
    assert.ok(fixLine && fixLine.observation.includes('边界未覆盖'), '修正要求必须以链行进入');
    assert.ok(recording.prompts[0].includes('边界未覆盖'), '修正轮 prompt 经缺省链基（seed=chainView）携带修正要求');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fork 作用域跨轮接续：state.seedHistory 累积、主链零回写', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-loop-fork-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'r1-marker');
    const deps = makeDeps(
      tmp,
      new ScriptedAdapter([
        '{"tool":"read","input":{"path":"a.txt"},"done":false}',
        JSON.stringify({ done: true, reply: 'r1 done' }),
        JSON.stringify({ done: true, reply: 'r2 done' }),
      ]),
    );
    const ctx = ctxOf({ goal: '子任务', seedHistory: [{ step: 1, action: 'task', observation: '当前指令：子任务' }] });
    const node = agentNode({ ...deps, scope: 'fork' });
    const out1 = await node.run(ctx, null);
    assert.equal(out1.status, 'done');
    const out2 = await node.run(ctx, null);
    assert.equal(out2.status, 'done');
    const chain = deps.context.chainView();
    assert.equal(chain.length, 0, 'fork 作用域零主链回写');
    const acc = ctx.state.seedHistory as Array<{ step: number; observation: string }>;
    assert.ok(acc.length >= 2, 'fork 轮间必须经 state.seedHistory 累积');
    assert.ok(acc.some((s) => s.observation.includes('r1-marker')), '上一轮步骤必须保留');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
