import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('tool 三态：并发批两调用 pending 上屏，乱序回程各结果插回其调用行后', async () => {
  const tmp = tmpdir('sunshinex-tooltri-');
  try {
    const ctrl = new SessionController({ root: tmp });
    ctrl.onEventForTest({ type: 'tool-call', text: 'read', payload: { input: { path: 'a.ts' }, callId: 'step:1-idx:0' } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'glob', payload: { input: { pattern: '*' }, callId: 'step:1-idx:1' } } as never);
    let s = ctrl.getState().messages;
    assert.equal(s.filter((m) => m.kind === 'call').length, 2);
    assert.ok(s.every((m) => m.kind !== 'call' || m.pending === true), '两调用行均处 pending 等待态');

    // 乱序回程：后发调用（idx:1）先回
    ctrl.onEventForTest({ type: 'tool-result', text: '2 files', payload: { ok: true, full: '2 files', tool: 'glob', callId: 'step:1-idx:1' } } as never);
    s = ctrl.getState().messages;
    const calls = s.filter((m) => m.kind === 'call');
    assert.equal(s[s.indexOf(calls[0]) + 1].kind, 'call', '尚未回程的调用行后无结果行');
    assert.equal(s[s.indexOf(calls[1]) + 1]?.text, '2 files', '先回程的结果紧跟其调用行');
    assert.equal(calls[0].pending, true, '未回程调用行保持 pending');
    assert.equal(calls[1].pending, false, '已回程调用行退出 pending');

    ctrl.onEventForTest({ type: 'tool-result', text: 'l1', payload: { ok: false, full: 'ENOENT', tool: 'read', callId: 'step:1-idx:0' } } as never);
    s = ctrl.getState().messages;
    const c0 = s.filter((m) => m.kind === 'call')[0];
    const r0 = s[s.indexOf(c0) + 1];
    assert.equal(r0.text, 'l1');
    assert.equal(r0.ok, false, '失败结果行标红（ok=false）');
    assert.equal(s.filter((m) => m.kind === 'call').every((m) => m.pending === false), true, '全部调用行退出 pending');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
