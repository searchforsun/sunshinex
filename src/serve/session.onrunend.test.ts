import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { SessionRuntime } from './session';
import type { RunEndInfo } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';

/** Task 4（2026-11-20 定时任务）：会话运行时收尾观察面 onRunEnd（spec §12 全矩阵）+ 非激活建会话
 *  （activate:false）+ internal read-only（HTTP /session/new 仍 400）。
 *  手法：直构 SessionRuntime（session.test.ts 样板——模型/时钟注入可断）覆盖回调矩阵；GuiDaemon 面
 *  覆盖 createSession 两键与 HTTP 收窄。 */

/** 轮询等待（同 session.test.ts 惯例）：20ms 片轮询直至 pred 为真，超时抛错 */
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

/** 模型调用永挂直至 signal 中止（session.test.ts HangingAdapter 同形）：interrupted 收尾的中正模拟 */
class HangingAdapter implements ModelAdapter {
  readonly provider = 'hanging';
  async chat(req: ChatRequest): Promise<ChatResult> {
    const signal = req.signal;
    return new Promise((_, reject) => {
      if (signal?.aborted) return reject(new Error('Task interrupted'));
      signal?.addEventListener('abort', () => reject(new Error('Task interrupted')), { once: true });
    });
  }
}

/** 模型 chat 抛普通 Error：反应堆归一为 stopReason='model-error' 的终态 outcome（回调仍须触发） */
class ThrowingAdapter implements ModelAdapter {
  readonly provider = 'throwing';
  async chat(_req: ChatRequest): Promise<ChatResult> {
    throw new Error('model exploded');
  }
}

/** 模型 chat 抛非 Error 且 toString 再抛：反应堆错误归一（String(e)）二次抛出 → runTask 本身拒绝，
 *  走 submit 的 .catch 日志与 finally 兜底（stopReason 无 outcome=undefined 的真实路径） */
class PoisonAdapter implements ModelAdapter {
  readonly provider = 'poison';
  async chat(_req: ChatRequest): Promise<ChatResult> {
    throw {
      toString(): string {
        throw new Error('poison toString');
      },
    };
  }
}

interface Ctx {
  session: SessionRuntime;
  tmp: string;
}

/** 装配样板（session.test.ts withSession 同形）：SUNSHINEX_DATA_DIR 钉 tmp；nextSeq 本地计数器；
 *  broadcast no-op。finally 兜 teardown——断言失败也不留悬挂 run/事件循环 */
async function withSession(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-onrunend-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  let seq = 0;
  const session = new SessionRuntime({
    id: 's1',
    root: tmp,
    model,
    nextSeq: () => {
      seq += 1;
      return seq;
    },
    broadcast: () => {},
    mintPid: () => 'p1',
  });
  try {
    await fn({ session, tmp });
  } finally {
    await session.teardown();
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** daemon 装配样板（daemon.pending.test.ts 同形）：SUNSHINEX_DATA_DIR 钉 tmp，token 固定；关闭后清理 */
async function withDaemon(model: ModelAdapter, fn: (ctx: { daemon: GuiDaemon; http: string; root: string; H: Record<string, string> }) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-onrunend-daemon-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model });
    const s = await daemon.start({ port: 0, token: 't' });
    try {
      const H = { authorization: 'Bearer t', 'content-type': 'application/json' } as Record<string, string>;
      await fn({ daemon, http: `http://127.0.0.1:${s.port}`, root: tmp, H });
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// ---------------------------------------------------------------------------------------------
// done + activate:false（简报基线用例）
// ---------------------------------------------------------------------------------------------

test('onRunEnd：done 回调一次并带 stopReason/seconds；createSession activate:false 不抢 active', { timeout: 20_000 }, async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ daemon, root }) => {
    const r = daemon.createSession(root, { activate: false });
    assert.ok(r.ok, 'activate:false 建会话受理');
    const sid = r.value.sessionId;
    const session = daemon.get(sid)!;
    const t0 = Date.now();
    const seen: RunEndInfo[] = [];
    session.onRunEnd((info) => seen.push(info));
    session.submit('hi');
    await waitFor(() => seen.length > 0, 10_000);
    assert.equal(seen.length, 1, 'done 只回调一次');
    assert.equal(seen[0]!.stopReason, 'done');
    assert.ok(seen[0]!.seconds >= 1, 'seconds 取轮收尾计算值（≥1）');
    assert.ok(Number.isFinite(seen[0]!.endedAt) && seen[0]!.endedAt >= t0, 'endedAt 为收尾时点');
    assert.equal(seen[0]!.tokens, 0, 'tokens=runOutcome.tokensUsed（脚本化回放为 0）');
    assert.equal(daemon.activeId(), undefined, 'activate:false 不抢 active');
  });
});

// ---------------------------------------------------------------------------------------------
// interrupted：在途 run 被 session.interrupt() 中止 → stopReason='interrupted'
// ---------------------------------------------------------------------------------------------

test('onRunEnd：interrupted 回调 stopReason=interrupted', { timeout: 20_000 }, async () => {
  await withSession(new HangingAdapter(), async ({ session }) => {
    const seen: RunEndInfo[] = [];
    session.onRunEnd((info) => seen.push(info));
    const t0 = Date.now();
    assert.deepEqual(session.submit('长任务'), { ok: true });
    await waitFor(() => session.status() === 'running', 3000);
    assert.deepEqual(session.interrupt(), { ok: true });
    await waitFor(() => seen.length > 0, 10_000);
    assert.equal(seen.length, 1, 'interrupted 只回调一次');
    assert.equal(seen[0]!.stopReason, 'interrupted');
    assert.ok(seen[0]!.seconds >= 1, 'seconds ≥ 1');
    assert.ok(Number.isFinite(seen[0]!.endedAt) && seen[0]!.endedAt >= t0, 'endedAt 为收尾时点');
  });
});

// ---------------------------------------------------------------------------------------------
// exception：模型 chat 抛普通 Error → 反应堆归一 model-error，回调仍须触发
// ---------------------------------------------------------------------------------------------

test('onRunEnd：模型异常（chat 抛 Error）回调仍触发（stopReason=model-error、时间字段有限）', { timeout: 20_000 }, async () => {
  await withSession(new ThrowingAdapter(), async ({ session }) => {
    const seen: RunEndInfo[] = [];
    session.onRunEnd((info) => seen.push(info));
    const t0 = Date.now();
    session.submit('explode');
    await waitFor(() => seen.length > 0, 10_000);
    assert.equal(seen.length, 1, '异常收尾只回调一次');
    assert.equal(seen[0]!.stopReason, 'model-error', '反应堆把模型异常归一为 model-error 终态');
    assert.ok(Number.isFinite(seen[0]!.endedAt) && seen[0]!.endedAt >= t0, 'endedAt 有限');
    assert.ok(Number.isFinite(seen[0]!.seconds) && seen[0]!.seconds >= 1, 'seconds 有限且 ≥1');
  });
});

test('onRunEnd：模型异常（runTask 拒绝）——.catch 记录日志且回调仍触发（stopReason undefined、时间字段有限）', { timeout: 20_000 }, async () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]): void => {
    logged.push(
      args
        .map((a) => {
          try {
            return String(a);
          } catch {
            return '<unprintable>';
          }
        })
        .join(' '),
    );
  };
  try {
    await withSession(new PoisonAdapter(), async ({ session }) => {
      const seen: RunEndInfo[] = [];
      session.onRunEnd((info) => seen.push(info));
      const t0 = Date.now();
      session.submit('explode');
      await waitFor(() => seen.length > 0, 10_000);
      assert.equal(seen.length, 1, 'runTask 拒绝收尾也只回调一次');
      assert.equal(seen[0]!.stopReason, undefined, '无 outcome → stopReason undefined（executor 映射 failed）');
      assert.ok(Number.isFinite(seen[0]!.endedAt) && seen[0]!.endedAt >= t0, 'endedAt 回退到收尾时点');
      assert.ok(Number.isFinite(seen[0]!.seconds) && seen[0]!.seconds >= 1, 'seconds 回退路径仍给有限值');
      assert.ok(logged.some((l) => l.includes('[serve] run failed:')), 'run 链 .catch 记录异常');
    });
  } finally {
    console.error = orig;
  }
});

// ---------------------------------------------------------------------------------------------
// unsubscribe / one-shot
// ---------------------------------------------------------------------------------------------

test('onRunEnd：off() 注销后回调不再触发', { timeout: 20_000 }, async () => {
  await withSession(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ session }) => {
    let calls = 0;
    const off = session.onRunEnd(() => {
      calls += 1;
    });
    off();
    assert.deepEqual(session.submit('hi'), { ok: true });
    await waitFor(() => session.status() === 'idle', 10_000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(calls, 0, '注销后回调不得触发');
  });
});

test('onRunEnd：一次性——首轮 done 回调一次，同会话第二轮不再回调', { timeout: 20_000 }, async () => {
  await withSession(new ScriptedAdapter(['{"done":true,"reply":"one"}', '{"done":true,"reply":"two"}']), async ({ session }) => {
    const seen: RunEndInfo[] = [];
    session.onRunEnd((info) => seen.push(info));
    assert.deepEqual(session.submit('first'), { ok: true });
    await waitFor(() => seen.length === 1, 10_000);
    assert.equal(seen[0]!.stopReason, 'done');
    // 第二轮同会话 done：观察者集合已在首轮 finally 清空
    assert.deepEqual(session.submit('second'), { ok: true });
    await waitFor(() => session.status() === 'running', 3000);
    await waitFor(() => session.status() === 'idle', 10_000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.length, 1, '第二轮不得复用首轮观察者（一次性）');
  });
});

// ---------------------------------------------------------------------------------------------
// internal read-only widen：daemon.createSession 允许 read-only，HTTP /session/new 仍 400
// ---------------------------------------------------------------------------------------------

test('createSession mode:read-only 内部放行（不抢 active）；HTTP /session/new 同值仍 400', { timeout: 20_000 }, async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ daemon, http, root, H }) => {
    const r = daemon.createSession(root, { mode: 'read-only', activate: false });
    assert.ok(r.ok, 'internal read-only 建会话受理');
    const session = daemon.get(r.value.sessionId)!;
    assert.equal(session.snapshotResponse().mode, 'read-only', '装配档=read-only');
    assert.equal(daemon.activeId(), undefined, 'activate:false 不抢 active');
    // HTTP 面白名单不收窄（internal-only 扩面）：read-only 仍 400 invalid mode
    const resp = await fetch(`${http}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root, mode: 'read-only' }) });
    assert.equal(resp.status, 400, 'HTTP /session/new mode:read-only 仍拒');
    const body = (await resp.json()) as { error?: string };
    assert.equal(body.error, 'invalid mode');
    assert.equal(daemon.activeId(), undefined, '被拒请求不改 active');
  });
});
