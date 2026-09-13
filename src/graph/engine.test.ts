import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDeps, GraphEngine, GraphNode, GraphTermination } from './engine';
import { GraphContext, GraphNodeOutput } from '../types';

// 引擎语义测试基建：空依赖（不触模型/工具）+ 手工节点工厂
const deps = {} as GraphDeps;
const term = (over: Partial<GraphTermination> = {}): GraphTermination => ({
  maxNodes: 12,
  maxTokens: 100_000,
  timeoutMs: 60_000,
  ...over,
});

function mkNode(
  id: string,
  kind: GraphNode['kind'],
  deps: string[],
  run: (ctx: GraphContext, inputs: Record<string, GraphNodeOutput>) => GraphNodeOutput | Promise<GraphNodeOutput>,
): GraphNode {
  return { id, kind, deps, run: (ctx, _d, inputs) => run(ctx, inputs) };
}

const out = (status: GraphNodeOutput['status'], tokens = 0, extra: Partial<GraphNodeOutput> = {}): GraphNodeOutput => ({
  nodeId: '',
  status,
  tokens,
  ...extra,
});

test('GraphEngine 环检测：A→B→C→A 报错且含全部环成员', () => {
  const eng = new GraphEngine(
    [
      mkNode('a', 'agent', ['c'], () => out('pass')),
      mkNode('b', 'agent', ['a'], () => out('pass')),
      mkNode('c', 'agent', ['b'], () => out('pass')),
    ],
    deps,
    term(),
  );
  let message = '';
  try {
    eng.layers();
    assert.fail('含环工作流应抛出');
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  for (const id of ['a', 'b', 'c']) assert.ok(message.includes(id), `错误信息应含环成员 ${id}：${message}`);
});

test('GraphEngine 同层并发：3 个慢节点 maxConcurrent ≥ 2', async () => {
  let cur = 0;
  let max = 0;
  const slow = (id: string): GraphNode =>
    mkNode(id, 'ci', [], async () => {
      cur += 1;
      max = Math.max(max, cur);
      await new Promise((r) => setTimeout(r, 20));
      cur -= 1;
      return out('pass');
    });
  const eng = new GraphEngine([slow('a'), slow('b'), slow('c')], deps, term());
  const r = await eng.run('并发见证');
  assert.equal(r.status, 'done');
  assert.ok(max >= 2, `同层应并发执行（max=${max}）`);
});

test('GraphEngine 错误局部化：fail → 传递依赖 skipped，无关分支照常', async () => {
  const eng = new GraphEngine(
    [
      mkNode('a', 'ci', [], () => out('failed', 0, { reply: '构建失败' })),
      mkNode('b', 'agent', ['a'], () => out('pass')),
      mkNode('c', 'agent', [], () => out('pass')),
    ],
    deps,
    term(),
  );
  const r = await eng.run('错误局部化');
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.failedNodes, ['a']);
  assert.equal(r.results['b'].status, 'skipped');
  assert.equal(r.results['c'].status, 'pass');
});

test('GraphEngine 预算超支：tokensUsed ≥ maxTokens → paused（非 failed）', async () => {
  const eng = new GraphEngine(
    [
      mkNode('a', 'ci', [], () => out('pass', 80)),
      mkNode('b', 'ci', ['a'], () => out('pass', 90)),
      mkNode('c', 'ci', ['b'], () => out('pass', 50)),
    ],
    deps,
    term({ maxTokens: 100 }),
  );
  const r = await eng.run('预算贯通');
  assert.equal(r.status, 'paused');
  assert.ok(r.tokensUsed >= 100, `超支应已发生（tokensUsed=${r.tokensUsed}）`);
});

test('GraphEngine 超时：timeoutMs=5 + 慢节点 → failed', async () => {
  const eng = new GraphEngine(
    [
      mkNode('a', 'ci', [], async () => {
        await new Promise((res) => setTimeout(res, 30));
        return out('pass');
      }),
      mkNode('b', 'ci', ['a'], () => out('pass')),
    ],
    deps,
    term({ timeoutMs: 5 }),
  );
  const r = await eng.run('超时终止');
  assert.equal(r.status, 'failed');
  assert.ok(String(r.reply ?? '').includes('超时'));
});

test('GraphEngine paused → resume：审批消费续跑，已 pass 节点不重跑', async () => {
  let preRuns = 0;
  let wRuns = 0;
  const eng = new GraphEngine(
    [
      mkNode('pre', 'ci', [], () => {
        preRuns += 1;
        return out('pass');
      }),
      mkNode('g', 'gate', ['pre'], (ctx) => {
        const approvals = ctx.state.approvals as Record<string, boolean> | undefined;
        if (approvals?.['g'] === true) return out('pass');
        if (approvals?.['g'] === false) return out('failed', 0, { reply: '人工拒绝' });
        return out('paused', 0, { reply: '等待人工审批' });
      }),
      mkNode('w', 'ci', ['g'], () => {
        wRuns += 1;
        return out('pass');
      }),
    ],
    deps,
    term(),
  );
  const r1 = await eng.run('审批流');
  assert.equal(r1.status, 'paused');
  assert.deepEqual(r1.pendingGates, ['g']);
  const r2 = await eng.resume({ g: true });
  assert.equal(r2.status, 'done');
  assert.equal(preRuns, 1, '已 pass 节点不应重跑');
  assert.equal(wRuns, 1, '下游节点 resume 后恰好执行一次');
});
