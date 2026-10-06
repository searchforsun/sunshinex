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

/** WS 下行帧契约（T1 会话中心）：恒 {kind:'event', sessionId, seq, e}——sessionId 为帧所属会话
 *  （三型帧均挂——approval/ask 帧 G4 起另形同挂）；seq 为 daemon 级全局单调序号（计数在先帧在后，
 *  首帧=1，跨会话不重号——G3 seq 协议 + T1 全局裁定）——本测试面唯一断言对象 */
interface Frame {
  kind: string;
  sessionId: string;
  seq: number;
  e: SessionEvent;
}

/** 轮询等待（同 daemon.test.ts 惯例）：20ms 片轮询直至 pred 为真，超时抛错 */
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

/** 挂起适配器（同 daemon.test.ts）：模型调用永挂——run 停在 model-start 后，事件面静止，补发语义可判 */
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
  http: string;
  ws: string;
  /** 首会话 id（helper 内创建，root=daemon tmp） */
  sid: string;
  /** 按会话维提交：POST /session/:id/submit */
  post: (goal: string, sid?: string) => Promise<Response>;
  /** POST /session/new（root 缺省 daemon tmp）——双会话用例自建第二会话 */
  newSession: (root?: string) => Promise<string>;
}

/** 装配样板（环境隔离同 daemon.test.ts）：SUNSHINEX_DATA_DIR 钉 tmp，token 固定 test-token，port 0；
 *  会话中心形态——daemon 空注册表启动，helper 内建首会话（root=tmp），既有单会话用例打 :id 端点 */
async function withWsDaemon(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-serve-ws-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model });
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
      await fn({ http, ws: `ws://127.0.0.1:${s.port}`, sid, post, newSession });
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 开连接并同步挂帧收集器（正确 token）：message 监听必须在构造后立刻挂——补发帧可能与握手响应
 *  同一 TCP 段到达，等 open 回执后再挂会丢同段帧（真实浏览器客户端 onmessage 先于 open 就位，无此问题） */
function openCollecting(url: string, headers?: Record<string, string>): Promise<{ ws: WebSocket; frames: Frame[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: headers ?? { authorization: 'Bearer test-token' } });
    const frames: Frame[] = [];
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as Frame);
    });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });
}

test('① 连接前 submit(hanging)：事件先入缓冲，后连 WS 补发全量既有事件（帧恒挂 sessionId）', async () => {
  const model = new HangingAdapter();
  await withWsDaemon(model, async (ctx) => {
    await ctx.post('长任务');
    // HangingAdapter.chat 被调用 ⇒ route/model-start 已同步泵入缓冲（emit→onEvent→push 同一 tick，chat 在 model-start 之后）
    await waitFor(() => model.calls > 0, 3000);
    // 连接晚于事件：收到的帧只能是补发（run 悬挂中，无新事件源）
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      await waitFor(() => frames.some((f) => f.e.type === 'model-start'), 3000);
      assert.ok(frames.every((f) => f.kind === 'event'), '补发帧恒 kind:"event"');
      assert.ok(frames.every((f) => f.sessionId === ctx.sid), '补发帧恒挂所属会话 sessionId');
      assert.ok(frames.some((f) => f.e.type === 'model-start'), '首批帧含连接前的 model-start');
      assert.ok(frames.some((f) => f.e.type === 'route'), 'run 起始 route 事件同样在场');
      const msIdx = frames.findIndex((f) => f.e.type === 'model-start');
      assert.ok(frames.findIndex((f) => f.e.type === 'route') < msIdx, '缓冲序=事件序：route 先于 model-start');
      // 补发是存量一次性快照：悬挂 run 无新帧，帧数应稳定
      const n = frames.length;
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(frames.length, n, '悬挂 run 下连接后不再来新帧（所见即补发）');
    } finally {
      ws.close();
    }
  });
});

test('② 连接中 submit(单 done 卡)：按序实时收 {kind:"event"} 帧，token 增量与 done 终态在场', async () => {
  await withWsDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      await ctx.post('把测试跑绿');
      await waitFor(() => frames.some((f) => f.e.type === 'done'), 10000);
      assert.ok(frames.every((f) => f.kind === 'event'), '全帧恒 kind:"event"');
      assert.ok(frames.every((f) => f.sessionId === ctx.sid), '实时帧恒挂所属会话 sessionId');
      const types = frames.map((f) => f.e.type);
      const msIdx = types.indexOf('model-start');
      const doneIdx = types.indexOf('done');
      assert.ok(msIdx >= 0, 'model-start 在场');
      assert.ok(doneIdx > msIdx, 'done 终态在 model-start 之后');
      // 终稿正文经 token 增量帧流过（model-start 与 done 之间）
      const tokens = frames
        .slice(msIdx, doneIdx)
        .filter((f) => f.e.type === 'token')
        .map((f) => f.e.text ?? '')
        .join('');
      assert.equal(tokens, 'ok', 'token 增量拼接=reply 正文');
      const done = frames[doneIdx].e;
      assert.equal(done.text, 'ok');
      assert.equal((done.payload as { stopReason?: string } | undefined)?.stopReason, 'done');
    } finally {
      ws.close();
    }
  });
});

test('③ 错 Bearer 升级被拒：客户端 error 且无 open', async () => {
  await withWsDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    let sawOpen = false;
    let sawError = false;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(ctx.ws, { headers: { authorization: 'Bearer wrong-token' } });
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
  });
});

test('③.5 双连接广播隔离：其一断连清理后，另一连接继续收后续 submit 的事件流', async () => {
  await withWsDaemon(new ScriptedAdapter(['{"done":true,"reply":"one"}', '{"done":true,"reply":"two"}']), async (ctx) => {
    const a = await openCollecting(ctx.ws);
    const b = await openCollecting(ctx.ws);
    const fa = a.frames;
    const fb = b.frames;
    try {
      // run1：两路同享广播
      await ctx.post('第一次');
      await waitFor(() => fb.some((f) => f.e.type === 'done'), 10000);
      assert.ok(fa.some((f) => f.e.type === 'done'), '断连前双连接均收 done');
      // 断连其一（客户端 terminate 触发的 socket 关闭与 server 侧 terminate 同走 close 事件清理面）
      a.ws.terminate();
      await waitFor(() => a.ws.readyState === WebSocket.CLOSED, 2000);
      // run2：幸存连接继续收完整事件面
      await waitFor(() => fb.length > 0 && fb.every((f) => f.kind === 'event'), 100);
      await ctx.post('第二次');
      await waitFor(() => fb.filter((f) => f.e.type === 'done').length >= 2, 10000);
      const firstDone = fb.findIndex((f) => f.e.type === 'done');
      const secondDone = fb.findIndex((f, i) => i > firstDone && f.e.type === 'done');
      assert.ok(secondDone > firstDone, '两轮 done 均到达幸存连接');
      assert.equal(fb[secondDone].e.text, 'two');
      const between = fb.slice(firstDone + 1, secondDone).map((f) => f.e.type);
      assert.ok(between.includes('model-start'), '第二轮 run 事件面完整（model-start 起步）');
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });
});

test('④ subprotocol 鉴权（浏览器路径）：bearer.<token> 无 Authorization 头可升级、protocol 回显、补发帧照收；错值拒', async () => {
  const model = new HangingAdapter();
  await withWsDaemon(model, async (ctx) => {
    await ctx.post('长任务');
    await waitFor(() => model.calls > 0, 3000);
    // 正确 subprotocol：纯浏览器形态——无 Authorization 头，token 只走 Sec-WebSocket-Protocol
    const { ws, frames } = await new Promise<{ ws: WebSocket; frames: Frame[] }>((resolve, reject) => {
      const w = new WebSocket(ctx.ws, ['bearer.test-token']);
      const collected: Frame[] = [];
      w.on('message', (data) => {
        collected.push(JSON.parse(data.toString()) as Frame);
      });
      w.once('open', () => resolve({ ws: w, frames: collected }));
      w.once('error', reject);
    });
    try {
      assert.equal(ws.protocol, 'bearer.test-token', '升级响应应回显请求的 subprotocol（浏览器侧鉴权证据）');
      await waitFor(() => frames.some((f) => f.e.type === 'model-start'), 3000);
      assert.ok(frames.every((f) => f.kind === 'event'), '补发帧恒 kind:"event"');
      assert.ok(frames.every((f) => f.sessionId === ctx.sid), '补发帧恒挂 sessionId（subprotocol 路径同帧形）');
      assert.ok(frames.some((f) => f.e.type === 'model-start'), 'subprotocol 路径同样享受缓冲补发');
    } finally {
      ws.close();
    }
    // 错值：拒升级（客户端 error 且无 open）
    let sawOpen = false;
    let sawError = false;
    await new Promise<void>((resolve) => {
      const w = new WebSocket(ctx.ws, ['bearer.wrong-token']);
      w.on('open', () => {
        sawOpen = true;
        resolve();
      });
      w.on('error', () => {
        sawError = true;
      });
      w.on('close', () => resolve());
    });
    assert.equal(sawOpen, false, '错 subprotocol 不得升级成功');
    assert.equal(sawError, true, '401 拒升级应表现为客户端 error');
  });
});

test('⑤ seq 协议：两轮 submit 全部 event 帧 seq 全局严格递增；补发帧 seq 保留各自值（首帧=1，续轮不重置）', async () => {
  await withWsDaemon(new ScriptedAdapter(['{"done":true,"reply":"one"}', '{"done":true,"reply":"two"}']), async (ctx) => {
    const snap = async (): Promise<{ status: string; lastSeq: number }> => {
      const r = await fetch(`${ctx.http}/session/${ctx.sid}/snapshot`, { headers: { authorization: 'Bearer test-token' } });
      assert.equal(r.status, 200);
      return (await r.json()) as { status: string; lastSeq: number };
    };
    const waitIdle = async (): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while ((await snap()).status !== 'idle') {
        if (Date.now() > deadline) throw new Error('waitIdle 超时');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    // 第一轮无连接：事件各自带 seq 入环形缓冲（run 收束=done 末事件已泵入），后连线所见全为补发
    await ctx.post('第一轮');
    await waitIdle();
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      await waitFor(() => frames.some((f) => f.e.type === 'done'), 3000);
      assert.equal(frames[0].seq, 1, '补发首帧 seq=1（计数在先帧在后）');
      for (let i = 1; i < frames.length; i++) {
        assert.ok(frames[i].seq > frames[i - 1].seq, `补发帧 seq 严格递增（${i}）`);
      }
      // 空闲态（done=末事件）无新事件源：lastSeq 恰等于已广播帧最大 seq
      const replayMax = Math.max(...frames.map((f) => f.seq));
      assert.equal((await snap()).lastSeq, replayMax, '补发窗口内 lastSeq=已广播最大 seq');

      // 第二轮连接中实时续推：实时帧 seq 续接补发最大值之后，跨轮全局单调不回绕、不重置
      await ctx.post('第二轮');
      await waitFor(() => frames.filter((f) => f.e.type === 'done').length >= 2, 10000);
      assert.ok(frames[frames.length - 1].seq > replayMax, '第二轮实时帧 seq 续接补发最大值之后');
      for (let i = 1; i < frames.length; i++) {
        assert.ok(frames[i].seq > frames[i - 1].seq, `全部帧（补发+实时）seq 全局严格递增（${i}）`);
      }
      assert.ok(frames.every((f) => f.kind === 'event'), '全帧恒 kind:"event"');
    } finally {
      ws.close();
    }
  });
});

test('⑥ 双会话帧归属：同一连接收两会话帧各挂各 sessionId（广播全连接，帧面按会话标注）', async () => {
  const model = new HangingAdapter();
  await withWsDaemon(model, async (ctx) => {
    // 第二会话：独立 tmp root
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-serve-ws-b-'));
    const s2 = await ctx.newSession(tmpB);
    assert.notEqual(s2, ctx.sid, '两会话 id 相异');

    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      // s1 run（hanging：事件面停在 model-start）
      await ctx.post('s1 长任务', ctx.sid);
      await waitFor(() => model.calls > 0, 3000);
      await waitFor(() => frames.filter((f) => f.sessionId === ctx.sid).some((f) => f.e.type === 'model-start'), 3000);
      // s2 run（同一连接继续收，帧挂 s2）
      await ctx.post('s2 长任务', s2);
      await waitFor(() => model.calls > 1, 3000);
      await waitFor(() => frames.filter((f) => f.sessionId === s2).some((f) => f.e.type === 'model-start'), 3000);

      // 会话归属：A 会话帧 sid=s1 / B 会话帧 sid=s2，各流各自含完整起步面（route→model-start）
      const f1 = frames.filter((f) => f.sessionId === ctx.sid);
      const f2 = frames.filter((f) => f.sessionId === s2);
      assert.ok(f1.length > 0 && f2.length > 0, '两会话帧均到达同一连接');
      for (const [label, list] of [['s1', f1] as const, ['s2', f2] as const]) {
        const types = list.map((f) => f.e.type);
        assert.ok(types.includes('route'), `${label} 流含 route`);
        assert.ok(types.indexOf('model-start') > types.indexOf('route'), `${label} 流 route 先于 model-start`);
      }
      // 收尾：停掉两个悬挂 run
      const H = { authorization: 'Bearer test-token' } as Record<string, string>;
      for (const sid of [ctx.sid, s2]) {
        const r = await fetch(`${ctx.http}/session/${sid}/interrupt`, { method: 'POST', headers: H });
        assert.equal(r.status, 200);
        await waitForAsync(() => sessionIdle(ctx.http, H, sid), 3000);
      }
    } finally {
      ws.close();
    }
  });
});

test('⑦ 双会话补发各归各：重连补发=全会话缓冲逐会话（会话序 s1..sN，各内缓冲序，seq 全局续接）', async () => {
  const model = new HangingAdapter();
  await withWsDaemon(model, async (ctx) => {
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-serve-ws-b2-'));
    try {
      const s2 = await ctx.newSession(tmpB);
      const H = { authorization: 'Bearer test-token' } as Record<string, string>;
      // s1 run 起步后中止（块完整收束），再 s2 run 起步后中止——两会话缓冲各有独立事件段
      await ctx.post('s1 长任务', ctx.sid);
      await waitFor(() => model.calls > 0, 3000);
      let r = await fetch(`${ctx.http}/session/${ctx.sid}/interrupt`, { method: 'POST', headers: H });
      assert.equal(r.status, 200);
      await waitForAsync(() => sessionIdle(ctx.http, H, ctx.sid), 3000);
      await ctx.post('s2 长任务', s2);
      await waitFor(() => model.calls > 1, 3000);
      r = await fetch(`${ctx.http}/session/${s2}/interrupt`, { method: 'POST', headers: H });
      assert.equal(r.status, 200);
      await waitForAsync(() => sessionIdle(ctx.http, H, s2), 3000);

      // 后连连接：所见全为补发——s1 块在前 s2 块在后（会话序），各内 seq 递增，跨块全局续接
      const { ws, frames } = await openCollecting(ctx.ws);
      try {
        await waitFor(() => frames.some((f) => f.sessionId === s2), 3000);
        const f1 = frames.filter((f) => f.sessionId === ctx.sid);
        const f2 = frames.filter((f) => f.sessionId === s2);
        assert.ok(f1.length > 0 && f2.length > 0, '补发含全部会话缓冲（裁定：全会话，客户端按 sessionId 过滤）');
        assert.equal(frames.indexOf(f1[0]), 0, '补发会话序：s1 块在前');
        assert.ok(frames.indexOf(f1[f1.length - 1]) < frames.indexOf(f2[0]), 's2 块整个在 s1 块之后');
        // 各内缓冲序=seq 序；跨块全局单调续接（s1 段先于 s2 段完成，全局计数器不回拨）
        for (const list of [f1, f2]) {
          for (let i = 1; i < list.length; i++) assert.ok(list[i].seq > list[i - 1].seq, '块内 seq 递增');
        }
        assert.ok(f2[0].seq > f1[f1.length - 1].seq, '跨块 seq 全局续接（daemon 级单调）');
        // 块内事件面完整：各自含 route（run 起步）
        assert.ok(f1.some((f) => f.e.type === 'route') && f2.some((f) => f.e.type === 'route'), '各会话块含完整 run 起步面');
      } finally {
        ws.close();
      }
    } finally {
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });
});

/** 会话 idle 轮询（⑥⑦ 辅助）：snapshot.status 回 idle */
async function sessionIdle(http: string, H: Record<string, string>, sid: string): Promise<boolean> {
  const r = await fetch(`${http}/session/${sid}/snapshot`, { headers: H });
  return ((await r.json()) as { status: string }).status === 'idle';
}

/** 异步谓词轮询（⑥⑦ 辅助）：20ms 片轮询 await pred 为真，超时抛错 */
async function waitForAsync(pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}
