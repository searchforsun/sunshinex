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

/** WS 下行帧契约（T2）：恒 {kind:'event', e}——本测试面唯一断言对象 */
interface Frame {
  kind: string;
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
  post: (goal: string) => Promise<Response>;
}

/** 装配样板（同 daemon.test.ts 的环境隔离）：SUNSHINEX_DATA_DIR 钉 tmp，token 固定 test-token，port 0 */
async function withWsDaemon(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-serve-ws-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ root: tmp, model });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const http = `http://127.0.0.1:${s.port}`;
    const post = async (goal: string): Promise<Response> => {
      const r = await fetch(`${http}/submit`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ goal }),
      });
      assert.equal(r.status, 202, 'submit 应 202');
      return r;
    };
    try {
      await fn({ http, ws: `ws://127.0.0.1:${s.port}`, post });
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

test('① 连接前 submit(hanging)：事件先入缓冲，后连 WS 补发全量既有事件', async () => {
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
