import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeTaskBoardTools, TASKBOARD_TOOL_NAMES } from './taskboard-tools';
import { TaskBoard } from '../../taskboard/board';
import { TeamStore } from '../../taskboard/store';
import { AgentTeamRegistry, MemoryAgentTeamStore } from '../../taskboard/team-registry';
import type { TeamRegistry } from '../../taskboard/teammate';
import type { BoardTask } from '../../taskboard/model';
import type { TaskRegistry } from '../tasks';

function makeBoard(tmp: string): { board: TaskBoard; teams: AgentTeamRegistry; teamId: string } {
  const registry = { submit: () => ({ id: 'b1', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry;
  const teams = new AgentTeamRegistry(new MemoryAgentTeamStore());
  const created = teams.create('alpha');
  if (!created.ok) throw new Error(created.error.message);
  const teamId = created.value.teamId;
  let boardRef: TaskBoard | undefined;
  const worker = {
    name: 'worker',
    teamId,
    stopped: false,
    kick(): void {
      const task = boardRef!.claim('worker', teamId);
      if (task !== undefined) void this.runTask(task);
    },
    async runTask(task: BoardTask): Promise<void> {
      const board = boardRef!;
      if (!board.markClaimed(task.id, 'worker')) return;
      await new Promise<void>((r) => setImmediate(r));
      board.finishExecution(task.id, { ok: true, by: 'worker', reply: `r ${task.title}`, tokens: 1 });
    },
    interruptCurrent: () => false,
  };
  const team = {
    get: (name: string) => (name === 'worker' ? worker : undefined),
    aliveNames: () => ['worker'],
    hasAlive: () => true,
  } as unknown as TeamRegistry;
  const board = new TaskBoard({ store: new TeamStore(path.join(tmp, 'teams', 'main')), registry, agentTeams: teams, team });
  boardRef = board;
  board.init();
  return { board, teams, teamId };
}

const drain = () => new Promise((r) => setImmediate(r));
const flushStub = async (): Promise<void> => { await drain(); await drain(); };

/** 从 create_agent_team_task observation 捕获真实板 id(回执标题优先、id= 置尾;随机段不可写字面量) */
function createdId(stdout: string): string {
  const m = /id=([^\s);,]+)/.exec(stdout);
  assert.ok(m, `observation 含新任务 id:${stdout}`);
  return m![1]!;
}

test('工具名全集(TASKBOARD_TOOL_NAMES 随动)与 observation 带板摘要;create_agent_team 返回 teamId;update_agent_team_task 只接受 assign|depend', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools-'));
  try {
    const { board, teams } = makeBoard(tmp);
    const tools = makeTaskBoardTools(board, teams);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TASKBOARD_TOOL_NAMES].sort());
    assert.ok(tools.every((t) => t.category === 'task'));
    const createTeam = tools.find((t) => t.name === 'create_agent_team')!;
    const teamOut = await createTeam.executor({ name: 'beta' });
    assert.equal(teamOut.exitCode, 0);
    assert.match(teamOut.stdout, /team "beta" created/);
    const teamId = /teamId=(\S+)/.exec(teamOut.stdout)![1]!;
    assert.match(teamId, /^team-[a-z0-9][a-z0-9-]*-[a-z0-9]{4}$/);
    assert.ok(teams.get(teamId) !== undefined, '队注册表含新建队');
    assert.equal(teams.get(teamId)!.name, 'beta');
    const create = tools.find((t) => t.name === 'create_agent_team_task')!;
    assert.deepEqual(
      [...(create.parameters?.required ?? [])].sort(),
      ['assignee', 'dependsOn', 'executor', 'retryOf', 'spec', 'teamId', 'title'],
    );
    const r = await create.executor({ teamId, title: 'A', spec: 'do A', dependsOn: null, assignee: null, executor: null, retryOf: null });
    assert.equal(r.exitCode, 0);
    const idA = createdId(r.stdout);
    assert.match(idA, /^task-[a-z0-9][a-z0-9-]*-[a-z0-9]{4}$/, `新方言形态:${idA}`);
    assert.equal(board.snapshot().tasks[idA]!.teamId, teamId);
    await drain();
    const update = tools.find((t) => t.name === 'update_agent_team_task')!;
    assert.deepEqual(update.parameters?.properties?.action && (update.parameters.properties.action as { enum?: string[] }).enum, ['assign', 'depend']);
    await assert.rejects(() => update.executor({ taskId: idA, action: 'cancel' }), /assign\|depend/, '取消不在 update_agent_team_task');
    await assert.rejects(() => create.executor({ title: 'X', spec: 'x', dependsOn: null, assignee: null, executor: null, retryOf: null }), /unknown teamId/);
    await flushStub();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create_agent_team_task 依赖校验 + update_agent_team_task depend 环拒绝经工具面透出', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools2-'));
  try {
    const { board, teams, teamId } = makeBoard(tmp);
    const tools = makeTaskBoardTools(board, teams);
    const create = tools.find((t) => t.name === 'create_agent_team_task')!;
    const update = tools.find((t) => t.name === 'update_agent_team_task')!;
    const ra = await create.executor({ teamId, title: 'A', spec: 'a', dependsOn: null, assignee: null, executor: null, retryOf: null });
    const idA = createdId(ra.stdout);
    const rb = await create.executor({ teamId, title: 'B', spec: 'b', dependsOn: [idA], assignee: null, executor: null, retryOf: null });
    assert.equal(rb.exitCode, 0);
    const idB = createdId(rb.stdout);
    await flushStub();
    // A←B 加边即与既有 B→A 边成环:拒绝
    await assert.rejects(() => update.executor({ taskId: idA, action: 'depend', dependsOn: idB }), /cycle/, '环拒绝透出 INVALID_ARG');
    await assert.rejects(() => create.executor({ teamId, title: 'C', spec: 'c', dependsOn: ['tX'], assignee: null, executor: null, retryOf: null }), /unknown dependency/);
    // 未知 action:INVALID_ARG(动作枚举面)
    await assert.rejects(() => update.executor({ taskId: idA, action: 'nope' }), /unknown action/);
    await flushStub();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('get_agent_team_board 收编进 lead 面:摘要行含 id/状态/标题,未设帽不透出预算', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools3-'));
  try {
    const { board, teams, teamId } = makeBoard(tmp);
    const tools = makeTaskBoardTools(board, teams);
    const create = tools.find((t) => t.name === 'create_agent_team_task')!;
    const getBoard = tools.find((t) => t.name === 'get_agent_team_board')!;
    const prev = await create.executor({ teamId, title: 'Prev', spec: 'p', dependsOn: null, assignee: null, executor: null, retryOf: null });
    const prevId = createdId(prev.stdout);
    await flushStub();
    assert.equal(board.snapshot().tasks[prevId]!.status, 'success');
    // 2026-11-04 用户裁定:retryOf 仅限异常终态——success 拒绝
    await assert.rejects(() => create.executor({ teamId, title: 'RetryDemo', spec: 'g', dependsOn: null, assignee: null, executor: null, retryOf: prevId }), /retry is only for abnormal ends/);
    // cancelled 可重试:新任务建后即停(异常终态)
    const prev2 = await create.executor({ teamId, title: 'Prev2', spec: 'p2', dependsOn: null, assignee: null, executor: null, retryOf: null });
    const prev2Id = createdId(prev2.stdout);
    assert.ok(board.stopTask(prev2Id).ok, '停 Prev2=cancelled');
    const r = await create.executor({ teamId, title: 'RetryDemo', spec: 'g', dependsOn: null, assignee: null, executor: null, retryOf: prev2Id });
    const id = createdId(r.stdout);
    assert.equal(board.snapshot().tasks[id]!.retryOf, prev2Id);
    const out = (await getBoard.executor({})) as { stdout: string };
    assert.match(out.stdout, new RegExp(`${id} \\[(pending|running|success)\\] RetryDemo team=${teamId} retryOf=${prev2Id}`), '板摘要行含 id/状态/标题/teamId/retryOf');
    const prevLine = out.stdout.split('\n').find((l) => l.startsWith(prevId));
    assert.ok(prevLine?.includes(`team=${teamId}`), '无 retryOf 的任务仍带 teamId');
    assert.equal(prevLine?.includes('retryOf='), false);
    assert.ok(!out.stdout.includes('team budget'), '未设预算帽不透出预算行');
    await flushStub();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('指派排队提示(2026-11-02 C):create/assign 指到忙碌成员回执附 queue note(在跑/已排队计数),指到空闲成员零噪声', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools-queue-'));
  try {
    const registry = { submit: () => ({ id: 'b1', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry;
    const teams = new AgentTeamRegistry(new MemoryAgentTeamStore());
    const created = teams.create('alpha');
    assert.ok(created.ok);
    const teamId = created.value.teamId;
    // 两成员桩:busy 在跑(isBusy=true,runTask 只入队不开跑——模拟单飞 worker 忙碌期);idler 空闲
    const mateOf = (name: string, busy: boolean) => ({
      name, teamId, stopped: false,
      isBusy: () => busy,
      kick(): void {},
      runTask: (): Promise<void> => Promise.resolve(),
      interruptCurrent: () => false,
    });
    const mates: Record<string, ReturnType<typeof mateOf>> = { busy: mateOf('busy', true), idler: mateOf('idler', false) };
    const team = {
      get: (name: string) => mates[name],
      aliveNames: () => Object.keys(mates),
      hasAlive: () => true,
    } as unknown as TeamRegistry;
    const board = new TaskBoard({ store: new TeamStore(path.join(tmp, 'teams', 'main')), registry, agentTeams: teams, team });
    board.init();
    const tools = makeTaskBoardTools(board, teams);
    const create = tools.find((t) => t.name === 'create_agent_team_task')!;
    const update = tools.find((t) => t.name === 'update_agent_team_task')!;
    // ① 指到忙碌成员:提示在跑;排队计数不含本任务
    const r1 = await create.executor({ teamId, title: 'Doc1', spec: 'd1', dependsOn: null, assignee: 'busy', executor: null, retryOf: null });
    assert.equal(r1.exitCode, 0);
    assert.match(r1.stdout, /queue note: teammate "busy" is busy \(running a task\) — this task waits its turn \(teammates run one task at a time\)/);
    // ② 再指一条:前一条仍 pending(指派未开跑)计入 waiting
    const r2 = await create.executor({ teamId, title: 'Doc2', spec: 'd2', dependsOn: null, assignee: 'busy', executor: null, retryOf: null });
    assert.match(r2.stdout, /queue note: teammate "busy" is busy \(running a task; 1 assigned task\(s\) already waiting\)/);
    // ③ 板上真在跑的任务按 executedBy 计入(即便成员桩 isBusy 为 false)
    const r3 = await create.executor({ teamId, title: 'Live', spec: 'l', dependsOn: null, assignee: null, executor: null, retryOf: null });
    const liveId = createdId(r3.stdout);
    assert.doesNotMatch(r3.stdout, /queue note/, 'assignee=null 不出提示');
    assert.ok(board.markClaimed(liveId, 'idler'), 'idler 开跑 Live');
    const r4 = await create.executor({ teamId, title: 'Doc3', spec: 'd3', dependsOn: null, assignee: 'idler', executor: null, retryOf: null });
    assert.match(r4.stdout, new RegExp(`queue note: teammate "idler" is busy \\(running ${liveId}\\)`));
    // ④ update assign 入口同样附提示;Live 收口后 idler 空闲 → 零噪声
    const r5 = await create.executor({ teamId, title: 'Doc4', spec: 'd4', dependsOn: null, assignee: null, executor: null, retryOf: null });
    const d4 = createdId(r5.stdout);
    const u1 = await update.executor({ taskId: d4, action: 'assign', assignee: 'idler', dependsOn: null });
    assert.match(u1.stdout, new RegExp(`^updated: ${d4} assign\nqueue note: teammate "idler" is busy \\(running ${liveId}; 1 assigned task\\(s\\) already waiting\\)`));
    assert.ok(board.finishExecution(liveId, { ok: true, by: 'idler' }).ok);
    const r6 = await create.executor({ teamId, title: 'Doc5', spec: 'd5', dependsOn: null, assignee: 'idler', executor: null, retryOf: null });
    // idler 不再在跑,但 Doc3/Doc4 仍 pending 排队 → 只报 waiting 计数
    assert.match(r6.stdout, /queue note: teammate "idler" is busy \(2 assigned task\(s\) already waiting\)/);
    await flushStub();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
