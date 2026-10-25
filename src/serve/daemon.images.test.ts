import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { KernelEntry } from '../session/entry';

/** 图片附件端到端（daemon 级）：HTTP submit/steer 携带 images（dataURL）→ 转录 user 条/队列条目原样承载；
 *  载荷校验面（>8 张/坏形态/超限 body/空文+图）；快照 queued 随行 images（GUI 队列编辑回填数据源）。
 *  装配样板沿 daemon.pending.test.ts：SUNSHINEX_DATA_DIR 钉 tmp、token 固定、port 0。 */

const PNG = 'data:image/png;base64,aGVsbG8=';
const JPEG = 'data:image/jpeg;base64,aGVsbG8y';

interface Snap {
  status: string;
  messages: KernelEntry[];
  queued: Array<{ seq: number; text: string; images?: string[] }>;
}

async function withImagesDaemon(fn: (http: string, H: Record<string, string>, sid: () => string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-serve-images-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']) });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const http = `http://127.0.0.1:${s.port}`;
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;
    const sid = (): string => {
      const r = daemon.createSession(tmp, { mode: 'acceptEdits' });
      if (!r.ok) throw new Error(`createSession failed: ${r.error.message}`);
      return r.value.sessionId;
    };
    try {
      await fn(http, H, sid);
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function snapshot(http: string, H: Record<string, string>, sid: string): Promise<Snap> {
  const r = await fetch(`${http}/session/${sid}/snapshot`, { headers: H });
  assert.equal(r.status, 200);
  return (await r.json()) as Snap;
}

async function waitIdle(http: string, H: Record<string, string>, sid: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if ((await snapshot(http, H, sid)).status === 'idle') return;
    if (Date.now() > deadline) throw new Error('waitIdle 超时');
    await new Promise((res) => setTimeout(res, 20));
  }
}

test('submit 携图：202 → 转录 user 条 md+images 原样承载（快照面）', async () => {
  await withImagesDaemon(async (http, H, sid) => {
    const s = sid();
    const r = await fetch(`${http}/session/${s}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ goal: '看这张图', images: [PNG, JPEG] }) });
    assert.equal(r.status, 202, '携图 submit 应 202');
    await waitIdle(http, H, s);
    const snap = await snapshot(http, H, s);
    const user = snap.messages.find((m) => m.kind === 'user');
    assert.ok(user, 'user 条在档');
    assert.equal(user!.md, '看这张图');
    assert.deepEqual(user!.images, [PNG, JPEG], '转录条 images 原样随档');
  });
});

test('空文+纯图 submit：202（图片即消息），user 条 md 空、images 在场', async () => {
  await withImagesDaemon(async (http, H, sid) => {
    const s = sid();
    const r = await fetch(`${http}/session/${s}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ goal: '', images: [PNG] }) });
    assert.equal(r.status, 202, '空文+纯图应受理');
    await waitIdle(http, H, s);
    const snap = await snapshot(http, H, s);
    const user = snap.messages.find((m) => m.kind === 'user');
    assert.equal(user!.md, '');
    assert.deepEqual(user!.images, [PNG]);
  });
});

test('运行中 steer 携图：队列条目随行 images（快照 queued 面——GUI 队列编辑回填数据源）', async () => {
  await withImagesDaemon(async (http, H, sid) => {
    const s = sid();
    const r = await fetch(`${http}/session/${s}/steer`, { method: 'POST', headers: H, body: JSON.stringify({ text: '带图插话', images: [PNG] }) });
    assert.equal(r.status, 200, '空闲 steer 亦受理（排队语义）');
    const snap = await snapshot(http, H, s);
    assert.equal(snap.queued.length, 1, '队列一条');
    assert.equal(snap.queued[0]!.text, '带图插话');
    assert.deepEqual(snap.queued[0]!.images, [PNG], '队列条目随行 images');
  });
});

test('载荷校验：9 张 400 / 坏形态 400 / 空文无图 400 / 超限 body 413', async () => {
  await withImagesDaemon(async (http, H, sid) => {
    const s = sid();
    const post = (body: unknown): Promise<Response> => fetch(`${http}/session/${s}/submit`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const nine = Array.from({ length: 9 }, () => PNG);
    assert.equal((await post({ goal: 'x', images: nine })).status, 400, '超出 8 张 400');
    assert.equal((await post({ goal: 'x', images: ['http://example.com/a.png'] })).status, 400, '非 dataURL 形态 400');
    assert.equal((await post({ goal: 'x', images: 'nope' })).status, 400, 'images 非数组 400');
    assert.equal((await post({ goal: '' })).status, 400, '空文无图维持原 400');
    assert.equal((await post({ goal: 'ok', images: [] })).status, 202, '空 images 列等同无图');
    // steer 同面
    const st = (body: unknown): Promise<Response> => fetch(`${http}/session/${s}/steer`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    assert.equal((await st({ text: '', images: [PNG] })).status, 200, '空文+纯图 steer 受理');
    assert.equal((await st({ text: '' })).status, 400, '空文无图 steer 400');
    // 超限 body：>32MB → 413（payload too large，连接收口）
    const big = 'data:image/png;base64,' + 'A'.repeat(33 * 1024 * 1024);
    const rBig = await fetch(`${http}/session/${s}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ goal: 'x', images: [big] }) });
    assert.equal(rBig.status, 413, '超限 body 413');
  });
});
