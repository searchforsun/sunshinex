import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionEvent } from '../types';
import { ActiveCall, LiveTaskState, applyTaskState, initialTaskState } from './task-state';

function ev(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent {
  return { type, ...(text !== undefined ? { text } : {}), ...(payload ? { payload } : {}), ts: 0 };
}

test('task-state：model-start→token→tool-call→tool-result→model-start→done 主链', () => {
  let s = initialTaskState();
  assert.equal(s.phase, 'idle');
  s = applyTaskState(s, ev('model-start', undefined, { step: 1 }));
  assert.equal(s.phase, 'thinking');
  s = applyTaskState(s, ev('token', 'he'));
  assert.equal(s.phase, 'responding');
  s = applyTaskState(s, ev('tool-call', 'read', { callId: 'step:1-idx:0', status: 'pending' }));
  assert.equal(s.phase, 'tool-pending');
  assert.equal(s.activeCalls.length, 1);
  assert.equal(s.activeCalls[0].callId, 'step:1-idx:0');
  assert.equal(s.activeCalls[0].verb, 'read');
  s = applyTaskState(s, ev('tool-result', 'ok', { callId: 'step:1-idx:0', status: 'completed' }));
  assert.equal(s.activeCalls.length, 0);
  assert.equal(s.phase, 'thinking');
  s = applyTaskState(s, ev('done', 'ok', { steps: 2 }));
  assert.equal(s.phase, 'idle');
});

test('task-state：并行批两 callId 独立推进、批内一先一后', () => {
  let s = applyTaskState(initialTaskState(), ev('model-start', undefined, { step: 1 }));
  s = applyTaskState(s, ev('tool-call', 'read', { callId: 'step:1-idx:0', status: 'pending' }));
  s = applyTaskState(s, ev('tool-call', 'glob', { callId: 'step:1-idx:1', status: 'pending' }));
  assert.equal(s.activeCalls.length, 2);
  s = applyTaskState(s, ev('tool-result', 'ok', { callId: 'step:1-idx:1', status: 'completed' }));
  assert.equal(s.activeCalls.length, 1);
  assert.equal(s.phase, 'tool-pending', '批内仍有未决调用保持 tool-pending');
  s = applyTaskState(s, ev('tool-result', 'ok', { callId: 'step:1-idx:0', status: 'failed' }));
  assert.equal(s.activeCalls.length, 0);
  assert.equal(s.phase, 'thinking');
});

test('task-state：tool-call 重复 callId 不重复追加；error 清态；无关事件原样', () => {
  let s = applyTaskState(initialTaskState(), ev('model-start', undefined, { step: 1 }));
  s = applyTaskState(s, ev('tool-call', 'read', { callId: 'step:1-idx:0', status: 'pending' }));
  const before = s.activeCalls.length;
  s = applyTaskState(s, ev('tool-call', 'read', { callId: 'step:1-idx:0', status: 'pending' }));
  assert.equal(s.activeCalls.length, before, '重复 callId 幂等');
  s = applyTaskState(s, ev('route', undefined, { tier: 'medium' }));
  assert.equal(s.phase, 'tool-pending', 'route 等无关事件零扰动');
  s = applyTaskState(s, ev('error', 'boom'));
  assert.deepEqual(s, initialTaskState(), 'error 清态');
});
