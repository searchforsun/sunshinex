import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDeps, GraphEngine, GraphNode, GraphTermination } from './engine';
import { GraphNodeOutput } from '../types';

const deps = {} as GraphDeps;
const term = (over: Partial<GraphTermination> = {}): GraphTermination => ({
  maxNodes: 12,
  maxTokens: 100_000,
  timeoutMs: 60_000,
  ...over,
});
const okNode = (id: string): GraphNode => ({
  id,
  kind: 'agent',
  deps: [],
  run: () => ({ nodeId: id, status: 'pass', tokens: 0 }) as GraphNodeOutput,
});

test('GraphEngine：D7 顺序——超时与预算同时越限报 deadline（旧序先报预算）', async () => {
  const r = await new GraphEngine([okNode('a')], deps, term({ maxTokens: 0, timeoutMs: 0 })).run('x');
  assert.equal(r.stopReason, 'deadline');
  assert.equal(r.status, 'failed');
});

test('GraphEngine：预算越限 → paused 且 stopReason=budget', async () => {
  const r = await new GraphEngine([okNode('a')], deps, term({ maxTokens: 0, timeoutMs: 60_000 })).run('x');
  assert.equal(r.stopReason, 'budget');
  assert.equal(r.status, 'paused');
});
