import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';

/** T1 会话管理器测试：daemon 从单会话改注册表——POST /session/new 创建、/session/:id/* 会话维端点、
 *  裸端点激活别名、双会话并发互不串流、全会话 teardown。既有 G1/G2 单会话用例已迁移 :id 形态（语义不变） */

/** 轮询等待（同 session.interrupt.test.ts 惯例）：20ms 片轮询直至 pred 为真，超时抛错 */
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

/** 挂起适配器：模型调用永挂直至外部 signal 中止（ScriptedAdapter 非 done 卡只是空批纠偏循环，
 *  「运行中」语义不可靠——挂起卡才是运行中锁的中正模拟，形态同 session.interrupt.test.ts） */
class HangingAdapter implements ModelAdapter {
  readonly provider = 'hanging';
  calls = 0;
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls++;
    const signal = req.signal;
    return new Promise((_, reject) => {
      if (signal?.aborted) return reject(new Error('Task interrupted'));
      signal?.addEventListener('abort', () => reject(new Error('Task interrupted')), { once: true });
    });
  }
}

/** signal 无视的挂起适配器：chat promise 永不收束（连 abort 也不理）——teardown 步骤 0 有界等待
 *  上限路径的中正模拟（HangingAdapter 会随 abort 收束，测不出 2s bound 的放行面） */
class SignalDeafAdapter implements ModelAdapter {
  readonly provider = 'deaf';
  calls = 0;
  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls++;
    return new Promise<ChatResult>(() => {});
  }
}

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;

interface Ctx {
  daemon: GuiDaemon;
  base: string;
  tmp: string;
  /** POST /session/new：root 缺省 tmp，回 sessionId（s<n>） */
  newSession: (root?: string) => Promise<string>;
}

/** 环境隔离样板：数据目录钉到本用例 tmp（focused 直跑不经 scripts/run-tests.js 预载，须自隔离用户全局区）。
 *  daemon 构造不再绑 root（会话注册表形态）——各用例经 POST /session/new 按需创建 */
async function withDaemon(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-serve-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const base = `http://127.0.0.1:${s.port}`;
    const newSession = async (root?: string): Promise<string> => {
      const r = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: root ?? tmp }) });
      assert.equal(r.status, 200, 'session/new 应 200');
      const body = (await r.json()) as { sessionId: string };
      return body.sessionId;
    };
    try {
      await fn({ daemon, base, tmp, newSession });
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('① healthz 免鉴权 200；会话维/裸端点无/错 token 401；未知路径 404', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base } = ctx;
    const h = await fetch(`${base}/healthz`);
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { ok: true }, 'healthz 只回 ok，零其它信息');

    // 鉴权恒在会话解析之前：裸端点与会话维端点同面
    for (const p of ['/submit', '/steer', '/interrupt']) {
      const noTok = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(noTok.status, 401, `${p} 无 token 401`);
    }
    const noTokSnap = await fetch(`${base}/snapshot`);
    assert.equal(noTokSnap.status, 401, '/snapshot 无 token 401');
    const noTokNew = await fetch(`${base}/session/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noTokNew.status, 401, '/session/new 无 token 401');
    const badTok = await fetch(`${base}/session/s1/submit`, { method: 'POST', headers: { ...AUTH, authorization: 'Bearer wrong' }, body: JSON.stringify({ goal: 'x' }) });
    assert.equal(badTok.status, 401);
    assert.equal((await badTok.json()).error, 'unauthorized');

    const nf = await fetch(`${base}/nope`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(nf.status, 404);
    assert.equal((await nf.json()).error, 'not found');
  });
});

test('② POST /session/new：合法 root 200 回 sessionId=s1 且置激活；无 root 400 迁移提示；root 不存在/非目录 400', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base, tmp, daemon } = ctx;
    // 无 root（旧裸软重置语义）：400 + 迁移提示（G3 裸端点兼容裁定）
    const bare = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(bare.status, 400, '无 root 400');
    assert.equal((await bare.json()).error, 'root required — the old soft-reset moved to /session/:id/reset');
    for (const bad of [undefined, 123, '']) {
      const r = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: bad }) });
      assert.equal(r.status, 400, `root=${JSON.stringify(bad)} 非法 → 400`);
    }

    // root 不存在 / 指向文件：INVALID_ARG 面 → 400
    const missing = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: path.join(tmp, 'no-such-dir') }) });
    assert.equal(missing.status, 400, 'root 不存在 → 400');
    const fileRoot = path.join(tmp, 'a-file.txt');
    fs.writeFileSync(fileRoot, 'x', 'utf8');
    const notDir = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: fileRoot }) });
    assert.equal(notDir.status, 400, 'root 非目录 → 400');

    // 合法创建：s1、单调方言、置激活、daemon.get 可达
    const sid = await ctx.newSession();
    assert.equal(sid, 's1', '首会话 s1（s<n> 进程内单调）');
    assert.equal(daemon.activeId(), 's1', '创建即置激活');
    assert.equal(daemon.get('s1')?.root, path.resolve(tmp), 'get() 回会话且 root 为解析后绝对路径');
    assert.deepEqual(await (await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) })).json(), { ok: true, sessionId: 's2' }, '同 root 多会话允许——第二会话 s2 且激活前移');
    assert.equal(daemon.activeId(), 's2', '最近创建者激活');

    // 未知 :id：五端点统一 404
    for (const [m, p] of [['POST', '/session/sX/submit'], ['POST', '/session/sX/steer'], ['POST', '/session/sX/interrupt'], ['POST', '/session/sX/reset'], ['GET', '/session/sX/snapshot']] as const) {
      const r = await fetch(`${base}${p}`, { method: m, headers: AUTH, body: m === 'POST' ? JSON.stringify({ goal: 'x', text: 'x' }) : undefined });
      assert.equal(r.status, 404, `${p} 未知会话 → 404`);
      assert.equal((await r.json()).error, 'unknown session');
    }
  });
});

test('③ 会话维 submit 校验面（平移）：空 body 400 / 非 JSON 400 / 非法 goal 400；合法 202 后回 idle', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base } = ctx;
    const sid = await ctx.newSession();
    const empty = await fetch(`${base}/session/${sid}/submit`, { method: 'POST', headers: AUTH, body: '' });
    assert.equal(empty.status, 400, '空 body JSON 解析失败 → 400');
    const bad = await fetch(`${base}/session/${sid}/submit`, { method: 'POST', headers: AUTH, body: 'not-json' });
    assert.equal(bad.status, 400, '非 JSON body → 400');
    for (const g of ['', 123, null]) {
      const r = await fetch(`${base}/session/${sid}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: g }) });
      assert.equal(r.status, 400, `goal=${JSON.stringify(g)} 非法 → 400`);
    }
    const okr = await fetch(`${base}/session/${sid}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '把测试跑绿' }) });
    assert.equal(okr.status, 202);
    assert.deepEqual(await okr.json(), { ok: true });
    const session = ctx.daemon.get(sid)!;
    await waitFor(() => session.status() === 'idle', 3000);
    assert.equal(session.status(), 'idle', '单 done 卡 run 异步完成后 status 回 idle');
  });
});

test('④ 双会话并发：各自 run 锁独立（A running 不挡 B submit）、各自 409、各自 interrupt 互不影响', async () => {
  await withDaemon(new HangingAdapter(), async (ctx) => {
    const { base, tmp, daemon } = ctx;
    const tmpB = path.join(tmp, 'root-b');
    fs.mkdirSync(tmpB, { recursive: true });
    const s1 = await ctx.newSession(); // root=tmp
    const s2 = await ctx.newSession(tmpB);
    assert.ok(s1 !== s2, '两会话 id 相异');

    const r1 = await fetch(`${base}/session/${s1}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: 'A 长任务' }) });
    assert.equal(r1.status, 202, 's1 提交受理');
    const sess1 = daemon.get(s1)!;
    const sess2 = daemon.get(s2)!;
    await waitFor(() => sess1.status() === 'running', 3000);

    // 会话 A running 不挡会话 B：B submit 仍 202（每会话独立 run 锁）
    const r2 = await fetch(`${base}/session/${s2}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: 'B 长任务' }) });
    assert.equal(r2.status, 202, 'A running 不挡 B submit');
    await waitFor(() => sess2.status() === 'running', 3000);

    // 各自 409：两会话都 running，各自拒绝二次提交
    for (const sid of [s1, s2]) {
      const again = await fetch(`${base}/session/${sid}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '再来' }) });
      assert.equal(again.status, 409, `${sid} 运行中二次 submit → 409`);
      assert.equal((await again.json()).error, 'run in progress');
    }

    // 各自 interrupt：s1 中止不影响 s2 运行态
    const it1 = await fetch(`${base}/session/${s1}/interrupt`, { method: 'POST', headers: AUTH });
    assert.equal(it1.status, 200);
    await waitFor(() => sess1.status() === 'idle', 3000);
    assert.equal(sess2.status(), 'running', 's1 中止后 s2 仍在跑（互不影响）');
    const it2 = await fetch(`${base}/session/${s2}/interrupt`, { method: 'POST', headers: AUTH });
    assert.equal(it2.status, 200);
    await waitFor(() => sess2.status() === 'idle', 3000);

    const noRun = await fetch(`${base}/session/${s1}/interrupt`, { method: 'POST', headers: AUTH });
    assert.equal(noRun.status, 409, '无运行时 interrupt → 409');
    assert.equal((await noRun.json()).error, 'no run in progress');
  });
});

test('⑤ 双会话事件流互不串流：各 root 独立装配，转录/快照各归各', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"alpha"}', '{"done":true,"reply":"beta"}']), async (ctx) => {
    const { base, tmp, daemon } = ctx;
    const tmpB = path.join(tmp, 'root-b');
    fs.mkdirSync(tmpB, { recursive: true });
    const s1 = await ctx.newSession();
    const s2 = await ctx.newSession(tmpB);

    // 两轮各归各会话（共享 daemon 级适配器依次出牌：s1 吃 alpha 卡、s2 吃 beta 卡）
    const snapOf = async (sid: string): Promise<{ messages: Array<{ kind: string; md: string }> }> => {
      const r = await fetch(`${base}/session/${sid}/snapshot`, { headers: AUTH });
      assert.equal(r.status, 200);
      return (await r.json()) as { messages: Array<{ kind: string; md: string }> };
    };
    const waitIdle = async (sid: string): Promise<void> => waitFor(() => daemon.get(sid)!.status() === 'idle', 10_000);

    const r1 = await fetch(`${base}/session/${s1}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '问 A' }) });
    assert.equal(r1.status, 202);
    await waitIdle(s1);
    const r2 = await fetch(`${base}/session/${s2}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '问 B' }) });
    assert.equal(r2.status, 202);
    await waitIdle(s2);

    const snap1 = await snapOf(s1);
    const snap2 = await snapOf(s2);
    const mds1 = snap1.messages.map((m) => m.md).join('\n');
    const mds2 = snap2.messages.map((m) => m.md).join('\n');
    assert.ok(mds1.includes('> 问 A') && mds1.includes('alpha'), 's1 转录含自身提交与终答');
    assert.ok(!mds1.includes('beta') && !mds1.includes('> 问 B'), 's1 不串入 s2 的事件流');
    assert.ok(mds2.includes('> 问 B') && mds2.includes('beta'), 's2 转录含自身提交与终答');
    assert.ok(!mds2.includes('alpha') && !mds2.includes('> 问 A'), 's2 不串入 s1 的事件流');
  });
});

test('⑥ 裸端点激活别名：无 active 409 {no active session}；创建后裸端点=激活会话语义；激活随最近创建前移', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"one"}', '{"done":true,"reply":"two"}']), async (ctx) => {
    const { base, tmp, daemon } = ctx;
    // 创建前：四裸端点统一 409
    for (const [m, p, body] of [['POST', '/submit', JSON.stringify({ goal: 'x' })], ['POST', '/steer', JSON.stringify({ text: 'x' })], ['POST', '/interrupt', undefined], ['GET', '/snapshot', undefined]] as const) {
      const r = await fetch(`${base}${p}`, { method: m, headers: AUTH, body });
      assert.equal(r.status, 409, `无激活会话 ${p} → 409`);
      assert.equal((await r.json()).error, 'no active session');
    }

    // 创建 s1 后：裸端点 = s1 语义（提交入 s1 转录）
    const s1 = await ctx.newSession();
    const bare1 = await fetch(`${base}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '裸提交一' }) });
    assert.equal(bare1.status, 202, '有激活会话后裸 submit 受理');
    await waitFor(() => daemon.get(s1)!.status() === 'idle', 10_000);

    // 创建 s2（激活前移）：裸端点随迁 s2——s1 转录不再增长
    const tmpB = path.join(tmp, 'root-b');
    fs.mkdirSync(tmpB, { recursive: true });
    const s2 = await ctx.newSession(tmpB);
    assert.equal(daemon.activeId(), s2);
    const bare2 = await fetch(`${base}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '裸提交二' }) });
    assert.equal(bare2.status, 202);
    await waitFor(() => daemon.get(s2)!.status() === 'idle', 10_000);

    const snapOf = async (sid: string): Promise<string> => {
      const r = await fetch(`${base}/session/${sid}/snapshot`, { headers: AUTH });
      return ((await r.json()) as { messages: Array<{ md: string }> }).messages.map((m) => m.md).join('\n');
    };
    assert.ok((await snapOf(s1)).includes('> 裸提交一'), 's1 收到激活期内的裸提交一');
    assert.ok(!(await snapOf(s1)).includes('裸提交二'), '激活前移后裸提交不入 s1');
    assert.ok((await snapOf(s2)).includes('> 裸提交二'), '裸提交二入激活会话 s2');
    // 裸 /snapshot = 激活会话（s2）快照
    const bareSnap = (await (await fetch(`${base}/snapshot`, { headers: AUTH })).json()) as { messages: Array<{ md: string }> };
    assert.ok(bareSnap.messages.map((m) => m.md).join('\n').includes('> 裸提交二'), '裸 snapshot 回激活会话的转录');
  });
});

test('⑦ POST /session/:id/reset（旧 /session/new 软重置迁入）：200 清转录与影子；未知 :id 404', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base } = ctx;
    const sid = await ctx.newSession();
    const r = await fetch(`${base}/session/${sid}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    assert.equal(r.status, 202);
    await waitFor(() => ctx.daemon.get(sid)!.status() === 'idle', 10_000);
    const before = (await (await fetch(`${base}/session/${sid}/snapshot`, { headers: AUTH })).json()) as { messages: unknown[] };
    assert.ok(before.messages.length > 0, 'reset 前转录非空');

    const reset = await fetch(`${base}/session/${sid}/reset`, { method: 'POST', headers: AUTH });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { ok: true });
    const after = (await (await fetch(`${base}/session/${sid}/snapshot`, { headers: AUTH })).json()) as { messages: unknown[]; board: { tasks: Record<string, unknown> } };
    assert.equal(after.messages.length, 0, 'reset 后转录清空');
    assert.deepEqual(after.board.tasks, {}, 'reset 后影子板清空');

    const nf = await fetch(`${base}/session/sX/reset`, { method: 'POST', headers: AUTH });
    assert.equal(nf.status, 404);
  });
});

test('⑧ close() 幂等且 close 后 fetch 拒连', async () => {
  const tmp = tmpdir('sunshinex-serve-close-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const base = `http://127.0.0.1:${s.port}`;
    await s.close();
    await s.close(); // 幂等：二次 close 不抛
    await daemon.close(); // 句柄 close 与 daemon.close 同一收口，同样幂等
    // close 后监听已撤：fetch 连接失败以 reject 形态暴露（undici TypeError: fetch failed）
    await assert.rejects(() => fetch(`${base}/healthz`));
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('⑨ 全会话 teardown：signal 无视的悬挂 run 不拖住 close（≤3s 上限，双会话并行收口）', { timeout: 8000 }, async () => {
  const tmp = tmpdir('sunshinex-serve-teardown-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model: new SignalDeafAdapter() });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const base = `http://127.0.0.1:${s.port}`;
    const tmpB = path.join(tmp, 'root-b');
    fs.mkdirSync(tmpB, { recursive: true });
    const mk = async (root: string): Promise<string> => {
      const r = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
      return ((await r.json()) as { sessionId: string }).sessionId;
    };
    const s1 = await mk(tmp);
    const s2 = await mk(tmpB);
    for (const sid of [s1, s2]) {
      const r = await fetch(`${base}/session/${sid}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '挂到天荒地老' }) });
      assert.equal(r.status, 202);
      await waitFor(() => daemon.get(sid)!.status() === 'running', 3000);
    }
    // 双会话各挂一个永不收束的 run：close 正常返回即全会话有界收口；若无界 await 会直接悬挂
    const t0 = Date.now();
    await s.close();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed <= 3000, `close 应有界（≤3s）完成，实际 ${elapsed}ms`);
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
