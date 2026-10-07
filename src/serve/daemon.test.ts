import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';
import { SEMANTIC_KEYS, applySettings, loadGlobalSettings, loadProjectSettings, resetSelfFilledSlots } from '../config/settings';

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

/** tmp 回收（Windows cwd 锁迟滞兜底）：G8b T3 起 pty 用例的 shell 以 tmp 为 cwd——kill 后句柄
 *  释放可迟于收口拍（EPERM），maxRetries/retryDelay 走 fs 内建重试面 */
function rmTmp(tmp: string): void {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
    rmTmp(tmp);
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

// ---------- G8b T3：pty daemon 接线（分配/kill 路由 + 专用 WS + teardown 插杀） ----------

/** pty WS 帧（S→C 四型）：replay/data 携 b=base64(UTF-8)；exit 携 code；error 携 message */
interface PtyFrame {
  t: 'replay' | 'data' | 'exit' | 'error';
  b?: string;
  code?: number;
  message?: string;
}

/** pty 专用 WS 开连接+帧收集（Bearer 头鉴权；message 监听构造后立刻挂——replay 帧可能与握手响应
 *  同 TCP 段到达，等 open 后再挂会丢首帧，同 daemon.ws.test openCollecting 教训） */
function openPty(url: string): Promise<{ ws: WebSocket; frames: PtyFrame[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer test-token' } });
    const frames: PtyFrame[] = [];
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as PtyFrame);
    });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });
}

/** data 帧流拼接解码（UTF-8）——终端输出文本的断言面 */
function ptyDataText(frames: PtyFrame[]): string {
  return frames.filter((f) => f.t === 'data').map((f) => Buffer.from(f.b ?? '', 'base64').toString('utf8')).join('');
}

/** 单帧解码（replay 重放断言面） */
function ptyDecode(f: PtyFrame): string {
  return Buffer.from(f.b ?? '', 'base64').toString('utf8');
}

test('⑩ pty 全链：分配→WS 回环→断线重连重放→DELETE kill(幂等)→会话 delete 全杀', { timeout: 90_000 }, async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base } = ctx;
    const wsBase = base.replace(/^http/, 'ws');
    const sid = await ctx.newSession();

    // 1) 分配：POST /session/:id/pty {cols,rows} → 200 {ptyId}（pty-<n> 方言）；未知会话 404
    const alloc = await fetch(`${base}/session/${sid}/pty`, { method: 'POST', headers: AUTH, body: JSON.stringify({ cols: 80, rows: 24 }) });
    assert.equal(alloc.status, 200, 'POST /session/:id/pty 应 200');
    const { ptyId } = (await alloc.json()) as { ptyId: string };
    assert.match(ptyId, /^pty-\d+$/, 'ptyId 方言 pty-<n>');
    const nf = await fetch(`${base}/session/sX/pty`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(nf.status, 404, '未知会话分配 → 404');

    // 2) WS 回环：连入首帧 replay(可能空) → in 帧下发标记命令 → data 帧流含标记
    //    （默认 shell 下命令行可用：win32 powershell / 其余 $SHELL??bash 同串均合法）
    const a = await openPty(`${wsBase}/session/${sid}/pty/${ptyId}`);
    try {
      await waitFor(() => a.frames.length > 0, 10_000);
      assert.equal(a.frames[0].t, 'replay', '连接首帧恒 replay');
      const cmd = `node -e "process.stdout.write('pty-e2e')"\r`;
      a.ws.send(JSON.stringify({ t: 'in', b: Buffer.from(cmd, 'utf8').toString('base64') }));
      await waitFor(() => ptyDataText(a.frames).includes('pty-e2e'), 30_000);
    } finally {
      a.ws.close();
    }
    await waitFor(() => a.ws.readyState === WebSocket.CLOSED, 5000);

    // 3) 断线重连（close≠kill，进程保活）：新 WS 连入 → 首帧 replay 含此前输出标记（环形缓冲重放）
    const b = await openPty(`${wsBase}/session/${sid}/pty/${ptyId}`);
    try {
      await waitFor(() => b.frames.length > 0, 10_000);
      assert.equal(b.frames[0].t, 'replay', '重连首帧恒 replay');
      assert.ok(ptyDecode(b.frames[0]).includes('pty-e2e'), '重放含断线前的输出标记');

      // 4) DELETE kill → 在线 WS 收 exit 帧(非零)后 close；重复 DELETE 幂等 200
      const kill = await fetch(`${base}/session/${sid}/pty/${ptyId}`, { method: 'DELETE', headers: AUTH });
      assert.equal(kill.status, 200, 'DELETE kill 应 200');
      assert.deepEqual(await kill.json(), { ok: true });
      await waitFor(() => b.frames.some((f) => f.t === 'exit'), 15_000);
      const exitFrame = b.frames.find((f) => f.t === 'exit')!;
      assert.notEqual(exitFrame.code, 0, '被 kill 的 pty exit 帧非零');
      await waitFor(() => b.ws.readyState === WebSocket.CLOSED, 5000);
    } finally {
      b.ws.close();
    }
    const again = await fetch(`${base}/session/${sid}/pty/${ptyId}`, { method: 'DELETE', headers: AUTH });
    assert.equal(again.status, 200, '重复 DELETE 幂等 200');
    assert.deepEqual(await again.json(), { ok: true });

    // 5) 会话 delete → killAllFor：第二台(默认 shell 存活)被连带清杀——在线 WS 收 exit 帧(非零,
    //    进程死透的可观测证据),之后新 WS 连入收 error 'pty not found'
    const alloc2 = await fetch(`${base}/session/${sid}/pty`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(alloc2.status, 200, 'body 全缺省(cols/rows 80/24)分配应 200');
    const { ptyId: ptyId2 } = (await alloc2.json()) as { ptyId: string };
    assert.notEqual(ptyId2, ptyId, '第二台 id 相异（pty-<n> 单调不复用）');
    const d = await openPty(`${wsBase}/session/${sid}/pty/${ptyId2}`);
    try {
      const del = await fetch(`${base}/session/${sid}/delete`, { method: 'POST', headers: AUTH });
      assert.equal(del.status, 200, 'idle 会话 delete 应 200');
      await waitFor(() => d.frames.some((f) => f.t === 'exit'), 15_000);
      assert.notEqual(d.frames.find((f) => f.t === 'exit')!.code, 0, 'killAllFor 插杀的 exit 帧非零');
      await waitFor(() => d.ws.readyState === WebSocket.CLOSED, 5000);
    } finally {
      d.ws.close();
    }
    const c = await openPty(`${wsBase}/session/${sid}/pty/${ptyId2}`);
    try {
      await waitFor(() => c.frames.length > 0, 10_000);
      assert.equal(c.frames[0].t, 'error', 'killAllFor 后连入 → error 帧');
      assert.equal(c.frames[0].message, 'pty not found');
      await waitFor(() => c.ws.readyState === WebSocket.CLOSED, 5000);
    } finally {
      c.ws.close();
    }
  });
});

test('⑪ pty 鉴权与未知 id：错 token 升级拒 401；未知 ptyId 升级即 error 帧后 close', { timeout: 30_000 }, async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const wsBase = ctx.base.replace(/^http/, 'ws');
    const sid = await ctx.newSession();
    // 错 token：401 拒升级——客户端 error 且无 open（同事件面 daemon.ws.test ③ 惯例）
    let sawOpen = false;
    let sawError = false;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${wsBase}/session/${sid}/pty/pty-9`, { headers: { authorization: 'Bearer wrong-token' } });
      ws.on('open', () => {
        sawOpen = true;
        resolve();
      });
      ws.on('error', () => {
        sawError = true;
      });
      ws.on('close', () => resolve());
    });
    assert.equal(sawOpen, false, '错 token 不得升级成功');
    assert.equal(sawError, true, '401 拒升级应表现为客户端 error');
    // 合法 token + 未知 ptyId：升级成功但即收 error 帧后 close(1008)
    const c = await openPty(`${wsBase}/session/${sid}/pty/pty-404`);
    try {
      await waitFor(() => c.frames.length > 0, 10_000);
      assert.equal(c.frames[0].t, 'error', '未知 ptyId 首帧 error');
      assert.equal(c.frames[0].message, 'pty not found');
      await waitFor(() => c.ws.readyState === WebSocket.CLOSED, 5000);
    } finally {
      c.ws.close();
    }
  });
});

// ---------- G8b T4:tree 端点(GET /session/:id/tree 单层目录列举) ----------

test('⑫ tree:单层列举/忽略集/上限截断/判界 403/根缺省/404/400', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base, tmp } = ctx;
    // 会话 root(独立于 tmp 根:data 目录/逃逸靶不混入 root 列举):dirA/(fileA.ts+sub/)、fileB.ts、
    // 忽略集四目录(.git/node_modules/dist/dist-gui——造在场以证「在场也不枚举」)
    const root = path.join(tmp, 'root');
    fs.mkdirSync(path.join(root, 'dirA', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dirA', 'fileA.ts'), 'x', 'utf8');
    fs.writeFileSync(path.join(root, 'fileB.ts'), 'x', 'utf8');
    for (const ign of ['.git', 'node_modules', 'dist', 'dist-gui']) fs.mkdirSync(path.join(root, ign));
    const sid = await ctx.newSession(root);
    const tree = async (q: string | null): Promise<Response> =>
      fetch(q === null ? `${base}/session/${sid}/tree` : `${base}/session/${sid}/tree?path=${encodeURIComponent(q)}`, { headers: AUTH });

    // —— 根缺省(无 path 参数)与 ?path=(空串)同义=会话 root:单层(dirA 内 sub/fileA.ts 不在)、
    //    忽略集不枚举、目录先序字母序、无 truncated 字段 ——
    for (const r of [await tree(null), await tree('')]) {
      assert.equal(r.status, 200, '根缺省/空 path 应 200');
      assert.deepEqual(await r.json(), { entries: [{ name: 'dirA', kind: 'dir' }, { name: 'fileB.ts', kind: 'file' }] }, '目录先序字母序,忽略集与深层不枚举');
    }

    // —— 子目录单层:dirA 内 [{sub,dir},{fileA.ts,file}]——目录段先+同段字母序 ——
    const sub = await tree('dirA');
    assert.equal(sub.status, 200);
    assert.deepEqual(await sub.json(), { entries: [{ name: 'sub', kind: 'dir' }, { name: 'fileA.ts', kind: 'file' }] });

    // —— 上限:501 项目录 → 截断恰 500 + truncated:true(且截断保序:首尾可对位) ——
    const many = path.join(root, 'many');
    fs.mkdirSync(many);
    for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(many, `f${String(i).padStart(3, '0')}.ts`), 'x', 'utf8');
    const rMany = await tree('many');
    assert.equal(rMany.status, 200);
    const bMany = (await rMany.json()) as { entries: Array<{ name: string; kind: string }>; truncated?: boolean };
    assert.equal(bMany.entries.length, 500, '501 项截断至 500');
    assert.equal(bMany.truncated, true, '超限带 truncated:true');
    assert.equal(bMany.entries[0].name, 'f000.ts', '截断保序:首项 f000.ts');
    assert.equal(bMany.entries[499].name, 'f499.ts', '截断保序:末项 f499.ts(f500.ts 被裁)');

    // —— 判界 403:../ 逃逸出会话 root(逃逸靶真实在场——判界先于存在性) ——
    fs.mkdirSync(path.join(tmp, 'outside'));
    const r403 = await tree('../outside');
    assert.equal(r403.status, 403);
    assert.deepEqual(await r403.json(), { error: 'path outside trusted roots' });

    // —— 不存在 404 / 非目录 400 ——
    const r404 = await tree('nope');
    assert.equal(r404.status, 404);
    assert.deepEqual(await r404.json(), { error: 'not found' });
    const r400 = await tree('fileB.ts');
    assert.equal(r400.status, 400);
    assert.deepEqual(await r400.json(), { error: 'not a directory' });

    // —— 链接条目按 stat 跟随实态分型(win32 junction 恒可造;无特权环境造链失败即跳过本段) ——
    const links = path.join(root, 'links');
    fs.mkdirSync(links);
    try {
      const toDir = path.join(links, 'toDir');
      if (process.platform === 'win32') fs.symlinkSync(path.join(root, 'dirA'), toDir, 'junction');
      else fs.symlinkSync(path.join(root, 'dirA'), toDir, 'dir');
      fs.symlinkSync(path.join(root, 'fileB.ts'), path.join(links, 'toFile'), 'file');
      const rLinks = await tree('links');
      assert.equal(rLinks.status, 200);
      assert.deepEqual(await rLinks.json(), { entries: [{ name: 'toDir', kind: 'dir' }, { name: 'toFile', kind: 'file' }] }, '链接按跟随实态:目录链接=dir,文件链接=file');
    } catch {
      // symlink 特权缺场(非 dev-mode win32 等):链接面留实现注释口径,不阻塞
    }
  });
});

// ---------- G8c T2:/settings 端点(GET effective 视图/来源分层 + PUT 结构化改写/自填槽清除重载) ----------

/** /settings 响应 keys 行面 */
interface SettingsKeyRow {
  key: string;
  value: string | null;
  source: 'env' | 'project' | 'global' | 'default';
  envOverride: boolean;
}

/** /settings 响应整体(断言所需的子集面) */
interface SettingsBody {
  keys: SettingsKeyRow[];
  permissions: {
    merged: { deny: string[]; allow: string[]; additionalDirs: string[] };
    project: { deny: string[]; allow: string[]; additionalDirs: string[] };
    global: { deny: string[]; allow: string[]; additionalDirs: string[] };
  };
  providers: { choices: Array<{ id: string; provider: string }>; apiKeyPresent: Record<string, boolean>; warnings: string[] };
}

/** /settings 系用例环境隔离(在 withDaemon 惯例上增设全局配置面;G8c T2/T3 两 describe 共用):
 *  - HOME/USERPROFILE 重定向 fakeHome:全局 settings/mcp 面不触碰真实用户家
 *  - SUNSHINEX_* 槽全量快照→清空→复原:用例内 applySettings 自填与 PUT reload 都写槽,结束必须回到
 *    进入前态(进入时在场者复原值、新增者删除、用例中被删的既有槽回植)
 *  - 自填集结束清空(resetSelfFilledSlots):用例登记的自填槽不复串后续用例的来源判定 */
async function withSettingsDaemon(fn: (ctx: { daemon: GuiDaemon; base: string; tmp: string; home: string }) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-settings-');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.sunshinex'), { recursive: true });
  const prev = { data: process.env.SUNSHINEX_DATA_DIR, home: process.env.HOME, userProfile: process.env.USERPROFILE };
  const envSnap = new Map<string, string>();
  for (const k of Object.keys(process.env)) if (k.startsWith('SUNSHINEX_')) envSnap.set(k, process.env[k]!);
  try {
    // 清空 SUNSHINEX_* 面(含 run-tests.js 预载的 DATA_DIR 等)再钉本用例值:来源判定不被外部环境染
    for (const k of [...envSnap.keys()]) delete process.env[k];
    process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    try {
      await fn({ daemon, base: `http://127.0.0.1:${s.port}`, tmp, home });
    } finally {
      await s.close();
    }
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!k.startsWith('SUNSHINEX_')) continue;
      if (envSnap.has(k)) process.env[k] = envSnap.get(k)!;
      else delete process.env[k];
    }
    for (const [k, v] of envSnap) if (process.env[k] === undefined) process.env[k] = v;
    resetSelfFilledSlots();
    if (prev.data === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prev.data;
    if (prev.home === undefined) delete process.env.HOME; else process.env.HOME = prev.home;
    if (prev.userProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.userProfile;
    rmTmp(tmp);
  }
}

describe('G8c T2 /settings 端点', () => {
  test('⑬ GET 无 root:真导出 env+envOverride / global / default 三态;键序=SEMANTIC_KEYS;无 token 401', async () => {
    await withSettingsDaemon(async ({ base, home }) => {
      const writeGlobal = (json: unknown): void =>
        fs.writeFileSync(path.join(home, '.sunshinex', 'settings.json'), JSON.stringify(json, null, 2), 'utf8');
      process.env.SUNSHINEX_LANGUAGE = 'env-lang'; // 真导出(shell 面):装载链只填缺省,不覆盖
      writeGlobal({ tier: 'global-tier', contextWindow: 160000 });
      // 模拟 CLI 入口装载链(daemon 本体不调链、继承入口 env——测试进程内等价复现同一对调用)
      applySettings(loadGlobalSettings());

      const noAuth = await fetch(`${base}/settings`);
      assert.equal(noAuth.status, 401, '/settings 无 token 401');

      const r = await fetch(`${base}/settings`, { headers: AUTH });
      assert.equal(r.status, 200);
      const body = (await r.json()) as SettingsBody;
      assert.deepEqual(body.keys.map((k) => k.key), Object.keys(SEMANTIC_KEYS), '键序=SEMANTIC_KEYS 键序(全语义键)');
      const row = (key: string): SettingsKeyRow => body.keys.find((k) => k.key === key)!;
      assert.deepEqual(row('language'), { key: 'language', value: 'env-lang', source: 'env', envOverride: true }, '真导出=env 最优先+禁编徽标');
      assert.deepEqual(row('tier'), { key: 'tier', value: 'global-tier', source: 'global', envOverride: false }, '全局文件键自填→global');
      assert.deepEqual(row('contextWindow'), { key: 'contextWindow', value: '160000', source: 'global', envOverride: false }, '数字键 String 归一后回显');
      assert.deepEqual(row('model'), { key: 'model', value: null, source: 'default', envOverride: false }, '未配置=default+null');
    });
  });

  test('⑭ GET ?root=项目:项目键 source=project 覆盖 global 同键;槽缺但项目文件有值→project/null', async () => {
    await withSettingsDaemon(async ({ base, tmp, home }) => {
      const writeGlobal = (json: unknown): void =>
        fs.writeFileSync(path.join(home, '.sunshinex', 'settings.json'), JSON.stringify(json, null, 2), 'utf8');
      const proj = path.join(tmp, 'proj');
      const writeProject = (json: unknown): void => {
        fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
        fs.writeFileSync(path.join(proj, '.sunshinex', 'settings.json'), JSON.stringify(json, null, 2), 'utf8');
      };
      writeGlobal({ tier: 'g-tier', language: 'en', contextWindow: 111111 });
      writeProject({ tier: 'p-tier', model: 'proj-model' });
      applySettings(loadProjectSettings(proj));
      applySettings(loadGlobalSettings());

      const r = await fetch(`${base}/settings?root=${encodeURIComponent(proj)}`, { headers: AUTH });
      assert.equal(r.status, 200);
      const body = (await r.json()) as SettingsBody;
      const row = (key: string): SettingsKeyRow => body.keys.find((k) => k.key === key)!;
      assert.deepEqual(row('tier'), { key: 'tier', value: 'p-tier', source: 'project', envOverride: false }, '项目键覆盖 global 同键→project');
      assert.deepEqual(row('model'), { key: 'model', value: 'proj-model', source: 'project', envOverride: false }, '项目独有键→project');
      assert.deepEqual(row('language'), { key: 'language', value: 'en', source: 'global', envOverride: false }, '项目未配置槽回退 global');
      assert.deepEqual(row('contextWindow'), { key: 'contextWindow', value: '111111', source: 'global', envOverride: false });

      // 槽缺(daemon 从未装载过该 root 的链,SUNSHINEX_MAX_TOKENS 亦未被任何先序装载触碰)+项目文件
      // 有值:source 走文件链→project,value 恒 env 槽面→null(仅视图归因,不反写 env)
      const projB = path.join(tmp, 'proj-b');
      fs.mkdirSync(path.join(projB, '.sunshinex'), { recursive: true });
      fs.writeFileSync(path.join(projB, '.sunshinex', 'settings.json'), JSON.stringify({ maxTokens: 12345 }), 'utf8');
      const rb = await fetch(`${base}/settings?root=${encodeURIComponent(projB)}`, { headers: AUTH });
      assert.equal(rb.status, 200);
      const rowb = ((await rb.json()) as SettingsBody).keys.find((k) => k.key === 'maxTokens')!;
      assert.deepEqual(rowb, { key: 'maxTokens', value: null, source: 'project', envOverride: false }, '槽缺+文件有值→project/null(仅项目视图,不反写 env)');
    });
  });

  test('⑮ permissions 两级+merged 三面;providers choices(项目整键遮蔽)/apiKeyPresent 布尔/warnings', async () => {
    await withSettingsDaemon(async ({ base, tmp, home }) => {
      fs.writeFileSync(path.join(home, '.sunshinex', 'settings.json'), JSON.stringify({
        permissions: { deny: ['Bash(rm*)'], allow: ['Read(*)'] },
        providers: [{ name: 'gp', baseUrl: 'https://gp.example', models: ['gm'] }],
      }, null, 2), 'utf8');
      const proj = path.join(tmp, 'proj');
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.sunshinex', 'settings.json'), JSON.stringify({
        permissions: { deny: ['Bash(rm*)', 'Write(/secret/*)'], additionalDirs: ['C:/extra'] },
        providers: [
          { name: 'pp', baseUrl: 'https://pp.example', models: ['pm1', 'pm2'] },
          { name: 'broken', models: [] }, // 坏条目(缺 baseUrl)→warning 且该源跳过
        ],
      }, null, 2), 'utf8');
      process.env.SUNSHINEX_API_KEY = 'sk-present'; // providers 密钥在场面(apiKeyPresent=true)

      const r = await fetch(`${base}/settings?root=${encodeURIComponent(proj)}`, { headers: AUTH });
      assert.equal(r.status, 200);
      const body = (await r.json()) as SettingsBody;
      assert.deepEqual(body.permissions.global, { deny: ['Bash(rm*)'], allow: ['Read(*)'], additionalDirs: [] }, 'global 级原样');
      assert.deepEqual(body.permissions.project, { deny: ['Bash(rm*)', 'Write(/secret/*)'], allow: [], additionalDirs: ['C:/extra'] }, 'project 级原样');
      assert.deepEqual(body.permissions.merged, { deny: ['Bash(rm*)', 'Write(/secret/*)'], allow: ['Read(*)'], additionalDirs: ['C:/extra'] }, 'merged=两级拼接去重(loadPermissions 同口径)');
      assert.deepEqual(body.providers.choices.map((c) => c.id), ['pp/pm1', 'pp/pm2'], '项目 providers 在场即整键遮蔽全局');
      assert.deepEqual(body.providers.apiKeyPresent, { pp: true }, '密钥在场性=布尔(专用槽>主槽),不显值');
      assert.equal(body.providers.warnings.length, 1, '坏条目产出一条 warning');
      assert.ok(body.providers.warnings[0]!.includes('broken'), 'warning 指名坏源');
    });
  });

  test('⑯ PUT 改键→GET 反映+盘上复读(保留 version/env/permissions/未知键);未知键/RETIRED/类型坏/缺 root 400;null 删键', async () => {
    await withSettingsDaemon(async ({ base, tmp }) => {
      const proj = path.join(tmp, 'proj');
      const file = path.join(proj, '.sunshinex', 'settings.json');
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      const original = {
        version: 1,
        model: 'old-model',
        tier: 'keep-me',
        env: { SUNSHINEX_API_KEY: 'preserve-me' },
        permissions: { deny: ['Bash(rm*)'] },
        customKey: { nested: true },
      };
      fs.writeFileSync(file, JSON.stringify(original, null, 2), 'utf8');
      applySettings(loadProjectSettings(proj));
      applySettings(loadGlobalSettings()); // 无全局文件——no-op

      const put = async (body: unknown): Promise<Response> =>
        fetch(`${base}/settings`, { method: 'PUT', headers: AUTH, body: JSON.stringify(body) });

      // 改键+新增键:盘上复读保留 version/env/permissions/未知键
      const ok = await put({ root: proj, updates: { model: 'new-model', maxTokens: 999999 } });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true });
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
        ...original,
        model: 'new-model',
        maxTokens: 999999,
      }, '结构化改写只动目标键,其余原样保留');

      const g = await fetch(`${base}/settings?root=${encodeURIComponent(proj)}`, { headers: AUTH });
      const gBody = (await g.json()) as SettingsBody;
      const row = (key: string): SettingsKeyRow => gBody.keys.find((k) => k.key === key)!;
      assert.deepEqual(row('model'), { key: 'model', value: 'new-model', source: 'project', envOverride: false }, 'PUT 后 GET 反映新值(自填槽已重载)');

      // 校验面 400(目标文件不被动)
      const before400 = fs.readFileSync(file, 'utf8');
      const unknown = await put({ root: proj, updates: { modle: 'x' } });
      assert.equal(unknown.status, 400, '拼错键 400');
      assert.ok(((await unknown.json()) as { error: string }).error.includes('unknown'), '未知键提示');
      const proto = await put({ root: proj, updates: { toString: 'x' } });
      assert.equal(proto.status, 400, '原型键穿透守卫:Object.hasOwn 判定,toString 不在自键集即 400(值比对会被 Object.prototype 解析穿透)');
      const retired = await put({ root: proj, updates: { dataDir: 'x' } });
      assert.equal(retired.status, 400, '退役键 400');
      assert.ok(((await retired.json()) as { error: string }).error.includes('projectsDir'), '退役键带处置提示(换 projectsDir)');
      const badType = await put({ root: proj, updates: { model: true } });
      assert.equal(badType.status, 400, '值类型非 string|number|null 400');
      const noRoot = await put({ updates: { model: 'x' } });
      assert.equal(noRoot.status, 400, '缺 root 400(PUT 恒项目级,全局走 raw 编辑)');
      const badUpdates = await put({ root: proj, updates: ['not', 'object'] });
      assert.equal(badUpdates.status, 400, 'updates 非对象 400');
      assert.equal(fs.readFileSync(file, 'utf8'), before400, '400 面零盘上副作用');

      // null=删键:盘上键消失,GET 回 default/null
      const del = await put({ root: proj, updates: { tier: null } });
      assert.equal(del.status, 200);
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      assert.equal('tier' in onDisk, false, 'null 删键');
      const g2 = await fetch(`${base}/settings?root=${encodeURIComponent(proj)}`, { headers: AUTH });
      const tierRow = ((await g2.json()) as SettingsBody).keys.find((k) => k.key === 'tier')!;
      assert.deepEqual(tierRow, { key: 'tier', value: null, source: 'default', envOverride: false }, '删键后槽清+回 default');
    });
  });

  test('⑰ 含注释文件 PUT→409 {file contains comments, use raw editor},盘上原样', async () => {
    await withSettingsDaemon(async ({ base, tmp }) => {
      const proj = path.join(tmp, 'proj');
      const file = path.join(proj, '.sunshinex', 'settings.json');
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      const raw = '{\n  // 手写注释\n  "model": "m"\n}\n';
      fs.writeFileSync(file, raw, 'utf8');

      const r = await fetch(`${base}/settings`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ root: proj, updates: { model: 'x' } }) });
      assert.equal(r.status, 409);
      assert.deepEqual(await r.json(), { error: 'file contains comments', hint: 'use raw editor' }, '结构化改写会丢注释→引流 raw 编辑面');
      assert.equal(fs.readFileSync(file, 'utf8'), raw, '409 面零盘上副作用(注释原样)');
    });
  });

  test('⑱ PUT 后自填槽清除重载:SUNSHINEX_CONTEXT_WINDOW 即新值;真导出键改文件成功但 env 值不动', async () => {
    await withSettingsDaemon(async ({ base, tmp }) => {
      const proj = path.join(tmp, 'proj');
      const file = path.join(proj, '.sunshinex', 'settings.json');
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ contextWindow: 111111 }), 'utf8');
      applySettings(loadProjectSettings(proj));
      assert.equal(process.env.SUNSHINEX_CONTEXT_WINDOW, '111111', '链装载自填旧值');

      const put = async (updates: Record<string, string | number | null>): Promise<Response> =>
        fetch(`${base}/settings`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ root: proj, updates }) });

      const r = await put({ contextWindow: 222222 });
      assert.equal(r.status, 200);
      assert.equal(process.env.SUNSHINEX_CONTEXT_WINDOW, '222222', '自填槽清除重载:新值即刻入 env(新会话即刻生效面)');

      // 真导出键:文件改成功,env 值不动(恒最优先)
      process.env.SUNSHINEX_LANGUAGE = 'env-lang';
      const r2 = await put({ language: 'file-lang' });
      assert.equal(r2.status, 200);
      assert.equal(process.env.SUNSHINEX_LANGUAGE, 'env-lang', '真导出 env 不被重载触碰');
      assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { language?: string }).language, 'file-lang', '文件面已改');

      const g = await fetch(`${base}/settings?root=${encodeURIComponent(proj)}`, { headers: AUTH });
      const body = (await g.json()) as SettingsBody;
      const langRow = body.keys.find((k) => k.key === 'language')!;
      const cwRow = body.keys.find((k) => k.key === 'contextWindow')!;
      assert.deepEqual(langRow, { key: 'language', value: 'env-lang', source: 'env', envOverride: true }, 'GET 仍判 env 最优先');
      assert.deepEqual(cwRow, { key: 'contextWindow', value: '222222', source: 'project', envOverride: false }, 'GET 反映重载后项目值');
    });
  });

  test('⑲ 全局 settings 畸形时 PUT 仍 200 且项目文件在盘(reload 逐级容错,写后不 500)', async () => {
    await withSettingsDaemon(async ({ base, tmp, home }) => {
      fs.writeFileSync(path.join(home, '.sunshinex', 'settings.json'), '{ not json', 'utf8'); // 全局文件畸形
      const proj = path.join(tmp, 'proj');
      const file = path.join(proj, '.sunshinex', 'settings.json');
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ model: 'old' }), 'utf8');

      const r = await fetch(`${base}/settings`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ root: proj, updates: { model: 'written' } }) });
      assert.equal(r.status, 200, '写盘成功是既成事实——重装时全局文件畸形不反噬 500(误导+坏文件死锁后续改写)');
      assert.deepEqual(await r.json(), { ok: true });
      assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { model?: string }).model, 'written', '项目文件如实落盘');
    });
  });

  test('⑳ 项目文件畸形 JSON(无注释)PUT→409,盘上原样', async () => {
    await withSettingsDaemon(async ({ base, tmp }) => {
      const proj = path.join(tmp, 'proj');
      const file = path.join(proj, '.sunshinex', 'settings.json');
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      const raw = '{\n  "model": "m"\n'; // 未闭合:无注释的畸形 JSON
      fs.writeFileSync(file, raw, 'utf8');

      const r = await fetch(`${base}/settings`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ root: proj, updates: { model: 'x' } }) });
      assert.equal(r.status, 409, '文件现状挡结构化改写(与注释同面)');
      assert.ok(((await r.json()) as { error: string }).error.includes('not valid JSON'), '错误指名畸形 JSON');
      assert.equal(fs.readFileSync(file, 'utf8'), raw, '409 面零盘上副作用');
    });
  });
});

// ---------- G8c T3:/settings/raw 双文件端点(settings.json+mcp.json 原文编辑+服务端验证拒存+原子写) ----------

describe('G8c T3 /settings/raw 双文件端点', () => {
  test('㉑ GET 双 scope×双文件:原文逐字复读(JSONC 注释在场);缺文件 {content:null};scope=global 忽略 root', async () => {
    await withSettingsDaemon(async ({ base, tmp, home }) => {
      const proj = path.join(tmp, 'proj');
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      const projSettings = '{\n  // 项目注释\n  "model": "pm"\n}\n';
      const projMcp = '{"mcpServers":{"a":{"command":"node"}}}\n';
      fs.writeFileSync(path.join(proj, '.sunshinex', 'settings.json'), projSettings, 'utf8');
      fs.writeFileSync(path.join(proj, '.sunshinex', 'mcp.json'), projMcp, 'utf8');
      const raw = async (q: string): Promise<Response> => fetch(`${base}/settings/raw?${q}`, { headers: AUTH });

      // 全局双文件缺场(home/.sunshinex 在场但无文件)→ content null
      const gs = await raw('scope=global&file=settings');
      assert.equal(gs.status, 200, 'GET 全局 settings 应 200');
      assert.deepEqual(await gs.json(), { content: null }, '全局 settings 缺文件 → {content:null}');
      const gm = await raw('scope=global&file=mcp');
      assert.equal(gm.status, 200);
      assert.deepEqual(await gm.json(), { content: null }, '全局 mcp 缺文件 → {content:null}');

      // 项目双文件往返:原文逐字(注释/缩进/尾随换行保真)
      const ps = await raw(`scope=project&file=settings&root=${encodeURIComponent(proj)}`);
      assert.equal(ps.status, 200);
      assert.deepEqual(await ps.json(), { content: projSettings }, '项目 settings 原文逐字(JSONC 注释在场)');
      const pm = await raw(`scope=project&file=mcp&root=${encodeURIComponent(proj)}`);
      assert.equal(pm.status, 200);
      assert.deepEqual(await pm.json(), { content: projMcp }, '项目 mcp 原文逐字');

      // scope=global 恒忽略 root:带项目 root 仍定位全局(缺文件 null,不受项目文件影响)
      const gIgn = await raw(`scope=global&file=settings&root=${encodeURIComponent(proj)}`);
      assert.deepEqual(await gIgn.json(), { content: null }, 'scope=global 忽略 root(仍定位全局)');

      // 全局 mcp 落盘后回读逐字
      const globalMcp = '{"mcpServers":{"g":{"command":"node"}}}\n';
      fs.writeFileSync(path.join(home, '.sunshinex', 'mcp.json'), globalMcp, 'utf8');
      const gm2 = await raw('scope=global&file=mcp');
      assert.deepEqual(await gm2.json(), { content: globalMcp }, '全局 mcp 原文逐字');
    });
  });

  test('㉒ PUT settings 畸形 JSONC→400 带 parseSettingsFile 原文 message(行号在场);拒存零副作用+tmp 清理', async () => {
    await withSettingsDaemon(async ({ base, tmp }) => {
      const proj = path.join(tmp, 'proj');
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      const put = async (body: unknown): Promise<Response> =>
        fetch(`${base}/settings/raw`, { method: 'PUT', headers: AUTH, body: JSON.stringify(body) });

      // 缺场文件面:畸形 JSONC 拒存(文件不得被创建)。第四行缺逗号——注释在场(JSONC)+畸形,
      // stripJsonComments 保行数后行号仍指向用户文件真实位置
      const malformed = '{\n  // 手写注释\n  "model": "m"\n  "tier": "x"\n}\n';
      const r = await put({ scope: 'project', root: proj, file: 'settings', content: malformed });
      assert.equal(r.status, 400, '畸形 JSONC 拒存 → 400');
      const body = (await r.json()) as { error: string };
      assert.ok(body.error.includes('settings.json 解析失败'), '400 带 parseSettingsFile 原文 message');
      assert.match(body.error, /line \d+/, '解析错误定位行号在场(指向用户文件真实位置)');
      assert.equal(fs.existsSync(path.join(proj, '.sunshinex', 'settings.json')), false, '拒存:目标文件不被创建');

      // version 非 1 拒存(装载面 fail-fast 同口径)
      const v2 = await put({ scope: 'project', root: proj, file: 'settings', content: '{"version": 2}' });
      assert.equal(v2.status, 400, 'version 非 1 → 400');

      // 既有文件面:拒存不动原文 + 验证失败的 tmp 不残留
      const file = path.join(proj, '.sunshinex', 'settings.json');
      const original = '{\n  "model": "keep"\n}\n';
      fs.writeFileSync(file, original, 'utf8');
      const r2 = await put({ scope: 'project', root: proj, file: 'settings', content: '{ bad' });
      assert.equal(r2.status, 400);
      assert.equal(fs.readFileSync(file, 'utf8'), original, '400 面零盘上副作用');
      assert.equal(
        fs.readdirSync(path.join(proj, '.sunshinex')).filter((f) => f.includes('.tmp-')).length,
        0,
        '验证失败的 tmp 已清理,无残片',
      );
    });
  });

  test('㉓ PUT mcp 畸形→400:非法 JSON/根非对象/mcpServers 非对象/注释(装载面严格 JSON);盘零副作用', async () => {
    await withSettingsDaemon(async ({ base, tmp }) => {
      const proj = path.join(tmp, 'proj');
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      const file = path.join(proj, '.sunshinex', 'mcp.json');
      const original = '{"mcpServers":{"keep":{"command":"node"}}}\n';
      fs.writeFileSync(file, original, 'utf8');
      const put = async (content: unknown): Promise<Response> =>
        fetch(`${base}/settings/raw`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ scope: 'project', root: proj, file: 'mcp', content }) });

      const badJson = await put('{ not json');
      assert.equal(badJson.status, 400, '非法 JSON → 400');
      const e1 = (await badJson.json()) as { error: string };
      assert.ok(e1.error.includes('mcp.json 解析失败'), '错误指名 mcp 解析失败');
      assert.match(e1.error, /(line|position) \d+/, '原文解析 reason 在场');

      const badRoot = await put('[1, 2]');
      assert.equal(badRoot.status, 400, '根数组 → 400');
      assert.ok(((await badRoot.json()) as { error: string }).error.includes('根必须是 JSON 对象'), '错误指名根对象要求');

      const badServers = await put('{"mcpServers": []}');
      assert.equal(badServers.status, 400, 'mcpServers 数组 → 400(装载面此形态静默读空,编辑面显式拒)');

      // 注释:装载面(parseMcpJsonFile)严格 JSON——注释文件会被静默读空,验证口径=装载口径,拒存
      // (与 settings JSONC 面相异:settings 装载面本身容忍注释)
      const commented = await put('{\n  // 注释\n  "mcpServers": {}\n}\n');
      assert.equal(commented.status, 400, 'mcp 面不容忍注释(装载口径使然)');

      assert.equal(fs.readFileSync(file, 'utf8'), original, '400 面零盘上副作用');
    });
  });

  test('㉔ 合法 PUT 写盘+GET 复读逐字一致(JSONC 注释保真);.sunshinex 目录缺场自动建', async () => {
    await withSettingsDaemon(async ({ base, tmp }) => {
      const proj = path.join(tmp, 'proj'); // .sunshinex 故意不预建:验证 PUT 自动 mkdir
      const rawSettings = '{\n  // 保持注释\n  "model": "raw-model",\n  "env": { "SUNSHINEX_API_KEY": "k" }\n}\n';
      const rawMcp = '{"mcpServers":{"srv":{"command":"node","args":["--flag"]}}}\n';
      const put = (scope: string, file: string, content: string, root?: string): Promise<Response> =>
        fetch(`${base}/settings/raw`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ scope, file, content, ...(root !== undefined ? { root } : {}) }) });

      const rs = await put('project', 'settings', rawSettings, proj);
      assert.equal(rs.status, 200, '合法 JSONC 写盘应 200(.sunshinex 自动建)');
      assert.deepEqual(await rs.json(), { ok: true });
      const rm = await put('project', 'mcp', rawMcp, proj);
      assert.equal(rm.status, 200);
      assert.deepEqual(await rm.json(), { ok: true });

      const get = async (q: string): Promise<{ content: string | null }> =>
        (await (await fetch(`${base}/settings/raw?${q}`, { headers: AUTH })).json()) as { content: string | null };
      assert.deepEqual(await get(`scope=project&file=settings&root=${encodeURIComponent(proj)}`), { content: rawSettings }, '写后复读逐字一致(注释/缩进/尾随换行保真)');
      assert.deepEqual(await get(`scope=project&file=mcp&root=${encodeURIComponent(proj)}`), { content: rawMcp }, 'mcp 写后复读逐字一致');
      assert.equal(fs.readFileSync(path.join(proj, '.sunshinex', 'settings.json'), 'utf8'), rawSettings, '盘上字节=PUT 原文');
      assert.equal(fs.readFileSync(path.join(proj, '.sunshinex', 'mcp.json'), 'utf8'), rawMcp, '盘上字节=PUT 原文');
    });
  });

  test('㉕ scope=global 落 userConfigDir:双文件写 <home>/.sunshinex 下;body root 不改定位不产目录', async () => {
    await withSettingsDaemon(async ({ base, tmp, home }) => {
      const put = async (body: unknown): Promise<Response> =>
        fetch(`${base}/settings/raw`, { method: 'PUT', headers: AUTH, body: JSON.stringify(body) });
      const gSettings = '{"tier": "global-tier"}\n';
      const gMcp = '{"mcpServers":{"g":{"command":"node"}}}\n';

      const r1 = await put({ scope: 'global', file: 'settings', content: gSettings });
      assert.equal(r1.status, 200, 'global settings 写盘应 200(无 root:只写盘)');
      const decoy = path.join(tmp, 'who-cares');
      const r2 = await put({ scope: 'global', file: 'mcp', content: gMcp, root: decoy });
      assert.equal(r2.status, 200);
      assert.equal(fs.readFileSync(path.join(home, '.sunshinex', 'settings.json'), 'utf8'), gSettings, 'global settings 落 <home>/.sunshinex/settings.json(userConfigDir)');
      assert.equal(fs.readFileSync(path.join(home, '.sunshinex', 'mcp.json'), 'utf8'), gMcp, 'global mcp 落 <home>/.sunshinex/mcp.json(root 不改定位)');
      assert.equal(fs.existsSync(decoy), false, 'root 被忽略:不产生目录副作用');
    });
  });

  test('㉖ 未知 scope/file→400(GET/PUT);scope=project 缺 root→400(GET/PUT);content 非 string→400', async () => {
    await withSettingsDaemon(async ({ base, tmp }) => {
      const proj = path.join(tmp, 'proj');
      const raw = async (q: string): Promise<Response> => fetch(`${base}/settings/raw?${q}`, { headers: AUTH });
      const put = async (body: unknown): Promise<Response> =>
        fetch(`${base}/settings/raw`, { method: 'PUT', headers: AUTH, body: JSON.stringify(body) });

      const gs = await raw('scope=team&file=settings');
      assert.equal(gs.status, 400, 'GET 未知 scope → 400');
      const gf = await raw(`scope=project&file=agents&root=${encodeURIComponent(proj)}`);
      assert.equal(gf.status, 400, 'GET 未知 file → 400');
      const gNoRoot = await raw('scope=project&file=settings');
      assert.equal(gNoRoot.status, 400, 'GET scope=project 缺 root → 400');

      const ps = await put({ scope: 'team', file: 'settings', content: '{}' });
      assert.equal(ps.status, 400, 'PUT 未知 scope → 400');
      const pf = await put({ scope: 'project', root: proj, file: 'agents', content: '{}' });
      assert.equal(pf.status, 400, 'PUT 未知 file → 400');
      const pNoRoot = await put({ scope: 'project', file: 'settings', content: '{}' });
      assert.equal(pNoRoot.status, 400, 'PUT scope=project 缺 root → 400');
      const badContent = await put({ scope: 'project', root: proj, file: 'settings', content: 123 });
      assert.equal(badContent.status, 400, 'content 非 string → 400');
    });
  });

  test('㉗ PUT raw settings reload:project→自填槽即新值;global 带 root→链重载入槽;global 无 root→只写盘槽不动;mcp 不触发', async () => {
    await withSettingsDaemon(async ({ base, tmp }) => {
      const proj = path.join(tmp, 'proj');
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.sunshinex', 'settings.json'), JSON.stringify({ contextWindow: 111111 }), 'utf8');
      applySettings(loadProjectSettings(proj));
      applySettings(loadGlobalSettings()); // 无全局文件——no-op
      assert.equal(process.env.SUNSHINEX_CONTEXT_WINDOW, '111111', '链装载自填旧值');

      const put = async (body: unknown): Promise<Response> =>
        fetch(`${base}/settings/raw`, { method: 'PUT', headers: AUTH, body: JSON.stringify(body) });

      // project 面:PUT raw→清自填槽重载链,槽即新值(沿 T2 ⑱ 手法)
      const r = await put({ scope: 'project', root: proj, file: 'settings', content: '{\n  // 注释保真\n  "contextWindow": 333333\n}\n' });
      assert.equal(r.status, 200);
      assert.equal(process.env.SUNSHINEX_CONTEXT_WINDOW, '333333', 'PUT raw project 后链重载,槽即新值');

      // global 带 root:reload 以该 root 跑链(全局链随跑),全局值入槽
      const r2 = await put({ scope: 'global', file: 'settings', content: '{"language": "gl-lang"}\n', root: proj });
      assert.equal(r2.status, 200);
      assert.equal(process.env.SUNSHINEX_LANGUAGE, 'gl-lang', 'global 写带 root→链重载跑,全局值入槽');

      // global 无 root:只写盘不 reload(裁定:恒不凭空触发项目链 reload)——槽不动
      const r3 = await put({ scope: 'global', file: 'settings', content: '{"language": "gl-two"}\n' });
      assert.equal(r3.status, 200);
      assert.equal(process.env.SUNSHINEX_LANGUAGE, 'gl-lang', 'global 无 root 只写盘:env 槽不动');

      // mcp 面:PUT 不触发 settings 链 reload(mcp 不在链内)——写盘即回
      const r4 = await put({ scope: 'global', file: 'mcp', content: '{"mcpServers":{}}\n' });
      assert.equal(r4.status, 200);
      assert.equal(process.env.SUNSHINEX_CONTEXT_WINDOW, '333333', 'mcp 写盘不动 settings 槽');
    });
  });
});
