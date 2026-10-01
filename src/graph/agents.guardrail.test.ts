import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeRoleAgent } from './agents';
import { GraphDeps } from './engine';
import { GraphContext } from '../types';
import type { ChatRequest, ChatResult } from '../types';
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

class CountingAdapter implements ModelAdapter {
  readonly provider = 'counting';
  calls = 0;
  constructor(private inner: ModelAdapter) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    return this.inner.chat(req);
  }
}

/** 用量适配器：脚本回放 + 固定 token 用量回传（tokenCap 是累计量纲，判定依赖真实 usage 流动） */
class UsageAdapter implements ModelAdapter {
  readonly provider = 'usage-scripted';
  calls = 0;
  constructor(private inner: ModelAdapter, private perCall: number) {}
  async chat(req: ChatRequest, hooks?: UsageHooks): Promise<ChatResult> {
    this.calls += 1;
    hooks?.onUsage?.(this.perCall);
    return this.inner.chat(req);
  }
}

function makeDeps(tmp: string, model: ModelAdapter): GraphDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  return { safety, registry, context: new ContextManager(tmp, new FileStore(tmp)), model };
}

test('makeRoleAgent：env 未设不设 token 硬顶——graph 剩余不再贯通，预算耗尽照常执行', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ag3-'));
  delete process.env.SUNSHINEX_SUBAGENT_TOKEN_CAP;
  try {
    const rec = new CountingAdapter(new ScriptedAdapter(['{"done":true,"reply":"完成了"}']));
    const deps = makeDeps(tmp, rec);
    const node = makeRoleAgent('planner', deps);
    const ctx: GraphContext = {
      state: { goal: 'x' },
      tokensUsed: 0,
      startedAt: Date.now(),
      results: {},
      // termination.maxTokens=0：旧形态换算 remaining=0 下发、模型一次都不调；新形态必须解耦照常跑完
      termination: { maxNodes: 10, maxTokens: 0, timeoutMs: 60_000 },
    };
    const out = await node.run(ctx, deps, {});
    assert.equal(out.status, 'pass', `graph 剩余不得再充当子代理硬顶：${JSON.stringify(out)}`);
    assert.equal(rec.calls, 1, '无硬顶 → 子代理正常完成');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('makeRoleAgent：SUNSHINEX_SUBAGENT_TOKEN_CAP 注入 → 子代理按独享硬顶收敛', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ag4-'));
  process.env.SUNSHINEX_SUBAGENT_TOKEN_CAP = '1';
  try {
    // 每步回传 5 token 且永不 done：cap=1 时子代理在第 2 步边界按预算收敛（累计 5 ≥ 1）
    const model = new UsageAdapter(new ScriptedAdapter(['{"done":false}']), 5);
    const deps = makeDeps(tmp, model);
    const node = makeRoleAgent('planner', deps);
    const ctx: GraphContext = {
      state: { goal: 'x' },
      tokensUsed: 0,
      startedAt: Date.now(),
      results: {},
      termination: { maxNodes: 10, maxTokens: 200_000, timeoutMs: 60_000 },
    };
    const out = await node.run(ctx, deps, {});
    assert.equal(out.status, 'failed');
    assert.equal(model.calls, 1, '护栏收敛前恰好一次模型调用');
  } finally {
    delete process.env.SUNSHINEX_SUBAGENT_TOKEN_CAP;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('makeRoleAgent：把剩余时间换算成 Reactor deadline（超时不调模型）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ag-'));
  try {
    const rec = new CountingAdapter(new ScriptedAdapter(['{"done":true,"reply":"不该被调用"}']));
    const deps = makeDeps(tmp, rec);
    const node = makeRoleAgent('planner', deps);
    const ctx: GraphContext = {
      state: { goal: 'x' },
      tokensUsed: 0,
      startedAt: Date.now(),
      results: {},
      termination: { maxNodes: 10, maxTokens: 200_000, timeoutMs: 0 },
    };
    const out = await node.run(ctx, deps, {});
    assert.equal(out.status, 'failed');
    assert.equal(rec.calls, 0, 'deadline 应在模型调用前收敛');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
