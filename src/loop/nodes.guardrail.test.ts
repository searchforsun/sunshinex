import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentNode } from './nodes';
import { LoopDeps, LoopEngine } from './engine';
import { LoopContext, LoopTermination } from '../types';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';

/** 计数适配器：用于断言「护栏挡在模型调用之前」 */
class CountingAdapter implements ModelAdapter {
  readonly provider = 'counting';
  calls = 0;
  constructor(private inner: ModelAdapter) {}
  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    this.calls += 1;
    return this.inner.complete(prompt, hooks);
  }
}

/** 用量适配器：脚本回放 + 固定 token 用量回传（Reactor 的 tokenCap 是累计量纲，判定依赖 adapter usage） */
class UsageAdapter implements ModelAdapter {
  readonly provider = 'usage-scripted';
  calls = 0;
  constructor(private inner: ModelAdapter, private perCall: number) {}
  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    this.calls += 1;
    hooks?.onUsage?.(this.perCall);
    return this.inner.complete(prompt);
  }
}

function makeDeps(tmp: string, model: ModelAdapter): LoopDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  return { safety, registry, context: new ContextManager(tmp, new FileStore(tmp)), model };
}

function ctxOf(state: Record<string, unknown>, over: Partial<LoopTermination> = {}): LoopContext {
  return {
    iteration: 0,
    state,
    tokensUsed: 0,
    startedAt: Date.now(),
    termination: { maxIterations: 4, maxTokens: 1_000, timeoutMs: 60_000, ...over },
  };
}

test('agentNode：剩余时间换算成 Reactor deadline，超时挡在模型调用之前', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-an-'));
  try {
    const rec = new CountingAdapter(new ScriptedAdapter(['{"done":true,"reply":"不该被调用"}']));
    const out = await agentNode(makeDeps(tmp, rec)).run(ctxOf({ goal: 'x' }, { timeoutMs: 0 }), null);
    assert.equal(out.status, 'fail');
    assert.equal(rec.calls, 0, 'deadline 应在模型调用前收敛');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('agentNode：剩余 token 换算成 Reactor tokenCap，超额同样不调模型', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-an2-'));
  try {
    const rec = new CountingAdapter(new ScriptedAdapter(['{"done":true,"reply":"不该被调用"}']));
    const out = await agentNode(makeDeps(tmp, rec)).run(ctxOf({ goal: 'x' }, { maxTokens: 0 }), null);
    assert.equal(out.status, 'fail');
    assert.equal(rec.calls, 0, 'tokenCap 应在模型调用前收敛');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 端到端：agent 节点因护栏收敛 → 引擎结果带出同一原因（Task 3 透传 + Task 4 写入）
test('agentNode → LoopEngine：护栏原因贯通到 LoopRunResult.stopReason', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-an3-'));
  try {
    // 每步回传 1 token 且永不 done：maxTokens=1 时节点内 Reactor 在第 2 步边界按 tokenCap 收敛
    const model = new UsageAdapter(new ScriptedAdapter(['{"done":false}']), 1);
    const deps = makeDeps(tmp, model);
    const r = await new LoopEngine([agentNode(deps, { maxSteps: 1 })], deps, {
      maxIterations: 4,
      maxTokens: 1,
      timeoutMs: 60_000,
    }).run('x');
    // 引擎边界预算收敛会报 paused；此处 failed + budget 只可能来自「节点写入 → 引擎透传」
    assert.equal(r.status, 'failed');
    assert.equal(r.stopReason, 'budget');
    assert.equal(r.iterations, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
