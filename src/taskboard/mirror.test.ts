// 镜像属性测试:TaskBoard 发射(task-* SessionEvent)↔ boardEventFrom 翻译 ↔
// applyBoardEvent 归约三方互为镜像——对代表性事件脚本,经真实 TaskBoard(假 runner 恒成功)逐变更收集事件,
// 投影侧(翻译 + reducer)终态必须与真相侧 board.snapshot() 结构相等。
// 口径边界:P2 起 set_dependency/assign 也发事件(task-dep-added/task-assigned),脚本补两步进覆盖;
// 变更即发射是本属性成立的前提,不是缺口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import { AgentTeamRegistry, MemoryAgentTeamStore } from './team-registry';
import { applyBoardEvent, emptyBoard, TaskBoardState } from './model';
import { boardEventFrom } from '../tui/session';
import { SessionEvent } from '../types';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const drain = () => new Promise((r) => setImmediate(r));

/** 投影可比面:排除 createdAt/updatedAt/artifact,比较 status/teamId/dependsOn/assignee/title/spec */
function project(s: TaskBoardState): Record<string, unknown> {
  return {
    seq: s.seq,
    tasks: Object.fromEntries(Object.entries(s.tasks).map(([id, t]) => [id, {
      id: t.id,
      title: t.title,
      spec: t.spec,
      status: t.status,
      teamId: t.teamId,
      dependsOn: [...t.dependsOn].sort(),
      assignee: t.assignee,
      ...(t.retryOf !== undefined ? { retryOf: t.retryOf } : {}),
    }])),
  };
}

test('镜像属性:发射↔翻译↔归约的投影终态与真相板一致(代表性脚本全量事件)', async () => {
  const tmp = tmpdir('sunshinex-tb-mirror-');
  try {
    const events: SessionEvent[] = [];
    const runner = {
      runSubagent: async (_i: unknown, o?: { taskLine?: string }) => {
        const line = o?.taskLine ?? '';
        if (line.endsWith(': C')) return { ok: false as const, error: { code: 'INCOMPLETE', message: 'no finish' } };
        return { ok: true as const, value: { reply: `done:${line}`, tokens: 1 } };
      },
    } as unknown as SubagentRunner;
    const registry = { submit: () => ({ id: 'm1', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry;
    const agentTeams = new AgentTeamRegistry(new MemoryAgentTeamStore(), () => 1);
    const team = agentTeams.create('alpha');
    assert.ok(team.ok);
    const teamId = team.value.teamId;
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner,
      registry,
      agentTeams,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 5000; return () => ++n; })(),
    });
    board.init();

    // A 成功解锁 B;C 失败挡住 D(task-blocked);再补依赖边与指派
    const ra = board.create({ teamId, title: 'A', spec: 'do A' });
    assert.ok(ra.ok);
    const idA = ra.value.taskId;
    const rb = board.create({ teamId, title: 'B', spec: 'do B', dependsOn: [idA] });
    assert.ok(rb.ok);
    const idB = rb.value.taskId;
    const rc = board.create({ teamId, title: 'C', spec: 'do C' });
    assert.ok(rc.ok);
    const idC = rc.value.taskId;
    const rd = board.create({ teamId, title: 'D', spec: 'do D', dependsOn: [idC] });
    assert.ok(rd.ok);
    const idD = rd.value.taskId;
    await drain();
    await drain();
    assert.ok(board.setDependency(idD, idA).ok);
    assert.ok(board.assign(idD, 'ext-lead').ok);

    const relevant = events.filter((e) => e.type.startsWith('task-'));
    for (const type of ['task-created', 'task-unlocked', 'task-status-changed', 'task-blocked', 'task-dep-added', 'task-assigned']) {
      assert.ok(relevant.some((e) => e.type === type), `脚本应覆盖 ${type} 事件`);
    }

    let mirror = emptyBoard();
    for (const e of relevant) mirror = applyBoardEvent(mirror, boardEventFrom(e));
    const real = board.snapshot();
    assert.equal(real.tasks[idA]!.status, 'success');
    assert.equal(real.tasks[idB]!.status, 'success');
    assert.equal(real.tasks[idC]!.status, 'failed');
    assert.equal(real.tasks[idD]!.status, 'pending');
    assert.deepEqual(project(mirror), project(real), '投影镜像终态应与真相板结构相等');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
