// 子智能体视图 running 升级幂等钉测(2026-10-19 真机「结果渲染到最后一个工具上」):
// batch-runner 执行起点补发同 callId 的二次 tool-call(pending→running),子面板转录必须幂等不重复追加——
// 双行入列时 pairChildResults 按 callId 归位后写覆盖前写,结果行挂到升级条、pending 条裸奔即错位病根
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { onChildEvent } from './child-panel';
import { pairChildResults } from './chat-model';
import type { SessionEvent } from '../types';

test('onChildEvent:同 callId 的 running 升级不重复追加调用行,结果行归位唯一调用', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-child-callup-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const base = { ts: Date.now() };
    const ev = (type: string, payload: Record<string, unknown>, text = ''): SessionEvent =>
      ({ type, text, payload: { ...payload, subagent: 'w1' }, ...base }) as never;
    onChildEvent(ctrl, ev('tool-call', { input: { command: 'wc -l' }, callId: 'step:3-idx:0', status: 'pending' }, 'exec'), 'w1');
    onChildEvent(ctrl, ev('tool-call', { input: { command: 'wc -l' }, callId: 'step:3-idx:0', status: 'running' }, 'exec'), 'w1');
    onChildEvent(ctrl, ev('tool-result', { ok: true, callId: 'step:3-idx:0' }, '439'), 'w1');
    const child = ctrl.state.children.find((c) => c.label === 'w1');
    assert.ok(child, '子智能体面板态已建');
    const calls = child.transcript.filter((l) => l.kind === 'call');
    assert.equal(calls.length, 1, `调用行恰一条(升级幂等),实际 ${calls.length}`);
    const paired = pairChildResults(child.transcript);
    const callIdx = paired.findIndex((l) => l.kind === 'call');
    assert.equal(paired[callIdx + 1]?.kind, 'result', '结果行紧随唯一调用行(不再挂到升级副本)');
    assert.equal(paired[callIdx + 1]?.text, '439');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
