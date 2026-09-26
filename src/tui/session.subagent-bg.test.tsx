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

test('归档统计摘要：subagentMeta.tokens 在位、detail 尾行含 ⏱ 步数耗时 tokens', () => {
  const tmp = tmpdir('sunshinex-sess-stats-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '调研', label: 'r' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'task t-1 started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'token', text: '', payload: { subagent: 'r' } } as never);
    ctrl.onEventForTest({ type: 'step', text: '', payload: { subagent: 'r' } } as never);
    ctrl.onEventForTest({ type: 'step', text: '', payload: { subagent: 'r' } } as never);
    ctrl.onEventForTest({ type: 'usage', text: '', payload: { subagent: 'r', turnTotal: 1200 } } as never);
    ctrl.onEventForTest({ type: 'done', text: '结论', payload: { subagent: 'r' } } as never);
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call?.subagentMeta, 'subagentMeta 在位');
    assert.equal(call!.subagentMeta!.tokens, 1200, 'tokens 归档');
    assert.equal(call!.subagentMeta!.steps, 2, '步数归档');
    assert.match(call!.detail ?? '', /⏱ \S+ · 2 steps · ↑1\.2k tokens$/m, 'detail 尾行为统计摘要行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('子代理 token 累计器：usage 增量并入 turn/session 两级（per-run 累计值取差值，不重复计）', () => {
  const tmp = tmpdir('sunshinex-sess-childtok-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'x', label: 'r' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'task t-1 started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'token', text: '', payload: { subagent: 'r' } } as never);
    ctrl.onEventForTest({ type: 'usage', text: '', payload: { subagent: 'r', turnTotal: 500 } } as never);
    ctrl.onEventForTest({ type: 'usage', text: '', payload: { subagent: 'r', turnTotal: 1200 } } as never);
    const m = ctrl.getState().metrics;
    assert.equal(m.turnChildTokens, 1200, 'turn 级 = 增量聚合（1200-500 差值）');
    assert.equal(m.sessionChildTokens, 1200, 'session 级同步累计');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
