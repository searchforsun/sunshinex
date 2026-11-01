import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import { makeTeammateTools } from './teammate-tools';
import { AgentTeamRegistry, MemoryAgentTeamStore } from './team-registry';
import type { TeamRegistry } from './teammate';
import type { BoardTask } from './model';
import { SessionEvent } from '../types';
import { teamTokenCapEnv } from '../config/termination-config';
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

/** 假 teammate 注册表:kick 认领后按 failTitles/hang/abortTitles 决定 finishExecution。
 *  interruptCurrent 打断 hang;releaseHang 放行 hang 成功收口。 */
function makeStubTeam(opts: {
  teamId: string;
  getBoard: () => TaskBoard;
  failTitles?: string[];
  abortTitles?: string[];
  hangTitles?: string[];
  hangAll?: boolean;
  calls?: string[];
  tokens?: number;
}): { team: TeamRegistry; releaseHang: () => void; interrupted: () => boolean } {
  const failTitles = new Set(opts.failTitles ?? []);
  const abortTitles = new Set(opts.abortTitles ?? []);
  const hangTitles = new Set(opts.hangTitles ?? []);
  const calls = opts.calls ?? [];
  const tokens = opts.tokens ?? 10;
  let hangResolve: (() => void) | undefined;
  let aborted = false;
  let hanging = false;
  let claiming = false;

  const shouldHang = (title: string): boolean => opts.hangAll === true || hangTitles.has(title);

  async function execute(task: BoardTask): Promise<void> {
    const board = opts.getBoard();
    const line = `Task ${task.id}: ${task.title}\n${task.spec}`;
    calls.push(line);
    // 让同 tick 内后续 create 先落板,并等 board.drain 收兵后再 finish→kick(否则 draining 中尾 kick 被吞)
    await new Promise<void>((r) => setImmediate(r));
    if (shouldHang(task.title)) {
      hanging = true;
      aborted = false;
      await new Promise<void>((res) => { hangResolve = res; });
      hanging = false;
      hangResolve = undefined;
      if (aborted) {
        board.finishExecution(task.id, {
          ok: false,
          terminal: 'cancelled',
          by: 'worker',
          error: { code: 'ABORTED', message: 'aborted' },
        });
        return;
      }
    }
    if (abortTitles.has(task.title)) {
      board.finishExecution(task.id, {
        ok: false,
        terminal: 'cancelled',
        by: 'worker',
        error: { code: 'ABORTED', message: 'aborted' },
      });
      return;
    }
    if (failTitles.has(task.title)) {
      board.finishExecution(task.id, {
        ok: false,
        by: 'worker',
        error: { code: 'INCOMPLETE', message: 'no finish' },
      });
      return;
    }
    board.finishExecution(task.id, {
      ok: true,
      by: 'worker',
      reply: `reply of ${line}`,
      tokens,
    });
  }

  const worker = {
    name: 'worker',
    teamId: opts.teamId,
    stopped: false,
    kick(): void {
      if (claiming || worker.stopped) return;
      claiming = true;
      void (async () => {
        try {
          while (!worker.stopped) {
            const task = opts.getBoard().claim('worker', opts.teamId);
            if (task === undefined) break;
            await execute(task);
          }
        } finally {
          claiming = false;
        }
      })();
    },
    async runTask(task: BoardTask): Promise<void> {
      const board = opts.getBoard();
      if (!board.markClaimed(task.id, 'worker')) return;
      await execute(task);
    },
    interruptCurrent(): boolean {
      if (!hanging || hangResolve === undefined) return false;
      aborted = true;
      hangResolve();
      return true;
    },
  };

  const team = {
    get: (name: string) => (name === 'worker' && !worker.stopped ? worker : undefined),
    aliveNames: (teamId?: string) => {
      if (worker.stopped) return [];
      if (teamId !== undefined && worker.teamId !== teamId) return [];
      return ['worker'];
    },
    hasAlive: () => !worker.stopped,
    stop: () => { worker.stopped = true; worker.interruptCurrent(); },
    stopAll: () => { worker.stopped = true; worker.interruptCurrent(); },
    teamIdOf: (name: string) => (name === 'worker' && !worker.stopped ? worker.teamId : undefined),
    register: () => ({ ok: true as const, value: undefined }),
  } as unknown as TeamRegistry;

  return {
    team,
    releaseHang: () => { hangResolve?.(); },
    interrupted: () => aborted,
  };
}

interface Harness {
  board: TaskBoard;
  events: SessionEvent[];
  calls: string[];
  teamId: string;
  agentTeams: AgentTeamRegistry;
  team: TeamRegistry;
  releaseHang: () => void;
}

function makeBoard(tmp: string, opts?: {
  failTitles?: string[];
  abortTitles?: string[];
  hangTitles?: string[];
  hangAll?: boolean;
  teamTokenCap?: number;
  tokens?: number;
}): Harness {
  const events: SessionEvent[] = [];
  const calls: string[] = [];
  const { agentTeams, teamId } = attachTeam();
  let boardRef: TaskBoard | undefined;
  const stub = makeStubTeam({
    teamId,
    getBoard: () => boardRef!,
    failTitles: opts?.failTitles,
    abortTitles: opts?.abortTitles,
    hangTitles: opts?.hangTitles,
    hangAll: opts?.hangAll,
    calls,
    tokens: opts?.tokens,
  });
  const board = new TaskBoard({
    store: new TeamStore(path.join(tmp, 'teams', 'main')),
    registry: registryStub,
    agentTeams,
    team: stub.team,
    onEvent: (e) => events.push(e),
    now: (() => { let n = 1000; return () => ++n; })(),
    ...(opts?.teamTokenCap !== undefined ? { teamTokenCap: opts.teamTokenCap } : {}),
  });
  boardRef = board;
  board.init();
  return { board, events, calls, teamId, agentTeams, team: stub.team, releaseHang: stub.releaseHang };
}

const drain = () => new Promise((r) => setImmediate(r));
/** stub 经 setImmediate 收口:连等两拍覆盖 kick→finish→尾 kick */
const flushStub = async (): Promise<void> => {
  await drain();
  await drain();
};

test('stopTask:pending 与 running → cancelled;终态幂等', async () => {
  const tmp = tmpdir('sunshinex-tb-stop-');
  try {
    const events: SessionEvent[] = [];
    const { agentTeams, teamId } = attachTeam();
    let boardRef: TaskBoard | undefined;
    const stub = makeStubTeam({ teamId, getBoard: () => boardRef!, hangTitles: ['A'] });
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      registry: { submit: () => ({ id: 's1', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry,
      agentTeams,
      team: stub.team,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    boardRef = board;
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
    assert.equal(stub.interrupted(), true, 'running 的 stopTask 经 interruptCurrent 打断 hang');
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
    await drain();
    assert.equal(board.snapshot().tasks[idA]!.status, 'cancelled', '迟到回写不覆盖 cancelled');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('stopTask:上游 cancelled 向 pending 下游发 task-blocked', async () => {
  const tmp = tmpdir('sunshinex-tb-stop-block-');
  try {
    const events: SessionEvent[] = [];
    const { agentTeams, teamId } = attachTeam();
    let boardRef: TaskBoard | undefined;
    const stub = makeStubTeam({ teamId, getBoard: () => boardRef!, hangTitles: ['A'] });
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'block')),
      registry: registryStub,
      agentTeams,
      team: stub.team,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    boardRef = board;
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
    const cases = ['A', 'B'];
    for (const title of cases) {
      const events: SessionEvent[] = [];
      const { agentTeams, teamId } = attachTeam();
      let boardRef: TaskBoard | undefined;
      const stub = makeStubTeam({ teamId, getBoard: () => boardRef!, abortTitles: [title] });
      const board = new TaskBoard({
        store: new TeamStore(path.join(tmp, 'teams', title)),
        registry: registryStub,
        agentTeams,
        team: stub.team,
        onEvent: (e) => events.push(e),
        now: (() => { let n = 1000; return () => ++n; })(),
      });
      boardRef = board;
      board.init();
      const up = board.create({ teamId, title, spec: title });
      assert.ok(up.ok);
      const id = up.value.taskId;
      const down = board.create({ teamId, title: `${title}-down`, spec: 'd', dependsOn: [id] });
      assert.ok(down.ok);
      await drain();
      assert.equal(board.snapshot().tasks[id]!.status, 'cancelled', title);
      assert.equal(board.snapshot().tasks[down.value.taskId]!.status, 'pending');
      const blocked = events.find((e) => e.type === 'task-blocked');
      assert.ok(blocked, `${title} 下游 task-blocked`);
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
      const { agentTeams, teamId } = attachTeam();
      let boardRef: TaskBoard | undefined;
      const stub = makeStubTeam({ teamId, getBoard: () => boardRef!, hangTitles: [title] });
      const board = new TaskBoard({
        store: new TeamStore(path.join(tmp, 'teams', title)),
        registry: registryStub,
        agentTeams,
        team: stub.team,
        now: (() => { let n = 1000; return () => ++n; })(),
      });
      boardRef = board;
      board.init();
      const created = board.create({ teamId, title, spec: title });
      assert.ok(created.ok);
      await drain();
      assert.equal(board.snapshot().tasks[created.value.taskId]!.status, 'running');
      const result = board.finishExecution(created.value.taskId, report);
      stub.releaseHang();
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

    const h = makeBoard(tmp, { failTitles: ['Anchor'] });
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
    const { agentTeams, teamId } = attachTeam();
    let boardRef: TaskBoard | undefined;
    const stub = makeStubTeam({ teamId, getBoard: () => boardRef!, calls });
    const board = new TaskBoard({
      store,
      registry: registryStub,
      agentTeams,
      team: stub.team,
      now: () => 50,
    });
    boardRef = board;
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
    const agentTeams = new AgentTeamRegistry(new MemoryAgentTeamStore(), () => 1);
    const alpha = agentTeams.create('alpha');
    const beta = agentTeams.create('beta');
    assert.ok(alpha.ok && beta.ok);
    let boardRef: TaskBoard | undefined;
    const stub = makeStubTeam({ teamId: alpha.value.teamId, getBoard: () => boardRef!, hangTitles: ['Live'] });
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      registry: registryStub,
      agentTeams,
      team: stub.team,
      now: (() => { let n = 10; return () => ++n; })(),
    });
    boardRef = board;
    board.init();
    const unknown = board.create({ teamId: 'team-nope', title: 'A', spec: 'a' });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.error.message, /unknown teamId: team-nope; create a team with create_agent_team first/);
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
    stub.releaseHang();
    await flushStub();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('依赖顺序:上游 running 时下游不派发;成功后下游 success', async () => {
  const tmp = tmpdir('sunshinex-tb-dep-');
  try {
    const calls: string[] = [];
    const { agentTeams, teamId } = attachTeam();
    let boardRef: TaskBoard | undefined;
    const stub = makeStubTeam({ teamId, getBoard: () => boardRef!, hangTitles: ['A'], calls });
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      registry: registryStub,
      agentTeams,
      team: stub.team,
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    boardRef = board;
    board.init();
    const a = board.create({ teamId, title: 'A', spec: 'do A' });
    assert.ok(a.ok);
    const idA = a.value.taskId;
    const b = board.create({ teamId, title: 'B', spec: 'do B', dependsOn: [idA] });
    assert.ok(b.ok);
    const idB = b.value.taskId;
    await drain();
    assert.deepEqual(calls, [`Task ${idA}: A\ndo A`]);
    assert.equal(board.snapshot().tasks[idA]!.status, 'running');
    assert.equal(board.snapshot().tasks[idB]!.status, 'pending');
    stub.releaseHang();
    await drain();
    await drain();
    assert.deepEqual(calls, [`Task ${idA}: A\ndo A`, `Task ${idB}: B\ndo B`]);
    assert.equal(board.snapshot().tasks[idA]!.status, 'success');
    assert.equal(board.snapshot().tasks[idB]!.status, 'success');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('执行失败:回写 failed + 下游 task-blocked 不自动 skip', async () => {
  const tmp = tmpdir('sunshinex-tb-fail-');
  try {
    const h = makeBoard(tmp, { failTitles: ['A'] });
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

test('无 team 注入:未指派任务保持 pending', async () => {
  const tmp = tmpdir('sunshinex-tb-noteam-');
  try {
    const { agentTeams, teamId } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      registry: registryStub,
      agentTeams,
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    board.init();
    const r = board.create({ teamId, title: 'A', spec: 'a' });
    assert.ok(r.ok);
    const idA = r.value.taskId;
    await drain();
    await new Promise((res) => setTimeout(res, 40));
    assert.equal(board.snapshot().tasks[idA]!.status, 'pending');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('无活 teammate:任务保持 pending,drain 有界', async () => {
  const tmp = tmpdir('sunshinex-tb-deadteam-');
  try {
    const { agentTeams, teamId } = attachTeam();
    let boardRef: TaskBoard | undefined;
    const stub = makeStubTeam({ teamId, getBoard: () => boardRef! });
    stub.team.stopAll();
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      registry: registryStub,
      agentTeams,
      team: stub.team,
      now: (() => { let n = 1000; return () => ++n; })(),
      retryDelayMs: 50,
    });
    boardRef = board;
    board.init();
    const r = board.create({ teamId, title: 'A', spec: 'a' });
    assert.ok(r.ok);
    const idA = r.value.taskId;
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(board.snapshot().tasks[idA]!.status, 'pending');
    const lines = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0).length;
    assert.ok(lines <= 10, `事件流有界(实际 ${lines})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('set_dependency 环检测;限流;id 方言', async () => {
  const tmp = tmpdir('sunshinex-tb-cycle-');
  try {
    const h = makeBoard(tmp, { failTitles: ['anchor'] });
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
    assert.equal((ev!.payload as Record<string, unknown>).teamName, 'alpha', '卡头直播：task-created 携注册表队名');
    assert.equal((ev!.payload as Record<string, unknown>).teamCreatedAt, 1);
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
    await flushStub();
    assert.ok(h.board.setDependency(b.value.taskId, a.value.taskId).ok);
    const dep = h.events.find((e) => e.type === 'task-dep-added');
    assert.deepEqual(dep!.payload, { taskId: b.value.taskId, dependsOn: a.value.taskId });
    assert.ok(h.board.setDependency(b.value.taskId, a.value.taskId).ok);
    assert.equal(h.events.filter((e) => e.type === 'task-dep-added').length, 1);
    assert.ok(h.board.assign(a.value.taskId, 'worker').ok);
    const asg = h.events.find((e) => e.type === 'task-assigned');
    assert.deepEqual(asg!.payload, { taskId: a.value.taskId, assignee: 'worker' });
    await flushStub();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('summaryLines 英文化:needs 标记,无中文字符;teamId 常在,retryOf 有值才出现', async () => {
  const tmp = tmpdir('sunshinex-tb-en-');
  try {
    const h = makeBoard(tmp, { failTitles: ['A'] });
    const a = h.board.create({ teamId: h.teamId, title: 'A', spec: 'a' });
    assert.ok(a.ok);
    await drain();
    const b = h.board.create({ teamId: h.teamId, title: 'B', spec: 'b', dependsOn: [a.value.taskId], retryOf: a.value.taskId });
    assert.ok(b.ok);
    const lines = h.board.summaryLines();
    assert.ok(lines.includes(`${a.value.taskId} [failed] A team=${h.teamId}`));
    assert.equal(lines.find((l) => l.startsWith(a.value.taskId))!.includes('retryOf='), false);
    assert.ok(lines.includes(`${b.value.taskId} [pending] B (needs ${a.value.taskId}) team=${h.teamId} retryOf=${a.value.taskId}`));
    assert.ok(lines.every((l) => !/[\u4e00-\u9fff]/.test(l)));
    const getTask = makeTeammateTools(h.board).find((t) => t.name === 'get_task')!;
    const fullB = (await getTask.executor({ taskId: b.value.taskId })) as { stdout: string };
    assert.match(fullB.stdout, new RegExp(`^teamId: ${h.teamId}$`, 'm'));
    assert.match(fullB.stdout, new RegExp(`^retryOf: ${a.value.taskId}$`, 'm'));
    const fullA = (await getTask.executor({ taskId: a.value.taskId })) as { stdout: string };
    assert.match(fullA.stdout, new RegExp(`^teamId: ${h.teamId}$`, 'm'));
    assert.equal(fullA.stdout.includes('retryOf:'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('init:旧 events.jsonl 含 gate-set 与 claimed 不抛,未收口任务变为 cancelled', async () => {
  const tmp = tmpdir('sunshinex-tb-legacy-');
  try {
    const dir = path.join(tmp, 'teams', 'main');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      JSON.stringify({ t: 'task-created', taskId: 't-open', title: 'Open', spec: 'o', dependsOn: [], teamId: 'tm-old', ts: 1 }),
      JSON.stringify({ t: 'gate-set', taskId: 't-open', ts: 2 }),
      JSON.stringify({ t: 'status-changed', taskId: 't-open', from: 'claimed', to: 'in-review', ts: 3 }),
      JSON.stringify({ t: 'task-created', taskId: 't-run', title: 'Run', spec: 'r', dependsOn: [], teamId: 'tm-old', ts: 4 }),
      JSON.stringify({ t: 'status-changed', taskId: 't-run', from: 'pending', to: 'running', ts: 5 }),
      JSON.stringify({ t: 'gate-resolved', taskId: 't-run', ts: 6 }),
      JSON.stringify({ t: 'task-created', taskId: 't-ok', title: 'Ok', spec: 'k', dependsOn: [], teamId: 'tm-old', ts: 7 }),
      JSON.stringify({ t: 'status-changed', taskId: 't-ok', from: 'pending', to: 'running', ts: 8 }),
      JSON.stringify({ t: 'status-changed', taskId: 't-ok', from: 'running', to: 'success', ts: 9 }),
    ].join('\n') + '\n', 'utf8');
    const { agentTeams } = attachTeam();
    const board = new TaskBoard({
      store: new TeamStore(dir),
      registry: registryStub,
      agentTeams,
    });
    assert.doesNotThrow(() => board.init());
    assert.equal(board.snapshot().tasks['t-open']!.status, 'cancelled');
    assert.equal(board.snapshot().tasks['t-run']!.status, 'cancelled');
    assert.equal(board.snapshot().tasks['t-ok']!.status, 'success');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('finishExecution 直调:artifact 与台账收口', async () => {
  const tmp = tmpdir('sunshinex-tb-finish-');
  try {
    const events: SessionEvent[] = [];
    const finishes: unknown[][] = [];
    const { agentTeams, teamId } = attachTeam();
    let boardRef: TaskBoard | undefined;
    const stub = makeStubTeam({ teamId, getBoard: () => boardRef!, hangTitles: ['A'] });
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      registry: { submit: () => ({ id: 'fx1', stop: () => {} }), append: () => {}, finish: (...args: unknown[]) => { finishes.push(args); } } as unknown as TaskRegistry,
      agentTeams,
      team: stub.team,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    boardRef = board;
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
    stub.releaseHang();
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
    assert.deepEqual(h.calls, [`Task ${idA}: A\na`, `Task ${idB}: B\nb`]);
    assert.ok(h.board.summaryLines().includes('team budget exhausted (20/15) tokens'));
    assert.ok(!h.events.some((e) => e.type === 'task-blocked'));
    const notices = h.events.filter((e) => e.type === 'notice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.text, 'team budget exhausted (20/15) tokens — new tasks stay pending until the cap is lifted');
    assert.deepEqual(notices[0]!.payload, { source: 'taskboard', used: 20, cap: 15 });
    assert.ok(h.board.assign(idA, 'worker').ok);
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
      registry: registryStub,
      agentTeams: h.agentTeams,
      team: h.team,
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
    const events: SessionEvent[] = [];
    const { agentTeams, teamId } = attachTeam();
    let boardRef: TaskBoard | undefined;
    const stub = makeStubTeam({ teamId, getBoard: () => boardRef!, hangTitles: ['A'] });
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      registry: registryStub,
      agentTeams,
      team: stub.team,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 2000; return () => ++n; })(),
    });
    boardRef = board;
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
      assert.equal(board.snapshot().tasks[idA]!.executedBy, 'worker');
      const workerEv = events.find((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.taskId === idA && (e.payload as Record<string, unknown>)?.status === 'running');
      assert.equal((workerEv!.payload as Record<string, unknown>)?.by, 'worker');
      const picked = board.claim('w1');
      assert.equal(picked?.id, idB);
      assert.equal(board.snapshot().tasks[idB]!.executedBy, 'w1');
      const claimEv = events.find((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.taskId === idB && (e.payload as Record<string, unknown>)?.status === 'running');
      assert.equal((claimEv!.payload as Record<string, unknown>)?.by, 'w1');
      const raw = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8');
      assert.ok(raw.includes('"by":"w1"'));
      assert.equal(board.markClaimed(idB, 'w2'), true);
      assert.equal(board.snapshot().tasks[idB]!.executedBy, 'w1');
    } finally {
      stub.releaseHang();
    }
    await drain();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settle:快 stub 完成后早退', async () => {
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

test('settle:慢 hang stub 超时返回 running', async () => {
  const tmp = tmpdir('sunshinex-tb-settle-slow-');
  try {
    const { agentTeams, teamId } = attachTeam();
    let boardRef: TaskBoard | undefined;
    const stub = makeStubTeam({ teamId, getBoard: () => boardRef!, hangTitles: ['S'] });
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      registry: registryStub,
      agentTeams,
      team: stub.team,
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    boardRef = board;
    board.init();
    const r = board.create({ teamId, title: 'S', spec: 's' });
    assert.ok(r.ok);
    const st = await board.settle(150);
    assert.equal(st.tasks[r.value.taskId]!.status, 'running');
    stub.releaseHang();
    await new Promise((r2) => setTimeout(r2, 250));
    assert.equal(board.snapshot().tasks[r.value.taskId]!.status, 'success');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
