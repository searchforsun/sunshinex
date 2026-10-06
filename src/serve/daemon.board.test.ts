import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { SessionEvent } from '../types';

/** G5 看板服务面测试：POST /session/:id/board/review（gate 审批映射——review 触发的
 *  gate-resolved/task-status 事件经该会话 pump 自然广播，既有链零新协议）+ snapshot.team 扩段
 *  （spawn mode:'team' 后 teammate 名/busy 投影）。snapshot.pending 段扩在 daemon.pending.test
 *  （manual 挂起装配样板），mode 白名单在 daemon.workspace.test（/session/new HTTP 样板）。
 *
 *  消费序（daemon.contract.test ③ 实测口径沿用）：ScriptedAdapter 卡序共享 daemon 级单例——主链
 *  create_task 牌收束（末位 done 牌重复供牌），review 后 fork 消费末位 done 牌即回写。 */

/** WS 下行帧宽松收集形态（事件帧带 seq+e；挂起帧带 pid——本套只消费事件帧） */
interface AnyFrame {
  kind: string;
  sessionId: string;
  seq?: number;
  e?: { type?: string };
}

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

/** 开连接并同步挂帧收集器（同 daemon.pending.test 惯例：message 监听在构造后立刻挂） */
function openCollecting(url: string): Promise<{ ws: WebSocket; frames: AnyFrame[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer test-token' } });
    const frames: AnyFrame[] = [];
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as AnyFrame);
    });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });
}

interface BoardTaskRow {
  id: string;
  status: string;
  gated?: boolean;
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

test('① gate 全链：create_task(gated:true) 入板悬置 → review approved:true → 200 → gate-resolved 经会话 pump 广播 → fork 派发 → in-review + gated=false', { timeout: 30_000 }, async () => {
  // 卡序：主链 create_task(gated) 牌 → done 牌收束；review 后 fork 消费末位 done 牌（重复供牌）回写 in-review
  const model = new ScriptedAdapter([
    '{"tool":"create_task","input":{"title":"Gated A","spec":"do a","dependsOn":null,"assignee":null,"gated":true,"executor":null}}',
    '{"done":true,"reply":"gated task created"}',
  ]);
  await withBoardDaemon(model, async (ctx) => {
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      await ctx.post('建个 gated 任务', ctx.sid);
      await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'idle', 10_000);
      // 悬置投影：入板即 gated（不派发），gate-waiting 事件已广播
      const snap1 = await snapOf(ctx, ctx.sid);
      assert.equal(snap1.board.tasks.t1?.gated, true, 'gated 任务入板即 gated=true');
      assert.equal(snap1.board.tasks.t1?.status, 'pending', 'gated 悬置不派发（pending）');
      assert.ok(frames.some((f) => f.e?.type === 'gate-waiting'), 'gate-waiting 事件经 pump 广播');

      // review：approved=true → 200 {ok:true}
      const r = await fetch(`${ctx.http}/session/${ctx.sid}/board/review`, {
        method: 'POST',
        headers: ctx.H,
        body: JSON.stringify({ taskId: 't1', approved: true }),
      });
      assert.equal(r.status, 200, 'review approved 应 200');
      assert.deepEqual(await r.json(), { ok: true });

      // 既有链自然广播：gate-resolved → 任务派发（fork delegation）→ 回写 in-review（投影轮询收敛）
      await waitFor(() => frames.some((f) => f.e?.type === 'gate-resolved'), 10_000);
      const deadline = Date.now() + 10_000;
      let final: SnapshotBody | undefined;
      for (;;) {
        const s = await snapOf(ctx, ctx.sid);
        const t = s.board.tasks.t1;
        if (t !== undefined && t.gated === false && t.status === 'in-review') {
          final = s;
          break;
        }
        if (Date.now() > deadline) throw new Error('gate 派发未收敛 in-review');
        await new Promise((res) => setTimeout(res, 20));
      }
      // fork 委派投影在场（delegationId 对齐台账口径 task-t1，kind subagent）
      assert.ok(final.delegations.some((d) => d.id === 'task-t1' && d.kind === 'subagent'), 'fork delegation 投影在场');
      assert.ok(frames.some((f) => f.e?.type === 'task-status-changed'), 'task-status-changed 事件经 pump 广播');
    } finally {
      ws.close();
    }
  });
});

test('② review 校验面：未知 taskId 400（错误文案）/ 未知会话 404 / 坏 body 400', async () => {
  await withBoardDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    // 未知 taskId：review Result fail（INVALID_ARG unknown task）→ 400 + message 直译
    const nf = await fetch(`${ctx.http}/session/${ctx.sid}/board/review`, {
      method: 'POST',
      headers: ctx.H,
      body: JSON.stringify({ taskId: 't9', approved: true }),
    });
    assert.equal(nf.status, 400, '未知 taskId 应 400');
    assert.equal(((await nf.json()) as { error: string }).error, 'unknown task: t9', '错误文案 = review fail message');

    // 未知会话：404 {unknown session}（sessionFor 单点）
    const ns = await fetch(`${ctx.http}/session/s777/board/review`, {
      method: 'POST',
      headers: ctx.H,
      body: JSON.stringify({ taskId: 't1', approved: true }),
    });
    assert.equal(ns.status, 404, '未知会话应 404');
    assert.deepEqual(await ns.json(), { error: 'unknown session' });

    // 坏 body：taskId 空/非 string、approved 非 boolean → 400
    for (const body of [{ taskId: '', approved: true }, { taskId: 't1' }, { taskId: 't1', approved: 'yes' }, { taskId: 42, approved: true }]) {
      const r = await fetch(`${ctx.http}/session/${ctx.sid}/board/review`, {
        method: 'POST',
        headers: ctx.H,
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 400, `body=${JSON.stringify(body)} 应 400`);
    }
    // 非 JSON body → 400（readJson 单点）
    const bad = await fetch(`${ctx.http}/session/${ctx.sid}/board/review`, { method: 'POST', headers: ctx.H, body: '' });
    assert.equal(bad.status, 400, '空 body 应 400');
  });
});

test('③ snapshot.team：spawn mode:"team" label w1 → team 段含 {name:"w1", busy:boolean}', { timeout: 30_000 }, async () => {
  const model = new ScriptedAdapter([
    '{"tool":"spawn","input":{"prompt":"worker w1 framing","agent_id":null,"label":"w1","tools":null,"background":null,"isolation":null,"mode":"team"}}',
    '{"done":true,"reply":"teammate spawned"}',
  ]);
  await withBoardDaemon(model, async (ctx) => {
    // 基线：无 teammate 时 team 段空数组
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
