import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter, UsageHooks } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';

/** G4 挂起面测试（daemon 级）：manual 会话的审批/问询闭环——WS approval/ask 帧 → HTTP 回执 → run 继续；
 *  interrupt deny 回填（表清 + 写被拒观察）；重连重发未决挂起（pid 同）；404 双路（未知/重复/kind 不符）；
 *  reset 通知帧。dontAsk 零行为变化由既有 daemon.test/ws.test/contract 套件覆盖（计划裁定：不重测）。
 *
 *  链路现场（实现核）：write 工具（canonical 'Write'）在 manual 下走 chain.evaluateAsync 的链侧 ask
 *  （chain.ts:86-98——写越信任域 resolveSafe 回 ask → guard.resolveAsk → asker），故挂起触发的 write
 *  目标必须在会话 root 之外（root 内写属信任域直放，chain.ts:216）——用例以会话外 out 目录承接真文件。
 *  ask_question 经 onAskUser 接缝（guard 三模式放行，builtin ask seam 挂起）。 */

/** WS 下行帧宽松收集形态：event 帧带 seq+e；approval/ask 帧带 pid+req；reset 帧只挂 sessionId */
interface AnyFrame {
  kind: string;
  sessionId: string;
  seq?: number;
  pid?: string;
  req?: Record<string, unknown>;
  e?: { type?: string; text?: string };
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
  /** 会话 root（daemon 预选同一 tmp） */
  root: string;
  /** 手工 manual 会话（daemon 级 API：/session/new 尚无 mode 面——计划裁定 2 的 CLI 预选同源形态） */
  manual: () => string;
  /** 按会话维提交：POST /session/:id/submit（202 断言内建） */
  post: (goal: string, sid: string) => Promise<void>;
  /** 鉴权头（JSON 面） */
  H: Record<string, string>;
  /** 会话外 tmp（写工具挂起目标：越会话 root 信任域） */
  out: string;
}

/** 装配样板（环境隔离同 daemon.ws.test.ts）：SUNSHINEX_DATA_DIR 钉 tmp，token 固定 test-token，port 0；
 *  manual 会话经 daemon.createSession(root, {mode:'manual'}) 直构（HTTP 面未开 mode 时的 daemon 级契约）。
 *  model 经工厂注入——卡序里的写目标路径需会话外 out 目录，先建目录再装适配器 */
async function withPendingDaemon(makeModel: (out: string) => ModelAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-serve-pending-');
  const out = tmpdir('sunshinex-serve-pending-out-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model: makeModel(out) });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const http = `http://127.0.0.1:${s.port}`;
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;
    const manual = (): string => {
      const r = daemon.createSession(tmp, { mode: 'manual' });
      if (!r.ok) throw new Error(`createSession failed: ${r.error.message}`);
      return r.value.sessionId;
    };
    const post = async (goal: string, sid: string): Promise<void> => {
      const r = await fetch(`${http}/session/${sid}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ goal }) });
      assert.equal(r.status, 202, 'submit 应 202');
    };
    try {
      await fn({ daemon, http, ws: `ws://127.0.0.1:${s.port}`, root: tmp, manual, post, H, out });
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

/** 开连接并同步挂帧收集器（同 daemon.ws.test.ts：message 监听在构造后立刻挂——补发帧可能与握手响应
 *  同一 TCP 段到达） */
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

/** 会话 idle 轮询：snapshot.status 回 idle */
async function waitIdle(http: string, H: Record<string, string>, sid: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await fetch(`${http}/session/${sid}/snapshot`, { headers: H });
    if (((await r.json()) as { status: string }).status === 'idle') return;
    if (Date.now() > deadline) throw new Error('waitIdle 超时');
    await new Promise((res) => setTimeout(res, 20));
  }
}

/** 越信任域的 write 卡（挂起链触发形态）：目标 = 会话外 out 目录真文件路径 */
function writeCard(out: string, name: string, content: string): string {
  return JSON.stringify({ tool: 'write', input: { path: path.join(out, name), content } });
}

/** ask_question 卡（builtin schema 现场核：question/options/multiple/allowCustom 四必填，multiple/allowCustom 可 null） */
function askCard(question: string, labels: string[]): string {
  return JSON.stringify({
    tool: 'ask_question',
    input: { question, options: labels.map((l) => ({ label: l, description: null })), multiple: null, allowCustom: null },
  });
}

test('① 审批闭环：manual write 挂起 → WS approval 帧（req 字段）→ POST /approval/:pid allow → 写落盘 + done + notice', async () => {
  await withPendingDaemon(
    (out) => new ScriptedAdapter([writeCard(out, 'pending-approval.txt', 'hello-approval'), '{"done":true,"reply":"written"}']),
    async (ctx) => {
      const sid = ctx.manual();
      const { ws, frames } = await openCollecting(ctx.ws);
      try {
        await ctx.post('写个文件', sid);
        // WS 收 approval 帧：kind/sessionId 挂会话；req 纯数据直序列化（ApprovalRequest 字面）
        await waitFor(() => frames.some((f) => f.kind === 'approval'), 10_000);
        const f = frames.find((fr) => fr.kind === 'approval')!;
        assert.equal(f.sessionId, sid, 'approval 帧挂所属会话');
        assert.equal(f.req?.kind, 'write', 'req.kind=write（链侧 ask 形态）');
        assert.ok(typeof f.req?.id === 'string' && (f.req.id as string).length > 0, 'req.id 在场（guard ap-N）');
        assert.ok(String(f.req?.subject ?? '').includes('pending-approval.txt'), 'req.subject=写目标路径');
        assert.ok(typeof f.req?.reason === 'string', 'req.reason 在场');
        assert.ok(typeof f.pid === 'string' && f.pid.length > 0, '帧带 daemon 级 pid（回执寻址键）');
        // 回执：POST /approval/:pid {decision:'allow'}（ApprovalDecision 字面：allow|always|deny）→ 200
        const r = await fetch(`${ctx.http}/approval/${f.pid}`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ decision: 'allow' }) });
        assert.equal(r.status, 200, '回执应 200');
        assert.deepEqual(await r.json(), { ok: true });
        // run 继续：done 终态到场
        await waitFor(() => frames.some((fr) => fr.e?.type === 'done'), 10_000);
        // 工具真执行：越信任域写经 allow 落盘（tmp out 真文件）
        assert.equal(fs.readFileSync(path.join(ctx.out, 'pending-approval.txt'), 'utf8'), 'hello-approval', 'allow 后 write 落盘');
        // 回执落档：notice 事件帧经该会话 pump（转录可见面）
        await waitFor(
          () => frames.some((fr) => fr.kind === 'event' && fr.e?.type === 'notice' && fr.e?.text === `approval ${f.pid} resolved: allow`),
          3000,
        );
      } finally {
        ws.close();
      }
    },
  );
});

test('② ask 闭环：manual ask_question 挂起 → WS ask 帧（req 字段）→ POST /ask/:pid/reply selected → done + notice', async () => {
  await withPendingDaemon(
    () => new ScriptedAdapter([askCard('Pick one', ['x', 'y']), '{"done":true,"reply":"asked"}']),
    async (ctx) => {
      const sid = ctx.manual();
      const { ws, frames } = await openCollecting(ctx.ws);
      try {
        await ctx.post('问一下', sid);
        await waitFor(() => frames.some((f) => f.kind === 'ask'), 10_000);
        const f = frames.find((fr) => fr.kind === 'ask')!;
        assert.equal(f.sessionId, sid, 'ask 帧挂所属会话');
        assert.equal(f.req?.question, 'Pick one', 'req.question 直序列化');
        assert.ok(Array.isArray(f.req?.options) && (f.req?.options as unknown[]).length === 2, 'req.options 直序列化');
        assert.ok(typeof f.pid === 'string' && f.pid.length > 0, '帧带 daemon 级 pid（AskUserRequest 无 id 字段——pid 承载回执寻址）');
        // kind 不符 404：ask 挂起错打 approval 端点
        const wrong = await fetch(`${ctx.http}/approval/${f.pid}`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ decision: 'allow' }) });
        assert.equal(wrong.status, 404, 'ask 挂起打 /approval 应 404（kind 不符）');
        // 回执：AskUserAnswer 字面 selected（types.ts 现场核：selected|custom|dismissed 三态）
        const r = await fetch(`${ctx.http}/ask/${f.pid}/reply`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ answer: { type: 'selected', labels: ['x'] } }) });
        assert.equal(r.status, 200, 'ask 回执应 200');
        // run 继续 + notice 落档
        await waitFor(() => frames.some((fr) => fr.e?.type === 'done'), 10_000);
        await waitFor(
          () => frames.some((fr) => fr.kind === 'event' && fr.e?.type === 'notice' && fr.e?.text === `ask ${f.pid} answered`),
          3000,
        );
      } finally {
        ws.close();
      }
    },
  );
});

test('③ interrupt deny 回填：挂起中中止 → approval 以 deny 回填（写被拒未落盘）→ 表清（旧 pid 404）→ run 收束无僵尸', async () => {
  await withPendingDaemon(
    (out) => new ScriptedAdapter([writeCard(out, 'pending-interrupt.txt', 'nope'), '{"done":true,"reply":"never"}']),
    async (ctx) => {
      const sid = ctx.manual();
      const { ws, frames } = await openCollecting(ctx.ws);
      try {
        await ctx.post('写个文件然后被中止', sid);
        await waitFor(() => frames.some((f) => f.kind === 'approval'), 10_000);
        const f = frames.find((fr) => fr.kind === 'approval')!;
        // 挂起中 interrupt：既有 abort 逻辑后该会话未决以 deny 回填并清表
        const r = await fetch(`${ctx.http}/session/${sid}/interrupt`, { method: 'POST', headers: ctx.H });
        assert.equal(r.status, 200, 'interrupt 应 200');
        // 无僵尸：run 有界收束（idle 回位）
        await waitIdle(ctx.http, ctx.H, sid);
        // deny 观察行：写被拒——目标文件不落盘
        assert.equal(fs.existsSync(path.join(ctx.out, 'pending-interrupt.txt')), false, 'deny 回填下写被拒（无文件）');
        // 表清：被回填的 pid 再回执 → 404（已决语义同重复回执）
        const again = await fetch(`${ctx.http}/approval/${f.pid}`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ decision: 'allow' }) });
        assert.equal(again.status, 404, 'interrupt 回填后旧 pid 应 404');
      } finally {
        ws.close();
      }
    },
  );
});

test('④ 重连重发未决挂起：挂起中断连重连 → approval 帧再至（pid 同）→ 回执闭环照常', async () => {
  await withPendingDaemon(
    (out) => new ScriptedAdapter([writeCard(out, 'pending-resend.txt', 'resend'), '{"done":true,"reply":"ok"}']),
    async (ctx) => {
      const sid = ctx.manual();
      const a = await openCollecting(ctx.ws);
      let pidA: string | undefined;
      try {
        await ctx.post('写个文件', sid);
        await waitFor(() => a.frames.some((f) => f.kind === 'approval'), 10_000);
        pidA = a.frames.find((f) => f.kind === 'approval')!.pid;
      } finally {
        a.ws.terminate();
      }
      await waitFor(() => a.ws.readyState === WebSocket.CLOSED, 2000);
      // 重连：补发事件缓冲后重发全部未决挂起帧——同 pid 再至
      const b = await openCollecting(ctx.ws);
      try {
        await waitFor(() => b.frames.some((f) => f.kind === 'approval'), 5000);
        const f = b.frames.find((fr) => fr.kind === 'approval')!;
        assert.equal(f.pid, pidA, '重发的挂起帧 pid 同（幂等去重键）');
        assert.equal(f.sessionId, sid, '重发帧挂所属会话');
        // 重连后回执闭环照常：allow → done → 落盘
        const r = await fetch(`${ctx.http}/approval/${f.pid}`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ decision: 'allow' }) });
        assert.equal(r.status, 200);
        await waitFor(() => b.frames.some((fr) => fr.e?.type === 'done'), 10_000);
        assert.equal(fs.readFileSync(path.join(ctx.out, 'pending-resend.txt'), 'utf8'), 'resend');
      } finally {
        b.ws.close();
      }
    },
  );
});

test('⑤ 回执 404/400 面：未知 pid 双端点 404；重复回执 404；kind 不符 404；非法载荷 400', async () => {
  await withPendingDaemon(
    (out) =>
      new ScriptedAdapter([writeCard(out, 'pending-404.txt', 'x'), askCard('Q', ['a', 'b']), '{"done":true,"reply":"done"}']),
    async (ctx) => {
      const sid = ctx.manual();
      // 未知 pid：两端点均 404
      const u1 = await fetch(`${ctx.http}/approval/nope`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ decision: 'allow' }) });
      assert.equal(u1.status, 404, '未知 pid approval 回执 404');
      const u2 = await fetch(`${ctx.http}/ask/nope/reply`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ answer: { type: 'dismissed' } }) });
      assert.equal(u2.status, 404, '未知 pid ask 回执 404');
      // 非法载荷：decision 非字面 400 / answer 坏形态 400
      const b1 = await fetch(`${ctx.http}/approval/nope2`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ decision: 'maybe' }) });
      assert.equal(b1.status, 400, 'decision 非法字面 400');
      const b2 = await fetch(`${ctx.http}/ask/nope2/reply`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ answer: { type: 'bogus' } }) });
      assert.equal(b2.status, 400, 'answer 坏形态 400');

      // 真实挂起（write 卡）：回执 deny → 重复回执 404，deny 定论不被翻转
      const { ws, frames } = await openCollecting(ctx.ws);
      try {
        await ctx.post('写再问', sid);
        await waitFor(() => frames.some((f) => f.kind === 'approval'), 10_000);
        const ap = frames.find((f) => f.kind === 'approval')!;
        const r1 = await fetch(`${ctx.http}/approval/${ap.pid}`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ decision: 'deny' }) });
        assert.equal(r1.status, 200);
        const r2 = await fetch(`${ctx.http}/approval/${ap.pid}`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ decision: 'allow' }) });
        assert.equal(r2.status, 404, '重复回执 404（resolve 后即删）');
        assert.equal(fs.existsSync(path.join(ctx.out, 'pending-404.txt')), false, 'deny 定论不被后续重复回执翻转');

        // ask 卡挂起（write 被拒后 run 续进第二卡）：kind 不符 + 正常 dismissed 收尾
        await waitFor(() => frames.some((f) => f.kind === 'ask'), 10_000);
        const ak = frames.find((f) => f.kind === 'ask')!;
        const w1 = await fetch(`${ctx.http}/approval/${ak.pid}`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ decision: 'allow' }) });
        assert.equal(w1.status, 404, 'ask pid 打 /approval 404');
        const r3 = await fetch(`${ctx.http}/ask/${ak.pid}/reply`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ answer: { type: 'dismissed' } }) });
        assert.equal(r3.status, 200);
        await waitFor(() => frames.some((f) => f.e?.type === 'done'), 10_000);
      } finally {
        ws.close();
      }
    },
  );
});

test('⑥ reset 通知帧：POST /session/:id/reset 尾部广播 {kind:"reset", sessionId}（无 seq）', async () => {
  await withPendingDaemon(
    () => new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    async (ctx) => {
      const sid = ctx.manual();
      await ctx.post('跑一轮', sid);
      await waitIdle(ctx.http, ctx.H, sid);
      const { ws, frames } = await openCollecting(ctx.ws);
      try {
        const r = await fetch(`${ctx.http}/session/${sid}/reset`, { method: 'POST', headers: ctx.H });
        assert.equal(r.status, 200, 'reset 应 200');
        await waitFor(() => frames.some((f) => f.kind === 'reset'), 5000);
        const f = frames.find((fr) => fr.kind === 'reset')!;
        assert.equal(f.sessionId, sid, 'reset 帧挂所属会话');
        assert.equal(f.seq, undefined, 'reset 帧无 seq（不入单调序列）');
      } finally {
        ws.close();
      }
    },
  );
});

test('⑦ snapshot.pending 段:manual 挂起中含本会话 {pid,kind:"approval",req}(req 直序列化含 subject)→ 回执后空', { timeout: 30_000 }, async () => {
  await withPendingDaemon(
    (out) => new ScriptedAdapter([writeCard(out, 'pending-snap.txt', 'snap'), '{"done":true,"reply":"ok"}']),
    async (ctx) => {
      const sid = ctx.manual();
      const { ws, frames } = await openCollecting(ctx.ws);
      try {
        await ctx.post('写个文件', sid);
        await waitFor(() => frames.some((f) => f.kind === 'approval'), 10_000);
        const pid = frames.find((f) => f.kind === 'approval')!.pid!;
        assert.ok(/^p\d+$/.test(pid), 'pid 形态 p<n>(daemon 级铸造)');
        // 挂起中:本会话 snapshot.pending 含该条目(daemon 侧合并 + sessionId 过滤);G7 增 req——
        // 挂起表 entry.req 直序列化(ApprovalRequest 字面),GUI reseed 重建卡的内容面
        const snapOf = async (target: string): Promise<{ pending: Array<{ pid: string; kind: string; req?: Record<string, unknown> }> }> => {
          const r = await fetch(`${ctx.http}/session/${target}/snapshot`, { headers: ctx.H });
          assert.equal(r.status, 200);
          return (await r.json()) as { pending: Array<{ pid: string; kind: string; req?: Record<string, unknown> }> };
        };
        const rows = (await snapOf(sid)).pending;
        assert.equal(rows.length, 1, 'pending 含本会话 approval 挂起(单条)');
        assert.equal(rows[0]!.pid, pid);
        assert.equal(rows[0]!.kind, 'approval');
        assert.equal(rows[0]!.req?.kind, 'write', 'req 直序列化(kind=链侧 ask 形态)');
        assert.ok(String(rows[0]!.req?.subject ?? '').includes('pending-snap.txt'), 'req 含 subject(写目标路径)');
        assert.equal(rows[0]!.req?.id, frames.find((f) => f.kind === 'approval')!.req?.id, 'req 与首播帧同源(entry.req 单点)');
        // 跨会话过滤:另开 manual 会话(无挂起)——pid 全局铸造但段面按 sessionId 过滤
        const other = ctx.manual();
        assert.deepEqual((await snapOf(other)).pending, [], '他会话 snapshot.pending 不串流(sessionId 过滤)');
        // 回执后:表清,段空
        const r = await fetch(`${ctx.http}/approval/${pid}`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ decision: 'allow' }) });
        assert.equal(r.status, 200);
        assert.deepEqual((await snapOf(sid)).pending, [], '回执后 pending 空');
        await waitFor(() => frames.some((fr) => fr.e?.type === 'done'), 10_000);
      } finally {
        ws.close();
      }
    },
  );
});

/** 门控适配器（G5 ghost 用例）：首调用挂起至 release()——interrupt 在模型回包前落位，释放后 write
 *  envelope 的工具执行/asker 触发都发生在 abort 之后（ghost 窗口的确定性复现）；其余调用透传内嵌
 *  ScriptedAdapter。刻意不监听 signal——中止后仍回包正是本用例的时序前提（reactor 步边界检查发生在
 *  chatRound 之后，本轮工具照常执行） */
class GateAdapter implements ModelAdapter {
  readonly provider = 'gate';
  calls = 0;
  private readonly scripted: ScriptedAdapter;
  private releaseGate?: () => void;
  private readonly held = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });
  constructor(cards: string[]) {
    this.scripted = new ScriptedAdapter(cards);
  }
  release(): void {
    this.releaseGate?.();
  }
  async chat(req: ChatRequest, hooks?: UsageHooks): Promise<ChatResult> {
    this.calls += 1;
    if (this.calls === 1) await this.held;
    return this.scripted.chat(req, hooks);
  }
  async chatStream(req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult> {
    const r = await this.chat(req, hooks);
    for (const ch of r.content) onDelta(ch);
    return r;
  }
}

test('⑧ ghost-pending 硬化：interrupt 后模型回包触发 write → asker 查 isAborted 直接 deny——零 approval 帧广播、不入表、run 收束', { timeout: 30_000 }, async () => {
  const holder: { gate?: GateAdapter } = {};
  await withPendingDaemon(
    (out) => {
      holder.gate = new GateAdapter([writeCard(out, 'ghost-pending.txt', 'nope'), '{"done":true,"reply":"never-reached-gate"}']);
      return holder.gate;
    },
    async (ctx) => {
      const gate = holder.gate!;
      const sid = ctx.manual();
      const { ws, frames } = await openCollecting(ctx.ws);
      try {
        await ctx.post('写个文件然后被中止', sid);
        // 时序锚点：首模型调用已到达且被门控挂起（run 在跑、ask 尚未发生）
        await waitFor(() => gate.calls >= 1, 5000);
        // interrupt：abort 落位时挂起表为空（denyPendingFor 无东西可回填）——之后到达的 ask 是 ghost
        const it = await fetch(`${ctx.http}/session/${sid}/interrupt`, { method: 'POST', headers: ctx.H });
        assert.equal(it.status, 200, 'interrupt 应 200');
        // 释放门：模型回 write envelope → 工具触发 → asker 闭包查 isAborted → 直接 deny（不注册不广播）
        gate.release();
        // run 有界收束（无僵尸：asker 未悬挂）
        await waitIdle(ctx.http, ctx.H, sid);
        // 零 approval/ask 帧广播（事件收集器全量断言）
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(frames.filter((f) => f.kind === 'approval').length, 0, 'ghost 窗口零 approval 帧（asker 未注册挂起）');
        assert.equal(frames.filter((f) => f.kind === 'ask').length, 0, 'ghost 窗口零 ask 帧');
        // 行为面：deny 下写被拒（目标不落盘）+ snapshot.pending 空
        assert.equal(fs.existsSync(path.join(ctx.out, 'ghost-pending.txt')), false, 'deny 直接回填——写被拒');
        const snap = (await (await fetch(`${ctx.http}/session/${sid}/snapshot`, { headers: ctx.H })).json()) as { pending: unknown[] };
        assert.deepEqual(snap.pending, [], '挂起表零残留');
      } finally {
        ws.close();
      }
    },
  );
});
