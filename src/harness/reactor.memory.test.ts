import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import type { ModelAdapter } from '../model/adapter';
import { MemoryStore } from './memory/store';

/** settle 接线端到端（规格 §4）：done&&reply 触发提取、失败路径不触发、Stub 门禁静默跳过、提取失败不倒灌任务成败 */

function withRoot(fn: (root: string) => Promise<void> | void): Promise<void> {
  return (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mem-e2e-'));
    process.env.SUNSHINEX_DATA_DIR = tmp;
    try {
      const root = path.join(tmp, 'root');
      fs.mkdirSync(root, { recursive: true });
      await fn(root);
    } finally {
      delete process.env.SUNSHINEX_DATA_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
}

const memCount = (root: string): number => new MemoryStore(root).count();

test('done 任务收口触发提取：openai 记录桩候选落盘', async () => {
  await withRoot(async (root) => {
    const model = dualStub(JSON.stringify({ memories: [{ type: 'project', description: 'deploy via pnpm', content: 'deploys run through pnpm scripts', scope: 'persistent' }] }));
    const h = new Harness({ root, mode: 'dontAsk', model });
    const r = await h.reactor.run({ goal: 'deploy the app' }, { maxSteps: 3 });
    assert.ok(r.done);
    assert.equal(memCount(root), 1, 'settle 单点并行提取落盘');
  });
});

test('失败路径（max-steps 未完成）不触发提取', async () => {
  await withRoot(async (root) => {
    const model = dualStub('{"memories":[]}', { chainSteps: 1 });
    const h = new Harness({ root, mode: 'dontAsk', model });
    const r = await h.reactor.run({ goal: 'impossible goal' }, { maxSteps: 1 });
    assert.ok(!r.done, '前提：任务未完成');
    assert.equal(memCount(root), 0, '非 done 路径零提取');
  });
});

test('Stub 门禁：任务正常完成、零提取零副作用', async () => {
  await withRoot(async (root) => {
    let calls = 0;
    const model: ModelAdapter = { provider: 'stub', complete: async () => { calls += 1; return '{"done":true,"reply":"ok"}'; } };
    const h = new Harness({ root, mode: 'dontAsk', model });
    await h.reactor.run({ goal: 'simple task' }, { maxSteps: 3 });
    assert.equal(calls, 1, '仅主链一次调用');
    assert.equal(memCount(root), 0, 'Stub 不产记忆');
  });
});

test('提取失败（模型抛错）不倒灌任务成败', async () => {
  await withRoot(async (root) => {
    let mainCalled = false;
    const model: ModelAdapter = {
      provider: 'openai',
      complete: async (prompt: string) => {
        if (prompt.includes('memory-extraction')) throw new Error('extraction endpoint down');
        mainCalled = true;
        return '{"done":true,"reply":"all good"}';
      },
    };
    const h = new Harness({ root, mode: 'dontAsk', model });
    const r = await h.reactor.run({ goal: 'task with failing memory extraction' }, { maxSteps: 3 });
    assert.ok(mainCalled, '前提：主链已走 openai 通道');
    assert.ok(r.done, '任务仍 done（旁路纪律）');
    assert.equal(memCount(root), 0);
  });
});

/** 双态 openai 桩：主链步返回 done 信封、提取调用（memory-extraction 标记）返回候选信封；chainSteps>0 时先吐链步制造未完成路径 */
function dualStub(envelope: string, opts?: { chainSteps?: number }): ModelAdapter {
  let mainCalls = 0;
  const chainSteps = opts?.chainSteps ?? 0;
  return {
    provider: 'openai',
    complete: async (prompt: string) => {
      if (prompt.includes('memory-extraction')) return envelope;
      mainCalls += 1;
      if (mainCalls <= chainSteps) return '{"tools":[{"action":"read","input":{"path":"notes.txt"}}]}';
      return '{"done":true,"reply":"task finished"}';
    },
  };
}
