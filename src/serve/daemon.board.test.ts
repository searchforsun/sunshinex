import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';

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
  fs.mkdirSync(path.join(process.env.SUNSHINEX_DATA_DIR, 'teams'), { recursive: true });
  fs.writeFileSync(
    path.join(process.env.SUNSHINEX_DATA_DIR, 'teams', 'registry.json'),
    JSON.stringify([{ teamId: TEAM_ID, name: 'alpha', createdAt: 1 }]),
  );
  try {
    const daemon = new GuiDaemon({ model, staticRoot: path.join(tmp, 'dist-gui-absent') });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const http = `http://127.0.0.1:${s.port}`;
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;
    const nr = await fetch(`${http}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: tmp }) });
    assert.equal(nr.status, 200, 'session/new 应 200');
    const sid = ((await nr.json()) as { sessionId: string }).sessionId;
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
}

interface SnapshotBody {
  board: { tasks: Record<string, BoardTaskRow> };
  delegations: Array<{ id: string; kind: string; status: string }>;
  team?: Array<{ name: string; busy: boolean }>;
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
