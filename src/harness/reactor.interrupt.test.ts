import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import { ModelAdapter, ScriptedAdapter } from '../model/adapter';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { SessionEvent } from '../types';

// 独立文件自持构建：reactor.test.ts 属并发会话活跃写入面（steer 线），中断钉子单文件承载避免共写竞态
function makeReactor(
  tmp: string,
  adapter: ModelAdapter,
  signal?: AbortSignal,
  onEvent?: (e: SessionEvent) => void,
): Reactor {
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({
    registry,
    safety,
    context,
    model: adapter,
    ...(signal ? { signal } : {}),
    ...(onEvent ? { onEvent } : {}),
  });
}

test('Reactor：步边界信号已中止 → interrupted 终态，零新步', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-abort1-'));
  const ctrl = new AbortController();
  ctrl.abort();
  const reactor = makeReactor(tmp, new ScriptedAdapter(['{"done":true,"reply":"never"}']), ctrl.signal);
  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, false);
  assert.equal(r.stopReason, 'interrupted', '步边界即停，终态 interrupted');
  assert.equal(r.steps.length, 0, '零新步执行');
});

test('Reactor：模型调用在途中止 → interrupted 终态，不走 error 通道', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-abort2-'));
  const ctrl = new AbortController();
  const errorEvents: string[] = [];
  const adapter = {
    provider: 'hang-abort',
    complete: (_p: string, _h?: unknown, _f?: unknown, signal?: AbortSignal): Promise<string> =>
      new Promise((_, reject) => {
        if (signal?.aborted) return reject(new Error('Task interrupted'));
        signal?.addEventListener('abort', () => reject(new Error('Task interrupted')), { once: true });
      }),
  };
  const reactor = makeReactor(tmp, adapter, ctrl.signal, (e) => {
    if (e.type === 'error') errorEvents.push(e.text ?? '');
  });
  const pending = reactor.run({ goal: 'x' });
  setTimeout(() => ctrl.abort(), 30);
  const r = await pending;
  assert.equal(r.done, false);
  assert.equal(r.stopReason, 'interrupted', '在途中止转 interrupted');
  assert.equal(errorEvents.length, 0, '用户中断不走 error 通道（回执由会话层统一发）');
});
