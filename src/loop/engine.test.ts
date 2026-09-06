import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopEngine, LoopDeps } from './engine';
import { LoopNodeBase, NodeOutput, LoopContext } from '../types';

/** 手工节点函数形态：async 或同步返回皆可（LoopNodeFn 双形态） */
type LoopNodeFn = (ctx: LoopContext, input: NodeOutput | null) => Promise<NodeOutput> | NodeOutput;
type ScriptedNode = LoopNodeBase & { run: LoopNodeFn };

/** 手工 LoopNodeFn：scripted 应答队列，超出后重复末项；记录调用次数 */
function scriptedNode(id: string, kind: LoopNodeBase['kind'], outputs: NodeOutput[]): ScriptedNode {
  const queue = [...outputs];
  const calls = { n: 0 };
  return {
    id,
    kind,
    run: (_ctx: LoopContext, _input: NodeOutput | null): NodeOutput => {
      const out = queue[Math.min(calls.n, queue.length - 1)];
      calls.n += 1;
      return out;
    },
  };
}

const term = (over: Partial<LoopEngine['termination']> = {}) => ({
  maxIterations: 4,
  maxTokens: 1000,
  timeoutMs: 60_000,
  ...over,
});

test('LoopEngine 验收终止：agent(done) → check(pass) → status done、iterations=1', async () => {
  const engine = new LoopEngine(
    [
      scriptedNode('agent', 'agent', [{ status: 'done', reply: 'ok', tokens: 0 }]),
      scriptedNode('check', 'check', [{ status: 'pass', tokens: 0 }]),
    ],
    {} as LoopDeps,
    term(),
  );
  const r = await engine.run('完成目标');
  assert.equal(r.status, 'done');
  assert.equal(r.iterations, 1);
});

test('LoopEngine 迭代耗尽：永循环节点 + maxIterations=3 → failed、iterations=3', async () => {
  let calls = 0;
  const engine = new LoopEngine(
    [
      {
        id: 'agent',
        kind: 'agent',
        run: () => {
          calls += 1;
          return { status: 'retry' as const, tokens: 0 };
        },
      },
    ],
    {} as LoopDeps,
    term({ maxIterations: 3 }),
  );
  const r = await engine.run('永不完成');
  assert.equal(r.status, 'failed');
  assert.equal(r.iterations, 3);
  assert.equal(calls, 3);
  assert.ok(r.error !== undefined);
});

test('LoopEngine 超时：timeoutMs=5 + 慢节点（30ms 延时）→ failed 且 error 含「超时」', async () => {
  const engine = new LoopEngine(
    [
      {
        id: 'agent',
        kind: 'agent',
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { status: 'retry' as const, tokens: 0 };
        },
      },
      scriptedNode('check', 'check', [{ status: 'pass', tokens: 0 }]),
    ],
    {} as LoopDeps,
    term({ timeoutMs: 5 }),
  );
  const r = await engine.run('慢目标');
  assert.equal(r.status, 'failed');
  assert.ok((r.error ?? '').includes('超时'));
});

test('LoopEngine 预算超支：单轮 tokens 超 maxTokens → paused（非 failed），tokensUsed 如实', async () => {
  const engine = new LoopEngine(
    [
      scriptedNode('agent', 'agent', [{ status: 'retry', tokens: 150 }]),
      scriptedNode('check', 'check', [{ status: 'pass', tokens: 0 }]),
    ],
    {} as LoopDeps,
    term({ maxTokens: 100 }),
  );
  const r = await engine.run('预算超支');
  assert.equal(r.status, 'paused');
  assert.equal(r.iterations, 1);
  assert.equal(r.tokensUsed, 150);
  assert.notEqual(r.status, 'done');
});

test('LoopEngine router：合法 route 正确跳转；未知 route fail-bounded 报错', async () => {
  const good = new LoopEngine(
    [
      scriptedNode('n1', 'router', [{ status: 'retry', route: 'n3', tokens: 0 }]),
      scriptedNode('n2', 'router', [{ status: 'fail', reply: 'wrong-node', tokens: 0 }]),
      scriptedNode('n3', 'agent', [{ status: 'done', reply: 'routed', tokens: 0 }]),
    ],
    {} as LoopDeps,
    term(),
  );
  const ok = await good.run('路由跳转');
  assert.equal(ok.status, 'done');
  assert.equal(ok.reply, 'routed');
  assert.equal(ok.iterations, 2); // n1 → n3：两个节点执行步

  const bad = new LoopEngine(
    [scriptedNode('n1', 'router', [{ status: 'retry', route: 'ghost', tokens: 0 }])],
    {} as LoopDeps,
    term(),
  );
  const failed = await bad.run('未知路由');
  assert.equal(failed.status, 'failed');
  assert.ok((failed.error ?? '').includes('ghost'));
  assert.equal(failed.iterations, 1);
});
