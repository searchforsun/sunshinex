import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection } from './connection';

/**
 * 连接层桩测（jsdom 无真 WS 服务面）：最小 WebSocket 桩类替换 globalThis.WebSocket，只验
 * 「建连形态」与「退订断连」两面——真 WS 全链（daemon 起 → subprotocol 鉴权 → 事件流）在
 * e2e.test.ts 走真 daemon。
 */

/** 最小 WebSocket 桩：记录构造入参（url/protocols）与 close 调用；close 幂等（真实 ws 语义：已断再 close 为 no-op） */
class WsStub {
  static instances: WsStub[] = [];
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
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
}

describe('gui connection（WS 桩）', () => {
  beforeEach(() => {
    WsStub.instances = [];
    vi.stubGlobal('WebSocket', WsStub);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('subscribe 建连形态：http 面剥尾斜杠转 ws 面 /events；subprotocol 恒 [bearer.<token>]（浏览器鉴权路径）', () => {
    const conn = createConnection({ baseUrl: 'http://127.0.0.1:7788/', token: 'tok-1' });
    conn.subscribe(() => {});
    const ws = WsStub.instances.at(-1);
    expect(ws).toBeDefined();
    expect(ws!.url).toBe('ws://127.0.0.1:7788/events');
    expect(ws!.protocols).toEqual(['bearer.tok-1']);
    // 连接级 close 同样收口每条在册 socket
    conn.close();
    expect(ws!.closeCalls).toBe(1);
  });

  it('退订即断本条 socket：unsub 调 close；重复退订/onclose 重入/事后 conn.close 均不重复断（幂等）', () => {
    const conn = createConnection({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    const unsub = conn.subscribe(() => {});
    const ws = WsStub.instances.at(-1)!;
    unsub();
    expect(ws.closeCalls).toBe(1, '退订器断本条 socket（防 G3 重连累积孤儿连接）');
    // onclose 重入：close 后 socket 触发 onclose（仍指向 teardown）再走一遍——无害
    ws.onclose?.();
    unsub();
    expect(ws.closeCalls).toBe(1);
    // 退订已出册：连接级 close 不再触及该 socket
    conn.close();
    expect(ws.closeCalls).toBe(1);
    // handler 清面：退订后不再收消息
    expect(ws.onopen).toBeNull();
    expect(ws.onmessage).toBeNull();
  });
});
