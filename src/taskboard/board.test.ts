import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import { AgentTeamRegistry, MemoryAgentTeamStore } from './team-registry';
import { SessionEvent } from '../types';
import { teamTokenCapEnv } from '../config/termination-config';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function attachTeam(now: () => number = () => 1): { agentTeams: AgentTeamRegistry; teamId: string } {
  const agentTeams = new AgentTeamRegistry(new MemoryAgentTeamStore(), now);
  const created = agentTeams.create('alpha');
  if (!created.ok) throw new Error(created.error.message);
  return { agentTeams, teamId: created.value.teamId };
}

const registryStub = { submit: () => ({ id: 'b1', stop: () => {} }), append: () => {}, finish: () => {}, list: () => [], get: () => undefined } as unknown as TaskRegistry;

interface Harness {
  board: TaskBoard;
  events: SessionEvent[];
  calls: string[];
  teamId: string;
  agentTeams: AgentTeamRegistry;
}

function makeBoard(tmp: string, opts?: { failReplies?: string[]; teamTokenCap?: number }): Harness {
  const events: SessionEvent[] = [];
  const calls: string[] = [];
  const failReplies = opts?.failReplies ?? [];
  const { agentTeams, teamId } = attachTeam();
  const runner = {
    runSubagent: async (_input: unknown, o?: { taskLine?: string }) => {
      const line = o?.taskLine ?? '';
      calls.push(line);
      if (failReplies.some((f) => line === f || line.endsWith(`: ${f}`))) return { ok: false as const, error: { code: 'INCOMPLETE', message: 'no finish' } };
      return { ok: true as const, value: { reply: `reply of ${line}`, tokens: 10 } };
    },
  } as unknown as SubagentRunner;
  const board = new TaskBoard({
    store: new TeamStore(path.join(tmp, 'teams', 'main')),
    runner,
    registry: registryStub,
    agentTeams,
    onEvent: (e) => events.push(e),
    now: (() => { let n = 1000; return () => ++n; })(),
    ...(opts?.teamTokenCap !== undefined ? { teamTokenCap: opts.teamTokenCap } : {}),
  });
  board.init();
  return { board, events, calls, teamId, agentTeams };
}

const drain = () => new Promise((r) => setImmediate(r));

test('stopTask:pending 与 running → cancelled;终态幂等', async () => {
  const tmp = tmpdir('sunshinex-tb-stop-');
  try {
    let release: () => void = () => {};
    const hang = new Promise<void>((res) => { release = res; });
    let aborted = false;
    const events: SessionEvent[] = [];
    const { agentTeams, teamId } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: {
        runSubagent: async (_i: unknown, o?: { signal?: AbortSignal }) => {
          await new Promise<void>((res) => {
            if (o?.signal?.aborted) { aborted = true; res(); return; }
            o?.signal?.addEventListener('abort', () => { aborted = true; res(); }, { once: true });
            hang.then(res);
          });
          return { ok: false as const, error: { code: 'ABORTED', message: 'aborted' } };
        },
      } as unknown as SubagentRunner,
      registry: { submit: () => ({ id: 's1', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry,
      agentTeams,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    board.init();
    const a = board.create({ teamId, title: 'A', spec: 'a' });
    assert.ok(a.ok);
    const idA = a.value.taskId;
    const b = board.create({ teamId, title: 'B', spec: 'b', dependsOn: [idA] });
    assert.ok(b.ok);
    const idB = b.value.taskId;
    await drain();
    assert.equal(board.snapshot().tasks[idA]!.status, 'running');
    assert.equal(board.snapshot().tasks[idB]!.status, 'pending');
    assert.ok(board.stopTask(idB).ok);
    assert.equal(board.snapshot().tasks[idB]!.status, 'cancelled');
    assert.ok(board.stopTask(idA).ok);
    assert.equal(board.snapshot().tasks[idA]!.status, 'cancelled');
    assert.equal(aborted, true, 'running 的 stopTask abort 执行体');
    const cancelled = events.filter((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.status === 'cancelled');
    assert.equal(cancelled.length, 2);
    const fromB = cancelled.find((e) => (e.payload as Record<string, unknown>).taskId === idB);
    const fromA = cancelled.find((e) => (e.payload as Record<string, unknown>).taskId === idA);
    assert.equal((fromB!.payload as Record<string, unknown>).from, 'pending');
    assert.equal((fromA!.payload as Record<string, unknown>).from, 'running');
    const again = board.stopTask(idA);
    assert.equal(again.ok, true, '终态幂等');
    assert.equal(events.filter((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.status === 'cancelled').length, 2, '终态不重复落事件');
    assert.equal(board.stopTask('missing').ok, false);
    release();
    await drain();
    assert.equal(board.snapshot().tasks[idA]!.status, 'cancelled', '迟到回写不覆盖 cancelled');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('stopTask:上游 cancelled 向 pending 下游发 task-blocked', async () => {
  const tmp = tmpdir('sunshinex-tb-stop-block-');
  try {
    const hang = new Promise<void>(() => {});
    const events: SessionEvent[] = [];
    const { agentTeams, teamId } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'block')),
      runner: { runSubagent: async () => { await hang; return { ok: true as const, value: { reply: 'r', tokens: 1 } }; } } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    board.init();
    const a = board.create({ teamId, title: 'A', spec: 'a' });
    assert.ok(a.ok);
    const idA = a.value.taskId;
    const b = board.create({ teamId, title: 'B', spec: 'b', dependsOn: [idA] });
    assert.ok(b.ok);
    const idB = b.value.taskId;
    await drain();
    assert.equal(board.snapshot().tasks[idA]!.status, 'running');
    assert.ok(board.stopTask(idA).ok);
    assert.equal(board.snapshot().tasks[idA]!.status, 'cancelled');
    assert.equal(board.snapshot().tasks[idB]!.status, 'pending');
    const blocked = events.filter((e) => e.type === 'task-blocked');
    assert.equal(blocked.length, 1);
    assert.equal((blocked[0]!.payload as Record<string, unknown>).taskId, idB);
    assert.deepEqual((blocked[0]!.payload as Record<string, unknown>).blockedBy, [idA]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('用户中止回写 cancelled:ABORTED 与 interrupted 不落 failed', async () => {
  const tmp = tmpdir('sunshinex-tb-abort-');
  try {
    const cases: Array<{ title: string; error: { code: string; message: string } }> = [
      { title: 'A', error: { code: 'ABORTED', message: 'aborted' } },
      { title: 'B', error: { code: 'INCOMPLETE', message: '[fork] did not finish (interrupted)' } },
    ];
    for (const c of cases) {
      const events: SessionEvent[] = [];
      const { agentTeams, teamId } = attachTeam();
      const board = new TaskBoard({
        store: new TeamStore(path.join(tmp, 'teams', c.title)),
        runner: { runSubagent: async () => ({ ok: false as const, error: c.error }) } as unknown as SubagentRunner,
        registry: registryStub,
        agentTeams,
        onEvent: (e) => events.push(e),
        now: (() => { let n = 1000; return () => ++n; })(),
      });
      board.init();
      const up = board.create({ teamId, title: c.title, spec: c.title });
      assert.ok(up.ok);
      const id = up.value.taskId;
      const down = board.create({ teamId, title: `${c.title}-down`, spec: 'd', dependsOn: [id] });
      assert.ok(down.ok);
      await drain();
      assert.equal(board.snapshot().tasks[id]!.status, 'cancelled', c.title);
      assert.equal(board.snapshot().tasks[down.value.taskId]!.status, 'pending');
      const blocked = events.find((e) => e.type === 'task-blocked');
      assert.ok(blocked, `${c.title} 下游 task-blocked`);
      assert.deepEqual((blocked!.payload as Record<string, unknown>).blockedBy, [id]);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('external-cli stopTask 调用 stop,已取消的委派收口不是 failed', async () => {
  const tmp = tmpdir('sunshinex-tb-ext-stop-');
  try {
    const events: SessionEvent[] = [];
    let release: () => void = () => {};
    const hang = new Promise<void>((res) => { release = res; });
    let stopped = '';
    const { agentTeams, teamId } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: { runSubagent: async () => ({ ok: true as const, value: { reply: 'r', tokens: 1 } }) } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams,
      externalExecutor: {
        stop: (id: string) => { stopped = id; },
        run: async () => { await hang; return { ok: false, reply: 'killed', tokens: 3 }; },
      },
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    board.init();
    const a = board.create({ teamId, title: 'A', spec: 'a', executor: 'external-cli' });
    assert.ok(a.ok);
    const idA = a.value.taskId;
    const b = board.create({ teamId, title: 'B', spec: 'b', dependsOn: [idA] });
    assert.ok(b.ok);
    await drain();
    assert.equal(board.snapshot().tasks[idA]!.status, 'running');
    assert.ok(board.stopTask(idA).ok);
    assert.equal(stopped, idA, 'external stop 被调用');
    assert.equal(board.snapshot().tasks[b.value.taskId]!.status, 'pending');
    assert.ok(events.some((e) => e.type === 'task-blocked'));
    release();
    await drain();
    await drain();
    assert.equal(board.snapshot().tasks[idA]!.status, 'cancelled', '迟到回写不覆盖 cancelled');
    const ended = events.filter((e) => e.type === 'delegation-ended');
    assert.equal(ended.length, 1);
    assert.equal((ended[0]!.payload as Record<string, unknown>).status, 'skipped');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('finishExecution:ok→success;error→failed;terminal cancelled', async () => {
  const tmp = tmpdir('sunshinex-tb-finish5-');
  try {
    const run = async (title: string, report: Parameters<TaskBoard['finishExecution']>[1]) => {
      let release: () => void = () => {};
      const hang = new Promise<void>((res) => { release = res; });
      const { agentTeams, teamId } = attachTeam();
      const board = new TaskBoard({
        store: new TeamStore(path.join(tmp, 'teams', title)),
        runner: { runSubagent: async () => { await hang; return { ok: true as const, value: { reply: 'late', tokens: 1 } }; } } as unknown as SubagentRunner,
        registry: registryStub,
        agentTeams,
        now: (() => { let n = 1000; return () => ++n; })(),
      });
      board.init();
      const created = board.create({ teamId, title, spec: title });
      assert.ok(created.ok);
      await drain();
      assert.equal(board.snapshot().tasks[created.value.taskId]!.status, 'running');
      const result = board.finishExecution(created.value.taskId, report);
      release();
      await drain();
      return { board, id: created.value.taskId, result };
    };
    const okRun = await run('A', { ok: true, reply: 'r', tokens: 5, durationMs: 3 });
    assert.ok(okRun.result.ok);
    assert.equal(okRun.board.snapshot().tasks[okRun.id]!.status, 'success');
    assert.equal(okRun.board.snapshot().tasks[okRun.id]!.artifact?.conclusion, 'r');
    const bad = await run('B', { ok: false, error: { code: 'INCOMPLETE', message: 'no finish' } });
    assert.ok(bad.result.ok);
    assert.equal(bad.board.snapshot().tasks[bad.id]!.status, 'failed');
    const stopped = await run('C', { ok: false, terminal: 'cancelled', error: { code: 'ABORTED', message: 'stop' } });
    assert.ok(stopped.result.ok);
    assert.equal(stopped.board.snapshot().tasks[stopped.id]!.status, 'cancelled');

    const h = makeBoard(tmp, { failReplies: ['Anchor'] });
    const anchor = h.board.create({ teamId: h.teamId, title: 'Anchor', spec: 'a' });
    assert.ok(anchor.ok);
    await drain();
    const pending = h.board.create({ teamId: h.teamId, title: 'D', spec: 'd', dependsOn: [anchor.value.taskId] });
    assert.ok(pending.ok);
    const illegal = h.board.finishExecution(pending.value.taskId, { ok: true, reply: 'x' });
    assert.equal(illegal.ok, false);
    if (!illegal.ok) assert.match(illegal.error.message, new RegExp(`cannot transition ${pending.value.taskId} from pending to success`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('init:打开态自愈为 cancelled 事件落盘(from 为装载前态)', async () => {
  const tmp = tmpdir('sunshinex-tb-recover-');
  try {
    const dir = path.join(tmp, 'teams', 'main');
    const store = new TeamStore(dir);
    store.append({ t: 'task-created', taskId: 'p', title: 'P', spec: 'p', dependsOn: [], teamId: 'tm1', ts: 1 });
    store.append({ t: 'task-created', taskId: 'r', title: 'R', spec: 'r', dependsOn: [], teamId: 'tm1', ts: 1 });
    store.append({ t: 'status-changed', taskId: 'r', from: 'pending', to: 'running', ts: 2 });
    store.append({ t: 'task-created', taskId: 'ok', title: 'OK', spec: 'ok', dependsOn: [], teamId: 'tm1', ts: 1 });
    store.append({ t: 'status-changed', taskId: 'ok', from: 'pending', to: 'running', ts: 2 });
    store.append({ t: 'status-changed', taskId: 'ok', from: 'running', to: 'success', ts: 3 });
    const calls: string[] = [];
    const { agentTeams } = attachTeam();
    const board = new TaskBoard({
      store,
      runner: { runSubagent: async () => { calls.push('run'); return { ok: true as const, value: { reply: 'r', tokens: 1 } }; } } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams,
      now: () => 50,
    });
    board.init();
    const s = board.snapshot();
    assert.equal(s.tasks['p']!.status, 'cancelled');
    assert.equal(s.tasks['r']!.status, 'cancelled');
    assert.equal(s.tasks['ok']!.status, 'success');
    assert.deepEqual(calls, [], '自愈不 kick');
    const raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    assert.match(raw, /"taskId":"p".*"from":"pending".*"to":"cancelled"/s);
    assert.match(raw, /"taskId":"r".*"from":"running".*"to":"cancelled"/s);
    assert.match(raw, /no live executors after restart/);
    assert.match(raw, /interrupted by restart/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create:未知 teamId 拒绝;retryOf 同队且前驱终态;dependsOn 同队', async () => {
  const tmp = tmpdir('sunshinex-tb-team-');
  try {
    let release: () => void = () => {};
    const hang = new Promise<void>((res) => { release = res; });
    const agentTeams = new AgentTeamRegistry(new MemoryAgentTeamStore(), () => 1);
    const alpha = agentTeams.create('alpha');
    const beta = agentTeams.create('beta');
    assert.ok(alpha.ok && beta.ok);
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: { runSubagent: async () => { await hang; return { ok: true as const, value: { reply: 'r', tokens: 1 } }; } } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams,
      now: (() => { let n = 10; return () => ++n; })(),
    });
    board.init();
    const unknown = board.create({ teamId: 'team-nope', title: 'A', spec: 'a' });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.error.message, /unknown teamId: team-nope; create a team with create_team first/);
    const live = board.create({ teamId: alpha.value.teamId, title: 'Live', spec: 'live' });
    assert.ok(live.ok);
    const idLive = live.value.taskId;
    await drain();
    assert.equal(board.snapshot().tasks[idLive]!.status, 'running');
    const early = board.create({ teamId: alpha.value.teamId, title: 'Retry', spec: 'retry', retryOf: idLive });
    assert.equal(early.ok, false);
    if (!early.ok) assert.match(early.error.message, new RegExp(`retryOf task ${idLive} is still running`));
    assert.ok(board.stopTask(idLive).ok);
    const retried = board.create({ teamId: alpha.value.teamId, title: 'Retry', spec: 'retry', retryOf: idLive });
    assert.ok(retried.ok);
    assert.equal(board.snapshot().tasks[retried.value.taskId]!.retryOf, idLive);
    const other = board.create({ teamId: beta.value.teamId, title: 'Other', spec: 'o' });
    assert.ok(other.ok);
    const crossRetry = board.create({ teamId: alpha.value.teamId, title: 'X', spec: 'x', retryOf: other.value.taskId });
    assert.equal(crossRetry.ok, false);
    if (!crossRetry.ok) assert.match(crossRetry.error.message, new RegExp(`retryOf task ${other.value.taskId} does not belong to team ${alpha.value.teamId}`));
    const crossDep = board.create({ teamId: alpha.value.teamId, title: 'Y', spec: 'y', dependsOn: [other.value.taskId] });
    assert.equal(crossDep.ok, false);
    if (!crossDep.ok) assert.match(crossDep.error.message, new RegExp(`dependsOn task ${other.value.taskId} is not on team ${alpha.value.teamId}`));
    const missingRetry = board.create({ teamId: alpha.value.teamId, title: 'Z', spec: 'z', retryOf: 'task-missing' });
    assert.equal(missingRetry.ok, false);
    if (!missingRetry.ok) assert.match(missingRetry.error.message, /retryOf task task-missing is not on team/);
    release();
    await drain();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('依赖顺序:上游 running 时下游不派发;成功后下游 success', async () => {
  const tmp = tmpdir('sunshinex-tb-dep-');
  try {
    let release: () => void = () => {};
    const hang = new Promise<void>((res) => { release = res; });
    const calls: string[] = [];
    const { agentTeams, teamId } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: {
        runSubagent: async (_i: unknown, o?: { taskLine?: string }) => {
          const line = o?.taskLine ?? '';
          calls.push(line);
          if (line.endsWith(': A')) await hang;
          return { ok: true as const, value: { reply: `reply of ${line}`, tokens: 10 } };
        },
      } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams,
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    board.init();
    const a = board.create({ teamId, title: 'A', spec: 'do A' });
    assert.ok(a.ok);
    const idA = a.value.taskId;
    const b = board.create({ teamId, title: 'B', spec: 'do B', dependsOn: [idA] });
    assert.ok(b.ok);
    const idB = b.value.taskId;
    await drain();
    assert.deepEqual(calls, [`Task ${idA}: A`]);
    assert.equal(board.snapshot().tasks[idA]!.status, 'running');
    assert.equal(board.snapshot().tasks[idB]!.status, 'pending');
    release();
    await drain();
    await drain();
    assert.deepEqual(calls, [`Task ${idA}: A`, `Task ${idB}: B`]);
    assert.equal(board.snapshot().tasks[idA]!.status, 'success');
    assert.equal(board.snapshot().tasks[idB]!.status, 'success');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('执行失败:回写 failed + 下游 task-blocked 不自动 skip', async () => {
  const tmp = tmpdir('sunshinex-tb-fail-');
  try {
    const h = makeBoard(tmp, { failReplies: ['A'] });
    const a = h.board.create({ teamId: h.teamId, title: 'A', spec: 'do A' });
    assert.ok(a.ok);
    const idA = a.value.taskId;
    const b = h.board.create({ teamId: h.teamId, title: 'B', spec: 'do B', dependsOn: [idA] });
    assert.ok(b.ok);
    const idB = b.value.taskId;
    await drain();
    assert.equal(h.board.snapshot().tasks[idA]!.status, 'failed');
    assert.equal(h.board.snapshot().tasks[idB]!.status, 'pending');
    const blocked = h.events.find((e) => e.type === 'task-blocked');
    assert.ok(blocked);
    assert.deepEqual((blocked!.payload as Record<string, unknown>)?.blockedBy, [idA]);
    const raw = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8');
    assert.ok(raw.includes('"note":"execution failed: INCOMPLETE: no finish"'), raw);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CONCURRENCY_LIMIT 留在 pending 后重派成功', async () => {
  const tmp = tmpdir('sunshinex-tb-conc-');
  try {
    const events: SessionEvent[] = [];
    let refused = false;
    const { agentTeams, teamId } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: {
        runSubagent: async () => {
          if (!refused) {
            refused = true;
            return { ok: false as const, error: { code: 'CONCURRENCY_LIMIT', message: 'Subagent concurrency limit reached (8)' } };
          }
          return { ok: true as const, value: { reply: 'ok after retry', tokens: 5 } };
        },
      } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
      retryDelayMs: 10,
    });
    board.init();
    const r = board.create({ teamId, title: 'A', spec: 'a' });
    assert.ok(r.ok);
    const idA = r.value.taskId;
    await drain();
    assert.equal(board.snapshot().tasks[idA]!.status, 'pending', '拒绝当时不进入 running');
    await new Promise((res) => setTimeout(res, 40));
    assert.equal(board.snapshot().tasks[idA]!.status, 'success');
    assert.ok(!events.some((e) => e.type === 'task-blocked'));
    assert.ok(!events.some((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.note === 'concurrency limit, deferred'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CONCURRENCY_LIMIT 持续占用:退避定时器有界重试', async () => {
  const tmp = tmpdir('sunshinex-tb-conc2-');
  try {
    let calls = 0;
    const { agentTeams, teamId } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: {
        runSubagent: async () => {
          calls += 1;
          return { ok: false as const, error: { code: 'CONCURRENCY_LIMIT', message: 'limit' } };
        },
      } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams,
      now: (() => { let n = 1000; return () => ++n; })(),
      retryDelayMs: 50,
    });
    board.init();
    const r = board.create({ teamId, title: 'A', spec: 'a' });
    assert.ok(r.ok);
    const idA = r.value.taskId;
    await new Promise((res) => setTimeout(res, 500));
    assert.ok(calls >= 2, `退避重派确有发生(实际 ${calls})`);
    assert.ok(calls <= 16, `无热循环(实际 ${calls})`);
    const lines = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0).length;
    assert.ok(lines <= 40, `事件流有界(实际 ${lines})`);
    assert.equal(board.snapshot().tasks[idA]!.status, 'pending');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('set_dependency 环检测;限流;id 方言', async () => {
  const tmp = tmpdir('sunshinex-tb-cycle-');
  try {
    const h = makeBoard(tmp, { failReplies: ['anchor'] });
    const anchor = h.board.create({ teamId: h.teamId, title: 'anchor', spec: 'a' });
    assert.ok(anchor.ok);
    const idAnchor = anchor.value.taskId;
    await drain();
    assert.equal(h.board.snapshot().tasks[idAnchor]!.status, 'failed');
    const a = h.board.create({ teamId: h.teamId, title: 'A', spec: 'a', dependsOn: [idAnchor] });
    const b = h.board.create({ teamId: h.teamId, title: 'B', spec: 'b', dependsOn: [idAnchor] });
    assert.ok(a.ok && b.ok);
    assert.ok(h.board.setDependency(a.value.taskId, b.value.taskId).ok);
    const cyc = h.board.setDependency(b.value.taskId, a.value.taskId);
    assert.equal(cyc.ok, false);
    if (!cyc.ok) assert.match(cyc.error.message, /cycle/);
    const d = h.board.create({ teamId: h.teamId, title: 'D', spec: 'd', dependsOn: [idAnchor] });
    assert.ok(d.ok);
    assert.match(d.value.taskId, /^task-[a-z0-9][a-z0-9-]*-[a-z0-9]{4}$/);
    assert.ok(d.value.taskId.startsWith('task-d-'));
    const cjk = h.board.create({ teamId: h.teamId, title: '解析器重构', spec: 'cjk', dependsOn: [idAnchor] });
    assert.ok(cjk.ok);
    assert.match(cjk.value.taskId, /^task-board-[a-z0-9]{4}$/);
    // anchor failed 不占 open;已有 A/B/D/cjk 共 4 个 pending,再补到 64
    for (let i = 0; i < 60; i++) h.board.create({ teamId: h.teamId, title: `bulk${i}`, spec: 'x', dependsOn: [idAnchor] });
    const over = h.board.create({ teamId: h.teamId, title: 'over', spec: 'x', dependsOn: [idAnchor] });
    assert.equal(over.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create executor 提示入板', async () => {
  const tmp = tmpdir('sunshinex-tb-exec-');
  try {
    const h = makeBoard(tmp);
    const r = h.board.create({ teamId: h.teamId, title: 'A', spec: 'a', executor: 'external-cli' });
    assert.ok(r.ok);
    const idA = r.value.taskId;
    assert.equal(h.board.snapshot().tasks[idA]!.executorHint, 'external-cli');
    const ev = h.events.find((e) => e.type === 'task-created');
    assert.equal((ev!.payload as Record<string, unknown>).executorHint, 'external-cli');
    assert.equal((ev!.payload as Record<string, unknown>).teamId, h.teamId);
    await drain();
    assert.equal(h.board.snapshot().tasks[idA]!.status, 'success');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('set_dependency/assign 发 task-dep-added/task-assigned', async () => {
  const tmp = tmpdir('sunshinex-tb-depev-');
  try {
    const h = makeBoard(tmp);
    const a = h.board.create({ teamId: h.teamId, title: 'A', spec: 'a' });
    const b = h.board.create({ teamId: h.teamId, title: 'B', spec: 'b' });
    assert.ok(a.ok && b.ok);
    await drain();
    assert.ok(h.board.setDependency(b.value.taskId, a.value.taskId).ok);
    const dep = h.events.find((e) => e.type === 'task-dep-added');
    assert.deepEqual(dep!.payload, { taskId: b.value.taskId, dependsOn: a.value.taskId });
    assert.ok(h.board.setDependency(b.value.taskId, a.value.taskId).ok);
    assert.equal(h.events.filter((e) => e.type === 'task-dep-added').length, 1);
    assert.ok(h.board.assign(a.value.taskId, 'alice').ok);
    const asg = h.events.find((e) => e.type === 'task-assigned');
    assert.deepEqual(asg!.payload, { taskId: a.value.taskId, assignee: 'alice' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('summaryLines 英文化:needs 标记,无中文字符', async () => {
  const tmp = tmpdir('sunshinex-tb-en-');
  try {
    const h = makeBoard(tmp, { failReplies: ['A'] });
    const a = h.board.create({ teamId: h.teamId, title: 'A', spec: 'a' });
    assert.ok(a.ok);
    await drain();
    const b = h.board.create({ teamId: h.teamId, title: 'B', spec: 'b', dependsOn: [a.value.taskId] });
    assert.ok(b.ok);
    const lines = h.board.summaryLines();
    assert.ok(lines.includes(`${a.value.taskId} [failed] A`));
    assert.ok(lines.includes(`${b.value.taskId} [pending] B (needs ${a.value.taskId})`));
    assert.ok(lines.every((l) => !/[\u4e00-\u9fff]/.test(l)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('finishExecution 直调:artifact 与台账收口', async () => {
  const tmp = tmpdir('sunshinex-tb-finish-');
  try {
    const events: SessionEvent[] = [];
    const finishes: unknown[][] = [];
    let release: () => void = () => {};
    const hang = new Promise<void>((res) => { release = res; });
    const { agentTeams, teamId } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: { runSubagent: async () => { await hang; return { ok: true as const, value: { reply: 'late', tokens: 1 } }; } } as unknown as SubagentRunner,
      registry: { submit: () => ({ id: 'fx1', stop: () => {} }), append: () => {}, finish: (...args: unknown[]) => { finishes.push(args); } } as unknown as TaskRegistry,
      agentTeams,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    board.init();
    const ra = board.create({ teamId, title: 'A', spec: 'a' });
    assert.ok(ra.ok);
    const idA = ra.value.taskId;
    await drain();
    assert.equal(board.snapshot().tasks[idA]!.status, 'running');
    board.finishExecution(idA, { ok: true, reply: 'r', tokens: 5 }, 'fx1');
    assert.equal(board.snapshot().tasks[idA]!.status, 'success');
    assert.equal(board.snapshot().tasks[idA]!.artifact?.tokens, 5);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]![1], 'done');
    const st = events.find((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.status === 'success');
    assert.equal((st!.payload as Record<string, unknown>).from, 'running');
    release();
    await drain();
    assert.equal(board.snapshot().tasks[idA]!.status, 'success');
    assert.equal(finishes.length, 1, '迟到回写不重复 finish');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('init 惰性建档:空板零物化,首写才建', async () => {
  const tmp = tmpdir('sunshinex-tb-lazy-');
  try {
    const h = makeBoard(tmp);
    const teamDir = path.join(tmp, 'teams', 'main');
    assert.equal(fs.existsSync(teamDir), false);
    const r = h.board.create({ teamId: h.teamId, title: 'A', spec: 'a' });
    assert.ok(r.ok);
    await drain();
    assert.ok(fs.existsSync(path.join(teamDir, 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(teamDir, 'board.json')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('持久化往返:重启 init 将 pending 与 running 自愈为 cancelled', async () => {
  const tmp = tmpdir('sunshinex-tb-round-');
  try {
    const h1 = makeBoard(tmp);
    const ra = h1.board.create({ teamId: h1.teamId, title: 'A', spec: 'do A' });
    assert.ok(ra.ok);
    const idA = ra.value.taskId;
    await drain();
    assert.equal(h1.board.snapshot().tasks[idA]!.status, 'success');
    const store2 = new TeamStore(path.join(tmp, 'teams', 'main'));
    store2.append({ t: 'task-created', taskId: 't9', title: 'X', spec: 'x', dependsOn: [], teamId: h1.teamId, ts: 1 });
    store2.append({ t: 'status-changed', taskId: 't9', from: 'pending', to: 'running', ts: 2 });
    const board2 = new TaskBoard({
      store: store2,
      runner: { runSubagent: async () => ({ ok: true as const, value: { reply: 'r', tokens: 1 } }) } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams: h1.agentTeams,
    });
    board2.init();
    assert.equal(board2.snapshot().tasks['t9']!.status, 'cancelled');
    assert.equal(board2.snapshot().tasks[idA]!.status, 'success');
    const raw = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8');
    assert.match(raw, /"from":"running","to":"cancelled"/);
    assert.match(raw, /interrupted by restart/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('teamTokenCapEnv:未设/空=undefined,合法正整数生效,非法 fail-fast 带槽名', () => {
  assert.equal(teamTokenCapEnv({}), undefined);
  assert.equal(teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '' }), undefined);
  assert.equal(teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '  ' }), undefined);
  assert.equal(teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '1000000' }), 1_000_000);
  assert.throws(() => teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '-5' }), /SUNSHINEX_TEAM_TOKEN_CAP/);
  assert.throws(() => teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '0' }), /SUNSHINEX_TEAM_TOKEN_CAP/);
  assert.throws(() => teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '2.5' }), /SUNSHINEX_TEAM_TOKEN_CAP/);
  assert.throws(() => teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: 'abc' }), /SUNSHINEX_TEAM_TOKEN_CAP/);
});

test('team 预算帽:超帽留 pending,摘要与 notice,重启后续接用量', async () => {
  const tmp = tmpdir('sunshinex-tb-teamcap-');
  try {
    const h = makeBoard(tmp, { teamTokenCap: 15 });
    const ra = h.board.create({ teamId: h.teamId, title: 'A', spec: 'a' });
    assert.ok(ra.ok);
    const idA = ra.value.taskId;
    await drain();
    assert.equal(h.board.snapshot().tasks[idA]!.status, 'success');
    assert.ok(h.board.summaryLines().includes('team budget 10/15 tokens'));
    const rb = h.board.create({ teamId: h.teamId, title: 'B', spec: 'b' });
    assert.ok(rb.ok);
    const idB = rb.value.taskId;
    await drain();
    assert.equal(h.board.snapshot().tasks[idB]!.status, 'success');
    const rc = h.board.create({ teamId: h.teamId, title: 'C', spec: 'c' });
    assert.ok(rc.ok);
    const idC = rc.value.taskId;
    await drain();
    assert.equal(h.board.snapshot().tasks[idC]!.status, 'pending');
    assert.deepEqual(h.calls, [`Task ${idA}: A`, `Task ${idB}: B`]);
    assert.ok(h.board.summaryLines().includes('team budget exhausted (20/15) tokens'));
    assert.ok(!h.events.some((e) => e.type === 'task-blocked'));
    const notices = h.events.filter((e) => e.type === 'notice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.text, 'team budget exhausted (20/15) tokens — new tasks stay pending until the cap is lifted');
    assert.deepEqual(notices[0]!.payload, { source: 'taskboard', used: 20, cap: 15 });
    assert.ok(h.board.assign(idA, 'alice').ok);
    await drain();
    assert.equal(h.board.snapshot().tasks[idC]!.status, 'pending');
    const rd = h.board.create({ teamId: h.teamId, title: 'D', spec: 'd' });
    assert.ok(rd.ok);
    const idD = rd.value.taskId;
    await drain();
    assert.equal(h.board.snapshot().tasks[idC]!.status, 'pending');
    assert.equal(h.board.snapshot().tasks[idD]!.status, 'pending');
    assert.equal(h.events.filter((e) => e.type === 'notice').length, 1);

    const board2 = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: { runSubagent: async () => ({ ok: true as const, value: { reply: 'r2', tokens: 10 } }) } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams: h.agentTeams,
      teamTokenCap: 15,
    });
    board2.init();
    assert.equal(board2.snapshot().tasks[idC]!.status, 'cancelled', '重启自愈取消残留 pending');
    const re = board2.create({ teamId: h.teamId, title: 'E', spec: 'e' });
    assert.ok(re.ok);
    await drain();
    assert.equal(board2.snapshot().tasks[re.value.taskId]!.status, 'pending');
    assert.ok(board2.summaryLines().includes('team budget exhausted (20/15) tokens'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('team 预算帽:超帽 claim 返回 undefined', async () => {
  const tmp = tmpdir('sunshinex-tb-capclaim-');
  try {
    const h = makeBoard(tmp, { teamTokenCap: 15 });
    const ra = h.board.create({ teamId: h.teamId, title: 'A', spec: 'a' });
    const rb = h.board.create({ teamId: h.teamId, title: 'B', spec: 'b' });
    assert.ok(ra.ok && rb.ok);
    await drain();
    await drain();
    const rc = h.board.create({ teamId: h.teamId, title: 'C', spec: 'c' });
    assert.ok(rc.ok);
    const idC = rc.value.taskId;
    await drain();
    assert.equal(h.board.snapshot().tasks[idC]!.status, 'pending');
    assert.equal(h.board.claim('w1'), undefined);
    assert.equal(h.board.snapshot().tasks[idC]!.status, 'pending');
    assert.ok(!h.events.some((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.taskId === idC && (e.payload as Record<string, unknown>)?.status === 'running'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('认领归因:claim/markClaimed/executeOne 的 by 在 running 时落盘', async () => {
  const tmp = tmpdir('sunshinex-tb-by-');
  try {
    let release: () => void = () => {};
    const hang = new Promise<void>((res) => { release = res; });
    const events: SessionEvent[] = [];
    const { agentTeams, teamId } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: { runSubagent: async () => { await hang; return { ok: true as const, value: { reply: 'late', tokens: 1 } }; } } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 2000; return () => ++n; })(),
    });
    board.init();
    try {
      const ra = board.create({ teamId, title: 'A', spec: 'a' });
      assert.ok(ra.ok);
      const idA = ra.value.taskId;
      await drain();
      const rb = board.create({ teamId, title: 'B', spec: 'b' });
      assert.ok(rb.ok);
      const idB = rb.value.taskId;
      assert.equal(board.snapshot().tasks[idA]!.status, 'running');
      assert.equal(board.snapshot().tasks[idA]!.executedBy, 'fork');
      const forkEv = events.find((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.taskId === idA && (e.payload as Record<string, unknown>)?.status === 'running');
      assert.equal((forkEv!.payload as Record<string, unknown>)?.by, 'fork');
      const claimed = board.claim('w1');
      assert.equal(claimed?.id, idB);
      assert.equal(board.snapshot().tasks[idB]!.executedBy, 'w1');
      const claimEv = events.find((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.taskId === idB && (e.payload as Record<string, unknown>)?.status === 'running');
      assert.equal((claimEv!.payload as Record<string, unknown>)?.by, 'w1');
      const raw = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8');
      assert.ok(raw.includes('"by":"w1"'));
      assert.equal(board.markClaimed(idB, 'w2'), true);
      assert.equal(board.snapshot().tasks[idB]!.executedBy, 'w1');
    } finally {
      release();
    }
    await drain();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settle:快 runner 完成后早退', async () => {
  const tmp = tmpdir('sunshinex-tb-settle-fast-');
  try {
    const h = makeBoard(tmp);
    const r = h.board.create({ teamId: h.teamId, title: 'A', spec: 'a' });
    assert.ok(r.ok);
    const t0 = Date.now();
    const st = await h.board.settle(1000);
    const waited = Date.now() - t0;
    assert.equal(st.tasks[r.value.taskId]!.status, 'success');
    assert.ok(Object.values(st.tasks).every((t) => t.status !== 'pending' && t.status !== 'running'));
    assert.ok(waited < 1000, `早退(实际 ${waited}ms)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settle:慢 runner 超时返回 running', async () => {
  const tmp = tmpdir('sunshinex-tb-settle-slow-');
  try {
    let release: () => void = () => {};
    const hang = new Promise<void>((res) => { release = res; });
    const { agentTeams, teamId } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: { runSubagent: async () => { await hang; return { ok: true as const, value: { reply: 'late', tokens: 1 } }; } } as unknown as SubagentRunner,
      registry: registryStub,
      agentTeams,
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    board.init();
    const r = board.create({ teamId, title: 'S', spec: 's' });
    assert.ok(r.ok);
    const st = await board.settle(150);
    assert.equal(st.tasks[r.value.taskId]!.status, 'running');
    release();
    await new Promise((r2) => setTimeout(r2, 250));
    assert.equal(board.snapshot().tasks[r.value.taskId]!.status, 'success');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
