import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionEvent } from '../../src/types';
import { emptyBoard } from './projection';
import { createConnection } from './connection';
import type { Connection, SnapshotResponse } from './connection';

/**
 * G3 连接层状态机桩测（jsdom 无真 WS/HTTP 服务面）：WebSocket/fetch/setTimeout 三桩驱动
 * 「seq 单调过滤 + 指数退避重连 + onResync 基线重置」全语义——真 WS 全链（subprotocol
 * 鉴权/事件流/快照）在 e2e.test.ts 走真 daemon。假计时器（vi.useFakeTimers）令退避序列
 * 可确定性断言；setTimeout spy 记录每次退避时长（1×2^n 帽 30s 的序列面）。
 */

type FullSnapshot = SnapshotResponse & { lastSeq: number };

/** 最小 WS 桩：记录构造入参（url/protocols）与 close 调用；测试驱动面 openNow/recv/lose/fail */
class WsStub {
  static instances: WsStub[] = [];
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;
  private closed = false;
  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    WsStub.instances.push(this);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls++;
  }
  openNow(): void {
    this.onopen?.();
  }
  recv(seq: number, e: SessionEvent): void {
    this.onmessage?.({ data: JSON.stringify({ kind: 'event', seq, e }) });
  }
  lose(): void {
    this.onclose?.();
  }
  fail(): void {
    this.onerror?.();
  }
}

interface RespLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
const ok = (json: unknown = {}): RespLike => ({ ok: true, status: 200, json: async () => json });
const errResp = (status: number): RespLike => ({ ok: false, status, json: async () => ({}) });
const snap = (lastSeq: number): FullSnapshot => ({
  messages: [],
  board: emptyBoard(),
  delegations: [],
  status: 'idle',
  lastSeq,
});
const ev = (type: SessionEvent['type'], ts: number): SessionEvent => ({ type, ts });

let conn: Connection | undefined;
let delaySpy: ReturnType<typeof vi.spyOn>;
let fetchQueue: RespLike[];
const fetchLog: Array<{ url: string; init: RequestInit | undefined }> = [];

const last = (): WsStub => WsStub.instances.at(-1)!;
const delays = (): number[] =>
  delaySpy.mock.calls.map((c) => c[1]).filter((ms): ms is number => typeof ms === 'number');
/** 微任务冲刷：fetch 链（mock body/json/then 各占一拍）确定性落定 */
async function flush(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}
/** 驱动一条连接走完 open → snapshot → onResync → open（帧面就绪） */
async function establish(ws: WsStub, lastSeq: number): Promise<void> {
  fetchQueue.push(ok(snap(lastSeq)));
  ws.openNow();
  await flush();
}

describe('gui connection 状态机（WS/fetch/计时三桩）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delaySpy = vi.spyOn(globalThis, 'setTimeout');
    WsStub.instances = [];
    vi.stubGlobal('WebSocket', WsStub);
    fetchQueue = [];
    fetchLog.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchLog.push({ url, init });
        const r = fetchQueue.shift();
        if (r === undefined) throw new Error(`test: unexpected fetch ${url}`);
        return r;
      }),
    );
  });
  afterEach(() => {
    conn?.close();
    conn = undefined;
    vi.unstubAllGlobals();
    delaySpy.mockRestore();
    vi.useRealTimers();
  });

  it('① 首连：connecting → open 先 snapshot → onResync → open；snapshot 完成前的补发帧缓冲后统一过滤投递（seq ≤ lastSeq 丢）', async () => {
    const trace: string[] = [];
    conn = createConnection({
      baseUrl: 'http://127.0.0.1:7788/',
      token: 'tok-1',
      onEvent: (_e, seq) => trace.push(`event:${seq}`),
      onResync: (s) => trace.push(`resync:${(s as FullSnapshot).lastSeq}`),
      onStateChange: (st) => trace.push(`state:${st}`),
      backoffBaseMs: 1,
    });
    expect(conn.state()).toBe('connecting');
    const ws = last();
    expect(ws.url).toBe('ws://127.0.0.1:7788/events');
    expect(ws.protocols).toEqual(['bearer.tok-1']);
    // snapshot 在途：补发帧先缓冲不投（防漏——基线落定前不能判新旧，防双应用——基线落定后统一过滤）
    fetchQueue.push(ok(snap(5)));
    ws.openNow();
    ws.recv(4, ev('token', 1)); // ≤ 基线 5 → snapshot 后丢弃
    ws.recv(6, ev('token', 2)); // > 5 → 投
    expect(trace).toEqual(['state:connecting']);
    await flush();
    // 序裁定：resync（基线）先于 open 态，open 后缓冲帧才过滤投递
    expect(trace).toEqual(['state:connecting', 'resync:5', 'state:open', 'event:6']);
    // 就绪后实时帧：旧 seq 丢、新 seq 前进
    ws.recv(3, ev('token', 3));
    ws.recv(7, ev('token', 4));
    expect(trace).toEqual(['state:connecting', 'resync:5', 'state:open', 'event:6', 'event:7']);
  });

  it('② 掉线重连：onclose → reconnecting → 退避后新连 open → 第二次 onResync（lastSeq 基线重置）；连续失败退避 1,2,4 递增', async () => {
    const seen: number[] = [];
    const resyncs: number[] = [];
    conn = createConnection({
      baseUrl: 'http://127.0.0.1:7788',
      token: 't',
      onEvent: (_e, seq) => seen.push(seq),
      onResync: (s) => resyncs.push((s as FullSnapshot).lastSeq),
      backoffBaseMs: 1,
    });
    const ws1 = last();
    await establish(ws1, 5);
    expect(conn.state()).toBe('open');
    // —— 掉线：reconnecting → 1ms 退避 → 新连接 ——
    ws1.lose();
    expect(conn.state()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1); // 退避 1×2^0 = 1ms
    const ws2 = last();
    expect(ws2).not.toBe(ws1);
    await establish(ws2, 9);
    expect(resyncs).toEqual([5, 9]); // 第二次 onResync：基线重置为新快照 lastSeq
    expect(conn.state()).toBe('open');
    ws2.recv(7, ev('token', 5)); // ≤ 新基线 9 → 丢（重连补发双应用根除）
    ws2.recv(10, ev('token', 6));
    expect(seen).toEqual([10]);
    // —— 连续失败（其间无成功建立）退避递增 1→2→4；成功建立已把计数清零，故重启于 1 ——
    ws2.lose();
    expect(conn.state()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1);
    last().lose();
    await vi.advanceTimersByTimeAsync(2);
    last().lose();
    await vi.advanceTimersByTimeAsync(4);
    expect(WsStub.instances.length).toBe(5);
    expect(delays()).toEqual([1, 1, 2, 4]);
  });

  it('②b 退避帽：delay = min(base×2^n, 30000)——基数超帽也只等 30s', async () => {
    conn = createConnection({
      baseUrl: 'http://x/',
      token: 't',
      onEvent: () => {},
      onResync: () => {},
      backoffBaseMs: 40_000,
    });
    const ws1 = last();
    await establish(ws1, 1);
    ws1.lose();
    expect(delays()).toEqual([30_000]);
  });

  it('③ 显式 close：closed + 断 socket + 清退避计时器；此后掉线事件不再造新连接', async () => {
    conn = createConnection({ baseUrl: 'http://x', token: 't', onEvent: () => {}, onResync: () => {}, backoffBaseMs: 1 });
    const ws1 = last();
    await establish(ws1, 3);
    conn.close();
    expect(conn.state()).toBe('closed');
    expect(ws1.closeCalls).toBe(1);
    conn.close(); // 幂等
    expect(ws1.closeCalls).toBe(1);
    ws1.lose(); // close 后迟到的 onclose（真实 socket 会回放）
    await vi.runAllTimersAsync(); // 若退避计时器未清，此处会造出新连接
    expect(WsStub.instances.length).toBe(1);
    expect(conn.state()).toBe('closed');
  });

  it('③b 掉线转 reconnecting 后显式 close：已排定的重连被取消（onerror 路径同收口）', async () => {
    conn = createConnection({ baseUrl: 'http://x', token: 't', onEvent: () => {}, onResync: () => {}, backoffBaseMs: 1 });
    const ws1 = last();
    await establish(ws1, 3);
    ws1.fail(); // onerror → 与 onclose 同收口
    expect(conn.state()).toBe('reconnecting');
    conn.close();
    await vi.runAllTimersAsync();
    expect(WsStub.instances.length).toBe(1);
    expect(conn.state()).toBe('closed');
  });

  it('④ seq 单调：等值/乱序旧帧丢，新帧投且 lastSeq 前进；非 event 帧与坏 JSON 忽略', async () => {
    const seen: number[] = [];
    conn = createConnection({
      baseUrl: 'http://x',
      token: 't',
      onEvent: (_e, seq) => seen.push(seq),
      onResync: () => {},
      backoffBaseMs: 1,
    });
    const ws = last();
    await establish(ws, 5);
    ws.recv(5, ev('token', 1)); // 等值 → 丢
    ws.recv(8, ev('token', 2)); // 新 → 投，lastSeq→8
    ws.recv(7, ev('token', 3)); // 乱序旧帧（高于旧基线但低于当前）→ 丢
    ws.recv(6, ev('token', 4)); // 同上 → 丢
    expect(seen).toEqual([8]);
    // 非 event 帧（hello 等外形）、坏 JSON、无 seq 的 event 帧：忽略且不动 lastSeq
    ws.onmessage?.({ data: JSON.stringify({ kind: 'hello' }) });
    ws.onmessage?.({ data: 'not-json' });
    ws.onmessage?.({ data: JSON.stringify({ kind: 'event', e: ev('token', 5) }) });
    ws.recv(9, ev('token', 6));
    expect(seen).toEqual([8, 9]);
  });

  it('⑤ HTTP 面：steer 透传 POST /steer {text}（Bearer+json）；submit 非 2xx 抛错且消息含 status', async () => {
    conn = createConnection({ baseUrl: 'http://127.0.0.1:7788', token: 'tok', onEvent: () => {}, onResync: () => {} });
    expect(conn.state()).toBe('connecting'); // WS 停在 connecting——HTTP 面独立可用
    fetchQueue.push(ok(), errResp(409));
    await conn.steer('调整方向');
    expect(fetchLog[0]?.url).toBe('http://127.0.0.1:7788/steer');
    expect(fetchLog[0]?.init?.method).toBe('POST');
    expect(fetchLog[0]?.init?.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' });
    expect(fetchLog[0]?.init?.body).toBe(JSON.stringify({ text: '调整方向' }));
    await expect(conn.submit('goal')).rejects.toThrow('/submit -> 409');
    expect(fetchLog[1]?.url).toBe('http://127.0.0.1:7788/submit');
    expect(fetchLog[1]?.init?.body).toBe(JSON.stringify({ goal: 'goal' }));
  });
});
