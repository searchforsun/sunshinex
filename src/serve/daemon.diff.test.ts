import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';

/**
 * G7 diff 面测试：GET /session/:id/diff?callId= —— write 调用 pre-image ↔ 磁盘现文件双内容。
 * 查询面现场核（实现面结论）：daemon 会话 write 影子快照 drain 仅在 dispose/reset（清单随 seal 落
 * journal），会话存续期内 sink 内存清单常驻——run 中/后均实时可查；blob 落盘
 * <dataDir>/sessions/_blobs/<sha256>。callId 经真链路取证：WS 帧缓冲收 tool-call 帧
 * （batch-runner emit('tool-call', name, {input, callId, status})——callId 形态 step:<n>-idx:<i>）。
 * dontAsk 会话（root 内写信任域直放）——write 直执行无挂起，快照照捕（capture 只记 root 内路径）。
 */

const AUTH = { authorization: 'Bearer test-token' } as Record<string, string>;

/** 预览/截断上限(与 daemon 常量同值):512KB——新旧内容各按此截断 */
const MAX = 512 * 1024;

interface Ctx {
  daemon: GuiDaemon;
  http: string;
  wsUrl: string;
  root: string;
  /** dontAsk 会话(HTTP 面:POST /session/new {root}) */
  newSession: () => Promise<string>;
  /** 会话维提交(202 断言内建) */
  post: (goal: string, sid: string) => Promise<void>;
  H: Record<string, string>;
}

/** 装配样板(环境隔离同 daemon.pending.test.ts 惯例):SUNSHINEX_DATA_DIR 钉 tmp(blob 落盘隔离),
 *  token 固定,port 0;model 经工厂注入(卡片序依赖先建 root 样例文件) */
async function withDiffDaemon(makeModel: () => ModelAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-serve-diff-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model: makeModel() });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const http = `http://127.0.0.1:${s.port}`;
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;
    const newSession = async (): Promise<string> => {
      const r = await fetch(`${http}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: tmp }) });
      assert.equal(r.status, 200, 'session/new 应 200');
      return ((await r.json()) as { sessionId: string }).sessionId;
    };
    const post = async (goal: string, sid: string): Promise<void> => {
      const r = await fetch(`${http}/session/${sid}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ goal }) });
      assert.equal(r.status, 202, 'submit 应 202');
    };
    try {
      await fn({ daemon, http, wsUrl: `ws://127.0.0.1:${s.port}`, root: tmp, newSession, post, H });
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

interface AnyFrame {
  kind: string;
  sessionId: string;
  seq?: number;
  e?: { type?: string; text?: string; payload?: Record<string, unknown> };
}

/** 开连接并同步挂帧收集器(同 daemon.pending.test.ts:补发帧可能与握手响应同一 TCP 段到达) */
function openCollecting(url: string): Promise<{ ws: WebSocket; frames: AnyFrame[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer test-token' } });
    const frames: AnyFrame[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString()) as AnyFrame));
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });
}

/** 轮询等待(同 daemon.pending.test.ts 惯例) */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 会话 idle 轮询 */
async function waitIdle(http: string, H: Record<string, string>, sid: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await fetch(`${http}/session/${sid}/snapshot`, { headers: H });
    if (((await r.json()) as { status: string }).status === 'idle') return;
    if (Date.now() > deadline) throw new Error('waitIdle 超时');
    await new Promise((res) => setTimeout(res, 20));
  }
}

/** write 卡(真链路:batch-runner 解析 envelope 出牌) */
function writeCard(rel: string, content: string): string {
  return JSON.stringify({ tool: 'write', input: { path: rel, content } });
}

const DONE = '{"done":true,"reply":"ok"}';

interface DiffBody {
  path?: string;
  oldContent?: string;
  newContent: string;
  truncated?: boolean;
}

/** GET diff(query 已编码),回 Response 原面(状态码断言用) */
async function diffOf(http: string, H: Record<string, string>, sid: string, callId: string): Promise<Response> {
  return fetch(`${http}/session/${encodeURIComponent(sid)}/diff?callId=${encodeURIComponent(callId)}`, { headers: H });
}

test('① diff 双内容:预置文件 write 后 200 oldContent=pre-image/newContent=磁盘现文件;新文件 oldContent 缺场;写后即可查(run 中实时)', { timeout: 30_000 }, async () => {
  await withDiffDaemon(
    () => new ScriptedAdapter([writeCard('src/a.ts', 'new body'), writeCard('src/fresh.ts', 'fresh body'), DONE]),
    async (ctx) => {
      fs.mkdirSync(path.join(ctx.root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(ctx.root, 'src', 'a.ts'), 'old body', 'utf8');
      const sid = await ctx.newSession();
      const { ws, frames } = await openCollecting(ctx.wsUrl);
      try {
        await ctx.post('改写并新建', sid);
        /** write 调用帧(按入参 path 寻址)的 callId */
        const callOf = (p: string): string => {
          const hit = frames.find(
            (f) => f.e?.type === 'tool-call' && f.e?.text === 'write' && (f.e?.payload?.input as { path?: string } | undefined)?.path === p,
          );
          if (hit === undefined) throw new Error(`no tool-call frame for ${p}`);
          return String(hit.e!.payload!.callId);
        };
        const resultArrived = (p: string): boolean =>
          frames.some((f) => f.e?.type === 'tool-result' && f.e?.payload?.callId === callOf(p));
        await waitFor(
          () =>
            frames.some(
              (f) => f.e?.type === 'tool-call' && f.e?.text === 'write' && (f.e?.payload?.input as { path?: string } | undefined)?.path === 'src/a.ts',
            ),
          10_000,
        );
        // 第一写完成即查(不待 done——sink 内存清单 run 中实时;写落盘先于 result 帧,取证即确定态)
        await waitFor(() => resultArrived('src/a.ts'), 10_000);
        // 既有文件:oldContent=pre-image blob,newContent=磁盘现文件(write 落盘结果)
        const r1 = await diffOf(ctx.http, ctx.H, sid, callOf('src/a.ts'));
        assert.equal(r1.status, 200, '既有文件 write 的 diff 应 200');
        const b1 = (await r1.json()) as DiffBody;
        assert.equal(b1.oldContent, 'old body', 'oldContent=写前 pre-image blob');
        assert.equal(b1.newContent, 'new body', 'newContent=磁盘现文件');
        assert.equal(b1.path, path.resolve(ctx.root, 'src', 'a.ts'), 'path=resolve 归一绝对路径');
        assert.equal(b1.truncated, undefined, '双侧小文件不带 truncated');
        // 收尾(run 落定)后再验第二写(新建文件)
        await waitFor(() => frames.some((f) => f.e?.type === 'done'), 10_000);
        const r2 = await diffOf(ctx.http, ctx.H, sid, callOf('src/fresh.ts'));
        assert.equal(r2.status, 200);
        const b2 = (await r2.json()) as DiffBody;
        assert.equal('oldContent' in b2, false, '新建写无 pre-image——oldContent 键缺场');
        assert.equal(b2.newContent, 'fresh body');
      } finally {
        ws.close();
      }
    },
  );
});

test('② 404/400 面:非 write 调用/未知 callId → 404 no snapshot;未知会话 404;缺 callId 400', { timeout: 30_000 }, async () => {
  await withDiffDaemon(
    () => new ScriptedAdapter([JSON.stringify({ tool: 'read', input: { path: 'src/keep.ts' } }), DONE]),
    async (ctx) => {
      fs.mkdirSync(path.join(ctx.root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(ctx.root, 'src', 'keep.ts'), 'kept', 'utf8');
      const sid = await ctx.newSession();
      const { ws, frames } = await openCollecting(ctx.wsUrl);
      try {
        await ctx.post('读一下', sid);
        await waitFor(() => frames.some((f) => f.e?.type === 'done'), 10_000);
        const readCall = frames.find((f) => f.e?.type === 'tool-call' && f.e?.text === 'read');
        assert.ok(readCall !== undefined && typeof readCall.e!.payload!.callId === 'string', 'read 调用帧在场');
        // 非 write 调用:命中 callId 但无 pre-image 面
        const r1 = await diffOf(ctx.http, ctx.H, sid, String(readCall.e!.payload!.callId));
        assert.equal(r1.status, 404);
        assert.deepEqual(await r1.json(), { error: 'no snapshot' });
        // 未知 callId
        const r2 = await diffOf(ctx.http, ctx.H, sid, 'nope');
        assert.equal(r2.status, 404);
        assert.deepEqual(await r2.json(), { error: 'no snapshot' });
        // 未知会话
        const r3 = await diffOf(ctx.http, ctx.H, 's99', 'whatever');
        assert.equal(r3.status, 404);
        assert.deepEqual(await r3.json(), { error: 'unknown session' });
        // 缺 callId
        const r4 = await fetch(`${ctx.http}/session/${sid}/diff`, { headers: ctx.H });
        assert.equal(r4.status, 400);
        assert.deepEqual(await r4.json(), { error: 'callId query param required' });
      } finally {
        ws.close();
      }
    },
  );
});

test('③ 截断:pre-image 与磁盘现文件各 512KB 截断 + truncated:true', { timeout: 30_000 }, async () => {
  await withDiffDaemon(
    () => new ScriptedAdapter([writeCard('big.txt', 'x'.repeat(MAX + 10)), DONE]),
    async (ctx) => {
      fs.writeFileSync(path.join(ctx.root, 'big.txt'), 'y'.repeat(MAX + 5), 'utf8');
      const sid = await ctx.newSession();
      const { ws, frames } = await openCollecting(ctx.wsUrl);
      try {
        await ctx.post('写大文件', sid);
        await waitFor(() => frames.some((f) => f.e?.type === 'done'), 10_000);
        const hit = frames.find((f) => f.e?.type === 'tool-call' && f.e?.text === 'write')!;
        assert.ok(hit !== undefined, 'write 调用帧在场');
        const r = await diffOf(ctx.http, ctx.H, sid, String(hit.e!.payload!.callId));
        assert.equal(r.status, 200);
        const b = (await r.json()) as DiffBody;
        assert.equal(b.truncated, true, '双侧超限 → truncated:true');
        assert.equal(b.oldContent!.length, MAX, 'oldContent 截首 512KB');
        assert.ok(b.oldContent!.split('').every((c) => c === 'y'), 'oldContent 为 pre-image 首段');
        assert.equal(b.newContent.length, MAX, 'newContent 截首 512KB');
        assert.ok(b.newContent.split('').every((c) => c === 'x'), 'newContent 为现文件首段');
      } finally {
        ws.close();
      }
    },
  );
});

test('④ 同路径多次写按调用序:第二次 write 的 oldContent=第一次写入结果(各自取写前态)', { timeout: 30_000 }, async () => {
  await withDiffDaemon(
    () => new ScriptedAdapter([writeCard('seq.ts', 'v2'), DONE, writeCard('seq.ts', 'v3'), DONE]),
    async (ctx) => {
      fs.writeFileSync(path.join(ctx.root, 'seq.ts'), 'v1', 'utf8');
      const sid = await ctx.newSession();
      const { ws, frames } = await openCollecting(ctx.wsUrl);
      try {
        await ctx.post('第一次写', sid);
        await waitIdle(ctx.http, ctx.H, sid);
        await ctx.post('第二次写', sid);
        await waitFor(() => frames.filter((f) => f.e?.type === 'tool-call' && f.e?.text === 'write').length >= 2, 10_000);
        await waitIdle(ctx.http, ctx.H, sid);
        const calls = frames
          .filter((f) => f.e?.type === 'tool-call' && f.e?.text === 'write' && (f.e?.payload?.input as { path?: string } | undefined)?.path === 'seq.ts')
          .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
          .map((f) => String(f.e!.payload!.callId));
        assert.equal(calls.length, 2, '两次 write 调用帧在场');
        // 第一写:pre-image=原文件 v1;newContent=磁盘现文件(已被第二写覆盖为 v3——现文件语义)
        const r1 = await diffOf(ctx.http, ctx.H, sid, calls[0]!);
        assert.equal(r1.status, 200);
        const b1 = (await r1.json()) as DiffBody;
        assert.equal(b1.oldContent, 'v1', '第一写 oldContent=最初 pre-image(按调用序,非最新清单项)');
        assert.equal(b1.newContent, 'v3', 'newContent=磁盘现文件(后续写已覆盖)');
        // 第二写:pre-image=第一写落盘的 v2
        const r2 = await diffOf(ctx.http, ctx.H, sid, calls[1]!);
        assert.equal(r2.status, 200);
        const b2 = (await r2.json()) as DiffBody;
        assert.equal(b2.oldContent, 'v2', '第二写 oldContent=第一写的结果(调用序对位)');
        assert.equal(b2.newContent, 'v3');
      } finally {
        ws.close();
      }
    },
  );
});
