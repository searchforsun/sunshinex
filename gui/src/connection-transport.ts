import type { SessionEvent } from '../../src/types';
import type { ConnectionState, WsFrame, GuiApprovalReq, GuiAskReq, GuiPlanApprovalReq } from './connection-types';

/** WS 传输状态机（D32 批A′ 拆分自 connection.ts）：连接/退避重连/代次失效/单调 seq 过滤/挂起帧
 *  去重分发——RPC 面仅消费 state/generation/lastSeqBySession/currentSocket/close 五面；事件流、挂起
 *  卡、重置与状态变迁经 TransportCallbacks 注入。行为零变化（connection.test 为锚）。
 */

export interface TransportCallbacks {
  onEvent(sessionId: string, e: SessionEvent, seq: number): void;
  onApproval?(sessionId: string, pid: string, req: GuiApprovalReq): void;
  onAsk?(sessionId: string, pid: string, req: GuiAskReq): void;
  /** 阶段三 plan-arm(spec §5.1):plan-approval 挂起帧同通道分发(同 pid 去重/重连重发幂等) */
  onPlanApproval?(sessionId: string, pid: string, req: GuiPlanApprovalReq): void;
  onReset(): void;
  onResetSession?(sessionId: string): void;
  onStateChange?(next: ConnectionState): void;
}

export interface ConnectionTransport {
  state(): ConnectionState;
  generation(): number;
  readonly lastSeqBySession: Map<string, number>;
  currentSocket(): WebSocket | undefined;
  close(): void;
}

export function toWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}`;
  if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}`;
  return httpUrl;
}

const BACKOFF_CAP_MS = 30_000;
/** 退避基数缺省 */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;

function wsUrl(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '');
  return `${toWsUrl(url)}/events`;
}

export function createConnectionTransport(base: string, token: string | undefined, backoffBaseMs: number, cb: TransportCallbacks): ConnectionTransport {
let status: ConnectionState = 'connecting';
let ws: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** 连续失败计数（成功建立清零）→ 退避指数 n；首个延迟恒 = base×2^0 */
let failures = 0;
/** 每会话 seq 基线：连接建立清零（重连=全量重放），sessionSnapshot 应答抬高（防双应用）；
 *  过滤单点 deliver 只读此表 */
const lastSeqBySession = new Map<string, number>();
/** G4 挂起 pid 去重表（连接生命周期维，重连不清——重连重发幂等）：同 pid 帧只回调一次；
 *  pid 是 daemon 级铸票，跨会话全局唯一，单 Set 足矣 */
const seenPids = new Set<string>();
/** 连接代次：旧 socket 迟到回调（close 后回放的 onclose、慢到的 snapshot 应答）凭此失效 */
let generation = 0;

function setState(next: ConnectionState): void {
  status = next;
  cb.onStateChange?.(next);
}

/** seq 过滤单点（每会话独立）：≤ 基线丢（补发/乱序旧帧），> 更新基线并按 sessionId 投上层 */
function deliver(sessionId: string, seq: number, e: SessionEvent): void {
  if (seq <= (lastSeqBySession.get(sessionId) ?? 0)) return;
  lastSeqBySession.set(sessionId, seq);
  cb.onEvent(sessionId, e, seq);
}

/** G4 挂起帧单点（无 seq，不入单调序列）：pid 去重后按 kind 回调——同 pid 重复帧（含重连
 *  重发）只回调一次；reset 通知不走此径（帧帧回调，见 onmessage）。阶段三 plan-arm(spec §5.1)
 *  增 plan-approval 分支——三 kind 同表同去重口径 */
function deliverPending(sessionId: string, pid: string, req: unknown, kind: 'approval' | 'ask' | 'plan-approval'): void {
  if (typeof req !== 'object' || req === null) return; // 坏载荷忽略
  if (seenPids.has(pid)) return; // 重连重发/重复帧幂等
  seenPids.add(pid);
  if (kind === 'approval') cb.onApproval?.(sessionId, pid, req as GuiApprovalReq);
  else if (kind === 'ask') cb.onAsk?.(sessionId, pid, req as GuiAskReq);
  else cb.onPlanApproval?.(sessionId, pid, req as GuiPlanApprovalReq);
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
  const sock = new WebSocket(wsUrl(base), token ? [`bearer.${token}`] : []);
  ws = sock;

  sock.onopen = () => {
    if (status === 'closed' || gen !== generation) return;
    // 建立=基线清零+投影重置+全量重放：上层先清各会话投影（onReset），随后到达的补发帧
    // （daemon 连接即发全部会话缓冲）各会话依序全过，上层重拉 snapshot 重建权威态
    lastSeqBySession.clear();
    failures = 0; // 完全建立才清退避计数
    cb.onReset();
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
    if (frame === null || typeof frame !== 'object') return;
    // G4 会话 reset 通知帧：无 seq/pid——不入单调序列也不去重，帧帧回调
    if (frame.kind === 'reset') {
      if (typeof frame.sessionId === 'string' && frame.sessionId.length > 0) cb.onResetSession?.(frame.sessionId);
      return;
    }
    // G4 审批/问询挂起帧 + 阶段三 plan-approval 挂起帧：无 seq——pid 去重后回调（寻址键=帧顶层 pid）
    if (frame.kind === 'approval' || frame.kind === 'ask' || frame.kind === 'plan-approval') {
      if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) return;
      if (typeof frame.pid !== 'string' || frame.pid.length === 0) return;
      deliverPending(frame.sessionId, frame.pid, frame.req, frame.kind);
      return;
    }
    if (frame.kind !== 'event' || typeof frame.seq !== 'number' || !frame.e) return;
    if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) return;
    deliver(frame.sessionId, frame.seq, frame.e);
  };
  sock.onclose = () => onLost(sock, gen);
  sock.onerror = () => onLost(sock, gen);
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
    state: () => status,
    generation: () => generation,
    lastSeqBySession,
    currentSocket: () => ws ?? undefined,
    close,
  };
}
