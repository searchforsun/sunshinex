// 队列暂停/恢复行为测试（2026-11-23 用户裁定「用户点击输入框暂停按钮,同时要暂停队列,不要自动发出;
// 横幅继续钮解除后才继续排队或自动发出」）：
// ①暂停态轮收束不取队——待发条目留存（快照 queuePaused=true + queued 不减）；
// ②恢复即续发——idle 且队列非空按序自动发送（user 回显+新 run）。
// HTTP 端点为薄委托（session-handlers handleQueuePause/Resume→SessionRuntime 两方法），行为面在此锁定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionRuntime } from './session';

/** 轮询判据（确定性等待,替代固定 sleep） */
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  for (let i = 0; i < ms / 10 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), '条件超时未满足');
}

function makeSession(model: import('../model/adapter').ModelAdapter): SessionRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-queue-pause-'));
  return new SessionRuntime({
    id: 's1',
    root,
    model,
    nextSeq: (() => {
      let n = 0;
      return () => ++n;
    })(),
    broadcast: () => {},
    mintPid: () => 'p1',
  });
}

test('clearSteer 清空全部排队（群聊 /clear）：返回条数、队列归零；暂停态保留待 /continue', async () => {
  const model = {
    provider: 'scripted-clear',
    chat: async () => JSON.stringify({ done: true, reply: 'unused' }),
  } as unknown as import('../model/adapter').ModelAdapter;
  const s = makeSession(model);
  try {
    s.steer('q1');
    s.steer('q2');
    assert.equal(s.snapshotResponse().queued.length, 2);
    s.queuePause();
    assert.equal(s.clearSteer(), 2, '返回清掉的条数');
    assert.equal(s.snapshotResponse().queued.length, 0, '队列清空');
    assert.equal(s.snapshotResponse().queuePaused, true, '清队列不等于恢复执行');
    s.queueResume();
    assert.equal(s.snapshotResponse().queuePaused, false);
  } finally {
    await s.teardown().catch(() => undefined);
  }
});

test('队列暂停:暂停态轮收束不自动发出(待发留存+queuePaused=true);恢复即按序续发', async () => {
  const replies = [
    JSON.stringify({ done: true, reply: '第一轮完成' }),
    JSON.stringify({ done: true, reply: '排队消息已处理' }),
  ];
  let call = 0;
  const model = {
    provider: 'scripted-queue',
    chat: async () => replies[Math.min(call++, replies.length - 1)],
  } as unknown as import('../model/adapter').ModelAdapter;
  const s = makeSession(model);
  try {
    // 队列先行入队（idle 态仅排队不起轮）→ 置暂停 → 提交第一轮
    s.steer('q1 排队消息');
    assert.equal(s.snapshotResponse().queued.length, 1);
    s.queuePause();
    assert.equal(s.snapshotResponse().queuePaused, true, '暂停态进快照（GUI 横幅数据源）');
    assert.deepEqual(s.submit('第一轮'), { ok: true });
    await waitFor(() => s.status() === 'idle');
    // 暂停态收口：不自动发出——q1 留存 + 空闲（第二轮未起）
    assert.equal(s.snapshotResponse().queued.length, 1, '暂停态轮收束不取队,待发留存');
    assert.equal(s.snapshotResponse().queuePaused, true);
    await waitFor(() => call === 1, 600); // 短窗确认无续发（q1 未起轮）
    // 恢复：解除暂停,idle 即按序自动发送 q1
    s.queueResume();
    await waitFor(() => s.status() === 'running', 2000);
    await waitFor(() => s.status() === 'idle');
    assert.equal(call, 2, '恢复后 q1 起轮处理');
    assert.equal(s.snapshotResponse().queued.length, 0, '恢复续发后队列清空');
    assert.equal(s.snapshotResponse().queuePaused, false, '恢复态回快照');
  } finally {
    await s.teardown().catch(() => undefined);
  }
});
