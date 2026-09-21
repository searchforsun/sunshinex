import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstate-'));
}

test('session 三态：事件流驱动 task 状态与 activeCalls', async () => {
  const tmp = tmpdir();
  try {
    const c = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    c.onEventForTest({ type: 'model-start', payload: { step: 1 }, ts: 0 });
    assert.equal(c.taskState().phase, 'thinking');
    c.onEventForTest({ type: 'tool-call', text: 'read', payload: { callId: 'step:1-idx:0', status: 'pending' }, ts: 1 });
    assert.equal(c.taskState().phase, 'tool-pending');
    assert.equal(c.taskState().activeCalls[0]?.verb, 'read');
    c.onEventForTest({ type: 'tool-result', text: 'ok', payload: { callId: 'step:1-idx:0', status: 'completed' }, ts: 2 });
    assert.equal(c.taskState().activeCalls.length, 0);
    c.onEventForTest({ type: 'done', text: 'ok', payload: { steps: 1 }, ts: 3 });
    assert.equal(c.taskState().phase, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('session 三态：/new 归位 idle', async () => {
  const tmp = tmpdir();
  try {
    const c = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    c.onEventForTest({ type: 'tool-call', text: 'read', payload: { callId: 'step:1-idx:0', status: 'pending' }, ts: 0 });
    assert.equal(c.taskState().phase, 'tool-pending');
    await c.submit('/new');
    assert.equal(c.taskState().phase, 'idle');
    assert.equal(c.taskState().activeCalls.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
