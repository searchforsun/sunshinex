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

/**
 * 后台 spawn 两段式语义（对标 CC Task run_in_background）：
 * ①tool-result 立即返回 → 调用行不归档、留待子事件到位后延迟归档；
 * ②主链回合结束进 idle 时未完成子代理面板保留（跨回合可见运行态）；
 * ③子代理 done 后归档命中，转录折入原调用行 detail（Ctrl+B 可展开）。
 */
test('后台 spawn：结果先行不即归档、面板跨回合保留、done 后延迟归档', () => {
  const tmp = tmpdir('sunshinex-sess-spawnbg-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    // 第一回合：主链发出后台 spawn，tool-result 立即返回
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '后台调查', label: 'bg' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'task t-1 started', payload: { tool: 'spawn', ok: true } } as never);
    let call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call, 'spawn 调用行在链');
    assert.equal(call!.detail, undefined, '结果先行：立即返回时尚无子事件，调用行不归档');
    // 子事件先到（面板建立、进入运行态）
    ctrl.onEventForTest({ type: 'token', text: '调查中\n', payload: { subagent: 'bg' } } as never);
    ctrl.onEventForTest({ type: 'step', text: '', payload: { subagent: 'bg' } } as never);
    // 主链回合结束进 idle：未完成子代理面板保留
    assert.equal(ctrl.getState().children.length, 1, 'idle 后运行中子代理面板保留');
    assert.equal(ctrl.getState().children[0]!.label, 'bg');
    assert.equal(call!.detail, undefined, '未完成不归档');
    // 子代理完成：延迟归档命中，转录折入原调用行
    ctrl.onEventForTest({ type: 'done', text: '后台结论', payload: { subagent: 'bg' } } as never);
    call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call!.detail?.includes('后台结论'), 'done 后延迟归档，转录折入原调用行');
    assert.ok(call!.subagentMeta, '归档写入 subagentMeta');
    assert.equal(ctrl.getState().children.length, 0, '归档后面板移除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
