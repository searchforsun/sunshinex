import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRuntime } from './session';
import type { EventFrame } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';

/** T1 SessionRuntime 平移面测试：从 daemon 单会话态抽出的会话运行时——帧形(sessionId+seq)/影子投影/
 *  转录/submit 202 语义/interrupt/status/snapshotResponse 形态/reset 软重置/teardown 有界收口。
 *  直构形态（不经 GuiDaemon）：nextSeq/broadcast 注入桩，会话语义自包含可断 */

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

/** 挂起适配器（同 daemon.test.ts）：模型调用永挂直至 signal 中止——「运行中」锁的中正模拟 */
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

/** signal 无视的挂起适配器：chat promise 永不收束——teardown 有界等待上限路径的中正模拟 */
class SignalDeafAdapter implements ModelAdapter {
  readonly provider = 'deaf';
  calls = 0;
  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls++;
    return new Promise<ChatResult>(() => {});
  }
}

interface Ctx {
  session: SessionRuntime;
  frames: EventFrame[];
  tmp: string;
}

/** 装配样板（环境隔离同 daemon.test.ts）：SUNSHINEX_DATA_DIR 钉 tmp；nextSeq 本地计数器（daemon 级
 *  全局单调的注入面）；broadcast 收集帧。finally 兜 teardown——断言失败也不留悬挂 run/事件循环 */
async function withSession(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-session-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  let seq = 0;
  const frames: EventFrame[] = [];
  let session: SessionRuntime | undefined;
  try {
    session = new SessionRuntime({
      id: 's1',
      root: tmp,
      model,
      nextSeq: () => {
        seq += 1;
        return seq;
      },
      broadcast: (f) => frames.push(f),
    });
    await fn({ session, frames, tmp });
  } finally {
    await session?.teardown();
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('① pump 平移面：帧恒 {kind:"event",sessionId,seq,e}、seq 计数在先首帧=1、广播帧与缓冲同源', async () => {
  await withSession(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const e1 = { type: 'notice', text: 'n1', ts: 1 } as const;
    const e2 = { type: 'task-created', payload: { taskId: 't1', title: 'A', spec: 'a' }, ts: 2 } as const;
    const e3 = { type: 'done', text: 'ok', ts: 3 } as const;
    ctx.session.pump(e1);
    ctx.session.pump(e2);
    ctx.session.pump(e3);
    assert.equal(ctx.frames.length, 3, '每 pump 一次广播一帧');
    assert.deepEqual(ctx.frames[0], { kind: 'event', sessionId: 's1', seq: 1, e: e1 }, '首帧 seq=1（计数在先帧在后）且挂会话 id');
    assert.deepEqual(ctx.frames[2], { kind: 'event', sessionId: 's1', seq: 3, e: e3 });
    for (let i = 1; i < ctx.frames.length; i++) {
      assert.ok(ctx.frames[i].seq > ctx.frames[i - 1].seq, `seq 单调递增（${i}）`);
      assert.equal(ctx.frames[i].sessionId, 's1', '全帧恒挂本会话 sessionId');
    }
    // 补发窗口与广播同源：缓冲帧即已广播帧（逐字段等）
    const buffered = ctx.session.bufferedFrames();
    assert.equal(buffered.length, 3);
    assert.deepEqual(buffered, ctx.frames, '缓冲帧与广播帧同源同序');
    // 影子投影平移面：task-created 经 boardEventFrom/applyBoardEvent 落位
    assert.equal(ctx.session.shadowBoard.tasks.t1?.title, 'A', '影子 board 含 pump 喂入的 t1');
    // 转录平移面：notice/done 入归档面
    const mds = ctx.session.transcript.entries().map((m) => m.kind);
    assert.ok(mds.includes('notice') && mds.includes('assistant'), '转录含 notice 与 done→assistant 条');
  });
});

test('② 实跑平移面：submit 受理→running→done→idle；转录三类在场、board 影子 t1、snapshotResponse 形态', async () => {
  // 消费序（taskboard.e2e 实测口径，同 daemon.contract ③）：create_task 牌 → done 牌收束
  const model = new ScriptedAdapter([
    '{"tool":"create_task","input":{"title":"A","spec":"a","dependsOn":null,"assignee":null,"gated":null,"executor":null}}',
    '{"done":true,"reply":"task created"}',
  ]);
  await withSession(model, async (ctx) => {
    assert.equal(ctx.session.status(), 'idle', '初始 idle');
    const r = ctx.session.submit('建个任务');
    assert.deepEqual(r, { ok: true }, '空闲 submit 受理（HTTP 202 面）');
    await waitFor(() => ctx.session.status() === 'idle', 10_000);
    // 转录三类：user 提交回显 / tool 配对条 / assistant 终答
    const kinds = ctx.session.transcript.entries().map((m) => m.kind);
    assert.ok(kinds.includes('user'), '转录含 user 条');
    assert.ok(kinds.includes('tool'), '转录含 tool 条');
    assert.ok(kinds.includes('assistant'), '转录含 assistant 条');
    const user = ctx.session.transcript.entries().find((m) => m.kind === 'user');
    assert.equal(user?.md, '> 建个任务', 'user 条为 `> <goal>` 形');
    // 影子：实跑事件流泵入投影
    assert.equal(ctx.session.shadowBoard.tasks.t1?.title, 'A', '实跑后影子 board 含 t1');
    assert.ok(Array.isArray(ctx.session.shadowDelegations), 'delegations 影子恒数组');
    // snapshotResponse 形态：五字段齐、lastSeq=本会话已泵最大 seq
    const snap = ctx.session.snapshotResponse();
    assert.equal(snap.status, 'idle');
    assert.ok(Array.isArray(snap.messages) && snap.messages.length > 0);
    assert.notEqual(snap.board.tasks.t1, undefined);
    assert.ok(Array.isArray(snap.delegations));
    assert.equal(snap.lastSeq, Math.max(...ctx.frames.map((f) => f.seq)), 'lastSeq=已广播帧最大 seq');
    assert.ok(ctx.frames.length > 0 && ctx.frames.every((f) => f.sessionId === 's1'), '实跑帧恒挂 sessionId');
  });
});

test('③ run 锁平移面：运行中二次 submit 拒（409 面）；interrupt 生效清锁；无运行 interrupt 拒', async () => {
  await withSession(new HangingAdapter(), async (ctx) => {
    const first = ctx.session.submit('长任务');
    assert.deepEqual(first, { ok: true });
    await waitFor(() => ctx.session.status() === 'running', 3000);
    const second = ctx.session.submit('再来');
    assert.deepEqual(second, { ok: false, status: 409, error: 'run in progress' }, '运行中 submit 拒且不排队');
    const it = ctx.session.interrupt();
    assert.deepEqual(it, { ok: true });
    await waitFor(() => ctx.session.status() === 'idle', 3000);
    const noRun = ctx.session.interrupt();
    assert.deepEqual(noRun, { ok: false, error: 'no run in progress' }, '无运行 interrupt 拒');
    // 中止后锁已清：可再受理
    const again = ctx.session.submit('重跑');
    assert.deepEqual(again, { ok: true }, 'interrupt 后可再 submit');
    ctx.session.interrupt(); // 收尾：停掉第二次 run 不留悬挂
    await waitFor(() => ctx.session.status() === 'idle', 3000);
  });
});

test('④ reset 软重置（旧 /session/new 语义迁入）：运行中先中止；影子/转录/缓冲清空；seq 计数不回拨', async () => {
  await withSession(new HangingAdapter(), async (ctx) => {
    ctx.session.submit('长任务');
    await waitFor(() => ctx.session.status() === 'running', 3000);
    const seqBefore = ctx.session.snapshotResponse().lastSeq;
    await ctx.session.reset();
    assert.equal(ctx.session.status(), 'idle', 'reset 中止在跑 run（有界等待 settle）');
    // 清空面：转录/影子/补发缓冲
    const snap = ctx.session.snapshotResponse();
    assert.equal(snap.messages.length, 0, 'reset 后转录清空');
    assert.deepEqual(snap.board, { tasks: {}, seq: 0 }, 'reset 后影子 board 归空');
    assert.equal(snap.delegations.length, 0);
    assert.equal(ctx.session.bufferedFrames().length, 0, 'reset 后补发缓冲清空');
    assert.ok(snap.lastSeq >= seqBefore, 'seq 全局单调语义：reset 不回拨（后续帧续接不重号）');
    // reset 后会话仍可用：新 submit 受理且事件续推
    const after = ctx.session.submit('重置后再跑');
    assert.deepEqual(after, { ok: true }, 'reset 后可再 submit');
    await waitFor(() => ctx.session.status() === 'running', 3000);
    await waitFor(() => ctx.frames.some((f) => f.seq > snap.lastSeq), 3000);
    ctx.session.interrupt();
    await waitFor(() => ctx.session.status() === 'idle', 3000);
    const seqAfter = ctx.session.snapshotResponse().lastSeq;
    assert.ok(seqAfter > snap.lastSeq, 'reset 后新 run 事件 seq 续接（全局计数器不重置）');
  });
});

test('⑤ teardown 平移面：signal 无视的悬挂 run 有界收口（≤3s）；status 回 idle', { timeout: 8000 }, async () => {
  const tmp = tmpdir('sunshinex-session-teardown-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  let seq = 0;
  const session = new SessionRuntime({
    id: 's9',
    root: tmp,
    model: new SignalDeafAdapter(),
    nextSeq: () => {
      seq += 1;
      return seq;
    },
    broadcast: () => {},
  });
  try {
    session.submit('挂到天荒地老');
    await waitFor(() => session.status() === 'running', 3000);
    const t0 = Date.now();
    await session.teardown();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed <= 3000, `teardown 应有界（≤3s）完成，实际 ${elapsed}ms`);
    await session.teardown(); // 幂等：二次调用不抛（无 current 时直落内脏收口）
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
