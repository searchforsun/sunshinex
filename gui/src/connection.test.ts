import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionEvent } from '../../src/types';
import { emptyBoard } from './projection';
import { createConnection } from './connection';
import type { Connection, SnapshotResponse, SettingsView } from './connection';

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
  /** G4 挂起帧(approval/ask:顶层 pid + req;对齐 daemon ApprovalFrame/AskFrame 形) */
  recvApproval(sessionId: string, pid: string, req: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ kind: 'approval', sessionId, pid, req }) });
  }
  recvAsk(sessionId: string, pid: string, req: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ kind: 'ask', sessionId, pid, req }) });
  }
  /** G4 reset 通知帧(只挂 kind+sessionId,无 seq/pid) */
  recvReset(sessionId: string): void {
    this.onmessage?.({ data: JSON.stringify({ kind: 'reset', sessionId }) });
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
    // G4 回执/回收面在场
    expect(typeof conn.replyApproval).toBe('function');
    expect(typeof conn.replyAsk).toBe('function');
    expect(typeof conn.deleteSession).toBe('function');
  });

  it('⑧ G4 挂起/reset 帧路由:approval/ask 按 (sessionId,pid,req) 回调;pid 去重(重连重发幂等);reset 不去重(帧帧回调)', async () => {
    const approvals: Array<[string, string, unknown]> = [];
    const asks: Array<[string, string, unknown]> = [];
    const resets: string[] = [];
    conn = createConnection({
      baseUrl: 'http://x',
      token: 't',
      onEvent: () => {},
      onReset: () => {},
      onApproval: (sessionId, pid, req) => approvals.push([sessionId, pid, req]),
      onAsk: (sessionId, pid, req) => asks.push([sessionId, pid, req]),
      onResetSession: (sessionId) => resets.push(sessionId),
      backoffBaseMs: 1,
    });
    const ws = last();
    ws.openNow();
    // —— 三 kind 各投:回调收 (sessionId, 帧顶层 pid, req 原文) ——
    const apReq = { id: 'ap-1', kind: 'write', subject: 'rm -rf /tmp/x', reason: 'destructive' };
    const askReq = { question: 'which?', options: [{ label: 'a' }, { label: 'b' }], multiple: true, customIndex: 2 };
    ws.recvApproval('s1', 'p-ap', apReq);
    ws.recvAsk('s2', 'p-ask', askReq);
    ws.recvReset('s1');
    expect(approvals).toEqual([['s1', 'p-ap', apReq]]);
    expect(asks).toEqual([['s2', 'p-ask', askReq]]);
    expect(resets).toEqual(['s1']);
    // —— pid 去重:同 pid 重复帧(approval/ask)只回调一次 ——
    ws.recvApproval('s1', 'p-ap', apReq);
    ws.recvApproval('s1', 'p-ap', apReq);
    ws.recvAsk('s2', 'p-ask', askReq);
    expect(approvals).toHaveLength(1);
    expect(asks).toHaveLength(1);
    // —— 异 pid 照常投;跨会话同 pid 也去重(pid 是 daemon 级铸票,全局唯一) ——
    ws.recvApproval('s1', 'p-ap2', apReq);
    expect(approvals).toHaveLength(2);
    // —— reset 不去重:每次到达都回调(一次 HTTP reset = 一次通知帧) ——
    ws.recvReset('s1');
    ws.recvReset('s1');
    expect(resets).toEqual(['s1', 's1', 's1']);
    // —— 坏形态忽略:无 sessionId / 无 pid / req 非对象 ——
    ws.onmessage?.({ data: JSON.stringify({ kind: 'approval', pid: 'p-x', req: apReq }) });
    ws.onmessage?.({ data: JSON.stringify({ kind: 'approval', sessionId: 's1', req: apReq }) });
    ws.onmessage?.({ data: JSON.stringify({ kind: 'ask', sessionId: 's1', pid: 'p-y' }) });
    ws.onmessage?.({ data: JSON.stringify({ kind: 'reset' }) });
    expect(approvals).toHaveLength(2);
    expect(asks).toHaveLength(1);
    expect(resets).toHaveLength(3);
    // —— 重连重发幂等:掉线重连后 daemon 同 pid 重发 → 仍零新增回调 ——
    ws.lose();
    await vi.advanceTimersByTimeAsync(1);
    const ws2 = last();
    ws2.openNow();
    ws2.recvApproval('s1', 'p-ap', apReq);
    ws2.recvAsk('s2', 'p-ask', askReq);
    expect(approvals).toHaveLength(2);
    expect(asks).toHaveLength(1);
  });

  it('⑨ G4 回执/回收 HTTP 面:replyApproval/replyAsk/deleteSession 的 URL/method/body;非 2xx 抛错含 status', async () => {
    conn = createConnection({ baseUrl: 'http://127.0.0.1:7788', token: 'tok', onEvent: () => {}, onReset: () => {} });
    const answer = { type: 'selected', labels: ['a', 'b'] } as const;
    fetchQueue.push(ok(), ok(), ok(), ok(), ok(), ok());
    await conn.replyApproval('p 1', 'always');
    await conn.replyAsk('p/2', answer);
    await conn.replyAsk('p/2', { type: 'custom', text: '自定义答复' });
    await conn.replyAsk('p/2', { type: 'dismissed' });
    await conn.deleteSession('s 9');
    await conn.deleteSession('s9');
    expect(fetchLog.map((f) => f.url)).toEqual([
      'http://127.0.0.1:7788/approval/p%201',
      'http://127.0.0.1:7788/ask/p%2F2/reply',
      'http://127.0.0.1:7788/ask/p%2F2/reply',
      'http://127.0.0.1:7788/ask/p%2F2/reply',
      'http://127.0.0.1:7788/session/s%209/delete',
      'http://127.0.0.1:7788/session/s9/delete',
    ]);
    expect(fetchLog.map((f) => f.init?.method)).toEqual(Array(6).fill('POST'));
    expect(fetchLog[0]?.init?.body).toBe(JSON.stringify({ decision: 'always' }));
    expect(fetchLog[1]?.init?.body).toBe(JSON.stringify({ answer }));
    expect(fetchLog[2]?.init?.body).toBe(JSON.stringify({ answer: { type: 'custom', text: '自定义答复' } }));
    expect(fetchLog[3]?.init?.body).toBe(JSON.stringify({ answer: { type: 'dismissed' } }));
    expect(fetchLog[4]?.init?.body).toBeUndefined(); // delete 无 body
    // 已决 pid 404 → 抛错含路径与 status(GUI 侧失败也移卡,不静默吞)
    fetchQueue.push(errResp(404));
    await expect(conn.replyApproval('p-1', 'allow')).rejects.toThrow('/approval/p-1 -> 404');
  });

  it('⑩ G8c 设置读面(GET):settings/settingsRaw/mcpServers/agentsView/skillsGroups/memoryStats 的 URL/query 形与应答解码;root 缺省省查询参;路径编码', async () => {
    conn = createConnection({ baseUrl: 'http://127.0.0.1:7788', token: 'tok', onEvent: () => {}, onReset: () => {} });
    const view: SettingsView = {
      keys: [
        { key: 'model', value: 'openai/gpt', source: 'project', envOverride: false },
        { key: 'apiKey', value: 'sk-env', source: 'env', envOverride: true },
      ],
      permissions: {
        merged: { deny: ['Bash(rm:*)'], allow: ['Read'], additionalDirs: ['/tmp'] },
        project: { deny: [], allow: ['Read'], additionalDirs: [] },
        global: { deny: ['Bash(rm:*)'], allow: [], additionalDirs: ['/tmp'] },
      },
      providers: {
        choices: [
          { id: 'openai/gpt', provider: 'openai', model: 'gpt', baseUrl: 'https://api.x', apiKeyEnv: 'SUNSHINEX_API_KEY_OPENAI' },
        ],
        apiKeyPresent: { openai: true },
        warnings: ['provider "local" has no models'],
      },
    };
    fetchQueue.push(
      ok(view), // settings('/w 1')(路径含空格——编码面)
      ok(view), // settings()(root 缺省 = 仅全局+env 面)
      ok({ content: '{\n  // JSONC 原文\n}\n' }), // settingsRaw('project','/w','mcp')
      ok({ content: null }), // settingsRaw('global', undefined,'settings')(缺文件空态)
      ok({
        servers: [
          { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], envKeys: ['KEY'], source: 'project', shadowed: false },
          { name: 'web', transport: 'http', url: 'https://mcp.x', envKeys: [], source: 'global', shadowed: true },
        ],
      }), // mcpServers('/w')
      ok({
        builtins: [{ role: 'planner', name: 'Planner', framing: 'requirement breakdown, solution and plan' }],
        view: {
          entries: [
            {
              id: 'coder',
              name: 'Coder',
              description: '写码',
              memory: true,
              source: 'project',
              shadowed: false,
              bodyPreview: '正文预览',
            },
            { id: 'coder', name: 'Coder', source: 'global', shadowed: true, bodyPreview: '' },
          ],
          warnings: ['/g/agents/bad/agent.md: malformed frontmatter'],
        },
      }), // agentsView()(root 缺省 = 仅全局清单)
      ok({
        groups: [
          { source: 'project', skills: [{ id: 'pdf', name: 'PDF', description: 'pdf 工具' }] },
          { source: 'user', skills: [{ id: 'scratch' }] },
          { source: 'learned', skills: [] },
        ],
      }), // skillsGroups('/w')
      ok({ entries: 0, lastWriteAt: null }), // memoryStats()(root 缺省 = 零值)
    );
    // —— 应答解码(结构直读,union/嵌套面全展开) ——
    await expect(conn.settings('/w 1')).resolves.toEqual(view);
    await expect(conn.settings()).resolves.toEqual(view);
    await expect(conn.settingsRaw('project', '/w', 'mcp')).resolves.toEqual({ content: '{\n  // JSONC 原文\n}\n' });
    await expect(conn.settingsRaw('global', undefined, 'settings')).resolves.toEqual({ content: null });
    await expect(conn.mcpServers('/w')).resolves.toEqual({
      servers: [
        { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], envKeys: ['KEY'], source: 'project', shadowed: false },
        { name: 'web', transport: 'http', url: 'https://mcp.x', envKeys: [], source: 'global', shadowed: true },
      ],
    });
    await expect(conn.agentsView()).resolves.toEqual({
      builtins: [{ role: 'planner', name: 'Planner', framing: 'requirement breakdown, solution and plan' }],
      view: {
        entries: [
          { id: 'coder', name: 'Coder', description: '写码', memory: true, source: 'project', shadowed: false, bodyPreview: '正文预览' },
          { id: 'coder', name: 'Coder', source: 'global', shadowed: true, bodyPreview: '' },
        ],
        warnings: ['/g/agents/bad/agent.md: malformed frontmatter'],
      },
    });
    await expect(conn.skillsGroups('/w')).resolves.toEqual({
      groups: [
        { source: 'project', skills: [{ id: 'pdf', name: 'PDF', description: 'pdf 工具' }] },
        { source: 'user', skills: [{ id: 'scratch' }] },
        { source: 'learned', skills: [] },
      ],
    });
    await expect(conn.memoryStats()).resolves.toEqual({ entries: 0, lastWriteAt: null });
    // —— URL 面:root 缺省省查询参;scope/file 定序;root 路径编码 ——
    expect(fetchLog.map((f) => f.url)).toEqual([
      'http://127.0.0.1:7788/settings?root=%2Fw%201',
      'http://127.0.0.1:7788/settings',
      'http://127.0.0.1:7788/settings/raw?scope=project&root=%2Fw&file=mcp',
      'http://127.0.0.1:7788/settings/raw?scope=global&file=settings',
      'http://127.0.0.1:7788/settings/mcp?root=%2Fw',
      'http://127.0.0.1:7788/settings/agents',
      'http://127.0.0.1:7788/settings/skills?root=%2Fw',
      'http://127.0.0.1:7788/settings/memory-stats',
    ]);
    // 读面全 GET 缺省(init.method 不出现)+ Bearer 头(getJson 单点惯例)
    expect(fetchLog.every((f) => f.init?.method === undefined)).toBe(true);
    expect(fetchLog[0]?.init?.headers).toEqual({ authorization: 'Bearer tok' });
    // 非 2xx 透传既有惯例:错误消息含路径与 status
    fetchQueue.push(errResp(400));
    await expect(conn.settingsRaw('project', undefined, 'settings')).rejects.toThrow('/settings/raw?scope=project&file=settings -> 400');
  });

  it('⑩b G8d agentBody(GET /settings/agents/body):URL/query 形(scope&id&root 缺省省参)+ 应答解码;404/400 以 HTTP 失败抛错含 status', async () => {
    conn = createConnection({ baseUrl: 'http://127.0.0.1:7788', token: 'tok', onEvent: () => {}, onReset: () => {} });
    fetchQueue.push(
      ok({ body: 'frontmatter 之后的完整正文\n多行原样\n' }), // agentBody('project','writer','/w 1')(root 路径编码面)
      ok({ body: '' }), // agentBody('global','mini')(root 缺省省参;空正文合法态)
    );
    await expect(conn.agentBody('project', 'writer', '/w 1')).resolves.toEqual({ body: 'frontmatter 之后的完整正文\n多行原样\n' });
    await expect(conn.agentBody('global', 'mini')).resolves.toEqual({ body: '' });
    // URL 面:root 缺省省查询参(settings 系同款);id 编码
    expect(fetchLog.map((f) => f.url)).toEqual([
      'http://127.0.0.1:7788/settings/agents/body?scope=project&id=writer&root=%2Fw%201',
      'http://127.0.0.1:7788/settings/agents/body?scope=global&id=mini',
    ]);
    expect(fetchLog.every((f) => f.init?.method === undefined)).toBe(true); // 读面全 GET
    expect(fetchLog[0]?.init?.headers).toEqual({ authorization: 'Bearer tok' });
    // 404(缺文件)/400(畸形 frontmatter)透传:错误消息含路径与 status
    fetchQueue.push(errResp(404));
    await expect(conn.agentBody('global', 'gone')).rejects.toThrow('/settings/agents/body?scope=global&id=gone -> 404');
    fetchQueue.push(errResp(400));
    await expect(conn.agentBody('project', 'broken', '/w')).rejects.toThrow('/settings/agents/body?scope=project&id=broken&root=%2Fw -> 400');
  });

  it('⑪ G8c 设置写面(PUT/POST):putSettings/putSettingsRaw/putMcpServers/putAgent/mcpProbe 的 URL/verb/body;void PUT 不解析应答体(200 空体过);非 2xx 抛错含 status', async () => {
    conn = createConnection({ baseUrl: 'http://127.0.0.1:7788', token: 'tok', onEvent: () => {}, onReset: () => {} });
    // void 写面应答不解析:json() 一经调用即抛——锁「200 {ok} 只查 ok 不读体」(空体 200 同过)
    const bareOk = (): RespLike => ({ ok: true, status: 200, json: async () => { throw new Error('test: void PUT must not read body'); } });
    const servers = [
      { name: 'fs', command: 'npx', args: ['-y', 'fs-mcp'], env: { KEY: 'V' } },
      { name: 'remote', transport: 'http' as const, url: 'https://mcp.x' },
    ];
    fetchQueue.push(
      bareOk(), // putSettings
      bareOk(), // putSettingsRaw project
      bareOk(), // putSettingsRaw global(root 缺省)
      bareOk(), // putMcpServers
      bareOk(), // putAgent upsert
      bareOk(), // putAgent delete
      ok({ ok: true, tools: [{ name: 'read', description: '读文件' }] }), // mcpProbe(root 缺省)
    );
    const updates = { model: 'openai/gpt', contextWindow: 200000, apiKey: null };
    await conn.putSettings('/w', updates);
    await conn.putSettingsRaw('project', '/w', 'settings', '{}\n');
    await conn.putSettingsRaw('global', undefined, 'mcp', '{\n  "mcpServers": {}\n}\n');
    await conn.putMcpServers('/w', servers);
    await conn.putAgent({ root: '/w', scope: 'project', op: 'upsert', id: 'coder', frontmatter: { name: 'Coder', memory: true }, body: '正文' });
    await conn.putAgent({ scope: 'global', op: 'delete', id: 'old-one' });
    await expect(conn.mcpProbe(undefined, 'fs')).resolves.toEqual({ ok: true, tools: [{ name: 'read', description: '读文件' }] });
    // —— URL/verb 面:四写面 PUT、probe POST ——
    expect(fetchLog.map((f) => f.url)).toEqual([
      'http://127.0.0.1:7788/settings',
      'http://127.0.0.1:7788/settings/raw',
      'http://127.0.0.1:7788/settings/raw',
      'http://127.0.0.1:7788/settings/mcp',
      'http://127.0.0.1:7788/settings/agents',
      'http://127.0.0.1:7788/settings/agents',
      'http://127.0.0.1:7788/settings/mcp/probe',
    ]);
    expect(fetchLog.map((f) => f.init?.method)).toEqual(['PUT', 'PUT', 'PUT', 'PUT', 'PUT', 'PUT', 'POST']);
    // —— body 面:字段名/缺省省字段(root undefined 不落 JSON)逐字 ——
    expect(fetchLog[0]?.init?.body).toBe(JSON.stringify({ root: '/w', updates }));
    expect(fetchLog[1]?.init?.body).toBe(JSON.stringify({ scope: 'project', root: '/w', file: 'settings', content: '{}\n' }));
    expect(fetchLog[2]?.init?.body).toBe(JSON.stringify({ scope: 'global', file: 'mcp', content: '{\n  "mcpServers": {}\n}\n' }));
    expect(fetchLog[3]?.init?.body).toBe(JSON.stringify({ root: '/w', servers }));
    expect(fetchLog[4]?.init?.body).toBe(
      JSON.stringify({ root: '/w', scope: 'project', op: 'upsert', id: 'coder', frontmatter: { name: 'Coder', memory: true }, body: '正文' }),
    );
    expect(fetchLog[5]?.init?.body).toBe(JSON.stringify({ scope: 'global', op: 'delete', id: 'old-one' }));
    expect(fetchLog[6]?.init?.body).toBe(JSON.stringify({ name: 'fs' }));
    // Bearer + json 头(写面)
    expect(fetchLog[0]?.init?.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' });
    // —— 非 2xx 透传:400 未知键 / 409 注释面 / 400 缺 root ——
    fetchQueue.push(errResp(400));
    await expect(conn.putSettings('/w', { bogus: 'x' })).rejects.toThrow('/settings -> 400');
    fetchQueue.push(errResp(409));
    await expect(conn.putSettingsRaw('project', '/w', 'settings', '// c\n')).rejects.toThrow('/settings/raw -> 409');
    fetchQueue.push(errResp(400));
    await expect(conn.mcpProbe(undefined, '')).rejects.toThrow('/settings/mcp/probe -> 400');
  });

  it('⑫ G8c mcpProbe 联合应答两态解码:ok:true tools / ok:false error 均 200 正常落定(探测失败是结果非错误码)', async () => {
    conn = createConnection({ baseUrl: 'http://x', token: 't', onEvent: () => {}, onReset: () => {} });
    fetchQueue.push(
      ok({ ok: true, tools: [{ name: 'read' }, { name: 'write', description: '写文件' }] }),
      ok({ ok: false, error: 'connection failed (fs): connect ECONNREFUSED' }),
      ok({ ok: false, error: 'identity mismatch (fs): serverInfo.name=other' }),
    );
    const good = await conn.mcpProbe('/w', 'fs');
    expect(good.ok).toBe(true);
    if (good.ok) {
      // ok:true 分支判别式收窄后 tools 直读
      expect(good.tools).toEqual([{ name: 'read' }, { name: 'write', description: '写文件' }]);
    }
    const bad = await conn.mcpProbe('/w', 'fs');
    expect(bad).toEqual({ ok: false, error: 'connection failed (fs): connect ECONNREFUSED' });
    const bad2 = await conn.mcpProbe('/w', 'fs');
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(bad2.error).toBe('identity mismatch (fs): serverInfo.name=other');
    // root 在场落 body(JSON 逐字)
    expect(fetchLog.every((f) => f.init?.body === JSON.stringify({ root: '/w', name: 'fs' }))).toBe(true);
  });
});
