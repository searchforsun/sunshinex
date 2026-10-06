import type { SessionEvent } from '../../src/types';
import type { TaskBoardState } from '../../src/taskboard/model';
import type { Delegation } from '../../src/delegation/projection';

/**
 * G3 gui 连接层：daemon 控制面的浏览器侧单点，单连接生命周期状态机
 * （connecting → open ⇄ reconnecting → closed）。核心裁定：
 * - seq 单调过滤：帧 seq ≤ 内部 lastSeq 一律丢弃（> 才更新并投）——重连补发帧
 *   双应用（转录/板重复追加）经此根除；lastSeq 唯一写点 = 每次连接的 snapshot 基线。
 * - open 先 snapshot 再收帧：WS open 后补发帧可能与 snapshot HTTP 竞速——在 snapshot
 *   完成前全部缓冲，基线落定（onResync 回调 + open 态）后统一过滤投递（防漏防重）。
 * - 重连 = 基线重置：退避后新连接 open 重新走「snapshot → onResync → open」，lastSeq
 *   以新快照为准（不与旧值取 max——快照是权威全量态）。
 * - 退避重连：非显式 close 的掉线（onclose/onerror）→ reconnecting → base×2^n 帽 30s
 *   重连，连续失败递增、成功建立（snapshot 落定）清零。
 * G2 的 subscribe 多连接语义退场：事件经 opts.onEvent 回调消费（App 装配属 T4）。
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

/** GET /snapshot 载荷形态（T1 单点，gui 侧契约声明；lastSeq 见 Connection.snapshot 交集） */
export interface SnapshotResponse {
  messages: SnapshotMessage[];
  board: TaskBoardState;
  delegations: Delegation[];
  status: 'idle' | 'running';
}

/** 连接状态机：启动 connecting；首连 open；掉线 reconnecting；显式 close 恒 closed */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** WS 下行帧：`{kind:'event', seq, e}`（T1 单点）；其余 kind（hello 等）/无 seq 帧不入单调序列，忽略 */
interface WsFrame {
  kind: string;
  seq?: number;
  e?: SessionEvent;
}

export interface ConnectionOpts {
  baseUrl: string;
  token: string;
  /** 就绪帧投递（已过 seq 过滤；seq 为帧自带序号） */
  onEvent: (e: SessionEvent, seq: number) => void;
  /** 每次（首连与重连）snapshot 落定时回调——页面以该快照重置全量态（基线） */
  onResync: (snapshot: SnapshotResponse) => void;
  /** 状态机迁移回调（含初始 connecting） */
  onStateChange?: (s: ConnectionState) => void;
  /** 退避基数 ms（缺省 1000；delay = base×2^连续失败数，帽 30s）——测试注入 1 */
  backoffBaseMs?: number;
}

export interface Connection {
  submit(goal: string): Promise<void>;
  /** POST /steer {text}：运行中插话（排队语义）；HTTP 失败抛错（消息含 status） */
  steer(text: string): Promise<void>;
  interrupt(): Promise<void>;
  /** GET /snapshot（ad-hoc 静态读，独立于重连基线流程）；lastSeq 同源 seq 泵 */
  snapshot(): Promise<SnapshotResponse & { lastSeq: number }>;
  close(): void;
  state(): ConnectionState;
  /** 测试钩子（e2e 断链注入专用）：当前底层 socket（无连接 undefined）——产品面勿消费 */
  debug: { socket(): WebSocket | undefined };
}

/** 退避帽（1×2^n 上限） */
const BACKOFF_CAP_MS = 30_000;
/** 退避基数缺省 */
const DEFAULT_BACKOFF_BASE_MS = 1_000;

/** baseUrl 的 http(s) 面 → ws(s) 面（浏览器 WebSocket 不接受 http 前缀；已 ws(s) 则原样透传） */
function wsUrl(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '');
  if (url.startsWith('http://')) url = `ws://${url.slice('http://'.length)}`;
  else if (url.startsWith('https://')) url = `wss://${url.slice('https://'.length)}`;
  return `${url}/events`;
}

export function createConnection(opts: ConnectionOpts): Connection {
  const { baseUrl, token, onEvent, onResync } = opts;
  const onStateChange = opts.onStateChange;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const base = baseUrl.replace(/\/+$/, '');

  let status: ConnectionState = 'connecting';
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 连续失败计数（成功建立清零）→ 退避指数 n；首个延迟恒 = base×2^0 */
  let failures = 0;
  /** seq 基线：-1 = 尚未 snapshot（任何帧不投，只缓冲）；此后唯一写点 = 各连接 snapshot.lastSeq */
  let lastSeq = -1;
  /** 连接代次：旧 socket 迟到回调（close 后回放的 onclose、慢到的 snapshot 应答）凭此失效 */
  let generation = 0;

  function setState(next: ConnectionState): void {
    status = next;
    onStateChange?.(next);
  }

  async function fetchSnapshot(): Promise<SnapshotResponse & { lastSeq: number }> {
    const res = await fetch(`${base}/snapshot`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`/snapshot -> ${res.status}`);
    return (await res.json()) as SnapshotResponse & { lastSeq: number };
  }

  /** seq 过滤单点：≤ 基线丢（补发/乱序旧帧），> 更新基线并投 */
  function deliver(seq: number, e: SessionEvent): void {
    if (seq <= lastSeq) return;
    lastSeq = seq;
    onEvent(e, seq);
  }

  function detach(sock: WebSocket): void {
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
  }

  /** 掉线收口（onclose/onerror 同路径）：非显式 close 且本 socket 仍在代 → 退避重连 */
  function onLost(sock: WebSocket, gen: number): void {
    if (status === 'closed' || gen !== generation) return;
    generation += 1; // 本连接逻辑退场（迟到回调全部失效）
    detach(sock);
    if (ws === sock) ws = null;
    scheduleRetry();
  }

  function scheduleRetry(): void {
    if (status === 'closed' || retryTimer !== undefined) return;
    const delay = Math.min(backoffBaseMs * 2 ** failures, BACKOFF_CAP_MS);
    failures += 1;
    setState('reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (status !== 'closed') connect();
    }, delay);
  }

  function connect(): void {
    if (status === 'closed') return;
    const gen = ++generation;
    // subprotocol `bearer.<token>` 鉴权（浏览器 WebSocket 不能自定义请求头，T1 裁定的浏览器路径）
    const sock = new WebSocket(wsUrl(base), [`bearer.${token}`]);
    ws = sock;
    /** snapshot 完成前的帧缓冲：open 与基线落定之间到达的补发帧先进缓冲，落定后统一过滤投递 */
    const pending: Array<{ seq: number; e: SessionEvent }> = [];
    /** 基线落定（snapshot→onResync→open 完成）→ 此后帧直投过滤 */
    let armed = false;

    sock.onopen = () => {
      if (status === 'closed' || gen !== generation) return;
      fetchSnapshot().then(
        (resp) => {
          if (status === 'closed' || gen !== generation) return;
          lastSeq = resp.lastSeq; // 基线重置：以新快照为准（重连不与旧 lastSeq 取 max）
          armed = true;
          failures = 0; // 完全建立（snapshot 落定）才清退避计数
          onResync(resp); // 页面先拿全量态，再进 open、再收增量帧
          setState('open');
          for (const f of pending) deliver(f.seq, f.e); // 缓冲帧统一过滤投递（防漏）
        },
        () => {
          // snapshot 失败视同连接失败：断本条 socket，走退避重连
          if (status === 'closed' || gen !== generation) return;
          generation += 1;
          detach(sock);
          sock.close();
          if (ws === sock) ws = null;
          scheduleRetry();
        },
      );
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (status === 'closed' || gen !== generation) return;
      let frame: WsFrame | undefined;
      try {
        frame = JSON.parse(String(ev.data)) as WsFrame;
      } catch {
        return; // 非 JSON 帧忽略
      }
      if (frame?.kind !== 'event' || typeof frame.seq !== 'number' || !frame.e) return;
      if (!armed) {
        pending.push({ seq: frame.seq, e: frame.e });
        return;
      }
      deliver(frame.seq, frame.e);
    };
    sock.onclose = () => onLost(sock, gen);
    sock.onerror = () => onLost(sock, gen);
  }

  async function post(path: string, body?: unknown): Promise<void> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  }

  function close(): void {
    if (status === 'closed') return; // 幂等
    generation += 1; // 在册 socket 与在途 snapshot 应答全部失效
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const sock = ws;
    ws = null;
    if (sock !== null) {
      detach(sock);
      sock.close();
    }
    setState('closed');
  }

  setState('connecting'); // 初始态即报（消费者免另查 state()）
  connect();

  return {
    submit(goal: string): Promise<void> {
      return post('/submit', { goal });
    },
    steer(text: string): Promise<void> {
      return post('/steer', { text });
    },
    interrupt(): Promise<void> {
      return post('/interrupt');
    },
    snapshot(): Promise<SnapshotResponse & { lastSeq: number }> {
      return fetchSnapshot();
    },
    close,
    state(): ConnectionState {
      return status;
    },
    debug: { socket: (): WebSocket | undefined => ws ?? undefined },
  };
}
