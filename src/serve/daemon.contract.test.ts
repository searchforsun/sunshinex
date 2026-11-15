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
import { MemoryAgentTeamStore } from '../taskboard/team-registry';
import type { AgentTeamRegistry } from '../taskboard/team-registry';
import { parseJournalFile, readSessionMeta, sessionsDir } from '../tui/session-journal';
import { resolveDataDir } from '../config/data-dir';
import { SUNX_BRIEF_LINE, SUNX_IDENTITY_LINE } from '../harness/prompts/shared';

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

const TEAM_ID = 'team-alpha-test';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 经 harness 注册表注入固定 teamId（会话隔离后不再写工作区级 teams/registry.json） */
function seedTeam(agentTeams: AgentTeamRegistry): void {
  const store = new MemoryAgentTeamStore();
  store.save([{ teamId: TEAM_ID, name: 'alpha', createdAt: 1 }]);
  agentTeams.adopt(store);
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

/** wire 工具名探针（sunx-face.test.ts probeAdapter 同构）：记录每轮模型面实发 tools 名单——注册表
 *  has() 只证装配注册分支（exec 两形态都在册），wire 面才是 loop 消费的 effective face（白名单派生） */
function wireProbe(base: ScriptedAdapter, seen: { toolNames: string[] }): ModelAdapter {
  return {
    provider: 'wire-probe',
    chat: async (req: ChatRequest) => {
      seen.toolNames.push(...(req.tools ?? []).map((t) => t.function.name));
      return base.chat(req);
    },
  };
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
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // win32：收口后偶发目录锁（watcher/句柄迟滞），不挡断言
    }
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
      // G14.100 runmeta 帧（收尾元数据，done 后 pump）是合法尾随事件——末帧 ∈ {done, runmeta}
      const lastType = frames[frames.length - 1].e.type;
      assert.ok(lastType === 'done' || lastType === 'runmeta', `idle 时末事件为 done/runmeta，实际 ${String(lastType)}`);
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
      // journal-minted 帧先于 route（2026-11-07 用户裁定「主动推送是基本能力」：会话创建即广播
      // journalId 旁路帧——s2 在 WS 连接之后新建,铸造帧在连接在场窗口到达;s1 帧铸造早于连接故首帧仍 route）
      assert.equal(s2Frames[0].e.type, 'journal-minted', 's2 轮首帧=创建即推的 journal-minted（主动推送面）');
      assert.equal(s2Frames[1].e.type, 'route', 'journal-minted 后随 route（会话维事件面完整起步）');
      assert.ok(s2Frames[0].seq > s1MaxSeq, 's2 帧 seq 跨会话全局续接（daemon 级单调不回拨）');
      assert.equal(s2Frames[secondDone].e.text, 'two');
      await waitFor(() => ctx.daemon.get(s2)!.status() === 'idle', 3000);

      // —— 快照各归各：s1 轮转录在 s1 侧原样在场，s2 侧只有第二轮 ——
      const snapOf = async (sid: string): Promise<string> => {
        const r = await fetch(`${ctx.http}/session/${sid}/snapshot`, { headers: { authorization: 'Bearer test-token' } });
        return ((await r.json()) as { messages: Array<{ md: string }> }).messages.map((m) => m.md).join('\n');
      };
      const m1 = await snapOf(ctx.sid);
      assert.ok(m1.includes('第一轮 goal') && m1.includes('one'), 's1 快照含第一轮全转录(user 裸文,P11)');
      assert.ok(!m1.includes('第二轮'), 's1 快照不含 s2 轮事件（互不串流）');
      const m2 = await snapOf(s2);
      assert.ok(m2.includes('第二轮 goal') && m2.includes('two'), 's2 快照含第二轮全转录');
      assert.ok(!m2.includes('第一轮'), 's2 快照不含 s1 轮事件');
      // 裸 /snapshot = 激活会话（s2）
      const bareSnap = (await (await fetch(`${ctx.http}/snapshot`, { headers: { authorization: 'Bearer test-token' } })).json()) as { messages: Array<{ md: string }> };
      assert.ok(bareSnap.messages.map((m) => m.md).join('\n').includes('第二轮 goal'), '裸 snapshot 回激活会话（s2）');
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

test('③ GET /session/:id/snapshot：含工具卡 run 后 messages 三类在场、board 影子落位、status idle；无 token 401', async () => {
  // 消费序（taskboard.e2e 实测口径）：主链 create_agent_team_task 牌 → 执行器内同步派发 fork（fork 消费下一张
  // done 牌）→ 主链再取（末位 done 牌重复供牌）→ run 收束。create_agent_team_task 入参带 teamId 与可空依赖字段。
  const model = new ScriptedAdapter([
    `{"tool":"create_agent_team_task","input":{"teamId":"${TEAM_ID}","title":"A","spec":"a","dependsOn":null,"assignee":null,"executor":null,"retryOf":null}}`,
    '{"done":true,"reply":"task created"}',
  ]);
  await withDaemon(model, async (ctx) => {
    seedTeam(ctx.daemon.get(ctx.sid)!.runtime.harness.agentTeams);
    // 鉴权面同 submit/interrupt：无 token 401
    const noTok = await fetch(`${ctx.http}/session/${ctx.sid}/snapshot`);
    assert.equal(noTok.status, 401);
    assert.deepEqual(await noTok.json(), { error: 'unauthorized' });

    await ctx.post('建个任务');
    await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'idle', 10000);

    const r = await fetch(`${ctx.http}/session/${ctx.sid}/snapshot`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(r.status, 200);
    const snap = (await r.json()) as {
      messages: Array<{ seq: number; ts: number; kind: string; md: string; name?: string; result?: { text: string; ok: boolean; full?: string } }>;
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
    assert.equal(user?.md, '建个任务', 'user 条为裸文(渲染中立,P11)');
    const tool = snap.messages.find((m) => m.kind === 'tool');
    assert.equal(tool!.md, '', 'tool 条 md 恒空(字段单源,P11 渲染中立)');
    assert.equal(tool!.name, 'create_agent_team_task', 'tool 条 name 字段为 create_agent_team_task');
    const boardIds = Object.keys(snap.board.tasks);
    assert.equal(boardIds.length, 1, '前置:恰一个板任务');
    const taskId = boardIds[0]!;
    assert.ok(
      tool!.result?.ok === true && (tool!.result.text.includes(`id=${taskId}`) || tool!.result.text.startsWith(`task ${taskId} created`)),
      'tool 条 result 字段含回执(字段权威)',
    );
    // 影子投影：pump 喂入的 task-created 经同源 boardEventFrom/applyBoardEvent 落位
    assert.notEqual(snap.board.tasks[taskId], undefined, 'board 影子含 create_agent_team_task 建出的任务');
    assert.equal(snap.board.tasks[taskId]!.title, 'A');
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

    // 收尾清锁后空闲态 steer 亦 200——队列态在内核(P5):空闲入队,下一轮步边界 drain 生效
    const stop = await fetch(`${ctx.http}/session/${ctx.sid}/interrupt`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
    assert.equal(stop.status, 200);
    await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'idle', 3000);
    const idle = await fetch(`${ctx.http}/session/${ctx.sid}/steer`, { method: 'POST', headers: H, body: JSON.stringify({ text: '下一轮先看测试' }) });
    assert.equal(idle.status, 200, '空闲 steer 恒 200（排队下一轮生效，不 409）');
    assert.deepEqual(await idle.json(), { ok: true });

    // P5 spec §12:steer/edit 编辑队列条目;越界/空白 400
    const snap0 = (await (await fetch(`${ctx.http}/session/${ctx.sid}/snapshot`, { headers: H })).json()) as { queued: Array<{ seq: number }> };
    assert.ok(snap0.queued.length >= 2, '前序入队两条在场');
    const bad = await fetch(`${ctx.http}/session/${ctx.sid}/steer/edit`, { method: 'POST', headers: H, body: JSON.stringify({ seq: 99, text: 'x' }) });
    assert.equal(bad.status, 400, '越界 edit 400');
    const blank = await fetch(`${ctx.http}/session/${ctx.sid}/steer/edit`, { method: 'POST', headers: H, body: JSON.stringify({ seq: 0, text: '   ' }) });
    assert.equal(blank.status, 400, '空白 text edit 400');
    const edit = await fetch(`${ctx.http}/session/${ctx.sid}/steer/edit`, { method: 'POST', headers: H, body: JSON.stringify({ seq: snap0.queued[0]!.seq, text: '改后的插话' }) });
    assert.equal(edit.status, 200);
    const snap1 = (await (await fetch(`${ctx.http}/session/${ctx.sid}/snapshot`, { headers: H })).json()) as { queued: Array<{ seq: number; text: string }> };
    assert.equal(snap1.queued.find((q) => q.seq === snap0.queued[0]!.seq)?.text, '改后的插话', 'edit 后快照回显新文本');
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

test('⑦ POST /session/:id/mode 契约（spec §3.2）：新四值合法 200、旧值 400', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const postMode = async (m: string): Promise<Response> =>
      fetch(`${ctx.http}/session/${ctx.sid}/mode`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ mode: m }),
      });
    // 新四值（三权限档 + plan 流程标记）逐一合法
    for (const m of ['read-only', 'acceptEdits', 'full-access', 'plan']) {
      const r = await postMode(m);
      assert.equal(r.status, 200, `mode=${m} 新值应 200`);
      assert.deepEqual(await r.json(), { ok: true, mode: m }, `mode=${m} 回显请求值`);
    }
    // 旧档名退役：fail-fast 400（manual→acceptEdits、dontAsk→full-access 已改名，不再静默收留）
    for (const legacy of ['manual', 'dontAsk']) {
      const r = await postMode(legacy);
      assert.equal(r.status, 400, `mode=${legacy} 旧值应 400`);
      assert.deepEqual(await r.json(), { error: 'invalid mode' }, `mode=${legacy} 恒定文案`);
    }
  });
});

test('⓿ snapshot 分页(2026-10-26 三期):缺省尾窗 200+full 恒剥;tail/before 显式页;互斥/非法 400;观测按需端点', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    // 种 ≥3 条转录(每条 user 轮 1 条;3 轮 3 user 条+assistant 条)
    for (const goal of ['g1', 'g2', 'g3']) {
      await ctx.post(goal, ctx.sid);
      await waitFor(() => ctx.daemon.get(ctx.sid)!.status() === 'idle', 10000);
    }
    const get = async (q: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      const r = await fetch(`${ctx.http}/session/${ctx.sid}/snapshot${q}`, { headers: { authorization: 'Bearer test-token' } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    // 缺省:尾窗 200(3 轮全在),total/oldestSeq/hasMore 齐,full 恒剥
    const def = await get('');
    const defMsgs = def.body.messages as Array<{ seq: number; result?: { full?: string }; md: string }>;
    assert.ok(defMsgs.length >= 6, `前置:3 轮转录 ≥6 条,实际 ${defMsgs.length}`);
    assert.equal(def.body.total, defMsgs.length);
    assert.equal(def.body.hasMore, false, '3 轮 < 200:头部已到');
    assert.ok(defMsgs.every((m) => m.result?.full === undefined), 'full 恒剥');
    // 显式 tail=2:最新 2 条
    const t2 = await get('?tail=2');
    assert.equal((t2.body.messages as unknown[]).length, 2);
    assert.equal(t2.body.hasMore, true);
    // before 游标
    const oldest = (def.body.oldestSeq as number);
    const page = await get(`?before=${oldest}&limit=2`);
    assert.equal(page.status, 200);
    // 互斥 400
    const bad = await get('?tail=2&before=3');
    assert.equal(bad.status, 400);
    // 非法 400
    const bad2 = await get('?tail=abc');
    assert.equal(bad2.status, 400);
    // 观测按需端点:取任一 tool 条 seq(3 轮 scripted 回执无 tool——用 user 条缺观测验 404/空面)
    const firstUserSeq = (def.body.messages as Array<{ seq: number; kind: string }>)[0]!.seq;
    const obs = await fetch(`${ctx.http}/session/${ctx.sid}/entry/${firstUserSeq}/observation`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(obs.status, 200, '在列 seq 200(无观测字段为 undefined 值)');
    const obs404 = await fetch(`${ctx.http}/session/${ctx.sid}/entry/999999/observation`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(obs404.status, 404, '越界 seq 404');
  });
});

// ---- sunx 会话装配（2026-11-15 sunx P1 Task 4）：kind 生命周期 + charter 编辑 + 换铸存活 ----

/** sunx 合同测试装配样板：kind/name/charter 三参建会话（root 显式传——/sessions 行断言需已知根） */
async function newSunxSession(http: string, opts: { root: string; name?: string; charter?: string }): Promise<string> {
  const r = await fetch(`${http}/session/new`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ root: opts.root, kind: 'sunx', ...(opts.name !== undefined ? { name: opts.name } : {}), ...(opts.charter !== undefined ? { charter: opts.charter } : {}) }),
  });
  assert.equal(r.status, 200, 'session/new kind=sunx 应 200');
  return ((await r.json()) as { sessionId: string }).sessionId;
}

test('⑧ sunx 出生：meta 落 kind/title(name)/charterRev=1；/sessions 行透出 kind；standard 不落任何新键', async () => {
  const model = new ScriptedAdapter(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']);
  await withDaemon(model, async (ctx) => {
    const sunxRoot = tmpdir('sunshinex-serve-sunx-root-');
    try {
      const sid = await newSunxSession(ctx.http, { root: sunxRoot, name: '编排者甲', charter: 'CHARTER-BIRTH-1' });
      // 惰性建档（出生写语义）：首实质事件（scripted 一轮）触发 mint——出生 meta 跟 birth 链路落档
      await ctx.post('跑一轮', sid);
      await waitFor(() => ctx.daemon.get(sid)!.status() === 'idle', 10000);
      const jid = ctx.daemon.get(sid)!.attachedJournalId;
      assert.ok(jid !== undefined, 'sunx 会话已铸档');
      const meta = readSessionMeta(resolveDataDir(sunxRoot), jid!);
      assert.equal(meta.kind, 'sunx', '出生 meta 落 kind');
      assert.equal(meta.title, '编排者甲', 'name 只写 meta.title（G14.16 既有显示链）');
      assert.equal(meta.charterRev, 1, '出生品性即初版 charterRev=1');
      // 品性层：charter 经装配透传进 ContextManager 会话冻结层
      assert.equal(ctx.daemon.get(sid)!.runtime.harness.context.snapshotExport().sig.charter, 'CHARTER-BIRTH-1', 'charter 入冻结层');
      // /sessions 行透出 kind（meta 读面）
      const rows = (await (await fetch(`${ctx.http}/sessions?root=${encodeURIComponent(sunxRoot)}`, { headers: { authorization: 'Bearer test-token' } })).json()) as Array<{ id: string; kind?: string; title?: string }>;
      const row = rows.find((r) => r.id === jid);
      assert.ok(row !== undefined, '/sessions 列出 sunx 会话');
      assert.equal(row!.kind, 'sunx', '行透出 kind');
      assert.equal(row!.title, '编排者甲', '行透出 title');

      // 对照组：standard 会话（kind 缺席）——不落任何新键（零变化不变式；同 root 建——读面同 dataDir
      // 才是真对照，跨根读缺档会把断言变空转通过）
      const stdSid = await ctx.newSession(sunxRoot);
      await ctx.post('标准一轮', stdSid);
      await waitFor(() => ctx.daemon.get(stdSid)!.status() === 'idle', 10000);
      const stdJid = ctx.daemon.get(stdSid)!.attachedJournalId;
      assert.ok(stdJid !== undefined);
      const stdMeta = readSessionMeta(resolveDataDir(sunxRoot), stdJid!);
      assert.equal(stdMeta.kind, undefined, 'standard 不落 kind 键');
      assert.equal(stdMeta.charterRev, undefined, 'standard 不落 charterRev 键');
    } finally {
      fs.rmSync(sunxRoot, { recursive: true, force: true });
    }
  });
});

test('⑨ charter 编辑：尾追替代行入链+charterRev 递增；空白 400；非 sunx 409；运行中可调', async () => {
  // 挂起适配器：编辑端点零模型调用（appendChain 纯链行）,挂起形态专验「运行中可调」
  await withDaemon(new HangingAdapter(), async (ctx) => {
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
    const sunxRoot = tmpdir('sunshinex-serve-charter-root-');
    try {
      const sid = await newSunxSession(ctx.http, { root: sunxRoot, charter: 'BIRTH CHARTER' });
      // 首次编辑（未跑轮=未铸档）：编辑端点先落 birth（charterRev:1）再算序次——首次编辑即 v2
      const r1 = await fetch(`${ctx.http}/session/${sid}/charter`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'FIRST EDIT CHARTER' }) });
      assert.equal(r1.status, 200);
      assert.deepEqual(await r1.json(), { ok: true, charterRev: 2 }, '首次编辑=birth v1 之后的 v2');
      const jid = ctx.daemon.get(sid)!.attachedJournalId;
      assert.ok(jid !== undefined, '编辑触发惰性建档（append 前置 mint）');
      // 链行（模型面）含替代前缀行+全文（journal chain 行）
      const chain = parseJournalFile(path.join(sessionsDir(resolveDataDir(sunxRoot)), `${jid!}.jsonl`)).events.find((e) => e.t === 'chain') as { t: 'chain'; steps: Array<{ action: string; observation: string }> } | undefined;
      assert.ok(chain !== undefined, 'chain 行已落档');
      const obs = chain!.steps.map((s) => s.observation).join('\n');
      assert.ok(obs.includes('[charter v2] supersedes the earlier charter; from now on follow the charter below.\n\nFIRST EDIT CHARTER'), '替代行前缀+空行+全文逐字在链');
      // 第二次编辑：旧值+1
      const r2 = await fetch(`${ctx.http}/session/${sid}/charter`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'SECOND EDIT CHARTER' }) });
      assert.equal(r2.status, 200);
      assert.deepEqual(await r2.json(), { ok: true, charterRev: 3 }, '旧值+1 递增');
      assert.equal(readSessionMeta(resolveDataDir(sunxRoot), jid!).charterRev, 3, 'meta.charterRev 落盘');

      // 空白 text → 400
      for (const text of ['', '   ']) {
        const bad = await fetch(`${ctx.http}/session/${sid}/charter`, { method: 'POST', headers: H, body: JSON.stringify({ text }) });
        assert.equal(bad.status, 400, `text=${JSON.stringify(text)} 空白 → 400`);
      }

      // 非 sunx 会话 → 409 not a sunx session
      const stdSid = await ctx.newSession();
      const r409 = await fetch(`${ctx.http}/session/${stdSid}/charter`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'x' }) });
      assert.equal(r409.status, 409, 'standard 会话拒绝');
      assert.equal((await r409.json()).error, 'not a sunx session');

      // 运行中可调（append-only 安全）：挂起 run 占锁中编辑仍 200
      const runSid = await newSunxSession(ctx.http, { root: sunxRoot });
      await fetch(`${ctx.http}/session/${runSid}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ goal: '长任务' }) });
      await waitFor(() => ctx.daemon.get(runSid)!.status() === 'running', 3000);
      const rRun = await fetch(`${ctx.http}/session/${runSid}/charter`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'RUNTIME EDIT' }) });
      assert.equal(rRun.status, 200, '运行中 charter 编辑受理');
      assert.deepEqual(await rRun.json(), { ok: true, charterRev: 2 });
      const stop = await fetch(`${ctx.http}/session/${runSid}/interrupt`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
      assert.equal(stop.status, 200);
      await waitFor(() => ctx.daemon.get(runSid)!.status() === 'idle', 3000);
    } finally {
      fs.rmSync(sunxRoot, { recursive: true, force: true });
    }
  });
});

test('⑨b charter 读面（sunx P2 Task 7）：GET /session/:id/charter 返回当前全文+rev——出生（未铸档）读 v1 零建档；编辑后读面跟新替代行全文（非出生冻结层旧文）；非 sunx 409；未知 404', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const H = { authorization: 'Bearer test-token' };
    const sunxRoot = tmpdir('sunshinex-serve-charter-read-root-');
    try {
      const sid = await newSunxSession(ctx.http, { root: sunxRoot, charter: 'BIRTH READ-1' });
      // 出生未铸档：GET 读 v1（出生品性即初版），且零建档（读面无写副作用——幽灵会话不变式不破）
      const g1 = await fetch(`${ctx.http}/session/${sid}/charter`, { headers: H });
      assert.equal(g1.status, 200);
      assert.deepEqual(await g1.json(), { text: 'BIRTH READ-1', charterRev: 1 }, '出生品性读 v1');
      assert.equal(ctx.daemon.get(sid)!.attachedJournalId, undefined, 'GET 零建档');
      // 编辑后读面跟新：替代行语义=当前全文，读面必须反映编辑后文本（charterLayer 构造即冻结，
      // 跟踪面在会话运行时——读出生旧文即本测试红）
      const e1 = await fetch(`${ctx.http}/session/${sid}/charter`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'EDITED READ-2' }) });
      assert.equal(e1.status, 200);
      const g2 = await fetch(`${ctx.http}/session/${sid}/charter`, { headers: H });
      assert.equal(g2.status, 200);
      assert.deepEqual(await g2.json(), { text: 'EDITED READ-2', charterRev: 2 }, '读面跟新（非出生旧文）');
      // 合同面与 POST 同口径：非 sunx 409 / 未知会话 404
      const stdSid = await ctx.newSession();
      const g409 = await fetch(`${ctx.http}/session/${stdSid}/charter`, { headers: H });
      assert.equal(g409.status, 409, 'standard 会话 409');
      assert.equal(((await g409.json()) as { error: string }).error, 'not a sunx session');
      const g404 = await fetch(`${ctx.http}/session/20261115T000000Z-none/charter`, { headers: H });
      assert.equal(g404.status, 404, '未知会话 404');
      // 无 token 401（auth 门同族）
      const g401 = await fetch(`${ctx.http}/session/${sid}/charter`);
      assert.equal(g401.status, 401);
    } finally {
      fs.rmSync(sunxRoot, { recursive: true, force: true });
    }
  });
});

test('⑨c charter 读面跨窗一致（fix round 1）：编辑→重启→重开 GET 返回编辑文（rev 一致）；reset→GET 返回出生文；无出生 charter 的未跑会话编辑后同窗覆盖', async () => {
  const model = new ScriptedAdapter(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']);
  await withDaemon(model, async (ctx) => {
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
    const HGET = { authorization: 'Bearer test-token' };
    const sunxRoot = tmpdir('sunshinex-serve-charter-drift-root-');
    try {
      // 窗 1（重启重开流）：编辑后重启重开——reCast 品性源=meta.charterText（编辑文跨重启），
      // 非快照 sig.charter（出生冻结层恒不随编辑动——修复前读面回退出生文而模型面链回放含替代
      // 行跟编辑文=漂移）
      const sid = await newSunxSession(ctx.http, { root: sunxRoot, charter: 'BIRTH DRIFT' });
      const e1 = await fetch(`${ctx.http}/session/${sid}/charter`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'EDITED DRIFT' }) });
      assert.equal(e1.status, 200);
      assert.deepEqual(await e1.json(), { ok: true, charterRev: 2 });
      const jid = ctx.daemon.get(sid)!.attachedJournalId;
      assert.ok(jid !== undefined);
      await withRestartedDaemon(model, async (http2) => {
        const shell = await fetch(`${http2}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: sunxRoot }) });
        assert.equal(shell.status, 200);
        const shellId = ((await shell.json()) as { sessionId: string }).sessionId;
        const ar = await fetch(`${http2}/session/${shellId}/attach`, { method: 'POST', headers: H, body: JSON.stringify({ journalId: jid }) });
        assert.equal(ar.status, 200);
        const g = await fetch(`${http2}/session/${shellId}/charter`, { headers: HGET });
        assert.equal(g.status, 200);
        assert.deepEqual(await g.json(), { text: 'EDITED DRIFT', charterRev: 2 }, '重开读面=编辑文+rev 一致（meta.charterText 源，非快照出生文）');
      });

      // 窗 2（软 reset 流）：reset 换新运行时=链清空+新上下文挂出生品性层——读面归出生文
      // （修复前 charterCurrent 保留 reset 前编辑文=GET 返回模型已不跟的文）
      const sid2 = await newSunxSession(ctx.http, { root: sunxRoot, charter: 'BIRTH RESET' });
      const e2 = await fetch(`${ctx.http}/session/${sid2}/charter`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'EDITED RESET' }) });
      assert.deepEqual(await e2.json(), { ok: true, charterRev: 2 });
      const rs = await fetch(`${ctx.http}/session/${sid2}/reset`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
      assert.equal(rs.status, 200);
      const g2 = await fetch(`${ctx.http}/session/${sid2}/charter`, { headers: HGET });
      assert.deepEqual(await g2.json(), { text: 'BIRTH RESET', charterRev: 2 }, 'reset 后读面=出生文（rev 计数器累计语义不变）');

      // 边界（Minor 4 同源）：无出生 charter 的未跑 sunx——编辑落 meta.charterText 后重开读面=
      // 编辑文（修复前 reCast 源=快照 sig.charter=null → GET text:null 遮蔽编辑）
      const sid3 = await newSunxSession(ctx.http, { root: sunxRoot });
      const e3 = await fetch(`${ctx.http}/session/${sid3}/charter`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'EDITED NO-BIRTH' }) });
      assert.deepEqual(await e3.json(), { ok: true, charterRev: 2 });
      const jid3 = ctx.daemon.get(sid3)!.attachedJournalId;
      assert.ok(jid3 !== undefined);
      await withRestartedDaemon(model, async (http2) => {
        const shell = await fetch(`${http2}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: sunxRoot }) });
        assert.equal(shell.status, 200);
        const shellId = ((await shell.json()) as { sessionId: string }).sessionId;
        const ar = await fetch(`${http2}/session/${shellId}/attach`, { method: 'POST', headers: H, body: JSON.stringify({ journalId: jid3 }) });
        assert.equal(ar.status, 200);
        const g = await fetch(`${http2}/session/${shellId}/charter`, { headers: HGET });
        assert.deepEqual(await g.json(), { text: 'EDITED NO-BIRTH', charterRev: 2 }, '无出生 charter：编辑文经 charterText 跨重启（快照 sig.charter=null 不遮蔽）');
      });
    } finally {
      fs.rmSync(sunxRoot, { recursive: true, force: true });
    }
  });
});

test('⑩ 换铸存活：reset 换新运行时后 sunx face 仍白名单、稳定段仍含章程、品性层仍带 charter；setMode 直切亦存活', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const sunxRoot = tmpdir('sunshinex-serve-reset-root-');
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
    try {
      const sid = await newSunxSession(ctx.http, { root: sunxRoot, charter: 'CHARTER-SURVIVE' });
      const s = ctx.daemon.get(sid)!;
      // 出生装配面基线（Tasks 1-3 就绪的 harness 面，凭 kind 透传激活）
      assert.equal(s.sessionKind, 'sunx', 'sessionKind 外窥');
      assert.ok(s.runtime.harness.tools.has('dispatch_task'), '出生 face 含 dispatch_task');
      assert.ok(s.runtime.harness.stableSegment().includes(SUNX_IDENTITY_LINE), '出生稳定段含 sunx 身份行');
      assert.ok(s.runtime.harness.stableSegment().includes(SUNX_BRIEF_LINE), '出生稳定段含编排章程行组');
      assert.equal(s.runtime.harness.context.snapshotExport().sig.charter, 'CHARTER-SURVIVE', '出生品性层在场');
      // setMode 直切（轻量不换铸）：面原样存活
      const mr = await fetch(`${ctx.http}/session/${sid}/mode`, { method: 'POST', headers: H, body: JSON.stringify({ mode: 'acceptEdits' }) });
      assert.equal(mr.status, 200);
      assert.ok(s.runtime.harness.stableSegment().includes(SUNX_IDENTITY_LINE), 'setMode 后稳定段仍含身份行');
      // reset 换铸（真换新运行时）：assemble() 单点透传 kind/charter——面与品性层全存活
      const rr = await fetch(`${ctx.http}/session/${sid}/reset`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
      assert.equal(rr.status, 200);
      assert.ok(s.runtime.harness.tools.has('dispatch_task'), 'reset 换铸后 face 仍含 dispatch_task');
      assert.ok(s.runtime.harness.stableSegment().includes(SUNX_IDENTITY_LINE), 'reset 换铸后稳定段仍含身份行');
      assert.ok(s.runtime.harness.stableSegment().includes(SUNX_BRIEF_LINE), 'reset 换铸后稳定段仍含章程行组');
      assert.equal(s.runtime.harness.context.snapshotExport().sig.charter, 'CHARTER-SURVIVE', 'reset 换铸后品性层仍带 charter');
    } finally {
      fs.rmSync(sunxRoot, { recursive: true, force: true });
    }
  });
});

// ---- sunx attach 重铸（2026-11-15 final review fix wave，spec §13「GUI 关掉重开恢复」根修）----
// GUI 重开链 = 壳 newSession（无 kind=standard 出生态）→ attach 附 journal：旁车 meta.kind='sunx'
// 而在座壳非 sunx 时壳须重铸为 sunx 形态（品性原文取 replay.snapshot.sig.charter）。

/** 第二台 daemon（重启模拟样板）：同进程新 GuiDaemon 实例——sessions 注册表空、数据目录同一
 *  （SUNSHINEX_DATA_DIR 已由 withDaemon 钉死），staticRoot 指向不存在目录保静态面不挂载 */
async function withRestartedDaemon(model: ModelAdapter, fn: (http2: string, daemon2: GuiDaemon, close: () => Promise<void>) => Promise<void>): Promise<void> {
  const daemon2 = new GuiDaemon({ model, staticRoot: path.join(tmpdir('sunshinex-serve-recast-'), 'dist-gui-absent') });
  const s2 = await daemon2.start({ port: 0, token: 'test-token' });
  try {
    await fn(`http://127.0.0.1:${s2.port}`, daemon2, () => s2.close());
  } finally {
    try {
      await s2.close();
    } catch {
      // 重复 close 幂等
    }
  }
}

test('⑪ attach 重铸：daemon 重启后 GUI 重开链（壳 newSession 无 kind→attach）恢复 sunx 形态——kind/face 白名单/身份行/品性层/charter 端点/侧栏 kind 全存活', async () => {
  const base = new ScriptedAdapter(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']);
  const probe = { toolNames: [] as string[] };
  await withDaemon(wireProbe(base, probe), async (ctx) => {
    // 第一拍：sunx 会话跑实质事件（铸档+ctx-snap 落 sig.charter）
    const sunxRoot = tmpdir('sunshinex-serve-recast-root-');
    try {
      const sid = await newSunxSession(ctx.http, { root: sunxRoot, name: '编排者乙', charter: 'RECAST-CHARTER-1' });
      await ctx.post('实质一轮', sid);
      await waitFor(() => ctx.daemon.get(sid)!.status() === 'idle', 10000);
      const jid = ctx.daemon.get(sid)!.attachedJournalId;
      assert.ok(jid !== undefined, 'sunx 会话已铸档');
      const namesAfterFirstTurn = probe.toolNames.length;
      assert.ok(probe.toolNames.slice(0, namesAfterFirstTurn).includes('dispatch_task'), '出生 sunx wire face 基线含 dispatch_task（探针自检）');

      // 第二拍：模拟重启——新 daemon 实例（空注册表）+ GUI 重开链（壳 newSession 无 kind → attach）
      await withRestartedDaemon(wireProbe(base, probe), async (http2, daemon2) => {
        const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
        const shell = await fetch(`${http2}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: sunxRoot }) });
        assert.equal(shell.status, 200, '重开壳 newSession（无 kind）200');
        const shellId = ((await shell.json()) as { sessionId: string }).sessionId;
        assert.equal(daemon2.get(shellId)!.sessionKind, undefined, '重开壳出生态=standard（修复前病灶）');
        const ar = await fetch(`${http2}/session/${shellId}/attach`, { method: 'POST', headers: H, body: JSON.stringify({ journalId: jid }) });
        assert.equal(ar.status, 200, 'attach 受理');
        const adopted = ((await ar.json()) as { sessionId: string }).sessionId;
        assert.equal(adopted, shellId, '无在座同档会话——壳自身收编该档（非收编复用路径）');
        const s = daemon2.get(shellId)!;

        // 形态面：kind 重铸 + 装配注册分支 + 身份行
        assert.equal(s.sessionKind, 'sunx', 'attach 重铸后 sessionKind=sunx');
        assert.ok(s.runtime.harness.tools.has('dispatch_task'), 'face 装配含 dispatch_task（standard 注册表必无）');
        assert.ok(s.runtime.harness.stableSegment().includes(SUNX_IDENTITY_LINE), '稳定段含 Sunx 身份行');
        // wire face（loop 消费的 effective face，真模型面）：探针轮含 dispatch_task 不含 exec
        const submit = await fetch(`${http2}/session/${shellId}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ goal: '重铸后探针轮' }) });
        assert.equal(submit.status, 202);
        await waitFor(() => daemon2.get(shellId)!.status() === 'idle', 10000);
        const recastNames = probe.toolNames.slice(namesAfterFirstTurn);
        assert.ok(recastNames.length > 0, '探针轮已发');
        assert.ok(recastNames.includes('dispatch_task'), '重铸后 wire face 含 dispatch_task');
        assert.ok(!recastNames.includes('exec'), '重铸后 wire face 不含 exec（重获 exec=修复前病灶）');
        // 上下文回种落在重铸后的运行时上（换铸先于 restoreSession 的序铁律）：转录非空
        assert.ok(s.transcriptCount() > 0, 'journal 链回放落在重铸后运行时（先播种再换铸=全丢的反例不出现）');
        // 品性层：snapshotExport sig.charter=原文
        assert.equal(s.runtime.harness.context.snapshotExport().sig.charter, 'RECAST-CHARTER-1', '品性层在（sig.charter=原文）');
        // charter 编辑端点可用（修复前 409 not a sunx session）
        const cr = await fetch(`${http2}/session/${shellId}/charter`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'POST-RECAST CHARTER' }) });
        assert.equal(cr.status, 200, 'charter 端点受理（非 409）');
        assert.deepEqual(await cr.json(), { ok: true, charterRev: 2 }, 'charterRev 递增');
        // 侧栏行 kind 仍 sunx（meta.kind 旁车读面）
        const rows = (await (await fetch(`${http2}/sessions?root=${encodeURIComponent(sunxRoot)}`, { headers: { authorization: 'Bearer test-token' } })).json()) as Array<{ id: string; kind?: string; title?: string }>;
        const row = rows.find((r) => r.id === jid);
        assert.ok(row !== undefined, '/sessions 列出该会话');
        assert.equal(row!.kind, 'sunx', '侧栏行 kind 仍 sunx');
        assert.equal(row!.title, '编排者乙', '侧栏行 title 仍自定义名');
      });
    } finally {
      fs.rmSync(sunxRoot, { recursive: true, force: true });
    }
  });
});

test('⑫ attach 重铸回归锚：standard 会话重启重开 attach 后行为与今日逐字节同（standard 形态零变化）', async () => {
  const model = new ScriptedAdapter(['{"done":true,"reply":"ok"}']);
  await withDaemon(model, async (ctx) => {
    const stdRoot = tmpdir('sunshinex-serve-recast-std-root-');
    try {
      const sid = await ctx.newSession(stdRoot);
      await ctx.post('标准一轮', sid);
      await waitFor(() => ctx.daemon.get(sid)!.status() === 'idle', 10000);
      const jid = ctx.daemon.get(sid)!.attachedJournalId;
      assert.ok(jid !== undefined);
      await withRestartedDaemon(model, async (http2, daemon2) => {
        const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
        const shell = await fetch(`${http2}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: stdRoot }) });
        const shellId = ((await shell.json()) as { sessionId: string }).sessionId;
        const ar = await fetch(`${http2}/session/${shellId}/attach`, { method: 'POST', headers: H, body: JSON.stringify({ journalId: jid }) });
        assert.equal(ar.status, 200, 'attach 受理');
        const s = daemon2.get(shellId)!;
        // standard 不重铸：kind 缺席、face 既有（exec 在/sunx 派发词不在）、稳定段无身份行、无品性层
        assert.equal(s.sessionKind, undefined, 'standard 会话 attach 后仍 standard');
        assert.ok(s.runtime.harness.tools.has('exec'), 'standard face 仍含 exec');
        assert.ok(!s.runtime.harness.tools.has('dispatch_task'), 'standard face 不含 dispatch_task');
        assert.ok(!s.runtime.harness.stableSegment().includes(SUNX_IDENTITY_LINE), '稳定段无 Sunx 身份行');
        assert.equal(s.runtime.harness.context.snapshotExport().sig.charter ?? null, null, '无品性层');
        assert.ok(s.transcriptCount() > 0, 'journal 链回放照常');
        // charter 端点 409 照旧
        const cr = await fetch(`${http2}/session/${shellId}/charter`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'x' }) });
        assert.equal(cr.status, 409, 'standard charter 端点仍 409');
      });
    } finally {
      fs.rmSync(stdRoot, { recursive: true, force: true });
    }
  });
});

test('⑬ attach 重铸幂等：已 attach 的 sunx 会话二次 attach 走收编复用，不二次换铸（运行时实例恒一）', async () => {
  const model = new ScriptedAdapter(['{"done":true,"reply":"ok"}']);
  await withDaemon(model, async (ctx) => {
    const sunxRoot = tmpdir('sunshinex-serve-recast-idem-root-');
    try {
      const sid = await newSunxSession(ctx.http, { root: sunxRoot, charter: 'IDEM-CHARTER' });
      await ctx.post('实质一轮', sid);
      await waitFor(() => ctx.daemon.get(sid)!.status() === 'idle', 10000);
      const jid = ctx.daemon.get(sid)!.attachedJournalId;
      assert.ok(jid !== undefined);
      await withRestartedDaemon(model, async (http2, daemon2) => {
        const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
        // 第一拍：重开链 attach——壳重铸为 sunx
        const shell1 = await fetch(`${http2}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: sunxRoot }) });
        const shell1Id = ((await shell1.json()) as { sessionId: string }).sessionId;
        const ar1 = await fetch(`${http2}/session/${shell1Id}/attach`, { method: 'POST', headers: H, body: JSON.stringify({ journalId: jid }) });
        assert.equal(ar1.status, 200);
        const seated = daemon2.get(shell1Id)!;
        assert.equal(seated.sessionKind, 'sunx', '首次 attach 重铸成立');
        const rtBefore = seated.runtime;
        const countBefore = seated.transcriptCount();
        // 第二拍：同档再开一壳 attach——收编复用路径，在座 sunx 运行时不得二次换铸
        const shell2 = await fetch(`${http2}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: sunxRoot }) });
        const shell2Id = ((await shell2.json()) as { sessionId: string }).sessionId;
        const ar2 = await fetch(`${http2}/session/${shell2Id}/attach`, { method: 'POST', headers: H, body: JSON.stringify({ journalId: jid }) });
        assert.equal(ar2.status, 200);
        const adoptedId = ((await ar2.json()) as { sessionId: string }).sessionId;
        assert.equal(adoptedId, shell1Id, '收编复用：返回在座会话 id（壳弃）');
        const after = daemon2.get(adoptedId)!;
        assert.equal(after.sessionKind, 'sunx', '在座形态不褪');
        assert.equal(after.runtime, rtBefore, '运行时实例恒一（二次换铸会整体换新——反例不出现）');
        assert.equal(after.transcriptCount(), countBefore, '转录投影不丢（换铸清态反例不出现）');
        assert.ok(daemon2.get(shell2Id) === undefined, '壳随收编弃座');
      });
    } finally {
      fs.rmSync(sunxRoot, { recursive: true, force: true });
    }
  });
});

test('⑭ 置顶档 kind 透传（sunx P2 Task 7）：PUT /app/pins 收 kind:"sunx" 原样落档回读（置顶行徽标跨重启存活）；非 sunx kind 值弃置；无 kind 行零新增键', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
    const put = await fetch(`${ctx.http}/app/pins`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({
        pins: [
          { id: 'j1', root: 'D:/w/p1', title: '钉甲', updatedAt: 5, kind: 'sunx' },
          { id: 'j2', root: 'D:/w/p2', title: '钉乙', updatedAt: 6, kind: 'standard' },
          { id: 'j3', root: 'D:/w/p3', updatedAt: 7 },
        ],
      }),
    });
    assert.equal(put.status, 200);
    const got = await fetch(`${ctx.http}/app/pins`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(got.status, 200);
    const { pins } = (await got.json()) as { pins: Array<{ id: string; kind?: string }> };
    assert.equal(pins.find((p) => p.id === 'j1')?.kind, 'sunx', 'sunx kind 原样落档（GET 回读=跨重启存活）');
    assert.equal(pins.find((p) => p.id === 'j2')?.kind, undefined, '非 sunx kind 值弃置（闭合枚举）');
    assert.equal(pins.find((p) => p.id === 'j3')?.kind, undefined, '无 kind 行零新增键（老钉字节不变）');
  });
});
