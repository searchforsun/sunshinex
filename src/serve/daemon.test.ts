import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';

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

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;

/** 环境隔离样板：数据目录钉到本用例 tmp（focused 直跑不经 scripts/run-tests.js 预载，须自隔离用户全局区） */
async function withDaemon(
  model: ModelAdapter,
  fn: (daemon: GuiDaemon, base: string) => Promise<void>,
): Promise<void> {
  const tmp = tmpdir('sunshinex-serve-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ root: tmp, model });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    try {
      await fn(daemon, `http://127.0.0.1:${s.port}`);
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('① healthz 免鉴权 200；submit 无/错 token 401；未知路径 404', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (_d, base) => {
    const h = await fetch(`${base}/healthz`);
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { ok: true }, 'healthz 只回 ok，零其它信息');

    const noTok = await fetch(`${base}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'x' }) });
    assert.equal(noTok.status, 401);
    assert.equal((await noTok.json()).error, 'unauthorized');

    const badTok = await fetch(`${base}/submit`, { method: 'POST', headers: { ...AUTH, authorization: 'Bearer wrong' }, body: JSON.stringify({ goal: 'x' }) });
    assert.equal(badTok.status, 401);
    assert.equal((await badTok.json()).error, 'unauthorized');

    const nf = await fetch(`${base}/nope`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(nf.status, 404);
    assert.equal((await nf.json()).error, 'not found');
  });
});

test('② submit 空 body 400 / 非 JSON 400 / 非法 goal 400；合法 202 后 run 完成回 idle', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (d, base) => {
    const empty = await fetch(`${base}/submit`, { method: 'POST', headers: AUTH, body: '' });
    assert.equal(empty.status, 400, '空 body JSON 解析失败 → 400');

    const bad = await fetch(`${base}/submit`, { method: 'POST', headers: AUTH, body: 'not-json' });
    assert.equal(bad.status, 400, '非 JSON body → 400');

    for (const g of ['', 123, null]) {
      const r = await fetch(`${base}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: g }) });
      assert.equal(r.status, 400, `goal=${JSON.stringify(g)} 非法 → 400`);
    }

    const okr = await fetch(`${base}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '把测试跑绿' }) });
    assert.equal(okr.status, 202);
    assert.deepEqual(await okr.json(), { ok: true });
    await waitFor(() => d.status() === 'idle', 3000);
    assert.equal(d.status(), 'idle', '单 done 卡 run 异步完成后 status 回 idle');
  });
});

test('③ 运行中二次 submit 409；interrupt 200 后可再 submit（abort 生效）', async () => {
  await withDaemon(new HangingAdapter(), async (d, base) => {
    const first = await fetch(`${base}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '长任务' }) });
    assert.equal(first.status, 202);
    await waitFor(() => d.status() === 'running', 3000);

    const second = await fetch(`${base}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '再来' }) });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, 'run in progress');

    const it = await fetch(`${base}/interrupt`, { method: 'POST', headers: AUTH });
    assert.equal(it.status, 200);
    assert.deepEqual(await it.json(), { ok: true });
    await waitFor(() => d.status() === 'idle', 3000);

    const noRun = await fetch(`${base}/interrupt`, { method: 'POST', headers: AUTH });
    assert.equal(noRun.status, 409, '无运行时 interrupt → 409');
    assert.equal((await noRun.json()).error, 'no run in progress');

    const again = await fetch(`${base}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '重跑' }) });
    assert.equal(again.status, 202, 'interrupt 后锁已清，可再 submit');
    await waitFor(() => d.status() === 'running', 3000);
    const stop = await fetch(`${base}/interrupt`, { method: 'POST', headers: AUTH }); // 收尾：停掉第二次 run，不留悬挂回调
    assert.equal(stop.status, 200);
    await waitFor(() => d.status() === 'idle', 3000);
  });
});

test('④ close() 幂等且 close 后 fetch 拒连', async () => {
  const tmp = tmpdir('sunshinex-serve-close-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
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
