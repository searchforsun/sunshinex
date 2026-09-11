import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LONG_TASK_TIMEOUT_MS, longTaskTemplate } from './templates';
import { LoopDeps } from './engine';
import { ModelAdapter } from '../model/adapter';
import { ScriptedAdapter, UsageHooks } from '../model/adapter';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';

function makeDeps(tmp: string, model: ModelAdapter): LoopDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  return { safety, registry, context: new ContextManager(tmp, new FileStore(tmp)), model };
}

function withTmp(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-lt-'));
  return fn(tmp).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

test('longTaskTemplate：时间兜底为 4h，可被显式覆盖', () => {
  const deps = {} as LoopDeps;
  assert.equal(longTaskTemplate(deps).termination.timeoutMs, LONG_TASK_TIMEOUT_MS);
  assert.equal(longTaskTemplate(deps, { termination: { timeoutMs: 60_000 } }).termination.timeoutMs, 60_000);
});

test('longTaskTemplate：单 agent 节点，模型自报 done 即结束（不回绕）', async () => {
  await withTmp(async (tmp) => {
    const tpl = longTaskTemplate(makeDeps(tmp, new ScriptedAdapter(['{"done":true,"reply":"长任务完成"}'])));
    const r = await tpl.engine.run('做一件长活');
    assert.equal(r.status, 'done');
    assert.equal(r.stopReason, 'done');
    assert.equal(r.iterations, 1, '单节点模板必须一次即终态（execAgent 的 pass 降级会导致回绕 100 次）');
  });
});

/** 回传真实用量的适配器：累计量纲的 tokenCap 依赖 adapter usage，ScriptedAdapter 恒回 0 则永不可达 */
class UsageAdapter implements ModelAdapter {
  readonly provider = 'usage';
  calls = 0;
  constructor(private inner: ModelAdapter, private tokensPerCall: number) {}
  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    this.calls += 1;
    hooks?.onUsage?.(this.tokensPerCall);
    return this.inner.complete(prompt, hooks);
  }
}

test('longTaskTemplate：时间兜底置 0 → 引擎边界先行收敛（模板覆盖必须生效）', async () => {
  await withTmp(async (tmp) => {
    const tpl = longTaskTemplate(makeDeps(tmp, new ScriptedAdapter(['{"done":true,"reply":"不该被调用"}'])), {
      termination: { timeoutMs: 0 },
    });
    const r = await tpl.engine.run('来不及了');
    assert.equal(r.status, 'failed');
    assert.equal(r.stopReason, 'deadline');
    assert.equal(r.iterations, 0, 'timeoutMs=0 → deadlineAt=startedAt：首节点前即收敛（Task 3 已冻结语义）');
  });
});

test('longTaskTemplate：节点内收敛同样只跑一次（不回绕）', async () => {
  await withTmp(async (tmp) => {
    // 越限必须落在「节点内部」：引擎边界用 maxTokens 判定，故取 maxTokens=1 让引擎放行、由节点内 tokenCap 收口
    const model = new UsageAdapter(new ScriptedAdapter(['{"tool":"glob","input":{"pattern":"*"},"done":false}']), 1);
    const tpl = longTaskTemplate(makeDeps(tmp, model), { termination: { maxTokens: 1 } });
    const r = await tpl.engine.run('预算极小');
    assert.equal(r.status, 'failed');
    assert.equal(r.stopReason, 'budget');
    assert.equal(r.iterations, 1, '节点内收敛也必须一步即终态（execAgent 的 pass 降级会导致此处为 100）');
  });
});
