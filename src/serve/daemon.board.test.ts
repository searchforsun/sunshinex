import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest } from '../types';
import { MemoryAgentTeamStore } from '../taskboard/team-registry';
import type { AgentTeamRegistry } from '../taskboard/team-registry';

const TEAM_ID = 'team-alpha-test';

/** snapshot.team：create_teammate 绑定已注册 teamId 后，快照 team 段含 name 与 busy。 */

/** 轮询等待（同 daemon.ws.test.ts 惯例）：20ms 片轮询直至 pred 为真，超时抛错 */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 经 harness 注册表注入固定 teamId（会话隔离后不再写工作区级 teams/registry.json） */
function seedTeam(agentTeams: AgentTeamRegistry): void {
  const store = new MemoryAgentTeamStore();
  store.save([{ teamId: TEAM_ID, name: 'alpha', createdAt: 1 }]);
  agentTeams.adopt(store);
}

interface Ctx {
  daemon: GuiDaemon;
  http: string;
  ws: string;
  /** 首会话 id（root=daemon tmp） */
  sid: string;
  /** 会话维提交（202 断言内建） */
  post: (goal: string, sid: string) => Promise<void>;
  /** 鉴权头 */
  H: Record<string, string>;
}

/** 装配样板（环境隔离同 daemon.contract.test.ts）：SUNSHINEX_DATA_DIR 钉 tmp，token 固定
 *  test-token，port 0，staticRoot 注入不存在目录（静态面恒未挂载，hermetic） */
async function withBoardDaemon(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-serve-board-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model, staticRoot: path.join(tmp, 'dist-gui-absent') });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const http = `http://127.0.0.1:${s.port}`;
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;
    const nr = await fetch(`${http}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: tmp }) });
    assert.equal(nr.status, 200, 'session/new 应 200');
    const sid = ((await nr.json()) as { sessionId: string }).sessionId;
    const session = daemon.get(sid)!;
    seedTeam(session.runtime.harness.agentTeams);
    // 先铸造 journal 并收养会话团队根：避免首笔板事件泵触发 adopt→recoverOnLoad 把打开态任务自愈为 cancelled
    session.persistSnapshotRow();
    const post = async (goal: string, target: string): Promise<void> => {
      const r = await fetch(`${http}/session/${target}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ goal }) });
      assert.equal(r.status, 202, 'submit 应 202');
    };
    try {
      await fn({ daemon, http, ws: `ws://127.0.0.1:${s.port}`, sid, post, H });
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

interface BoardTaskRow {
  id: string;
  status: string;
  teamId?: string;
  retryOf?: string;
  title?: string;
}

interface TeamRow {
  teamId: string;
  name: string;
  createdAt: number;
}

interface SnapshotBody {
  board: { tasks: Record<string, BoardTaskRow> };
  delegations: Array<{ id: string; kind: string; status: string }>;
  team?: Array<{ name: string; busy: boolean }>;
  teams?: TeamRow[];
}

const FIVE = new Set(['pending', 'running', 'success', 'failed', 'cancelled']);

/** 子智能体模型调用挂起，直到 abort。板任务可停在 running。 */
class HangAdapter implements ModelAdapter {
  readonly provider = 'hang';
  chat(req: ChatRequest): Promise<never> {
    const signal = req.signal;
    return new Promise((_, reject) => {
      if (signal?.aborted) {
        reject(new Error('Task interrupted'));
        return;
      }
      signal?.addEventListener('abort', () => reject(new Error('Task interrupted')), { once: true });
    });
  }
}

async function waitForAsync(pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 单点拉快照 */
async function snapOf(ctx: Ctx, sid: string): Promise<SnapshotBody> {
  const r = await fetch(`${ctx.http}/session/${sid}/snapshot`, { headers: ctx.H });
  assert.equal(r.status, 200, 'snapshot 应 200');
  return (await r.json()) as SnapshotBody;
}
test('snapshot.team：create_teammate 建队友 w1 → team 段含 name 与 busy', { timeout: 30_000 }, async () => {
  const model = new ScriptedAdapter([
    JSON.stringify({ tool: 'create_teammate', input: { teamId: TEAM_ID, name: 'w1', prompt: 'worker w1 framing' } }),
    '{"done":true,"reply":"teammate spawned"}',
  ]);
  await withBoardDaemon(model, async (ctx) => {
    const before = await snapOf(ctx, ctx.sid);
    assert.ok(Array.isArray(before.team), 'team 段恒数组');
    assert.equal(before.team!.length, 0, '无 teammate 时空');
    await ctx.post('起个 teammate', ctx.sid);
    await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'idle', 10_000);
    const snap = await snapOf(ctx, ctx.sid);
    assert.ok(Array.isArray(snap.team), 'team 段在场');
    const w1 = snap.team!.find((m) => m.name === 'w1');
    assert.ok(w1, 'team 段含 spawn 建出的 w1');
    assert.equal(typeof w1.busy, 'boolean', 'busy 布尔（TeamRegistry.get/isBusy 同源）');
    assert.equal(w1.busy, false, '空闲 teammate busy=false');
  });
});

test('POST /session/:id/board/stop：pending→cancelled；running→cancelled 且台账 stopped；快照含 teams 与 teamId/retryOf/五态', { timeout: 30_000 }, async () => {
  await withBoardDaemon(new HangAdapter(), async (ctx) => {
    const seeded = await snapOf(ctx, ctx.sid);
    assert.ok(seeded.teams?.some((t) => t.teamId === TEAM_ID && t.name === 'alpha' && t.createdAt === 1), '快照 teams 含已注册队');

    const harness = ctx.daemon.get(ctx.sid)!.runtime.harness;
    // 板任务仅经 teammate 认领进 running；HangAdapter 使认领后挂起，便于 stop 测 running 态
    const ct = harness.tools.get('create_teammate');
    assert.ok(ct, 'create_teammate 在场');
    const spawned = await ct.executor({ teamId: TEAM_ID, name: 'w1', prompt: 'hold board tasks', agent_id: null });
    assert.equal(spawned.exitCode, 0, `create_teammate: ${spawned.stdout}`);

    const board = harness.taskboard;
    const createdA = board.create({ teamId: TEAM_ID, title: 'Run', spec: 'hold' });
    assert.ok(createdA.ok);
    const idA = createdA.value.taskId;
    await waitForAsync(async () => (await snapOf(ctx, ctx.sid)).board.tasks[idA]?.status === 'running', 5_000);

    const createdB = board.create({ teamId: TEAM_ID, title: 'Hold', spec: 'wait', dependsOn: [idA] });
    assert.ok(createdB.ok);
    const idB = createdB.value.taskId;
    const pendingSnap = await snapOf(ctx, ctx.sid);
    assert.equal(pendingSnap.board.tasks[idB]?.status, 'pending');
    assert.equal(pendingSnap.board.tasks[idB]?.teamId, TEAM_ID);
    assert.ok(FIVE.has(pendingSnap.board.tasks[idA]!.status));
    assert.ok(FIVE.has(pendingSnap.board.tasks[idB]!.status));

    const stopB = await fetch(`${ctx.http}/session/${ctx.sid}/board/stop`, {
      method: 'POST', headers: ctx.H, body: JSON.stringify({ taskId: idB }),
    });
    assert.equal(stopB.status, 200);
    assert.equal((await snapOf(ctx, ctx.sid)).board.tasks[idB]?.status, 'cancelled');
    assert.equal((await snapOf(ctx, ctx.sid)).board.tasks[idA]?.status, 'running', '只停 pending，上游继续 running');

    const stopA = await fetch(`${ctx.http}/session/${ctx.sid}/board/stop`, {
      method: 'POST', headers: ctx.H, body: JSON.stringify({ taskId: idA }),
    });
    assert.equal(stopA.status, 200);
    const afterA = await snapOf(ctx, ctx.sid);
    assert.equal(afterA.board.tasks[idA]?.status, 'cancelled');

    const tasksRes = await fetch(`${ctx.http}/session/${ctx.sid}/tasks`, { headers: ctx.H });
    assert.equal(tasksRes.status, 200);
    const rows = (await tasksRes.json()) as Array<{ label: string; status: string }>;
    const ledger = rows.find((t) => t.label === idA);
    assert.ok(ledger, 'running 板任务有台账');
    assert.equal(ledger.status, 'stopped', 'running 停板同时台账 stopped');

    const again = await fetch(`${ctx.http}/session/${ctx.sid}/board/stop`, {
      method: 'POST', headers: ctx.H, body: JSON.stringify({ taskId: idA }),
    });
    assert.equal(again.status, 200, '终态幂等');

    const createdC = board.create({ teamId: TEAM_ID, title: 'Retry', spec: 'again', retryOf: idA });
    assert.ok(createdC.ok);
    const idC = createdC.value.taskId;
    const retrySnap = await snapOf(ctx, ctx.sid);
    assert.equal(retrySnap.board.tasks[idC]?.teamId, TEAM_ID);
    assert.equal(retrySnap.board.tasks[idC]?.retryOf, idA);
    assert.ok(FIVE.has(retrySnap.board.tasks[idC]!.status));

    const missing = await fetch(`${ctx.http}/session/${ctx.sid}/board/stop`, {
      method: 'POST', headers: ctx.H, body: JSON.stringify({ taskId: 'missing-task' }),
    });
    assert.equal(missing.status, 400);
    const empty = await fetch(`${ctx.http}/session/${ctx.sid}/board/stop`, {
      method: 'POST', headers: ctx.H, body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    const unknown = await fetch(`${ctx.http}/session/no-such-session/board/stop`, {
      method: 'POST', headers: ctx.H, body: JSON.stringify({ taskId: idA }),
    });
    assert.equal(unknown.status, 404);

    await fetch(`${ctx.http}/session/${ctx.sid}/board/stop`, {
      method: 'POST', headers: ctx.H, body: JSON.stringify({ taskId: idC }),
    });
  });
});
