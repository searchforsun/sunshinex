import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor, ReactorDeps } from './reactor';
import { ScriptedAdapter } from '../model/adapter';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';

/** 测试装配：真实安全链 / 注册表 / 上下文 + 注入适配器（对齐 reactor.test.ts 样板） */
function makeDeps(tmp: string, model: ReactorDeps['model']): ReactorDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  return { safety, registry, context: new ContextManager(tmp, new FileStore(tmp)), model };
}

const CALL = '{"tool":"glob","input":{"pattern":"*"},"done":false}';
const DONE = '{"done":true,"reply":"好了"}';

function withTmp(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-guard-'));
  return fn(tmp).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

test('Reactor：步数上限耗尽 → done=false 且 stopReason=max-steps', async () => {
  await withTmp(async (tmp) => {
    const r = await new Reactor(makeDeps(tmp, new ScriptedAdapter([CALL, CALL, CALL]))).run(
      { goal: '一直调工具' },
      { maxSteps: 2 },
    );
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'max-steps');
    assert.equal(r.steps.length, 2, '步数上限 2 应恰好跑 2 步');
  });
});

test('Reactor：deadline 已过 → 一步都不跑即收敛', async () => {
  await withTmp(async (tmp) => {
    const r = await new Reactor(makeDeps(tmp, new ScriptedAdapter([DONE]))).run(
      { goal: '来不及了' },
      { deadlineAt: Date.now() - 1 },
    );
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'deadline');
    assert.equal(r.steps.length, 0);
  });
});

test('Reactor：tokenCap=0 → 立即按预算收敛（累计量纲，与窗口 budget 无关）', async () => {
  await withTmp(async (tmp) => {
    const r = await new Reactor(makeDeps(tmp, new ScriptedAdapter([DONE]))).run(
      { goal: '预算为零' },
      { tokenCap: 0 },
    );
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'budget');
    assert.equal(r.steps.length, 0);
  });
});

test('Reactor：未给 tokenCap 时窗口 budget 不构成硬停（跑完即 done）', async () => {
  await withTmp(async (tmp) => {
    const r = await new Reactor(makeDeps(tmp, new ScriptedAdapter([CALL, CALL, CALL]))).run(
      { goal: '调两次工具后被步数拦住' },
      { maxSteps: 2, budget: { total: 200_000, reserve: 40_000 } },
    );
    assert.equal(r.stopReason, 'max-steps', '窗口预算不得冒名顶替为累计硬停');
  });
});

test('Reactor：模型抛错 → stopReason=model-error 且不抛给调用方', async () => {
  await withTmp(async (tmp) => {
    const boom = {
      provider: 'boom',
      async complete(): Promise<string> {
        throw new Error('模型挂了');
      },
    };
    const r = await new Reactor(makeDeps(tmp, boom)).run({ goal: '触发模型失败' }, { maxSteps: 3 });
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'model-error');
    assert.equal(r.reply, '模型挂了');
  });
});
