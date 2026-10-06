import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionEvent } from '../../src/types';
import { emptyBoard } from './projection';
import { createConnection } from './connection';
import type { Connection, SnapshotResponse } from './connection';

/**
 * G3.5 连接层状态机桩测(会话维;jsdom 无真 WS/HTTP 服务面):WebSocket/fetch/setTimeout
 * 三桩驱动「每会话 seq 过滤 + 帧按 sessionId 分发 + 指数退避重连 + onReset 全量重放」
 * 全语义——真 WS 全链(subprotocol 鉴权/事件流/快照)在 e2e.test.ts 走真 daemon。假计时器
 * (vi.useFakeTimers)令退避序列可确定性断言;setTimeout spy 记录每次退避时长(1×2^n 帽 30s)。
 */

type FullSnapshot = SnapshotResponse & { lastSeq: number };

/** 最小 WS 桩:记录构造入参(url/protocols)与 close 调用;测试驱动面 openNow/recv/lose/fail */
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
  recv(sessionId: string, seq: number, e: SessionEvent): void {
    this.onmessage?.({ data: JSON.stringify({ kind: 'event', sessionId, seq, e }) });
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
/** 微任务冲刷:fetch 链(mock body/json/then 各占一拍)确定性落定 */
async function flush(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

describe('gui connection 状态机(会话维;WS/fetch/计时三桩)', () => {
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

  it('① 首连:connecting → onReset(先) → open(后);补发帧按 sessionId 分发,同会话等值/旧 seq 丢、每会话基线独立', async () => {
    const trace: string[] = [];
    conn = createConnection({
      baseUrl: 'http://127.0.0.1:7788/',
      token: 'tok-1',
      onEvent: (sessionId, _e, seq) => trace.push(`${sessionId}:${seq}`),
      onReset: () => trace.push('reset'),
      onStateChange: (st) => trace.push(`state:${st}`),
      backoffBaseMs: 1,
    });
    expect(conn.state()).toBe('connecting');
    const ws = last();
    expect(ws.url).toBe('ws://127.0.0.1:7788/events');
    expect(ws.protocols).toEqual(['bearer.tok-1']);
    // 建立:先 onReset(上层清投影)再进 open 态;建立后帧即投(无快照等待窗)
    ws.openNow();
    expect(trace).toEqual(['state:connecting', 'reset', 'state:open']);
    // daemon 连接即补发全部会话缓冲:两会话交错到达(daemon 按会话序逐会话补发,跨会话 seq 不保序)
    ws.recv('s1', 1, ev('token', 1));
    ws.recv('s2', 2, ev('token', 2));
    ws.recv('s1', 3, ev('token', 3));
    expect(trace).toEqual(['state:connecting', 'reset', 'state:open', 's1:1', 's2:2', 's1:3']);
    // 同会话等值/旧 seq 丢;s1 前进不拦 s2(每会话独立基线——全局单基线会误丢他会话帧)
    ws.recv('s1', 3, ev('token', 4));
    ws.recv('s1', 2, ev('token', 5));
    ws.recv('s2', 4, ev('token', 6));
    expect(trace).toEqual(['state:connecting', 'reset', 'state:open', 's1:1', 's2:2', 's1:3', 's2:4']);
  });

  it('② 掉线重连:onclose → reconnecting → 退避后新连 open → 第二次 onReset(基线清零全量重放);连续失败退避 1,2,4 递增', async () => {
    const seen: string[] = [];
    let resets = 0;
    conn = createConnection({
      baseUrl: 'http://127.0.0.1:7788',
      token: 't',
      onEvent: (sessionId, _e, seq) => seen.push(`${sessionId}:${seq}`),
      onReset: () => {
        resets += 1;
      },
      backoffBaseMs: 1,
    });
    const ws1 = last();
    ws1.openNow();
    ws1.recv('s1', 5, ev('token', 1)); // 旧连接已见 s1:5
    expect(conn.state()).toBe('open');
    // —— 掉线:reconnecting → 1ms 退避 → 新连接 ——
    ws1.lose();
    expect(conn.state()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1); // 退避 1×2^0 = 1ms
    const ws2 = last();
    expect(ws2).not.toBe(ws1);
    ws2.openNow();
    expect(resets).toBe(2); // 每次建立都 onReset(首连+重连同路径)
    expect(conn.state()).toBe('open');
    // 全量重放裁定:重连补发帧 seq ≤ 旧连接已见的 5 也投(上层已清投影,重放不双应用)
    ws2.recv('s1', 5, ev('token', 2));
    expect(seen).toEqual(['s1:5', 's1:5']);
    // —— 连续失败(其间无成功建立)退避递增 1→2→4;成功建立已把计数清零,故重启于 1 ——
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

  it('②b 退避帽:delay = min(base×2^n, 30000)——基数超帽也只等 30s', async () => {
    conn = createConnection({
      baseUrl: 'http://x/',
      token: 't',
      onEvent: () => {},
      onReset: () => {},
      backoffBaseMs: 40_000,
    });
    const ws1 = last();
    ws1.openNow();
    ws1.lose();
    expect(delays()).toEqual([30_000]);
  });

  it('③ 显式 close:closed + 断 socket + 清退避计时器;此后掉线事件不再造新连接', async () => {
    conn = createConnection({ baseUrl: 'http://x', token: 't', onEvent: () => {}, onReset: () => {}, backoffBaseMs: 1 });
    const ws1 = last();
    ws1.openNow();
    conn.close();
    expect(conn.state()).toBe('closed');
    expect(ws1.closeCalls).toBe(1);
    conn.close(); // 幂等
    expect(ws1.closeCalls).toBe(1);
    ws1.lose(); // close 后迟到的 onclose(真实 socket 会回放)
    await vi.runAllTimersAsync(); // 若退避计时器未清,此处会造出新连接
    expect(WsStub.instances.length).toBe(1);
    expect(conn.state()).toBe('closed');
  });

  it('③b 掉线转 reconnecting 后显式 close:已排定的重连被取消(onerror 路径同收口)', async () => {
    conn = createConnection({ baseUrl: 'http://x', token: 't', onEvent: () => {}, onReset: () => {}, backoffBaseMs: 1 });
    const ws1 = last();
    ws1.openNow();
    ws1.fail(); // onerror → 与 onclose 同收口
    expect(conn.state()).toBe('reconnecting');
    conn.close();
    await vi.runAllTimersAsync();
    expect(WsStub.instances.length).toBe(1);
    expect(conn.state()).toBe('closed');
  });

  it('④ seq 单调(每会话):乱序旧帧丢,新帧投且基线前进;非 event 帧/坏 JSON/无 seq/无 sessionId 帧忽略', async () => {
    const seen: string[] = [];
    conn = createConnection({
      baseUrl: 'http://x',
      token: 't',
      onEvent: (sessionId, _e, seq) => seen.push(`${sessionId}:${seq}`),
      onReset: () => {},
      backoffBaseMs: 1,
    });
    const ws = last();
    ws.openNow();
    ws.recv('s1', 8, ev('token', 1)); // 新 → 投,基线→8
    ws.recv('s1', 7, ev('token', 2)); // 乱序旧帧 → 丢
    ws.recv('s1', 6, ev('token', 3)); // 同上 → 丢
    expect(seen).toEqual(['s1:8']);
    // 非 event 帧(hello 等外形)、坏 JSON、无 seq/无 sessionId 的 event 帧:忽略且不动基线
    ws.onmessage?.({ data: JSON.stringify({ kind: 'hello' }) });
    ws.onmessage?.({ data: 'not-json' });
    ws.onmessage?.({ data: JSON.stringify({ kind: 'event', sessionId: 's1', e: ev('token', 4) }) });
    ws.onmessage?.({ data: JSON.stringify({ kind: 'event', seq: 9, e: ev('token', 5) }) });
    ws.recv('s1', 9, ev('token', 6));
    expect(seen).toEqual(['s1:8', 's1:9']);
  });

  it('⑤ sessionSnapshot:应答抬高该会话过滤基线(≤ lastSeq 迟到帧丢、> 投);他会话基线不受扰', async () => {
    const seen: string[] = [];
    conn = createConnection({
      baseUrl: 'http://x',
      token: 't',
      onEvent: (sessionId, _e, seq) => seen.push(`${sessionId}:${seq}`),
      onReset: () => {},
      backoffBaseMs: 1,
    });
    const ws = last();
    ws.openNow();
    fetchQueue.push(ok(snap(7)));
    const resp = await conn.sessionSnapshot('s1');
    expect(resp.lastSeq).toBe(7);
    await flush();
    ws.recv('s1', 7, ev('token', 1)); // ≤ 快照基线 → 丢(种子替换投影后双应用防线)
    ws.recv('s1', 8, ev('token', 2)); // > → 投
    ws.recv('s2', 3, ev('token', 3)); // 他会话独立基线 → 投
    expect(seen).toEqual(['s1:8', 's2:3']);
  });

  it('⑤b 慢到 snapshot 应答:掉线换代后落定不抬基线——不污新连接的全量重放窗', async () => {
    const seen: string[] = [];
    conn = createConnection({
      baseUrl: 'http://x',
      token: 't',
      onEvent: (sessionId, _e, seq) => seen.push(`${sessionId}:${seq}`),
      onReset: () => {},
      backoffBaseMs: 1,
    });
    const ws1 = last();
    ws1.openNow();
    fetchQueue.push(ok(snap(9)));
    const pending = conn.sessionSnapshot('s1'); // 发起于旧代
    ws1.lose(); // 掉线换代(应答在途)
    await vi.advanceTimersByTimeAsync(1);
    const ws2 = last();
    ws2.openNow(); // 新连接建立:基线清零
    expect(await pending).toMatchObject({ lastSeq: 9 }); // 慢到应答仍返回给调用方
    // 若慢到应答抬了基线,seq 6(≤9)会被误丢——全量重放窗必须放行
    ws2.recv('s1', 6, ev('token', 1));
    expect(seen).toEqual(['s1:6']);
  });

  it('⑥ HTTP 面(会话维):workspaces/sessionsOf/dirpicker/newSession/attach 与 :id 三动作的 URL/method/body;query 路径编码;非 2xx 抛错含 status', async () => {
    conn = createConnection({ baseUrl: 'http://127.0.0.1:7788', token: 'tok', onEvent: () => {}, onReset: () => {} });
    expect(conn.state()).toBe('connecting'); // WS 停在 connecting——HTTP 面独立可用
    fetchQueue.push(
      ok([{ slug: 'a', mtime: 1, sessionCount: 2 }]), // workspaces
      ok([]), // sessionsOf
      ok({ path: '/home', parent: '/', dirs: [] }), // dirpicker()
      ok({ path: '/w', parent: '/home', dirs: [] }), // dirpicker('/w')
      ok({ ok: true, sessionId: 's1' }), // newSession
      ok(), // attach
      ok(), // sessionSubmit
      ok(), // sessionSteer
      ok(), // sessionInterrupt
    );
    await conn.workspaces();
    await conn.sessionsOf('/root with space');
    await conn.dirpicker();
    await conn.dirpicker('/w');
    const { sessionId } = await conn.newSession('/w');
    expect(sessionId).toBe('s1');
    await conn.attach('s1', 'j1');
    await conn.sessionSubmit('s1', 'goal x');
    await conn.sessionSteer('s1', '运行中插话');
    await conn.sessionInterrupt('s1');
    expect(fetchLog.map((f) => f.url)).toEqual([
      'http://127.0.0.1:7788/workspaces',
      'http://127.0.0.1:7788/sessions?root=%2Froot%20with%20space',
      'http://127.0.0.1:7788/dirpicker',
      'http://127.0.0.1:7788/dirpicker?path=%2Fw',
      'http://127.0.0.1:7788/session/new',
      'http://127.0.0.1:7788/session/s1/attach',
      'http://127.0.0.1:7788/session/s1/submit',
      'http://127.0.0.1:7788/session/s1/steer',
      'http://127.0.0.1:7788/session/s1/interrupt',
    ]);
    expect(fetchLog[4]?.init?.method).toBe('POST');
    expect(fetchLog[4]?.init?.body).toBe(JSON.stringify({ root: '/w' }));
    expect(fetchLog[5]?.init?.body).toBe(JSON.stringify({ journalId: 'j1' }));
    expect(fetchLog[6]?.init?.body).toBe(JSON.stringify({ goal: 'goal x' }));
    expect(fetchLog[7]?.init?.body).toBe(JSON.stringify({ text: '运行中插话' }));
    // Bearer + json 头(POST 面)
    expect(fetchLog[6]?.init?.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' });
    // 非 2xx:错误消息含路径与 status
    fetchQueue.push(errResp(409));
    await expect(conn.sessionSubmit('s1', 'g')).rejects.toThrow('/session/s1/submit -> 409');
  });

  it('⑦ 旧名退役:返回面无裸端点方法 submit/steer/interrupt/snapshot(G3.5 删旧名裁定——compile 层互补的运行时形状断言)', () => {
    conn = createConnection({ baseUrl: 'http://x', token: 't', onEvent: () => {}, onReset: () => {} });
    const face = conn as unknown as Record<string, unknown>;
    expect(face.submit).toBeUndefined();
    expect(face.steer).toBeUndefined();
    expect(face.interrupt).toBeUndefined();
    expect(face.snapshot).toBeUndefined();
    // 会话维新面在场
    expect(typeof conn.sessionSubmit).toBe('function');
    expect(typeof conn.sessionSteer).toBe('function');
    expect(typeof conn.sessionInterrupt).toBe('function');
    expect(typeof conn.sessionSnapshot).toBe('function');
    expect(typeof conn.workspaces).toBe('function');
    expect(typeof conn.sessionsOf).toBe('function');
    expect(typeof conn.dirpicker).toBe('function');
    expect(typeof conn.newSession).toBe('function');
    expect(typeof conn.attach).toBe('function');
  });
});
