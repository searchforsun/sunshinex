import type { SessionEvent } from '../../src/types';
import type { TaskBoardState } from '../../src/taskboard/model';
import type { Delegation } from '../../src/delegation/projection';

/**
 * G2 gui 连接层：daemon 控制面（HTTP /snapshot、/submit、/interrupt + WS /events）的浏览器侧单点。
 * 类型形态对齐主仓 T1（src/serve/daemon.ts snapshot() 与 frameEvent）——gui 侧独立声明
 * （浏览器 bundle 不引主仓运行时代码，投影纯件经 projection.ts 另轨 re-export）。
 */

/** 粗粒度转录条目（对齐主仓 src/serve/transcript.ts TranscriptEntry） */
export interface SnapshotMessage {
  seq: number;
  ts: number;
  kind: 'user' | 'assistant' | 'tool';
  md: string;
}

/** GET /snapshot 载荷形态（T1 单点，gui 侧契约声明） */
export interface SnapshotResponse {
  messages: SnapshotMessage[];
  board: TaskBoardState;
  delegations: Delegation[];
  status: 'idle' | 'running';
}

/** WS 下行帧：`{kind:'event', e}` 之外的 kind 忽略（T1 帧形单点，G3 扩展 hello/backfill 等） */
interface WsFrame {
  kind: string;
  e?: SessionEvent;
}

export interface Connection {
  snapshot(): Promise<SnapshotResponse>;
  /** 每次 subscribe 独立建 WS；返回退订器（只关本条 socket，不动整条连接） */
  subscribe(cb: (e: SessionEvent) => void): () => void;
  submit(goal: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
  state(): 'connecting' | 'open' | 'closed';
}

/** baseUrl 的 http(s) 面 → ws(s) 面（浏览器 WebSocket 不接受 http 前缀；已 ws(s) 则原样透传） */
function wsUrl(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '');
  if (url.startsWith('http://')) url = `ws://${url.slice('http://'.length)}`;
  else if (url.startsWith('https://')) url = `wss://${url.slice('https://'.length)}`;
  return `${url}/events`;
}

export function createConnection(opts: { baseUrl: string; token: string }): Connection {
  const { baseUrl, token } = opts;
  const base = baseUrl.replace(/\/+$/, '');
  const sockets = new Set<WebSocket>();
  let status: 'connecting' | 'open' | 'closed' = 'connecting';

  async function post(path: string, body?: unknown): Promise<void> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  }

  return {
    async snapshot(): Promise<SnapshotResponse> {
      const res = await fetch(`${base}/snapshot`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`/snapshot -> ${res.status}`);
      return (await res.json()) as SnapshotResponse;
    },

    subscribe(cb: (e: SessionEvent) => void): () => void {
      // subprotocol `bearer.<token>` 鉴权（浏览器 WebSocket 不能自定义请求头，T1 裁定的浏览器路径）
      const ws = new WebSocket(wsUrl(base), [`bearer.${token}`]);
      sockets.add(ws);
      ws.onopen = () => {
        if (status !== 'closed') status = 'open';
      };
      ws.onmessage = (ev: MessageEvent) => {
        let frame: WsFrame | undefined;
        try {
          frame = JSON.parse(String(ev.data)) as WsFrame;
        } catch {
          return; // 非 JSON 帧忽略（G2 只认 event 帧）
        }
        if (frame && frame.kind === 'event' && frame.e) cb(frame.e);
      };
      const teardown = () => {
        sockets.delete(ws);
        ws.onopen = null;
        ws.onmessage = null;
      };
      ws.onclose = teardown;
      ws.onerror = teardown;
      return teardown;
    },

    submit(goal: string): Promise<void> {
      return post('/submit', { goal });
    },

    interrupt(): Promise<void> {
      return post('/interrupt');
    },

    close(): void {
      for (const ws of sockets) ws.close();
      sockets.clear();
      status = 'closed';
    },

    state() {
      return status;
    },
  };
}
