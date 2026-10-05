import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { runningDelegations } from './chat-model';
import { ScriptedAdapter } from '../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('delegation 事件进投影:state.delegations 维护、终态对 children 行否决', () => {
  const tmp = tmpdir('sunshinex-sess-del-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    // 合成子代理流(既有测试路径,无 Runner):children 建条
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '审查', label: 'rv' } } } as never);
    ctrl.onEventForTest({ type: 'token', text: '审查中\n', payload: { subagent: 'rv' } } as never);
    // 投影流:另一委派 graph-node 启动
    ctrl.onEventForTest({ type: 'delegation-started', ts: 100, payload: { delegationId: 'planner', kind: 'graph-node', label: 'planner' } } as never);
    let st = ctrl.getState();
    assert.equal(st.delegations.length, 1);
    assert.equal(st.delegations[0]!.id, 'planner');
    // P1 协议补齐(投影单源):合成子代理流无 Runner,rv 的运行行须由 delegation 事件入投影——
    // children 只承载转录明细,不再是 runningDelegations 数据源(与受保护 App 测试同一补齐规则)
    ctrl.onEventForTest({ type: 'delegation-started', ts: 150, payload: { delegationId: 'rv', kind: 'subagent', label: 'rv' } } as never);
    st = ctrl.getState();
    let rows = runningDelegations(st);
    assert.deepEqual(rows.map((r) => r.label).sort(), ['planner', 'rv'], '投影单源:running 行全部来自 delegation 事件(planner+rv)');
    // 投影终态否决同名 children 行(rv 的 Runner ended 先行,done 事件迟到)
    ctrl.onEventForTest({ type: 'delegation-ended', ts: 200, payload: { delegationId: 'rv', kind: 'subagent', status: 'done' } } as never);
    st = ctrl.getState();
    rows = runningDelegations(st);
    assert.deepEqual(rows.map((r) => r.label), ['planner'], '投影 done → rv 不再运行中');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/new 重置:delegations 清空', async () => {
  const tmp = tmpdir('sunshinex-sess-delnew-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'delegation-started', ts: 100, payload: { delegationId: 'x', kind: 'subagent' } } as never);
    assert.ok(ctrl.getState().delegations.length > 0);
    // /new 公开入口 = submit('/new')(现场实测:session.ts handleSlash '/new' 分支,无独立 newSession 方法)
    await ctrl.submit('/new');
    assert.equal(ctrl.getState().delegations.length, 0, '/new 清空投影');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
