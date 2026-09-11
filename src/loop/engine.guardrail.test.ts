import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopEngine, LoopDeps, LoopEngineNode } from './engine';
import { LoopTermination } from '../types';

const deps = {} as LoopDeps;
const term = (over: Partial<LoopTermination>): LoopTermination => ({
  maxIterations: 4,
  maxTokens: 1_000,
  timeoutMs: 60_000,
  ...over,
});
const okNode = (id: string): LoopEngineNode => ({ id, kind: 'agent', run: () => ({ status: 'pass', tokens: 0 }) });

test('LoopEngine：timeoutMs=0 → failed 且 stopReason=deadline（未执行任何节点）', async () => {
  const r = await new LoopEngine([okNode('a')], deps, term({ timeoutMs: 0 })).run('x');
  assert.equal(r.status, 'failed');
  assert.equal(r.stopReason, 'deadline');
  assert.equal(r.iterations, 0);
});

test('LoopEngine：D7 顺序——预算与迭代同时越限报 budget（旧序会先报 iteration）', async () => {
  const r = await new LoopEngine([okNode('a')], deps, term({ maxIterations: 0, maxTokens: 0 })).run('x');
  assert.equal(r.stopReason, 'budget');
  assert.equal(r.status, 'paused');
});
