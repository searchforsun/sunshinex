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

test('task-* 事件进板投影;delegation 带标签不再误吞(分流防御)', () => {
  const tmp = tmpdir('sunshinex-sess-board-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'task-created', ts: 100, payload: { taskId: 't1', title: 'A', dependsOn: [] } } as never);
    ctrl.onEventForTest({ type: 'task-status-changed', ts: 101, payload: { taskId: 't1', from: 'pending', status: 'claimed' } } as never);
    let st = ctrl.getState();
    assert.equal(st.board.tasks['t1']!.status, 'claimed');
    assert.equal(st.board.seq, 1);
    // 分流防御:delegation 事件即使被误打 subagent 标签也走投影(终审 minor 的结构性回避)
    ctrl.onEventForTest({ type: 'delegation-started', ts: 102, payload: { delegationId: 'task-t1', kind: 'subagent', label: 'task-t1', subagent: 'task-t1' } } as never);
    st = ctrl.getState();
    assert.equal(st.delegations.length, 1, '带标签的 delegation 事件仍进投影');
    assert.equal(st.children.length, 0, '不误入子代理面板分支');
    // 单源收敛:children 不再是 runningDelegations 数据源
    ctrl.onEventForTest({ type: 'token', text: 'x\n', payload: { subagent: 'orphan' } } as never);
    assert.deepEqual(runningDelegations(ctrl.getState()).map((r) => r.label), ['task-t1'], '无 delegation 事件的 children 行不再显示');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/new 重置板投影', () => {
  const tmp = tmpdir('sunshinex-sess-boardnew-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'task-created', ts: 100, payload: { taskId: 't1', title: 'A', dependsOn: [] } } as never);
    assert.ok(Object.keys(ctrl.getState().board.tasks).length > 0);
    void ctrl.submit('/new');
    assert.equal(Object.keys(ctrl.getState().board.tasks).length, 0, '/new 清空板投影');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
