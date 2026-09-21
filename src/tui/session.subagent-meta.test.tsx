import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('spawn 归档写入 subagentMeta（steps + durationMs）', () => {
  const tmp = tmpdir('sunshinex-sess-spawnmeta-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '审查', label: 'rv' } } } as never);
    ctrl.onEventForTest({ type: 'token', text: '审查中\n', payload: { subagent: 'rv' } } as never);
    ctrl.onEventForTest({ type: 'step', text: '', payload: { subagent: 'rv' } } as never);
    ctrl.onEventForTest({ type: 'usage', text: '', payload: { subagent: 'rv', turnTotal: 4200 } } as never);
    ctrl.onEventForTest({ type: 'done', text: '审查结论', payload: { subagent: 'rv' } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'rv 完成', payload: { tool: 'spawn', ok: true } } as never);
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call, 'spawn 调用行在链');
    assert.ok(call!.detail?.includes('审查结论'), '转录已折入 detail');
    assert.ok(call!.subagentMeta, '归档应写入 subagentMeta');
    assert.ok(call!.subagentMeta!.steps >= 1, 'steps 取自 ChildLiveState.steps');
    assert.ok(call!.subagentMeta!.durationMs >= 0, 'durationMs = 归档时刻 - startedAt');
    assert.equal(ctrl.getState().children.length, 0, '归档后面板移除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('INVALID_ARG 即败零子事件：spawn 调用行无 subagentMeta（折叠态省尾注）', () => {
  const tmp = tmpdir('sunshinex-sess-spawnmeta2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: {} } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'INVALID_ARG', payload: { tool: 'spawn', ok: false } } as never);
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call);
    assert.equal(call!.subagentMeta, undefined, '零子事件无归档命中，meta 保持缺省');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
