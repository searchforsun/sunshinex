import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeTaskBoardTools, TASKBOARD_TOOL_NAMES } from './taskboard-tools';
import { TaskBoard } from '../../taskboard/board';
import { TeamStore } from '../../taskboard/store';
import { AgentTeamRegistry, MemoryAgentTeamStore } from '../../taskboard/team-registry';
import type { SubagentRunner } from '../subagent';
import type { TaskRegistry } from '../tasks';

function makeBoard(tmp: string): { board: TaskBoard; teams: AgentTeamRegistry; teamId: string } {
  const runner = { runSubagent: async (_i: unknown, o?: { taskLine?: string }) => ({ ok: true as const, value: { reply: `r ${o?.taskLine ?? ''}`, tokens: 1 } }) } as unknown as SubagentRunner;
  const registry = { submit: () => ({ id: 'b1', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry;
  const teams = new AgentTeamRegistry(new MemoryAgentTeamStore());
  const created = teams.create('alpha');
  if (!created.ok) throw new Error(created.error.message);
  const board = new TaskBoard({ store: new TeamStore(path.join(tmp, 'teams', 'main')), runner, registry, agentTeams: teams });
  board.init();
  return { board, teams, teamId: created.value.teamId };
}

const drain = () => new Promise((r) => setImmediate(r));

/** 从 create_task observation 捕获真实板 id(回执标题优先、id= 置尾;随机段不可写字面量) */
function createdId(stdout: string): string {
  const m = /id=([^\s);,]+)/.exec(stdout);
  assert.ok(m, `observation 含新任务 id:${stdout}`);
  return m![1]!;
}

test('工具名全集(TASKBOARD_TOOL_NAMES 随动)与 observation 带板摘要;create_team 返回 teamId;update_task 只接受 assign|depend', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools-'));
  try {
    const { board, teams } = makeBoard(tmp);
    const tools = makeTaskBoardTools(board, teams);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TASKBOARD_TOOL_NAMES].sort());
    assert.ok(tools.every((t) => t.category === 'task'));
    const createTeam = tools.find((t) => t.name === 'create_team')!;
    const teamOut = await createTeam.executor({ name: 'beta' });
    assert.equal(teamOut.exitCode, 0);
    assert.match(teamOut.stdout, /team "beta" created/);
    const teamId = /teamId=(\S+)/.exec(teamOut.stdout)![1]!;
    assert.match(teamId, /^team-[a-z0-9][a-z0-9-]*-[a-z0-9]{4}$/);
    const create = tools.find((t) => t.name === 'create_task')!;
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
    const update = tools.find((t) => t.name === 'update_task')!;
    assert.deepEqual(update.parameters?.properties?.action && (update.parameters.properties.action as { enum?: string[] }).enum, ['assign', 'depend']);
    await assert.rejects(() => update.executor({ taskId: idA, action: 'cancel' }), /assign\|depend/, '取消不在 update_task');
    await assert.rejects(() => create.executor({ title: 'X', spec: 'x', dependsOn: null, assignee: null, executor: null, retryOf: null }), /unknown teamId/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create_task 依赖校验 + update_task depend 环拒绝经工具面透出', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools2-'));
  try {
    const { board, teams, teamId } = makeBoard(tmp);
    const tools = makeTaskBoardTools(board, teams);
    const create = tools.find((t) => t.name === 'create_task')!;
    const update = tools.find((t) => t.name === 'update_task')!;
    const ra = await create.executor({ teamId, title: 'A', spec: 'a', dependsOn: null, assignee: null, executor: null, retryOf: null });
    const idA = createdId(ra.stdout);
    const rb = await create.executor({ teamId, title: 'B', spec: 'b', dependsOn: [idA], assignee: null, executor: null, retryOf: null });
    assert.equal(rb.exitCode, 0);
    const idB = createdId(rb.stdout);
    await drain();
    // A←B 加边即与既有 B→A 边成环:拒绝
    await assert.rejects(() => update.executor({ taskId: idA, action: 'depend', dependsOn: idB }), /cycle/, '环拒绝透出 INVALID_ARG');
    await assert.rejects(() => create.executor({ teamId, title: 'C', spec: 'c', dependsOn: ['tX'], assignee: null, executor: null, retryOf: null }), /unknown dependency/);
    // 未知 action:INVALID_ARG(动作枚举面)
    await assert.rejects(() => update.executor({ taskId: idA, action: 'nope' }), /unknown action/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('get_board 收编进 lead 面:摘要行含 id/状态/标题,未设帽不透出预算', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tbtools3-'));
  try {
    const { board, teams, teamId } = makeBoard(tmp);
    const tools = makeTaskBoardTools(board, teams);
    const create = tools.find((t) => t.name === 'create_task')!;
    const getBoard = tools.find((t) => t.name === 'get_board')!;
    const prev = await create.executor({ teamId, title: 'Prev', spec: 'p', dependsOn: null, assignee: null, executor: null, retryOf: null });
    const prevId = createdId(prev.stdout);
    await drain();
    assert.equal(board.snapshot().tasks[prevId]!.status, 'success');
    const r = await create.executor({ teamId, title: 'RetryDemo', spec: 'g', dependsOn: null, assignee: null, executor: null, retryOf: prevId });
    const id = createdId(r.stdout);
    assert.equal(board.snapshot().tasks[id]!.retryOf, prevId);
    const out = (await getBoard.executor({})) as { stdout: string };
    assert.match(out.stdout, new RegExp(`${id} \\[(pending|running|success)\\] RetryDemo team=${teamId} retryOf=${prevId}`), '板摘要行含 id/状态/标题/teamId/retryOf');
    const prevLine = out.stdout.split('\n').find((l) => l.startsWith(prevId));
    assert.ok(prevLine?.includes(`team=${teamId}`), '无 retryOf 的任务仍带 teamId');
    assert.equal(prevLine?.includes('retryOf='), false);
    assert.ok(!out.stdout.includes('team budget'), '未设预算帽不透出预算行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
