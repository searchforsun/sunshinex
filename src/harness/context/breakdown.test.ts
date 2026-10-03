import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextBreakdown } from './breakdown';
import { estimateTokens } from './window';
import type { ChainAction, ContextItem, HistoryStep } from '../../types';

const item = (content: string): ContextItem => ({ kind: 'history', content });
const step = (action: ChainAction | undefined, observation: string): HistoryStep => ({ step: 1, ...(action !== undefined ? { action } : {}), observation });

function base(over: Partial<Parameters<typeof contextBreakdown>[0]> = {}) {
  return {
    stableSegment: 'stable segment line',
    instructions: [item('SUNSHINE line A'), item('SUNSHINE line B')],
    skills: [item('Available skills: a, b')],
    memory: [item('Persistent memory: lead')],
    compacted: [item('[Compacted summary checksum=ab]\nsummary body')],
    chain: [
      step('task', 'Current instruction: do it'),
      step('reply', 'done with a fairly long answer text'),
      step('tool-call', '[tool] read {"path":"x"}'),
      step('tool-result', 'file content here'),
      step(undefined, 'unlabeled legacy row'),
    ] as HistoryStep[],
    skill: null,
    window: 1000,
    chainFrom: 2,
    ...over,
  };
}

test('breakdown：分段 token 与各面独立估算一致，Σ parts = total，free = window − total', () => {
  const input = base();
  const b = contextBreakdown(input);
  const by = (id: string) => b.parts.find((p) => p.id === id);
  assert.equal(by('stable')?.tokens, estimateTokens(input.stableSegment), '稳定段独立估算');
  assert.equal(by('instructions')?.tokens, estimateTokens('SUNSHINE line A') + estimateTokens('SUNSHINE line B'), '指令段逐条求和');
  assert.equal(by('compacted')?.tokens, estimateTokens(input.compacted[0].content), '压缩块逐条求和');
  assert.equal(by('chain')?.tokens, b.chainByAction.reduce((s, a) => s + a.tokens, 0), '链段与动作细分严格相等');
  assert.equal(b.total, b.parts.reduce((s, p) => s + p.tokens, 0), '总量=Σ分段');
  assert.equal(b.free, 1000 - b.total, '余量=窗口−总量');
  assert.equal(b.chainFrom, 2, '压缩水位透传');
});

test('breakdown：分段固定装配序；skill 块缺席不占段、在场置尾', () => {
  const absent = contextBreakdown(base());
  assert.deepEqual(absent.parts.map((p) => p.id), ['stable', 'instructions', 'skills', 'memory', 'compacted', 'chain'], '无技能块时六段固定序');
  const present = contextBreakdown(base({ skill: 'skill body text' }));
  assert.equal(present.parts[present.parts.length - 1].id, 'skill', '技能块置尾');
  assert.equal(present.parts[present.parts.length - 1].tokens, estimateTokens('skill body text'), '技能块独立估算');
});

test('breakdown：链动作细分覆盖全链（未登记动作归 note），tokens 降序', () => {
  const b = contextBreakdown(base());
  assert.equal(b.chainByAction.reduce((s, a) => s + a.steps, 0), 5, 'Σ steps = 链行数');
  const note = b.chainByAction.find((a) => a.action === 'note');
  assert.equal(note?.steps, 1, '未登记动作归 note');
  assert.equal(b.chainByAction[0].action, 'reply', '本题最重动作 reply 居首（降序）');
  for (let i = 1; i < b.chainByAction.length; i++) {
    assert.ok(b.chainByAction[i - 1].tokens >= b.chainByAction[i].tokens, 'tokens 降序');
  }
});

test('breakdown：全空上下文六段保留（空态也是事实），free 随窗口；超限 free 钳 0 不为负', () => {
  const empty = contextBreakdown({ ...base(), instructions: [], skills: [], memory: [], compacted: [], chain: [], chainFrom: 0 });
  assert.deepEqual(empty.parts.map((p) => p.id), ['stable', 'instructions', 'skills', 'memory', 'compacted', 'chain'], '空段保留恒定六段');
  assert.deepEqual(empty.parts.slice(1).map((p) => p.tokens), [0, 0, 0, 0, 0], '空段 tokens 全零');
  assert.equal(empty.total, estimateTokens('stable segment line'), '总量=稳定段');
  const over = contextBreakdown({ ...base(), window: 1 });
  assert.equal(over.free, 0, '超限钳 0');
});
