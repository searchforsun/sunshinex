import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDeps, GraphEngine, GraphNode, GraphTermination } from './engine';
import { GraphNodeOutput, SessionEvent } from '../types';

const term = (over: Partial<GraphTermination> = {}): GraphTermination => ({ maxNodes: 12, maxTokens: 100_000, timeoutMs: 60_000, ...over });

function mkNode(id: string, deps: string[], run: () => GraphNodeOutput | Promise<GraphNodeOutput>): GraphNode {
  return { id, kind: 'agent', deps, run: (_ctx, _d, _inputs) => run() };
}

test('GraphEngine 节点进度事件:started/ended 成对、失败/跳过映射正确(串行链保序)', async () => {
  const events: SessionEvent[] = [];
  const deps = { onEvent: (e: SessionEvent) => events.push(e) } as unknown as GraphDeps;
  // 链 a(失败) → b(依赖 a,应 skipped);c 独立通过
  const eng = new GraphEngine(
    [
      mkNode('a', [], () => ({ nodeId: 'a', status: 'failed', tokens: 0 })),
      mkNode('b', ['a'], () => ({ nodeId: 'b', status: 'pass', tokens: 0 })),
      mkNode('c', [], () => ({ nodeId: 'c', status: 'pass', tokens: 7 })),
    ],
    deps,
    term(),
  );
  await eng.run('goal');
  const seq = events.map((e) => `${e.type}:${(e.payload as Record<string, unknown>)?.delegationId ?? ''}:${(e.payload as Record<string, unknown>)?.status ?? ''}`);
  // 层 1 [a,c] 并发:两 started 都先于任一 ended(map 序同步发射);层 2 b 无 started 只有 skipped ended
  const aStart = seq.findIndex((s) => s === 'delegation-started:a:');
  const cStart = seq.findIndex((s) => s === 'delegation-started:c:');
  const aEnd = seq.findIndex((s) => s === 'delegation-ended:a:failed');
  const bEnd = seq.findIndex((s) => s === 'delegation-ended:b:skipped');
  const cEnd = seq.findIndex((s) => s === 'delegation-ended:c:done');
  assert.ok(aStart >= 0 && cStart >= 0 && aEnd >= 0 && bEnd >= 0 && cEnd >= 0, `事件齐备,实际:${JSON.stringify(seq)}`);
  assert.ok(aStart < aEnd && cStart < cEnd, 'started 先于自身 ended');
  assert.ok(aEnd < bEnd, 'b 的 skipped 在 a 失败之后(层序)');
  assert.ok(!seq.some((s) => s.startsWith('delegation-started:b:')), 'skipped 节点无 started');
  assert.equal((events[0]!.payload as Record<string, unknown>)?.kind, 'graph-node');
  assert.equal((events[0]!.payload as Record<string, unknown>)?.nodeKind, 'agent');
});

test('GraphEngine 节点异常:catch 路径发 ended failed', async () => {
  const events: SessionEvent[] = [];
  const deps = { onEvent: (e: SessionEvent) => events.push(e) } as unknown as GraphDeps;
  const eng = new GraphEngine(
    [mkNode('boom', [], () => { throw new Error('kaboom'); })],
    deps,
    term(),
  );
  await eng.run('goal');
  const seq = events.map((e) => e.type);
  assert.deepEqual(seq, ['delegation-started', 'delegation-ended']);
  assert.equal((events[1]!.payload as Record<string, unknown>)?.status, 'failed');
});
