import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('tool 三态：调用行延迟入档——运行中历史区零调用行，回程时调用行+结果行成对定格（CC 模式）', async () => {
  const tmp = tmpdir('sunshinex-tooltri-');
  try {
    const ctrl = new SessionController({ root: tmp });
    ctrl.onEventForTest({ type: 'tool-call', text: 'read', payload: { input: { path: 'a.ts' }, callId: 'step:1-idx:0' } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'glob', payload: { input: { pattern: '*' }, callId: 'step:1-idx:1' } } as never);
    let s = ctrl.getState().messages;
    // 运行中：历史区零调用行——底部 Spinner 活动行是唯一运行态显示（CC 模式，不重复）
    assert.equal(s.filter((m) => m.kind === 'call').length, 0, '运行中调用行不入历史区（延迟入档）');
    assert.ok(s.every((m) => m.kind !== 'call' || m.pending === true), '历史区零 pending 调用行');

    // 乱序回程：后发调用（idx:1）先回——调用行+结果行成对入档
    ctrl.onEventForTest({ type: 'tool-result', text: '2 files', payload: { ok: true, full: '2 files', tool: 'glob', callId: 'step:1-idx:1' } } as never);
    s = ctrl.getState().messages;
    assert.equal(s.filter((m) => m.kind === 'call').length, 1, '仅回程者定格入档');
    const pair = s[s.length - 2];
    assert.equal(s[s.length - 1].text, '2 files', '结果行紧跟其调用行');
    assert.equal(pair.kind, 'call', '调用行与结果行成对入档');
    assert.equal(pair.text, 'GLOB *', '调用行内容为挂起时生成的调用行');
    assert.equal(s.filter((m) => m.kind === 'call').every((m) => m.pending === false), true, '定格调用行退出 pending');

    ctrl.onEventForTest({ type: 'tool-result', text: 'l1', payload: { ok: false, full: 'ENOENT', tool: 'read', callId: 'step:1-idx:0' } } as never);
    s = ctrl.getState().messages;
    assert.equal(s.filter((m) => m.kind === 'call').length, 2, '全部调用行已定格');
    const r0 = s[s.length - 1];
    assert.equal(r0.text, 'l1');
    assert.equal(r0.ok, false, '失败结果行标红（ok=false）');
    assert.equal(s.filter((m) => m.kind === 'call').every((m) => m.pending === false), true, '全部调用行退出 pending');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tool 三态兜底：任务收尾时未回程调用补入档（不蒸发，降级定格）', async () => {
  const tmp = tmpdir('sunshinex-tooltri2-');
  try {
    const ctrl = new SessionController({ root: tmp });
    ctrl.onEventForTest({ type: 'tool-call', text: 'read', payload: { input: { path: 'a.ts' }, callId: 'step:1-idx:0' } } as never);
    ctrl.onEventForTest({ type: 'done', text: 'done' } as never);
    const s = ctrl.getState().messages;
    assert.equal(s.filter((m) => m.kind === 'call').length, 1, '未回程调用行在收尾时补入档');
    assert.equal(s.filter((m) => m.kind === 'call').every((m) => m.pending === false), true, '补入档调用行退出 pending');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 回归（2026-09-26 真机症状）：tool-call 事件缺 notify——底部活动行不出现，委派期像卡住
test('tool-call 事件即时通知订阅方（底部活动行实时性）', async () => {
  const tmp = tmpdir('sunshinex-tooltri3-');
  try {
    const ctrl = new SessionController({ root: tmp });
    let notified = 0;
    ctrl.onState(() => notified++);
    ctrl.onEventForTest({ type: 'tool-call', text: 'read', payload: { input: { path: 'a.ts' }, callId: 'step:1-idx:0' } } as never);
    assert.equal(notified, 1, 'tool-call 事件应触发 onState 通知（挂起入档与活动行都依赖它）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
