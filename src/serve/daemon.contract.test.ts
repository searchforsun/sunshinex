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

/** G1 契约收口测试：全链（submit → WS 事件序 → done → 二轮续推）+ API 面收口（404 hint/401/409/400）。
 *  helper 形态照 daemon.ws.test.ts / daemon.test.ts 惯例，本文件自包含 */

/** WS 下行帧契约：恒 {kind:'event', e}——与 daemon.ws.test.ts 同形 */
interface Frame {
  kind: string;
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
  http: string;
  ws: string;
  post: (goal: string) => Promise<Response>;
}

/** 装配样板（同 daemon.ws.test.ts 环境隔离）：SUNSHINEX_DATA_DIR 钉 tmp，token 固定 test-token，port 0 */
async function withDaemon(model: ModelAdapter, fn: (daemon: GuiDaemon, ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-serve-contract-');
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
      await fn(daemon, { http, ws: `ws://127.0.0.1:${s.port}`, post });
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

test('① 全链：submit → WS 按序事件流至 done（末帧 done、恒 kind:"event"、route<model-start<done）→ idle → 二轮续推', async () => {
  // 每轮一张 done 卡：两轮 run 各消耗一卡（done 卡一次模型调用即收束）
  const model = new ScriptedAdapter(['{"done":true,"reply":"one"}', '{"done":true,"reply":"two"}']);
  await withDaemon(model, async (d, ctx) => {
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      // —— 第一轮：连接在先，submit 后事件实时按序流至 done ——
      await ctx.post('第一轮 goal');
      await waitFor(() => frames.some((f) => f.e.type === 'done'), 10000);
      const firstDone = frames.findIndex((f) => f.e.type === 'done');
      assert.ok(frames.slice(0, firstDone + 1).every((f) => f.kind === 'event'), '全帧恒 kind:"event"');
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
      await waitFor(() => d.status() === 'idle', 3000);
      assert.equal(frames[frames.length - 1].e.type, 'done', 'idle 时末事件 type 为 done');

      // —— 第二轮：新 goal、适配器再一卡——泵生命周期跨 run，事件流在同一连接续推 ——
      await ctx.post('第二轮 goal');
      await waitFor(() => frames.filter((f) => f.e.type === 'done').length >= 2, 10000);
      const secondDone = frames.findIndex((f, i) => i > firstDone && f.e.type === 'done');
      assert.ok(frames.slice(firstDone + 1, secondDone + 1).every((f) => f.kind === 'event'), '二轮帧恒 kind:"event"');
      // 第二轮首事件晚于第一轮 done（跨 run 不混流），且同为完整 run 事件面（route 起步）
      assert.equal(frames[firstDone + 1].e.type, 'route', '第二轮首帧紧随第一轮 done 之后，type 为 route');
      const types2 = frames.slice(firstDone + 1, secondDone + 1).map((f) => f.e.type);
      const ms2 = types2.indexOf('model-start');
      assert.ok(ms2 > 0, '二轮 model-start 在场');
      assert.equal(types2[types2.length - 1], 'done', '二轮末帧同为 done');
      assert.equal(frames[secondDone].e.text, 'two');
      await waitFor(() => d.status() === 'idle', 3000);
      assert.equal(frames[frames.length - 1].e.type, 'done', '二轮收束后末帧仍为 done');
    } finally {
      ws.close();
    }
  });
});

test('② API 面收口：未知 GET 404+hint；无 token 401；运行中 submit 409 / idle interrupt 409；空 body 400', async () => {
  await withDaemon(new HangingAdapter(), async (d, ctx) => {
    // 404：未知路径（非 API 端点、非 healthz）——G1 裁定恒定 hint；POST 未知路径统一同形
    const nf = await fetch(`${ctx.http}/foo`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(nf.status, 404);
    assert.deepEqual(await nf.json(), { error: 'not found', hint: GUI_HINT }, '404 body 逐字=error+hint');
    const nfPost = await fetch(`${ctx.http}/nope`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(nfPost.status, 404);
    assert.deepEqual(await nfPost.json(), { error: 'not found', hint: GUI_HINT }, 'POST 未知路径同 404 同 hint（统一裁定）');

    // 401：无 token 提交
    const noTok = await fetch(`${ctx.http}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'x' }) });
    assert.equal(noTok.status, 401);
    assert.deepEqual(await noTok.json(), { error: 'unauthorized' });

    // 400：空 body（JSON 解析失败）
    const empty = await fetch(`${ctx.http}/submit`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: '' });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'invalid json body');

    // 409（idle interrupt）：无运行时中断请求被拒
    const itIdle = await fetch(`${ctx.http}/interrupt`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
    assert.equal(itIdle.status, 409);
    assert.equal((await itIdle.json()).error, 'no run in progress');

    // 409（运行中 submit）：挂起 run 占锁，新提交被拒；随后 interrupt 收尾清锁
    await ctx.post('长任务');
    await waitFor(() => d.status() === 'running', 3000);
    const conflict = await fetch(`${ctx.http}/submit`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ goal: '再来' }) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, 'run in progress');
    const stop = await fetch(`${ctx.http}/interrupt`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
    assert.equal(stop.status, 200);
    await waitFor(() => d.status() === 'idle', 3000);
  });
});
