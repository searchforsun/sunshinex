import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult, SessionEvent } from '../types';

/** G1 契约收口测试（T1 会话中心迁移）：全链（submit → WS 事件序 → done → 二轮续推——① 起两轮跨会话）
 *  + API 面收口（404 hint/401/409/400）。helper 形态照 daemon.ws.test.ts / daemon.test.ts 惯例，自包含 */

/** WS 下行帧契约：恒 {kind:'event', sessionId, seq, e}——与 daemon.ws.test.ts 同形（T1 会话中心 + G3 seq 协议） */
interface Frame {
  kind: string;
  sessionId: string;
  seq: number;
  e: SessionEvent;
}

/** 未知路径 404 hint（G1 裁定：恒定提示，G2 起按 dist-gui 探测分流）——与 daemon.ts 单点文案须逐字一致 */
const GUI_HINT = 'GUI assets not built — run pnpm --filter gui build (G2)';

/** 轮询等待：20ms 片轮询直至 pred 为真，超时抛错 */
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

/** 挂起适配器（同 daemon.test.ts）：模型调用永挂——「运行中」锁的可靠模拟（ScriptedAdapter done 卡瞬间收束） */
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

interface Ctx {
  daemon: GuiDaemon;
  http: string;
  ws: string;
  /** 首会话 id（helper 内创建，root=daemon tmp） */
  sid: string;
  /** 会话维提交（缺省首会话） */
  post: (goal: string, sid?: string) => Promise<Response>;
  /** POST /session/new（root 缺省 daemon tmp） */
  newSession: (root?: string) => Promise<string>;
}

/** 装配样板（环境隔离同 daemon.ws.test.ts）：SUNSHINEX_DATA_DIR 钉 tmp，token 固定 test-token，port 0。
 *  staticRoot 缺省注入「不存在的 tmp 目录」——静态面恒未挂载（404 hint 原样），测试不依赖
 *  进程 cwd 是否恰有 dist-gui（仓库根真实在场，hermetic 钉死缺场形态；⑥ 显式传 populated 目录） */
async function withDaemon(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void>, staticRoot?: string): Promise<void> {
  const tmp = tmpdir('sunshinex-serve-contract-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model, staticRoot: staticRoot ?? path.join(tmp, 'dist-gui-absent') });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const http = `http://127.0.0.1:${s.port}`;
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;
    const newSession = async (root?: string): Promise<string> => {
      const r = await fetch(`${http}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: root ?? tmp }) });
      assert.equal(r.status, 200, 'session/new 应 200');
      return ((await r.json()) as { sessionId: string }).sessionId;
    };
    const sid = await newSession();
    const post = async (goal: string, target?: string): Promise<Response> => {
      const r = await fetch(`${http}/session/${target ?? sid}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ goal }) });
      assert.equal(r.status, 202, 'submit 应 202');
      return r;
    };
    try {
      await fn({ daemon, http, ws: `ws://127.0.0.1:${s.port}`, sid, post, newSession });
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 开连接并同步挂帧收集器（照 daemon.ws.test.ts：message 监听须在构造后立刻挂——补发帧可能与握手
 *  响应同一 TCP 段到达，等 open 后再挂会丢同段帧） */
function openCollecting(url: string): Promise<{ ws: WebSocket; frames: Frame[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer test-token' } });
    const frames: Frame[] = [];
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as Frame);
    });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });
}

test('① 全链跨会话：s1 轮 run 事件流至 done → 新建 s2 二轮续推（帧各挂 sessionId、seq 全局续接、快照各归各、裸端点随激活）', async () => {
  // 每会话一张 done 卡：两会话 run 各消耗一卡（done 卡一次模型调用即收束）
  const model = new ScriptedAdapter(['{"done":true,"reply":"one"}', '{"done":true,"reply":"two"}']);
  await withDaemon(model, async (ctx) => {
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      // —— 第一轮（s1）：连接在先，submit 后事件实时按序流至 done ——
      await ctx.post('第一轮 goal', ctx.sid);
      await waitFor(() => frames.some((f) => f.e.type === 'done'), 10000);
      const firstDone = frames.findIndex((f) => f.e.type === 'done');
      assert.ok(frames.slice(0, firstDone + 1).every((f) => f.kind === 'event' && f.sessionId === ctx.sid), 's1 轮全帧恒 kind:"event" 且挂 s1');
      // 帧间 type 序：route（run 起步路由）→ model-start（模型面起步）→ token 增量 → done（收尾必发）
      const types1 = frames.slice(0, firstDone + 1).map((f) => f.e.type);
      const route1 = types1.indexOf('route');
      const ms1 = types1.indexOf('model-start');
      assert.ok(route1 >= 0, 'run 首帧面含 route');
      assert.ok(ms1 > route1, 'model-start 晚于 route');
      assert.ok(firstDone > ms1, 'done 收尾帧晚于 model-start');
      const tokens1 = frames.slice(ms1, firstDone).filter((f) => f.e.type === 'token').map((f) => f.e.text ?? '').join('');
      assert.equal(tokens1, 'one', '终稿正文经 token 增量帧流过（model-start 与 done 之间）');
      assert.equal(frames[firstDone].e.text, 'one');
      // run 收束：status 回 idle 后事件面静止——末帧即 done（done 后无尾随事件源）
      await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'idle', 3000);
      assert.equal(frames[frames.length - 1].e.type, 'done', 'idle 时末事件 type 为 done');
      const s1MaxSeq = Math.max(...frames.map((f) => f.seq));

      // —— 第二轮（s2 新会话）：同一连接续推，帧挂 s2、seq 跨会话全局续接 ——
      const s2 = await ctx.newSession();
      assert.equal(ctx.daemon.activeId(), s2, '最近创建者激活');
      await ctx.post('第二轮 goal', s2);
      await waitFor(() => frames.filter((f) => f.sessionId === s2).some((f) => f.e.type === 'done'), 10000);
      const s2Frames = frames.filter((f) => f.sessionId === s2);
      const secondDone = s2Frames.findIndex((f) => f.e.type === 'done');
      assert.ok(secondDone > 0, 's2 轮含 done 终态');
      assert.ok(s2Frames.slice(0, secondDone + 1).every((f) => f.kind === 'event'), 's2 轮全帧恒 kind:"event"');
      assert.equal(s2Frames[0].e.type, 'route', 's2 轮首帧 type 为 route（会话维事件面完整起步）');
      assert.ok(s2Frames[0].seq > s1MaxSeq, 's2 帧 seq 跨会话全局续接（daemon 级单调不回拨）');
      assert.equal(s2Frames[secondDone].e.text, 'two');
      await waitFor(() => ctx.daemon.get(s2)!.status() === 'idle', 3000);

      // —— 快照各归各：s1 轮转录在 s1 侧原样在场，s2 侧只有第二轮 ——
      const snapOf = async (sid: string): Promise<string> => {
        const r = await fetch(`${ctx.http}/session/${sid}/snapshot`, { headers: { authorization: 'Bearer test-token' } });
        return ((await r.json()) as { messages: Array<{ md: string }> }).messages.map((m) => m.md).join('\n');
      };
      const m1 = await snapOf(ctx.sid);
      assert.ok(m1.includes('> 第一轮 goal') && m1.includes('one'), 's1 快照含第一轮全转录');
      assert.ok(!m1.includes('第二轮'), 's1 快照不含 s2 轮事件（互不串流）');
      const m2 = await snapOf(s2);
      assert.ok(m2.includes('> 第二轮 goal') && m2.includes('two'), 's2 快照含第二轮全转录');
      assert.ok(!m2.includes('第一轮'), 's2 快照不含 s1 轮事件');
      // 裸 /snapshot = 激活会话（s2）
      const bareSnap = (await (await fetch(`${ctx.http}/snapshot`, { headers: { authorization: 'Bearer test-token' } })).json()) as { messages: Array<{ md: string }> };
      assert.ok(bareSnap.messages.map((m) => m.md).join('\n').includes('> 第二轮 goal'), '裸 snapshot 回激活会话（s2）');
    } finally {
      ws.close();
    }
  });
});

test('② API 面收口：未知 GET 404+hint；无 token 401；运行中 submit 409 / idle interrupt 409；空 body 400', async () => {
  await withDaemon(new HangingAdapter(), async (ctx) => {
    // 404：未知路径（非 API 端点、非 healthz）——G1 裁定恒定 hint；POST 未知路径统一同形
    const nf = await fetch(`${ctx.http}/foo`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(nf.status, 404);
    assert.deepEqual(await nf.json(), { error: 'not found', hint: GUI_HINT }, '404 body 逐字=error+hint');
    const nfPost = await fetch(`${ctx.http}/nope`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(nfPost.status, 404);
    assert.deepEqual(await nfPost.json(), { error: 'not found', hint: GUI_HINT }, 'POST 未知路径同 404 同 hint（统一裁定）');

    // 401：无 token 提交（会话维端点鉴权面同裸端点）
    const noTok = await fetch(`${ctx.http}/session/${ctx.sid}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'x' }) });
    assert.equal(noTok.status, 401);
    assert.deepEqual(await noTok.json(), { error: 'unauthorized' });

    // 400：空 body（JSON 解析失败）
    const empty = await fetch(`${ctx.http}/session/${ctx.sid}/submit`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: '' });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'invalid json body');

    // 409（idle interrupt）：无运行时中断请求被拒
    const itIdle = await fetch(`${ctx.http}/session/${ctx.sid}/interrupt`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
    assert.equal(itIdle.status, 409);
    assert.equal((await itIdle.json()).error, 'no run in progress');

    // 409（运行中 submit）：挂起 run 占锁，新提交被拒；随后 interrupt 收尾清锁
    await ctx.post('长任务');
    await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'running', 3000);
    const conflict = await fetch(`${ctx.http}/session/${ctx.sid}/submit`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ goal: '再来' }) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, 'run in progress');
    const stop = await fetch(`${ctx.http}/session/${ctx.sid}/interrupt`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
    assert.equal(stop.status, 200);
    await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'idle', 3000);
  });
});

test('③ GET /session/:id/snapshot：含工具卡 run 后 messages 三类在场、board 影子 t1 落位、status idle；无 token 401', async () => {
  // 消费序（taskboard.e2e 实测口径）：主链 create_task 牌 → 执行器内同步派发 fork（fork 消费下一张
  // done 牌）→ 主链再取（末位 done 牌重复供牌）→ run 收束。create_task 入参六件全给（T1 P2 形态）。
  const model = new ScriptedAdapter([
    '{"tool":"create_task","input":{"title":"A","spec":"a","dependsOn":null,"assignee":null,"gated":null,"executor":null}}',
    '{"done":true,"reply":"task created"}',
  ]);
  await withDaemon(model, async (ctx) => {
    // 鉴权面同 submit/interrupt：无 token 401
    const noTok = await fetch(`${ctx.http}/session/${ctx.sid}/snapshot`);
    assert.equal(noTok.status, 401);
    assert.deepEqual(await noTok.json(), { error: 'unauthorized' });

    await ctx.post('建个任务');
    await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'idle', 10000);

    const r = await fetch(`${ctx.http}/session/${ctx.sid}/snapshot`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(r.status, 200);
    const snap = (await r.json()) as {
      messages: Array<{ seq: number; ts: number; kind: string; md: string }>;
      board: { tasks: Record<string, { id: string; title: string }>; seq: number };
      delegations: unknown[];
      status: string;
    };
    // messages：三类粗粒度转录在场（user 提交回显 / assistant 终答 / tool 配对条）
    const kinds = snap.messages.map((m) => m.kind);
    assert.ok(kinds.includes('user'), 'messages 含 user 条');
    assert.ok(kinds.includes('assistant'), 'messages 含 assistant 条');
    assert.ok(kinds.includes('tool'), 'messages 含 tool 条');
    const user = snap.messages.find((m) => m.kind === 'user');
    assert.equal(user?.md, '> 建个任务', 'user 条为 `> <goal>` 形');
    const tool = snap.messages.find((m) => m.kind === 'tool');
    assert.ok(tool!.md.startsWith('● create_task\n'), 'tool 条 verb 行为 create_task');
    assert.ok(tool!.md.includes('task t1 created'), 'tool 条含 result 首行摘要');
    // 影子投影：pump 喂入的 task-created 经同源 boardEventFrom/applyBoardEvent 落位
    assert.notEqual(snap.board.tasks.t1, undefined, 'board 影子含 create_task 建出的 t1');
    assert.equal(snap.board.tasks.t1!.title, 'A');
    assert.ok(Array.isArray(snap.delegations), 'delegations 影子恒数组');
    assert.equal(snap.status, 'idle', 'run 收束后 status=idle');
  });
});


test('④ POST /session/:id/steer：无 token 401；空/空白/非 string text 400；运行中 200 {ok:true}；空闲亦恒 200（排队下一轮生效）', async () => {
  await withDaemon(new HangingAdapter(), async (ctx) => {
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
    // 401：鉴权面同 submit/interrupt
    const noTok = await fetch(`${ctx.http}/session/${ctx.sid}/steer`, { method: 'POST', body: JSON.stringify({ text: 'x' }) });
    assert.equal(noTok.status, 401);
    assert.deepEqual(await noTok.json(), { error: 'unauthorized' });

    // 400：text 非非空 string（空串/纯空白/数字/null）——空白串与 SteeringChannel.enqueue 的 trim-忽略口径一致拒
    for (const text of ['', '   ', 42, null]) {
      const r = await fetch(`${ctx.http}/session/${ctx.sid}/steer`, { method: 'POST', headers: H, body: JSON.stringify({ text }) });
      assert.equal(r.status, 400, `text=${JSON.stringify(text)} 非法 → 400`);
      assert.equal((await r.json()).error, 'text must be a non-empty string');
    }

    // 200：运行中投递（挂起 run 占锁中）
    await ctx.post('长任务');
    await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'running', 3000);
    const st = await fetch(`${ctx.http}/session/${ctx.sid}/steer`, { method: 'POST', headers: H, body: JSON.stringify({ text: '改查另一处' }) });
    assert.equal(st.status, 200);
    assert.deepEqual(await st.json(), { ok: true }, '运行中 steer 恒 200 {ok:true}（daemon 不因 steer 倒面）');

    // 收尾清锁后空闲态 steer 亦 200——SteeringChannel 纯内存 FIFO 语义：空闲入队，下一轮步边界 drain 生效
    const stop = await fetch(`${ctx.http}/session/${ctx.sid}/interrupt`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
    assert.equal(stop.status, 200);
    await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'idle', 3000);
    const idle = await fetch(`${ctx.http}/session/${ctx.sid}/steer`, { method: 'POST', headers: H, body: JSON.stringify({ text: '下一轮先看测试' }) });
    assert.equal(idle.status, 200, '空闲 steer 恒 200（排队下一轮生效，不 409）');
    assert.deepEqual(await idle.json(), { ok: true });
  });
});

test('⑤ snapshot.lastSeq：idle 态（done=末事件）恰等于 WS 已收帧最大 seq（先影子后广播序内）', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      await ctx.post('跑一轮');
      await waitFor(() => frames.some((f) => f.e.type === 'done'), 10000);
      await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'idle', 3000);
      const r = await fetch(`${ctx.http}/session/${ctx.sid}/snapshot`, { headers: { authorization: 'Bearer test-token' } });
      assert.equal(r.status, 200);
      const snap = (await r.json()) as { lastSeq: number };
      const maxSeq = Math.max(...frames.map((f) => f.seq));
      assert.ok(frames.length > 0, '已收帧非空');
      assert.ok(frames.every((f) => Number.isInteger(f.seq) && f.seq >= 1), '帧 seq 恒 ≥1 整数');
      assert.equal(snap.lastSeq, maxSeq, 'lastSeq=已收帧最大 seq（重连协议：客户端凭 seq 判缺口）');
    } finally {
      ws.close();
    }
  });
});

test('⑥ 静态挂载：GET / 回 index.html（html mime）、/app.js 回 js mime、SPA 兜底、穿越拒 404；缺 staticRoot 文件 → 404+hint 原样', async () => {
  const tmp = tmpdir('sunshinex-serve-static-');
  const dir = path.join(tmp, 'dist-gui');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html>sunshinex gui</html>', 'utf8');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("gui")', 'utf8');
  try {
    await withDaemon(new HangingAdapter(), async (ctx) => {
      // GET /：目录路径经 root 兜底回 index.html，html mime
      const idx = await fetch(`${ctx.http}/`);
      assert.equal(idx.status, 200);
      assert.ok((idx.headers.get('content-type') ?? '').startsWith('text/html'), '/ 回 text/html');
      assert.ok((await idx.text()).includes('sunshinex gui'), '/ 回 index.html 本体');

      // 静态文件直读：扩展名 mime 表（js 面）
      const js = await fetch(`${ctx.http}/app.js`);
      assert.equal(js.status, 200);
      assert.ok((js.headers.get('content-type') ?? '').startsWith('text/javascript'), '/app.js 回 text/javascript');
      assert.equal(await js.text(), 'console.log("gui")');

      // SPA 兜底：root 内未命中路径回 index.html（客户端路由刷新路径不 404）
      const spa = await fetch(`${ctx.http}/chat/section-2`);
      assert.equal(spa.status, 200);
      assert.ok((await spa.text()).includes('sunshinex gui'), '未命中路径兜底 index.html');

      // 穿越拒：%2e%2e%2f 整段不在 URL 规范的四个 dot-segment 形态之内，原样抵 server——decode 后成
      // ../ 经 join+normalize 越界即 404，不落 SPA 兜底（纯 %2E%2E 形态在 fetch/URL 侧即被 dot-segment
      // 规范折叠到根，到不了 daemon；本向量专测 daemon 侧穿越防线本体）
      const trav = await fetch(`${ctx.http}/%2e%2e%2fpackage.json`);
      assert.equal(trav.status, 404, '路径穿越必须 404（不得读 staticRoot 外文件）');
      assert.deepEqual(await trav.json(), { error: 'not found', hint: GUI_HINT }, '穿越拒与缺静态同 404 形（不落 SPA）');

      // API 路由恒先于静态：healthz 免鉴权照旧 JSON
      const h = await fetch(`${ctx.http}/healthz`);
      assert.deepEqual(await h.json(), { ok: true });
    }, dir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 缺场形态：staticRoot 指向不存在目录（withDaemon 缺省注入）——未知 GET 保持 G1 的 404+hint 原样
  await withDaemon(new HangingAdapter(), async (ctx) => {
    const nf = await fetch(`${ctx.http}/foo`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(nf.status, 404);
    assert.deepEqual(await nf.json(), { error: 'not found', hint: GUI_HINT }, '无静态产物时 404 hint 原样');
  });
});
