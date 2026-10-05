// 镜像属性测试(终审钉口径):TaskBoard 发射(task-*/gate-* SessionEvent)↔ boardEventFrom 翻译 ↔
// applyBoardEvent 归约三方互为镜像——对代表性事件脚本,经真实 TaskBoard(假 runner 恒成功)逐变更收集事件,
// 投影侧(翻译 + reducer)终态必须与真相侧 board.snapshot() 结构相等。
// 口径边界:P1 仅镜像有 SessionEvent 发射的变更(create/review/gate/执行回写);set_dependency 与
// assign 不发事件(投影面无对应面),脚本刻意回避——变更即发射是本属性成立的前提,不是缺口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import { applyBoardEvent, emptyBoard, TaskBoardState } from './model';
import { boardEventFrom } from '../tui/session';
import { SessionEvent } from '../types';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const drain = () => new Promise((r) => setImmediate(r));

/** 投影可比面:排除 createdAt/updatedAt/artifact(时间戳与结论富字段),比较 statuses/dependsOn/assignee/gated/titles/specs */
function project(s: TaskBoardState): Record<string, unknown> {
  return {
    seq: s.seq,
    tasks: Object.fromEntries(Object.entries(s.tasks).map(([id, t]) => [id, {
      id: t.id,
      title: t.title,
      spec: t.spec,
      status: t.status,
      dependsOn: [...t.dependsOn].sort(),
      assignee: t.assignee,
      gated: t.gated,
    }])),
  };
}

test('镜像属性:发射↔翻译↔归约的投影终态与真相板一致(代表性脚本全量事件)', async () => {
  const tmp = tmpdir('sunshinex-tb-mirror-');
  try {
    const events: SessionEvent[] = [];
    const runner = {
      runSubagent: async (_i: unknown, o?: { taskLine?: string }) => ({ ok: true as const, value: { reply: `done:${o?.taskLine ?? ''}`, tokens: 1 } }),
    } as unknown as SubagentRunner;
    const registry = { submit: () => ({ id: 'm1', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry;
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner,
      registry,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 5000; return () => ++n; })(),
    });
    board.init();

    // 代表性变更脚本(经公共操作面,每次状态变更都有对应 SessionEvent):
    // t1 无依赖 / t2 依赖 t1 / t3 无依赖 → 同批派发回写 in-review;
    // t4 依赖 t3 → gate 挂起;裁决 t3 拒(关单 failed)→ t4 收 task-blocked(§4.1 不自动 skip);
    // 裁决 t1 过 → t2 解锁派发回写;裁决 t2 过;审批 t4 → gate 解锁(依赖失败仍 pending)。
    assert.ok(board.create({ title: 'A', spec: 'do A' }).ok);                    // t1
    assert.ok(board.create({ title: 'B', spec: 'do B', dependsOn: ['t1'] }).ok); // t2
    assert.ok(board.create({ title: 'C', spec: 'do C' }).ok);                    // t3
    await drain(); // t1/t3 → claimed → in-review;t2 等 t1 保持 pending
    assert.ok(board.create({ title: 'D', spec: 'do D', dependsOn: ['t3'] }).ok); // t4(pending,t3 未终态)
    assert.ok(board.gate('t4', 'need human check').ok);
    await drain();
    assert.ok((await board.review('t3', { approved: false })).ok); // t3 failed + t4 task-blocked
    assert.ok((await board.review('t1', { approved: true })).ok);  // t1 done → t2 派发 → in-review
    await drain();
    assert.ok((await board.review('t2', { approved: true })).ok);  // t2 done
    assert.ok((await board.review('t4', { approved: true })).ok);  // gate 解锁;依赖 t3 failed → 仍 pending

    // 脚本覆盖面守卫:六类板事件全出现(防脚本退化成空转,属性静默变弱)
    const relevant = events.filter((e) => e.type.startsWith('task-') || e.type.startsWith('gate-'));
    for (const type of ['task-created', 'task-unlocked', 'task-status-changed', 'task-blocked', 'gate-waiting', 'gate-resolved']) {
      assert.ok(relevant.some((e) => e.type === type), `脚本应覆盖 ${type} 事件`);
    }

    // 镜像管线:每条事件经翻译单点 → 同一 reducer 归约,终态必须等于真相板
    let mirror = emptyBoard();
    for (const e of relevant) mirror = applyBoardEvent(mirror, boardEventFrom(e));
    const real = board.snapshot();
    assert.equal(real.tasks['t1']!.status, 'done');
    assert.equal(real.tasks['t2']!.status, 'done');
    assert.equal(real.tasks['t3']!.status, 'failed');
    assert.equal(real.tasks['t4']!.status, 'pending');
    assert.deepEqual(project(mirror), project(real), '投影镜像终态应与真相板结构相等');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
