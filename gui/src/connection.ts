import type { SessionEvent } from '../../src/types';
import type { TaskBoardState } from '../../src/taskboard/model';
import type { Delegation } from '../../src/delegation/projection';

/**
 * G3.5 gui 连接层（会话维）：daemon 控制面的浏览器侧单点，单连接生命周期状态机
 * （connecting → open ⇄ reconnecting → closed）。骨架平移自 G3 单点版（四态/指数退避/
 * generation guard/seq 过滤），会话维三处改判：
 * - 帧按 sessionId 分发：单 WS 收全会话帧（daemon 无订阅概念，连接建立即补发全部会话缓冲），
 *   连接层不滤会话全交上层 onEvent(sessionId, e, seq)——投影挂哪个会话由上层裁。
 * - seq 过滤改每会话基线：daemon seq 泵全局单调（跨会话不重号），但多会话补发流按会话序
 *   s1..sN 交错到达——全局单 lastSeq 会误丢他会话帧，故 Map<sessionId, lastSeq> 各归各。
 *   基线写点：①每次连接建立清零（重连=全量重放裁定，见下）；②sessionSnapshot(id) 应答
 *   以 lastSeq 抬高（防快照在途帧双应用——种子替换投影后，≤ 快照切割序的迟到帧照投即重）。
 * - 重连 = onReset + 全量重放：连接建立（首连与重连同路径）不再自动拉快照——多会话下由
 *   上层逐会话重拉（sessionSnapshot 供上层），连接层只回调 onReset()（上层清投影）后放行
 *   全部补发帧（基线清零 → 补发帧各会话依序全过）。旧 onResync(snapshot) 载荷路径退役。
 * 退避重连/显式 close/generation guard 语义平移：非显式 close 掉线 → reconnecting →
 * base×2^n 帽 30s 重连，成功建立（open 落定）清零；旧 socket 迟到回调凭代次失效。
 * 旧名退役（G3.5 裁定）：裸端点 submit/steer/interrupt/snapshot 删除——会话维 :id 形态
 * 唯一（daemon 侧裸端点仍是激活别名，gui 面不再消费）。
 */

/** 粗粒度转录条目（对齐主仓 src/serve/transcript.ts TranscriptEntry） */
export interface SnapshotMessage {
  seq: number;
  ts: number;
  kind: 'user' | 'assistant' | 'tool';
  md: string;
}

/** GET /session/:id/snapshot 载荷形态（T1 会话维，gui 侧契约声明）；lastSeq 见 Connection.sessionSnapshot 交集 */
export interface SnapshotResponse {
  messages: SnapshotMessage[];
  board: TaskBoardState;
  delegations: Delegation[];
  status: 'idle' | 'running';
}

/** GET /workspaces 行（T2 工作区注册表，对齐主仓 daemon.ts WorkspaceRow）：root 经 workspace.json
 *  反解——历史工作区（TUI 时代档）无此档 → root undefined（不可 attach，仅统计展示） */
export interface WorkspaceRow {
  root?: string;
  slug: string;
  mtime: number;
  sessionCount: number;
}

/** GET /sessions?root= 行（T2，对齐主仓 session-journal.ts SessionMeta 实际返回）：id=journal id */
export interface SessionRow {
  id: string;
  file: string;
  updatedAt: number;
  firstUser?: string;
  forkedFrom?: { sourceSessionId: string; upToLine: number; kind: 'rewind' | 'fork' };
}

/** GET /dirpicker?path= 载荷（T2 服务端目录选择）：path=绝对路径，parent=上级（盘根=自身），dirs=子目录名 */
export interface DirPickerResp {
  path: string;
  parent: string;
  dirs: string[];
}

/** 连接状态机：启动 connecting；建立 open；掉线 reconnecting；显式 close 恒 closed */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** WS 下行帧：`{kind:'event', sessionId, seq, e}`（T1 会话维）；其余 kind（hello 等）/无 seq/
 *  无 sessionId 帧不入单调序列，忽略 */
interface WsFrame {
  kind: string;
  sessionId?: string;
  seq?: number;
  e?: SessionEvent;
}

export interface ConnectionOpts {
  baseUrl: string;
  token: string;
  /** 就绪帧投递（已过每会话 seq 过滤，按帧 sessionId 分发——连接层不滤会话，全给上层） */
  onEvent: (sessionId: string, e: SessionEvent, seq: number) => void;
  /** 每次连接建立（首连与重连同路径）回调：上层清各会话投影 + 逐会话重拉 snapshot
   *  （重连=重置投影+全量重放裁定——连接层不再自动拉快照，sessionSnapshot 供上层重建基线） */
  onReset: () => void;
  /** 状态机迁移回调（含初始 connecting） */
  onStateChange?: (s: ConnectionState) => void;
  /** 退避基数 ms（缺省 1000；delay = base×2^连续失败数，帽 30s）——测试注入 1 */
  backoffBaseMs?: number;
}

export interface Connection {
  /** GET /workspaces：工作区注册表扫描（T2） */
  workspaces(): Promise<WorkspaceRow[]>;
  /** GET /sessions?root=：工作区会话（journal）列表（T2） */
  sessionsOf(root: string): Promise<SessionRow[]>;
  /** GET /dirpicker?path=（缺省 home）：服务端目录浏览（T2） */
  dirpicker(path?: string): Promise<DirPickerResp>;
  /** POST /session/new {root}：按 root 装配新会话（并置激活）→ {sessionId} */
  newSession(root: string): Promise<{ sessionId: string }>;
  /** POST /session/:id/attach {journalId}：恢复既有 journal 到该会话（并置激活） */
  attach(sessionId: string, journalId: string): Promise<void>;
  /** POST /session/:id/submit {goal}：会话提交（202 受理；409 拒二次提交） */
  sessionSubmit(id: string, goal: string): Promise<void>;
  /** POST /session/:id/steer {text}：运行中插话（排队语义）；HTTP 失败抛错（消息含 status） */
  sessionSteer(id: string, text: string): Promise<void>;
  /** POST /session/:id/interrupt：中止在跑 run（无在跑 409） */
  sessionInterrupt(id: string): Promise<void>;
  /** GET /session/:id/snapshot：会话全量快照；lastSeq 同源 seq 泵——本连接层以其抬高该会话
   *  过滤基线（种子替换投影后的迟到补发帧双应用防线） */
  sessionSnapshot(id: string): Promise<SnapshotResponse & { lastSeq: number }>;
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
  const { baseUrl, token, onEvent, onReset } = opts;
  const onStateChange = opts.onStateChange;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const base = baseUrl.replace(/\/+$/, '');

  let status: ConnectionState = 'connecting';
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 连续失败计数（成功建立清零）→ 退避指数 n；首个延迟恒 = base×2^0 */
  let failures = 0;
  /** 每会话 seq 基线：连接建立清零（重连=全量重放），sessionSnapshot 应答抬高（防双应用）；
   *  过滤单点 deliver 只读此表 */
  const lastSeqBySession = new Map<string, number>();
  /** 连接代次：旧 socket 迟到回调（close 后回放的 onclose、慢到的 snapshot 应答）凭此失效 */
  let generation = 0;

  function setState(next: ConnectionState): void {
    status = next;
    onStateChange?.(next);
  }

  /** seq 过滤单点（每会话独立）：≤ 基线丢（补发/乱序旧帧），> 更新基线并按 sessionId 投上层 */
  function deliver(sessionId: string, seq: number, e: SessionEvent): void {
    if (seq <= (lastSeqBySession.get(sessionId) ?? 0)) return;
    lastSeqBySession.set(sessionId, seq);
    onEvent(sessionId, e, seq);
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

    sock.onopen = () => {
      if (status === 'closed' || gen !== generation) return;
      // 建立=基线清零+投影重置+全量重放：上层先清各会话投影（onReset），随后到达的补发帧
      // （daemon 连接即发全部会话缓冲）各会话依序全过，上层重拉 snapshot 重建权威态
      lastSeqBySession.clear();
      failures = 0; // 完全建立才清退避计数
      onReset();
      setState('open');
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
      if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) return;
      deliver(frame.sessionId, frame.seq, frame.e);
    };
    sock.onclose = () => onLost(sock, gen);
    sock.onerror = () => onLost(sock, gen);
  }

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  async function post(path: string, body?: unknown): Promise<void> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  }

  /** sessionSnapshot 单点：GET + 代次守卫下的基线抬高（慢到应答不污新连接的全量重放窗） */
  async function fetchSessionSnapshot(id: string): Promise<SnapshotResponse & { lastSeq: number }> {
    const gen = generation;
    const resp = await getJson<SnapshotResponse & { lastSeq: number }>(`/session/${encodeURIComponent(id)}/snapshot`);
    if (gen === generation && resp.lastSeq > (lastSeqBySession.get(id) ?? 0)) {
      lastSeqBySession.set(id, resp.lastSeq);
    }
    return resp;
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
    workspaces(): Promise<WorkspaceRow[]> {
      return getJson<WorkspaceRow[]>('/workspaces');
    },
    sessionsOf(root: string): Promise<SessionRow[]> {
      return getJson<SessionRow[]>(`/sessions?root=${encodeURIComponent(root)}`);
    },
    dirpicker(path?: string): Promise<DirPickerResp> {
      return getJson<DirPickerResp>(path === undefined ? '/dirpicker' : `/dirpicker?path=${encodeURIComponent(path)}`);
    },
    async newSession(root: string): Promise<{ sessionId: string }> {
      const res = await fetch(`${base}/session/new`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ root }),
      });
      if (!res.ok) throw new Error(`/session/new -> ${res.status}`);
      return (await res.json()) as { sessionId: string };
    },
    attach(sessionId: string, journalId: string): Promise<void> {
      return post(`/session/${encodeURIComponent(sessionId)}/attach`, { journalId });
    },
    sessionSubmit(id: string, goal: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/submit`, { goal });
    },
    sessionSteer(id: string, text: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/steer`, { text });
    },
    sessionInterrupt(id: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/interrupt`);
    },
    sessionSnapshot(id: string): Promise<SnapshotResponse & { lastSeq: number }> {
      return fetchSessionSnapshot(id);
    },
    close,
    state(): ConnectionState {
      return status;
    },
    debug: { socket: (): WebSocket | undefined => ws ?? undefined },
  };
}
