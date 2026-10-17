import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScriptedAdapter } from '../model/adapter';
import { SessionRuntime } from './session';

/** G10-C1d 排队插话段与撤回:steering FIFO 快照/按下标撤/snapshot.queued 回显。 */

function makeSession(): SessionRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-g10-queue-'));
  return new SessionRuntime({
    id: 's1',
    root,
    model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    nextSeq: (() => {
      let n = 0;
      return () => ++n;
    })(),
    broadcast: () => {},
  });
}

test('排队插话:snapshot.queued 回显 + 按下标撤回(越界 false)', () => {
  const s = makeSession();
  assert.equal(s.snapshotResponse().queued.length, 0);
  s.steer('第一条插话');
  s.steer('第二条插话');
  const q = s.snapshotResponse().queued;
  assert.equal(q.length, 2);
  assert.deepEqual(q.map((x) => x.seq), [0, 1]);
  assert.equal(q[1]!.text, '第二条插话');
  assert.equal(s.cancelSteer(0), true); // 撤第一条
  const q2 = s.snapshotResponse().queued;
  assert.equal(q2.length, 1);
  assert.equal(q2[0]!.text, '第二条插话'); // 剩余条目前移,seq 重排为 0
  assert.equal(s.cancelSteer(5), false); // 越界
});

test('P5 queue 帧广播(spec §12):每次队列变更一帧 payload.items=全量列表;不经 pump 主链(零转录条目);编辑同播', () => {
  const frames: Array<{ kind: string; sessionId: string; seq: number; e: { type: string; payload?: Record<string, unknown> } }> = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-g10-queue-'));
  const s = new SessionRuntime({
    id: 's2',
    root,
    model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    nextSeq: (() => {
      let n = 0;
      return () => ++n;
    })(),
    broadcast: (f) => frames.push(f as never),
  });
  s.steer('一');
  s.steerEdit(0, '一改');
  const qf = frames.filter((f) => f.e.type === 'queue');
  assert.equal(qf.length, 2, '两次变更两帧(编辑含)');
  assert.equal(qf[0]!.sessionId, 's2');
  assert.deepEqual(qf[1]!.e.payload!.items, [{ seq: 0, text: '一改', front: false }]);
  const seqs = frames.map((f) => f.seq);
  assert.deepEqual(seqs, [1, 2], 'queue 帧占全局 seq(重连补发窗含)');
  assert.equal(s.snapshotResponse().messages.length, 0, '队列变更零转录条目(旁路帧不喂内核)');
  assert.equal(s.snapshotResponse().lastSeq, 2, 'lastSeq 随 queue 帧抬');
});
