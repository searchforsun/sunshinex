import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeRoleAgent } from './agents';
import { GraphDeps } from './engine';
import { GraphContext, GraphTermination } from '../types';
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
  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    this.calls += 1;
    return this.inner.complete(prompt, hooks);
  }
}

function makeDeps(tmp: string, model: ModelAdapter): GraphDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  return { safety, registry, context: new ContextManager(tmp, new FileStore(tmp)), model };
}

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
      termination: { maxNodes: 10, maxTokens: 200_000, timeoutMs: 0 } as GraphTermination,
    };
    const out = await node.run(ctx, deps, {});
    assert.equal(out.status, 'failed');
    assert.equal(rec.calls, 0, 'deadline 应在模型调用前收敛');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
