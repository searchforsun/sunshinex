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
 * G4 挂起面（审批/问询/reset）：approval/ask 挂起帧无 seq 不入单调序列——pid（daemon 级
 * 铸票，连接生命周期维 Set 去重，重连重发幂等）回调上层；回执走 HTTP（replyApproval/
 * replyAsk，寻址统一帧顶层 pid——req.id 是会话内编号非寻址键）；reset 通知帧帧帧回调
 * （onResetSession）；deleteSession（T2 回收端点）供 Chat 顶栏 Delete（G5:Home 行 Delete 以
 * journal id 寻址恒 404 退役——会话端点以 daemon 会话 id 寻址才是有效路径）；boardReview
 * （G5 看板服务面）供 Board 页 gate 行内审批。
 */

/** 粗粒度转录条目(对齐主仓 src/serve/transcript.ts TranscriptEntry;G4 对齐五 kind——
 *  notice/error 归档面在档,三 kind 子集声明会静默窄化种子数据) */
export interface SnapshotMessage {
  seq: number;
  ts: number;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error';
  md: string;
}

/** G4 审批挂起请求(gui 侧契约声明;对齐 daemon ApprovalFrame.req 即 src/types ApprovalRequest
 *  字面,不引其类型):id 是会话内编号(ap-N)——非回执寻址键,回执统一用帧顶层 pid(T1 契约:
 *  误用 req.id 打 /approval/:pid 会静默 404)。字段全可选:gui 只展示不消费其结构完整性 */
export interface GuiApprovalReq {
  id?: string;
  kind?: string;
  subject?: string;
  reason?: string;
}

/** G4 问询挂起请求(对齐 AskUserRequest 实发字段——现场核 daemon 帧形态):customIndex 即
 *  「Other…」自由输入项下标(allowCustom 形态的实载字段,gui 以 customIndex !== undefined
 *  判输入面在场);filterable 仅 TUI 渲染面消费,gui 忽略 */
export interface GuiAskReq {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  customIndex?: number;
  filterable?: boolean;
}

/** G4 问询回执三态(对齐 AskUserAnswer):勾选 / 自定义文本 / 放弃(放弃属正常观察非错误) */
export type GuiAskAnswer =
  | { type: 'selected'; labels: string[] }
  | { type: 'custom'; text: string }
  | { type: 'dismissed' };

/** GET /session/:id/snapshot 载荷形态（T1 会话维，gui 侧契约声明）；lastSeq 见 Connection.sessionSnapshot 交集。
 *  G5 扩段:team(teammate 投影——harness.team 同源,Board 侧栏消费;daemon 必发,类型上可选防旧档)、
 *  pending(本会话未决挂起;G7 增 req=挂起表 entry.req 直序列化——连接层 pid 去重拦了重连重发帧,
 *  snapshot 是刷新/reseed 后卡内容的唯一来源,Chat reseed 据此重建卡) */
export interface SnapshotResponse {
  messages: SnapshotMessage[];
  board: TaskBoardState;
  delegations: Delegation[];
  status: 'idle' | 'running';
  team?: Array<{ name: string; busy: boolean }>;
  pending?: Array<{ pid: string; kind: 'approval' | 'ask'; req?: unknown }>;
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

/** GET /session/:id/file?path= 载荷（G6 预览面）：path=daemon 侧 resolve 归一后的绝对路径；
 *  truncated=true 表示原文超 512KB、content 为首 512KB 截断（预览语义非全文） */
export interface FileResp {
  path: string;
  content: string;
  truncated?: boolean;
}

/** GET /session/:id/diff?callId= 载荷（G7 收口交接）：write 调用 pre-image ↔ 磁盘现文件双内容——
 *  oldContent=写前 pre-image blob（新建写无 blob 缺场）;newContent=磁盘现文件(后续写已覆盖时非
 *  本调用的 content——现文件语义);truncated=任一侧超 512KB 截断 */
export interface DiffResp {
  path: string;
  oldContent?: string;
  newContent: string;
  truncated?: boolean;
}

/** 连接状态机：启动 connecting；建立 open；掉线 reconnecting；显式 close 恒 closed */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** WS 下行帧：`{kind:'event', sessionId, seq, e}`（T1 会话维）；G4 挂起/reset 帧无 seq 不入单调
 *  序列（approval/ask 带 pid+req，reset 只挂 sessionId）；其余 kind（hello 等）/无 seq/
 *  无 sessionId 帧不入单调序列，忽略 */
interface WsFrame {
  kind: string;
  sessionId?: string;
  seq?: number;
  e?: SessionEvent;
  pid?: string;
  req?: unknown;
}

export interface ConnectionOpts {
  baseUrl: string;
  token: string;
  /** 就绪帧投递（已过每会话 seq 过滤，按帧 sessionId 分发——连接层不滤会话，全给上层） */
  onEvent: (sessionId: string, e: SessionEvent, seq: number) => void;
  /** 每次连接建立（首连与重连同路径）回调：上层清各会话投影 + 逐会话重拉 snapshot
   *  （重连=重置投影+全量重放裁定——连接层不再自动拉快照，sessionSnapshot 供上层重建基线） */
  onReset: () => void;
  /** G4 审批挂起帧回调（pid 为 daemon 级回执寻址键，非 req.id；同 pid 重复帧只回调一次——
   *  重连重发幂等；会话过滤归上层） */
  onApproval?: (sessionId: string, pid: string, req: GuiApprovalReq) => void;
  /** G4 问询挂起帧回调（同上 pid 去重；AskUserRequest 无 id 字段——pid 单点承载寻址） */
  onAsk?: (sessionId: string, pid: string, req: GuiAskReq) => void;
  /** G4 会话 reset 通知帧回调（不去重——每帧都回调：一次 HTTP reset = 一次通知；上层清该
   *  会话投影重播种） */
  onResetSession?: (sessionId: string) => void;
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
  /** POST /session/new {root, mode?}:按 root 装配新会话（并置激活）→ {sessionId};mode 可选
   *  ('manual' 审批问询挂起 / 'dontAsk' 缺省)——缺省不发 body 字段(旧 daemon 兼容) */
  newSession(root: string, mode?: 'dontAsk' | 'manual'): Promise<{ sessionId: string }>;
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
  /** POST /approval/:pid {decision}（G4）：decision ∈ 'allow'|'always'|'deny'——回执寻址用帧
   *  顶层 pid（非 req.id）；未知/已决/kind 不符 pid 404（GUI 侧失败也移卡） */
  replyApproval(pid: string, decision: string): Promise<void>;
  /** POST /ask/:pid/reply {answer}（G4）：answer 三态（GuiAskAnswer）；404 面同上 */
  replyAsk(pid: string, answer: GuiAskAnswer): Promise<void>;
  /** POST /session/:id/board/review {taskId, approved}（G5 看板服务面）:gate 双语义(gated 审批
   *  解锁 / in-review 关单)——Board 页 onReview 装配点;400 面=未知任务/状态不符 */
  boardReview(sessionId: string, taskId: string, approved: boolean): Promise<void>;
  /** GET /session/:id/file?path=（G6 预览面）：path 相对会话 root 或绝对均可；403(越界)/404(不
   *  存在/目录)/415(二进制)以 HTTP 失败抛错（消息含 status）——Files 页错误态消费 */
  readFile(sessionId: string, path: string): Promise<FileResp>;
  /** GET /session/:id/diff?callId=（G7 diff 面）：write 调用双内容（见 DiffResp）；404（无快照/
   *  callId 无帧/会话）以 HTTP 失败抛错——Chat write 展开退单列现内容的判据 */
  fetchDiff(sessionId: string, callId: string): Promise<DiffResp>;
  /** POST /session/:id/delete（T2 会话回收，Home 消费）：running 409；journal 文件保留 */
  deleteSession(id: string): Promise<void>;
  /** POST /session/:id/pty {cols?,rows?}（G8b T3）：按需开 pty → {ptyId}；cols/rows 缺省省字段
   *  （daemon 缺省 80×24）；Terminal 页（T6）持 ptyId 开专用 WS /session/:id/pty/:ptyId */
  openPty(sessionId: string, cols?: number, rows?: number): Promise<{ ptyId: string }>;
  /** DELETE /session/:id/pty/:ptyId（G8b T3）：同步注销——kill 后新 WS 连入收 error
   *  'pty not found'（注销即失效，无宽限窗） */
  killPty(sessionId: string, ptyId: string): Promise<void>;
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
  const { onApproval, onAsk, onResetSession } = opts;
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
  /** G4 挂起 pid 去重表（连接生命周期维，重连不清——重连重发幂等）：同 pid 帧只回调一次；
   *  pid 是 daemon 级铸票，跨会话全局唯一，单 Set 足矣 */
  const seenPids = new Set<string>();
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

  /** G4 挂起帧单点（无 seq，不入单调序列）：pid 去重后按 kind 回调——同 pid 重复帧（含重连
   *  重发）只回调一次；reset 通知不走此径（帧帧回调，见 onmessage） */
  function deliverPending(sessionId: string, pid: string, req: unknown, kind: 'approval' | 'ask'): void {
    if (typeof req !== 'object' || req === null) return; // 坏载荷忽略
    if (seenPids.has(pid)) return; // 重连重发/重复帧幂等
    seenPids.add(pid);
    if (kind === 'approval') onApproval?.(sessionId, pid, req as GuiApprovalReq);
    else onAsk?.(sessionId, pid, req as GuiAskReq);
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
      if (frame === null || typeof frame !== 'object') return;
      // G4 会话 reset 通知帧：无 seq/pid——不入单调序列也不去重，帧帧回调
      if (frame.kind === 'reset') {
        if (typeof frame.sessionId === 'string' && frame.sessionId.length > 0) onResetSession?.(frame.sessionId);
        return;
      }
      // G4 审批/问询挂起帧：无 seq——pid 去重后回调（寻址键=帧顶层 pid）
      if (frame.kind === 'approval' || frame.kind === 'ask') {
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
    async newSession(root: string, mode?: 'dontAsk' | 'manual'): Promise<{ sessionId: string }> {
      const res = await fetch(`${base}/session/new`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(mode === undefined ? { root } : { root, mode }),
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
    replyApproval(pid: string, decision: string): Promise<void> {
      return post(`/approval/${encodeURIComponent(pid)}`, { decision });
    },
    replyAsk(pid: string, answer: GuiAskAnswer): Promise<void> {
      return post(`/ask/${encodeURIComponent(pid)}/reply`, { answer });
    },
    boardReview(sessionId: string, taskId: string, approved: boolean): Promise<void> {
      return post(`/session/${encodeURIComponent(sessionId)}/board/review`, { taskId, approved });
    },
    readFile(sessionId: string, filePath: string): Promise<FileResp> {
      return getJson<FileResp>(`/session/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}`);
    },
    fetchDiff(sessionId: string, callId: string): Promise<DiffResp> {
      return getJson<DiffResp>(`/session/${encodeURIComponent(sessionId)}/diff?callId=${encodeURIComponent(callId)}`);
    },
    deleteSession(id: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/delete`);
    },
    async openPty(sessionId: string, cols?: number, rows?: number): Promise<{ ptyId: string }> {
      const path = `/session/${encodeURIComponent(sessionId)}/pty`;
      // 缺省尺寸省字段(newSession mode 同款——旧 daemon 兼容;daemon 缺省 80×24)
      const body: { cols?: number; rows?: number } = {};
      if (cols !== undefined) body.cols = cols;
      if (rows !== undefined) body.rows = rows;
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status}`);
      return (await res.json()) as { ptyId: string };
    },
    async killPty(sessionId: string, ptyId: string): Promise<void> {
      const path = `/session/${encodeURIComponent(sessionId)}/pty/${encodeURIComponent(ptyId)}`;
      const res = await fetch(`${base}${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    },
    close,
    state(): ConnectionState {
      return status;
    },
    debug: { socket: (): WebSocket | undefined => ws ?? undefined },
  };
}
