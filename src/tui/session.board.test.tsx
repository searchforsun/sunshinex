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

test('task-dep-added/task-assigned 事件经翻译进板投影(P2 新型)', () => {
  const tmp = tmpdir('sunshinex-sess-boarddep-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'task-created', ts: 100, payload: { taskId: 't1', title: 'A', dependsOn: [] } } as never);
    ctrl.onEventForTest({ type: 'task-created', ts: 101, payload: { taskId: 't2', title: 'B', dependsOn: [] } } as never);
    ctrl.onEventForTest({ type: 'task-dep-added', ts: 102, payload: { taskId: 't2', dependsOn: 't1' } } as never);
    ctrl.onEventForTest({ type: 'task-assigned', ts: 103, payload: { taskId: 't2', assignee: 'bob' } } as never);
    const st = ctrl.getState();
    assert.deepEqual(st.board.tasks['t2']!.dependsOn, ['t1'], 'task-dep-added → dependency-added 入投影');
    assert.equal(st.board.tasks['t2']!.assignee, 'bob', 'task-assigned → assigned 入投影');
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
    // 非真相源投影(仅事件注入,未经 harness 任务板)/new 后被丢弃,重播种自(空的)工作区快照
    assert.equal(Object.keys(ctrl.getState().board.tasks).length, 0, '/new 重播种自 harness 快照(此处为空板)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/new 重播种板投影:任务从工作区真相源(harness 任务板快照)回填,不随轮转化清空', async () => {
  const tmp = tmpdir('sunshinex-sess-boardseed-');
  try {
    // ScriptedAdapter 预置一张 done 牌:taskboard.create 自动派发的真实 fork 一次收口,drain 落定
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const r = ctrl.runtime.harness.taskboard.create({ title: 'A', spec: 'a' });
    assert.ok(r.ok && r.value.taskId === 't1');
    const settle = async (pred: () => boolean, ticks = 200): Promise<void> => {
      for (let i = 0; i < ticks && !pred(); i++) await new Promise((res) => setImmediate(res));
    };
    await settle(() => ctrl.runtime.harness.taskboard.snapshot().tasks['t1']?.status === 'in-review');
    const before = ctrl.getState().board;
    assert.equal(before.tasks['t1']!.status, 'in-review', '事件投影已进板');
    assert.equal(before.tasks['t1']!.spec, 'a', '投影携带真实 spec(task-created 事件带 spec)');
    void ctrl.submit('/new');
    const after = ctrl.getState().board;
    assert.ok(after.tasks['t1'] !== undefined, '/new 后板投影重播种自 harness 快照,任务仍在');
    assert.equal(after.tasks['t1']!.status, 'in-review');
    assert.equal(after.tasks['t1']!.spec, 'a');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
