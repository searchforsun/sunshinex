import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { ModelAdapter } from '../model/adapter';
import { ok, fail } from '../result';
import type { Result } from '../result';
import { SessionRuntime } from './session';
import type { EventFrame } from './session';
import { journalMessagesToEntries, chainStepsToEntries } from './session';
import type { ApprovalDecision, ApprovalRequest, AskUserAnswer, AskUserRequest } from '../types';
import { SessionJournal, listSessions, parseJournalFile, reduceJournal, sessionsDir } from '../tui/session-journal';
import { resolveDataDir, projectsRoot } from '../config/data-dir';

/** GUI daemon 构造面（G3 会话中心）：不再绑 root——daemon 持会话注册表，会话经 createSession(root)
 *  按需装配（--root CLI 参数降级为「启动即预选」，缺省空注册表启动）。model 与 CLI buildModel/TUI
 *  同源注入（三面同一 ModelAdapter 契约，daemon 级单例供各会话共享）；staticRoot 为 GUI 静态产物目录
 *  （G3 静态挂载），缺省 cwd 相对 dist-gui——serve 命令从仓库根跑即对，测试注入 tmp 路径保持 hermetic */
export interface GuiDaemonOpts {
  model: ModelAdapter;
  staticRoot?: string;
}

/** start 入参：port 缺省 0（临时端口，返回实际监听值）；token 缺省随机 24 字节 hex（规格 §4.3） */
export interface GuiDaemonStartOpts {
  port?: number;
  token?: string;
}

/** start 回执：port 为实际监听端口；close 与 GuiDaemon.close 同一幂等收口 */
export interface GuiDaemonHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

/** GET /workspaces 行（T2 工作区注册表）：slug=projectsRoot 下工作区目录名；root 经 createSession
 *  落档的 `<dataDir>/workspace.json` 反解——历史工作区（TUI 时代档）无此档 → root undefined（前端
 *  不可 attach，仅统计展示）；mtime=dataDir mtime；sessionCount=sessions 目录 jsonl 数（缺目录=0） */
export interface WorkspaceRow {
  root?: string;
  slug: string;
  mtime: number;
  sessionCount: number;
}

/** 挂起面 WS 帧（G4 审批问询，spec §4.2）：无 seq——不入单调序列（挂起非事件流成员，重连重发幂等，
 *  客户端以 pid 去重）；pid 为 daemon 级铸造的挂起票据（回执端点 `POST /approval/:pid` /
 *  `POST /ask/:pid/reply` 的寻址键）；req 纯数据直序列化（ApprovalRequest/AskUserRequest 字面） */
export interface ApprovalFrame {
  kind: 'approval';
  sessionId: string;
  pid: string;
  req: ApprovalRequest;
}

/** ask 挂起帧：AskUserRequest 无 id 字段（types.ts 现场核）——pid 由 daemon 单点铸造承载回执寻址 */
export interface AskFrame {
  kind: 'ask';
  sessionId: string;
  pid: string;
  req: AskUserRequest;
}

/** reset 通知帧（G4 裁定 7）：无 seq——GUI 收到即清该会话本地投影并重播种（sessionSnapshot） */
export interface ResetFrame {
  kind: 'reset';
  sessionId: string;
}

/** daemon 下行帧全并集：pump 事件帧（有 seq）+ 挂起/reset 帧（无 seq）——广播面单点共用序列化 */
export type DaemonFrame = EventFrame | ApprovalFrame | AskFrame | ResetFrame;

/** 挂起表条目（G4 裁定 1）：kind 判别联合——回执端点按 kind 对表（approval 回执打到 ask 挂起 = 404）；
 *  resolve 即回执值（interrupt/teardown 以 deny/dismissed 回填，TUI approval.ts 先例） */
type PendingEntry =
  | { kind: 'approval'; sessionId: string; req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }
  | { kind: 'ask'; sessionId: string; req: AskUserRequest; resolve: (a: AskUserAnswer) => void };

/** 挂起条目 → WS 帧（首播与重连重发同形同构：kind/sessionId/pid/req 四件） */
function pendingFrameOf(pid: string, entry: PendingEntry): ApprovalFrame | AskFrame {
  return entry.kind === 'approval'
    ? { kind: 'approval', sessionId: entry.sessionId, pid, req: entry.req }
    : { kind: 'ask', sessionId: entry.sessionId, pid, req: entry.req };
}

/** AskUserAnswer 回执载荷校验（G4）：三态字面核验——selected 需 string[]、custom 需非空 text、
 *  dismissed 无参；非法形态回 null（HTTP 面 400）。labels 空数组放行——类型面合法，工具执行面
 *  自行降级为 dismissed 观察文案（builtin.ts ask_question executor 既有口径） */
function parseAskAnswer(v: unknown): AskUserAnswer | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as { type?: unknown; labels?: unknown; text?: unknown };
  if (a.type === 'dismissed') return { type: 'dismissed' };
  if (a.type === 'custom') return typeof a.text === 'string' && a.text.length > 0 ? { type: 'custom', text: a.text } : null;
  if (a.type === 'selected') {
    if (!Array.isArray(a.labels) || !a.labels.every((l) => typeof l === 'string')) return null;
    return { type: 'selected', labels: a.labels as string[] };
  }
  return null;
}

/** JSON body 上限（1MB）：防无界 body 撑爆 daemon 内存；超限即断连收口 */
const MAX_BODY_BYTES = 1024 * 1024;

/** WS 保活节拍：30s 一 ping；pong 静默超 60s 即 terminate（close 事件统一清理） */
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

/** 静态缺失提示（G1 裁定恒定文案；G3 起 dist-gui 在场则 GET 挂静态，缺场仍回此形态） */
const GUI_ASSETS_HINT = 'GUI assets not built — run pnpm --filter gui build (G2)';

/** 旧 /session/new 裸软重置的迁移提示（G3 裸端点兼容裁定：无 root 的旧语义让位 /session/:id/reset） */
const ROOT_REQUIRED_HINT = 'root required — the old soft-reset moved to /session/:id/reset';

/** 静态 mime 表（G3）：按扩展名映射，缺省 application/octet-stream（浏览器按 Content-Type 处置，
 *  未知类型不猜测——下载面行为由客户端定） */
const STATIC_MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function mimeOf(file: string): string {
  return STATIC_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 静态读文件：任何读失败（缺失/目录/权限）归一 null——SPA 兜底与 404 由调用方分径 */
function readStaticFile(file: string): Promise<Buffer | null> {
  return new Promise((resolve) => fs.readFile(file, (err, data) => resolve(err === null ? data : null)));
}

/** 路由表条目：path 支持 `:name` 段参数（会话维端点 /session/:id/*）；auth 恒验除 healthz */
interface Route {
  method: string;
  path: string;
  auth: boolean;
  run: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => Promise<void>;
}

/**
 * GUI daemon 核心（spec §3/§7 会话中心）：HTTP 控制面 + WS 事件面 + 会话注册表。每会话一个
 * SessionRuntime（按 root 独立装配 createRuntime——独立泵/影子投影/转录/run 票据），daemon 持
 * 全局面：seq 计数（T1 裁定：全局单调而非每会话——跨会话帧不重号，客户端按 sessionId 过滤后仍是
 * 严格递增流）、WS 连接面、激活会话指针。HTTP 面：healthz 免鉴权 + 会话维端点（/session/:id/*）
 * 与裸端点（/submit 等四件 = 激活会话别名，G2 gui 面渐进迁移不破，v1.x 移除）经 Bearer token 鉴权
 * （§4.3：仅回环 + token，远程暴露为 v1 非目标）。WS 事件面：onEvent 单点泵入 → 帧挂 sessionId
 * 广播全部连接 + 各会话 512 环形缓冲，连接建立即补发全部会话缓冲（会话序 s1..sN，各内缓冲序——
 * T1 裁定：全部会话，客户端按 sessionId 过滤）；升级同走 Bearer 头鉴权。
 */
export class GuiDaemon {
  private readonly model: ModelAdapter;
  private readonly sessions = new Map<string, SessionRuntime>();
  /** 会话 id 方言 s<n>：进程内单调计数（spec §7） */
  private sessionSeq = 0;
  /** seq 泵计数（G3 seq 协议 + T1 全局裁定）：计数在先帧在后（首帧 seq=1），跨会话全局单调不重置——
   *  各会话 snapshot.lastSeq 同一计数器分配故各自单调 */
  private seqCounter = 0;
  /** 激活会话（spec §7 Ruling 1）：最近 create/attach 的会话；裸端点与 board/review 挂它。UI 切换 =
   *  纯前端状态，不改 daemon active（协议兼容层概念，不是 UI 状态） */
  private active?: string;
  private server?: http.Server;
  /** 幂等收口：首调落链，后续调用复用同一 Promise（close 链只走一遍） */
  private closePromise?: Promise<void>;
  /** WS 面：noServer 挂 http server upgrade；连接 Set=pump 广播面 */
  private wss?: WebSocketServer;
  private readonly wsClients = new Set<WebSocket>();
  /** 每 pong 时间戳（WeakMap 旁挂，不入连接对象）：ping 心跳判活依据 */
  private readonly wsLastPong = new WeakMap<WebSocket, number>();
  private pingTimer?: NodeJS.Timeout;
  /** GUI 静态产物根（G3）：opts 注入，缺省 cwd 相对 dist-gui */
  private readonly staticRoot: string;
  /** 静态面探测结果（start 时一次缓存）：index.html 在场才挂静态，缺场保持 API-only（404 hint 原样） */
  private staticReady = false;
  /** 挂起表（G4 裁定 1：daemon 级单表，entry 携 sessionId）：pid=daemon 级单调铸造 `p<n>`——guard 的
   *  ap-N 是会话内序（每会话独立 guard 实例），跨会话可撞，全局唯一由 daemon 单点保证；resolve 后即删
   *  （重复回执 404 的判据） */
  private readonly pending = new Map<string, PendingEntry>();
  private pendingSeq = 0;

  constructor(opts: GuiDaemonOpts) {
    this.staticRoot = opts.staticRoot ?? path.resolve('dist-gui');
    this.model = opts.model;
  }

  /**
   * 创建会话（spec §7）：root 存在性/目录校验（INVALID_ARG）→ 按 root 装配 SessionRuntime（同 root
   * 多会话允许——各自独立主链，Ruling 2）→ 入注册表（s<n> 进程内单调）→ 置激活。同时向
   * `resolveDataDir(root)/workspace.json` 落档 `{root}`（T2 工作区注册表：slug 单向哈希反解不了
   * root——落档供 GET /workspaces 读回真 root；历史工作区无此档降级 slug-only）。落档尽力而为：
   * 数据面不可写（只读 projects 根）不挡会话创建，/workspaces 对该工作区降级 slug-only 行。Result
   * 面：daemon 级 API（serve --root 预选/后续工作区注册表消费），HTTP 面映射 400/200。
   * G4：opts.mode='manual' 时向会话注入审批/问询两闭包——resolve 挂在 daemon 挂起表条目上 + 广播
   *  挂起帧（WS 消费面回执 POST /approval/:pid / /ask/:pid/reply）；缺省 dontAsk 零行为变化。
   * T2：出生即挂新 SessionJournal（`new SessionJournal(dataDir)` 惰性建档——首 run 首条 chain append
   *  才落盘建新档，档 id 同源 newSessionId()；空会话零文件，TUI 惰性先例同构）——首 run 起链持久，
   *  后续 /sessions 列档与 attach 重开（chain 派生转录）可消费。
   */
  createSession(root: string, opts?: { mode?: 'dontAsk' | 'manual' }): Result<{ sessionId: string }> {
    const abs = path.resolve(root);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return fail('INVALID_ARG', `root does not exist: ${abs}`);
    }
    if (!st.isDirectory()) return fail('INVALID_ARG', `root is not a directory: ${abs}`);
    const dataDir = resolveDataDir(abs);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify({ root: abs }) + '\n', 'utf8');
    } catch {
      // 落档尽力：写失败只让 /workspaces 降级 slug-only，不影响会话装配
    }
    this.sessionSeq += 1;
    const id = `s${this.sessionSeq}`;
    const session = new SessionRuntime({
      id,
      root: abs,
      model: this.model,
      nextSeq: () => {
        this.seqCounter += 1;
        return this.seqCounter;
      },
      broadcast: (frame) => this.broadcastFrame(frame),
      ...(opts?.mode === 'manual'
        ? {
            mode: 'manual' as const,
            asker: (req: ApprovalRequest): Promise<ApprovalDecision> =>
              new Promise((resolve) => {
                const pid = this.nextPendingId();
                this.pending.set(pid, { kind: 'approval', sessionId: id, req, resolve });
                this.broadcastFrame({ kind: 'approval', sessionId: id, pid, req });
              }),
            onAskUser: (req: AskUserRequest): Promise<AskUserAnswer> =>
              new Promise((resolve) => {
                const pid = this.nextPendingId();
                this.pending.set(pid, { kind: 'ask', sessionId: id, req, resolve });
                this.broadcastFrame({ kind: 'ask', sessionId: id, pid, req });
              }),
          }
        : {}),
    });
    this.sessions.set(id, session);
    this.active = id;
    // T2 出生 journal：挂载即接 onContextChange 续写链（惰性建档，见 createSession 注释）
    session.attachJournal(new SessionJournal(dataDir));
    return ok({ sessionId: id });
  }

  /**
   * attach 恢复（spec §7 / T2 实装）：会话 root 的 dataDir 下定位 `<journalId>.jsonl`（未知 id
   * INVALID_ARG）→ parseJournalFile/reduceJournal（TUI /resume 同源）→ 版本守卫（≠1 拒载）→ 播种：
   * 链经 context.restoreSession 直注入（TUI resume 单点——比逐条 appendChain 多保真 compact 态且
   * 不触发变更订阅）、msg 行经 journalMessagesToEntries 映射入 transcript.seed → SessionJournal
   * attach 续挂 + SessionRuntime.attachJournal 挂订阅（后续 run 的 chain 行续落同档，teardown
   * seal）→ 置激活。双挂/运行中挂 INVALID_STATE（播种会击穿在飞 run 的链）。
   */
  attach(id: string, journalId: string): Result<{ sessionId: string }> {
    const session = this.sessions.get(id);
    if (session === undefined) return fail('INVALID_ARG', `unknown session: ${id}`);
    if (session.attachedJournalId !== undefined) return fail('INVALID_STATE', 'session already has an attached journal');
    if (session.status() === 'running') return fail('INVALID_STATE', 'cannot attach while a run is in progress');
    const dataDir = resolveDataDir(session.root);
    const file = path.join(sessionsDir(dataDir), `${journalId}.jsonl`);
    if (!fs.existsSync(file)) return fail('INVALID_ARG', `unknown journalId: ${journalId}`);
    const replay = reduceJournal(parseJournalFile(file).events);
    if (replay.version !== 1) return fail('INVALID_ARG', `unsupported journal version: ${String(replay.version)}`);
    session.runtime.harness.context.restoreSession({ chain: replay.chain, chainFrom: replay.chainFrom, compacted: replay.compacted });
    // 转录播种（Ruling 5 双源不重复）：msg 行在场（TUI 档）→ msg 派生；msg 行计数===0（daemon 会话
    // 档只落 chain）→ chain 行派生兜底（task→user 引用块 / reply→assistant / call+result 配对→tool）——
    // 两路径互斥，零重复
    const msgs = journalMessagesToEntries(replay.messages);
    session.transcript.seed(msgs.length > 0 ? msgs : chainStepsToEntries(replay.chain));
    const journal = new SessionJournal(dataDir);
    journal.attach(journalId);
    session.attachJournal(journal);
    this.active = id;
    return ok({ sessionId: id });
  }

  /** 会话外窥（测试/后续 T2+ 端点消费）：未知 id 回 undefined */
  get(id: string): SessionRuntime | undefined {
    return this.sessions.get(id);
  }

  /** 激活会话 id（无会话时 undefined——裸端点 409 的判据） */
  activeId(): string | undefined {
    return this.active;
  }

  /** 挂起 id 铸造单点（G4）：daemon 级单调 `p<n>`（全局唯一，见 pending 字段注） */
  private nextPendingId(): string {
    this.pendingSeq += 1;
    return `p${this.pendingSeq}`;
  }

  /** 会话维挂起回填（G4 裁定 3：interrupt/reset=deny 回填——TUI approval.ts 先例）：该会话全部未决
   *  approval→deny、ask→dismissed 并清表；不发 notice（中止路径的观察行由 run 自身事件面承载） */
  private denyPendingFor(sessionId: string): void {
    for (const [pid, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      this.pending.delete(pid);
      if (entry.kind === 'approval') entry.resolve('deny');
      else entry.resolve({ type: 'dismissed' });
    }
  }

  /** 全表回填（close 序步骤 0，同构裁定 3——分会话 denyPendingFor 的全表形态） */
  private denyAllPending(): void {
    for (const [pid, entry] of this.pending) {
      this.pending.delete(pid);
      if (entry.kind === 'approval') entry.resolve('deny');
      else entry.resolve({ type: 'dismissed' });
    }
  }

  /** 回执落档单点（G4 裁定 1 尾项）：notice 事件帧经该会话 pump——入转录/环形缓冲/广播三面（粗归档
   *  可见，不发明新事件型）；会话已不在（理论上不可达——挂起条目随会话存续）静默跳过 */
  private noticePending(entry: PendingEntry, text: string): void {
    this.sessions.get(entry.sessionId)?.pump({ type: 'notice', text, ts: Date.now() });
  }

  /** 泵广播面（daemon 级单点）：帧序列化一次逐连接 send——同一连接的帧恒按 pump 调用序到达（ws
   *  内部发送缓冲有序，无需额外队列）；连接层按 sessionId 分发/过滤（T3）。G4：签名放宽至 DaemonFrame
   *  全并集（挂起/reset 帧与事件帧共用本序列化路径） */
  private broadcastFrame(frame: DaemonFrame): void {
    if (this.wsClients.size === 0) return;
    const json = JSON.stringify(frame);
    for (const ws of this.wsClients) ws.send(json);
  }

  /**
   * 启动 HTTP 控制面：恒绑 127.0.0.1（§4.3 裁定——远程暴露为 v1 非目标，bind 面=鉴权面的第一道）；
   * port 0 = 系统分配临时端口，回执返回实际监听值（测试并行不撞口）。
   */
  async start(opts?: GuiDaemonStartOpts): Promise<GuiDaemonHandle> {
    const token = opts?.token ?? crypto.randomBytes(24).toString('hex');
    const server = http.createServer((req, res) => this.dispatch(req, res, token));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts?.port ?? 0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.wss = this.attachWs(server, token);
    // 静态面探测（启动一次，缓存布尔）：index.html 在场才挂静态——缺场 GET 保持 G1 的 404+hint 原样
    this.staticReady = fs.existsSync(path.join(this.staticRoot, 'index.html'));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('GuiDaemon: listen address unavailable');
    return { port: addr.port, token, close: () => this.close() };
  }

  /** WS 面装配：http server 'upgrade' → 鉴权双形态（§4.3 Bearer 头，G2 增补浏览器路径
   *  `Sec-WebSocket-Protocol: bearer.<token>`——浏览器 WebSocket API 不能自定义请求头，token 只能
   *  借 subprotocol 名携带）→ wss.handleUpgrade 接管；noServer 形态复用同一 http server（端口不另开）。
   *  升级响应回显由 ws 库默认行为承担：completeUpgrade 未设 handleProtocols 时取请求协议列表首个
   *  （websocket-server.js `protocols.values().next().value`）写回 Sec-WebSocket-Protocol——客户端
   *  恰好只带一个协议（bearer.<token>），回显即原值，客户端 ws.protocol 可直接校验。30s ping 保活
   *  计时器在此启动，close 时清 */
  private attachWs(server: http.Server, token: string): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const viaHeader = req.headers.authorization === `Bearer ${token}`;
      const viaSubprotocol = req.headers['sec-websocket-protocol'] === `bearer.${token}`;
      // teardown 已启动即不再收新连接（WS 先于 server close 退场，此处与鉴权失败同拒升级）
      if (this.closePromise || (!viaHeader && !viaSubprotocol)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onWsConnection(ws));
    });
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    return wss;
  }

  /** 连接生命周期：入 Set（广播面）→ 补发全部会话缓冲 + 重发全部未决挂起帧（G4 裁定 4）→ pong 记时/
   *  close 清理。补发在 upgrade 回调内同步完成，与后续实时帧（pump 单点）天然无交错——逐会话帧序=缓冲
   *  序接事件序；T1 裁定：全部会话（s1..sN 会话序，各内缓冲序），客户端按帧面 sessionId 过滤（T3
   *  onSessionEvent）——不收 `{"kind":"listen"}` 订阅消息（帧全带 sessionId 客户端自滤）。
   *  挂起重发无 seq：同 pid 帧可能重复到达（首播+重连），客户端以 pid 去重幂等（G4） */
  private onWsConnection(ws: WebSocket): void {
    this.wsClients.add(ws);
    this.wsLastPong.set(ws, Date.now());
    ws.on('pong', () => this.wsLastPong.set(ws, Date.now()));
    // error 必须挂 listener（EventEmitter 契约）：socket 错误细节不倒面，close 统一走清理
    ws.on('error', () => {});
    ws.on('close', () => this.wsClients.delete(ws));
    for (const session of this.sessions.values()) {
      for (const f of session.bufferedFrames()) ws.send(JSON.stringify(f));
    }
    for (const [pid, entry] of this.pending) ws.send(JSON.stringify(pendingFrameOf(pid, entry)));
  }

  /** 保活心跳：逐连接判活——pong 静默超 60s 即 terminate（close 事件统一清理 Set），否则发 ping */
  private heartbeat(): void {
    const now = Date.now();
    for (const ws of this.wsClients) {
      if (now - (this.wsLastPong.get(ws) ?? now) > PONG_TIMEOUT_MS) {
        ws.terminate();
        continue;
      }
      ws.ping();
    }
  }

  /** 幂等 teardown：单次化落链（closePromise 守卫），升级拒绝面同判 */
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.teardown();
    return this.closePromise;
  }

  /** daemon 收口序（平移扩展为全会话形态）：0) 全会话在跑 run 即刻中止 + 有界等待 settle（并发）→
   *  1) WS 面收 → 2) HTTP server 收 → 3) 全会话运行时内脏收口（stopAll→drain→mcpClose，并发）。
   *  网络面先行关闭——不再接受新请求/新连接、在跑 run 中止后再动运行时内脏（逐会话收口序在会话维
   *  保序，daemon 维网络面插在两相之间）；细节裁定见各步骤行内注释 */
  private async teardown(): Promise<void> {
    // 0) 挂起全表回填（G4 裁定 3）：悬挂的 asker promise 先落 deny/dismissed——被中止 run 才能在
    //    有界窗口内真正 settle
    this.denyAllPending();
    // 0b) 全会话在跑 run 即刻中止（并发）：与单会话序同理——悬挂 run 的 promise 会拖住事件循环/测试
    //    收口；每会话有界等待 2s（Promise.all 并发不叠加）
    await Promise.all([...this.sessions.values()].map((s) => s.abortAndSettle()));
    // 1) WS 面先收：停 ping 计时器，逐连接 1001 Going Away 后 wss.close——先于 HTTP server close，
    //    升级连接与请求连接同序退场，server close 时无存活的升级套接字拖尾
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    const wss = this.wss;
    if (wss) {
      for (const ws of this.wsClients) ws.close(1001);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      this.wsClients.clear();
    }
    // 2) HTTP server 先收：close 停接新连接，closeAllConnections 掐掉存活的 keep-alive 空闲连接——
    //    否则 undici 连接池的滞留套接字会让 close 回调悬到超时，teardown 时序不可控
    const srv = this.server;
    if (srv) {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      });
    }
    // 3) 全会话运行时内脏收口（并发）：stopAll → drain → mcpClose（序同 CLI teardownCliRun 现场）
    await Promise.all([...this.sessions.values()].map((s) => s.dispose()));
  }

  /** 内部路由表（T1 会话中心：会话维端点 + 裸端点激活别名；G2 /snapshot、G3 /steer 平移）；
   *  静态资源走 dispatch 的 GET 兜底分支，不占路由表 */
  private readonly routes: ReadonlyArray<Route> = [
    { method: 'GET', path: '/healthz', auth: false, run: async (_req, res) => this.send(res, 200, { ok: true }) },
    { method: 'POST', path: '/session/new', auth: true, run: (req, res) => this.handleSessionNew(req, res) },
    { method: 'POST', path: '/session/:id/submit', auth: true, run: (req, res, p) => this.handleSubmit(req, res, p.id) },
    { method: 'POST', path: '/session/:id/steer', auth: true, run: (req, res, p) => this.handleSteer(req, res, p.id) },
    { method: 'POST', path: '/session/:id/interrupt', auth: true, run: async (_req, res, p) => this.handleInterrupt(res, p.id) },
    { method: 'POST', path: '/session/:id/reset', auth: true, run: async (_req, res, p) => this.handleReset(res, p.id) },
    { method: 'GET', path: '/session/:id/snapshot', auth: true, run: async (_req, res, p) => this.handleSnapshot(res, p.id) },
    { method: 'POST', path: '/session/:id/attach', auth: true, run: (req, res, p) => this.handleAttach(req, res, p.id) },
    // T2 会话回收：running 409（先收 run 再删）；journal 文件保留（磁盘档案非 daemon 生命周期资产）
    { method: 'POST', path: '/session/:id/delete', auth: true, run: async (_req, res, p) => this.handleDelete(res, p.id) },
    // G4 挂起回执面：pid 为 daemon 级挂起票据（会话无关路由——pid 本身寻址，无会话维前缀）
    { method: 'POST', path: '/approval/:pid', auth: true, run: (req, res, p) => this.handleApprovalReply(req, res, p.pid) },
    { method: 'POST', path: '/ask/:pid/reply', auth: true, run: (req, res, p) => this.handleAskReply(req, res, p.pid) },
    // T2 工作区注册表 + 恢复面：workspaces 扫描 / sessions 列档 / dirpicker 目录选择
    { method: 'GET', path: '/workspaces', auth: true, run: async (_req, res) => this.handleWorkspaces(res) },
    { method: 'GET', path: '/sessions', auth: true, run: async (req, res) => this.handleSessions(req, res) },
    { method: 'GET', path: '/dirpicker', auth: true, run: async (req, res) => this.handleDirpicker(req, res) },
    // 裸端点 = 激活会话别名（G3 兼容裁定：G2 gui 面不破，v1.x 移除）；无 active 409
    { method: 'POST', path: '/submit', auth: true, run: (req, res) => this.handleSubmit(req, res, undefined) },
    { method: 'POST', path: '/steer', auth: true, run: (req, res) => this.handleSteer(req, res, undefined) },
    { method: 'POST', path: '/interrupt', auth: true, run: async (_req, res) => this.handleInterrupt(res, undefined) },
    { method: 'GET', path: '/snapshot', auth: true, run: async (_req, res) => this.handleSnapshot(res, undefined) },
  ];

  /** 路由匹配（段参数 :name）：段数与字面段全等才命中；参数段解码（失败按字面处理，不命中） */
  private matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
    const segs = pathname.split('/').filter((s) => s.length > 0);
    for (const route of this.routes) {
      const rSegs = route.path.split('/').filter((s) => s.length > 0);
      if (route.method !== method || rSegs.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let hit = true;
      for (let i = 0; i < rSegs.length; i++) {
        if (rSegs[i].startsWith(':')) {
          try {
            params[rSegs[i].slice(1)] = decodeURIComponent(segs[i]);
          } catch {
            params[rSegs[i].slice(1)] = segs[i];
          }
        } else if (rSegs[i] !== segs[i]) {
          hit = false;
          break;
        }
      }
      if (hit) return { route, params };
    }
    return undefined;
  }

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const matched = this.matchRoute(req.method ?? 'GET', url.pathname);
    if (matched) {
      // 鉴权（§4.3）：除 healthz 外恒验 Bearer token，且先于会话解析（401 面不泄露会话语义）——恒时
      // 比较不做（token 非密钥材料，回环面时序侧信道无实义）
      if (matched.route.auth && req.headers.authorization !== `Bearer ${token}`) {
        this.send(res, 401, { error: 'unauthorized' });
        return;
      }
      matched.route.run(req, res, matched.params).catch((err) => {
        console.error('[serve] handler error:', err);
        if (!res.headersSent) this.send(res, 500, { error: 'internal error' });
        else res.end();
      });
      return;
    }
    // API 未命中的 GET 且静态产物在场（G3 静态挂载）：安全拼接 + mime + SPA 兜底；仅 GET（HEAD/POST 不挂）
    if (req.method === 'GET' && this.staticReady) {
      this.handleStatic(url.pathname, res).catch((err) => {
        console.error('[serve] static error:', err);
        if (!res.headersSent) this.send(res, 500, { error: 'internal error' });
        else res.end();
      });
      return;
    }
    // 静态缺失提示（G1 裁定：恒定 hint；GET/POST 未知路径统一带 hint）
    this.send(res, 404, { error: 'not found', hint: GUI_ASSETS_HINT });
  }

  /** 静态文件面（G3）：pathname → 解码（%2E%2E 类编码穿越在 URL 解析后才现形）→ join+normalize →
   *  必须仍在 staticRoot 内（前缀判定含分隔符，root 本体即 / 兜底 index.html）→ 未命中（缺失/目录）
   *  落 SPA 兜底 index.html，兜底亦缺才 404+hint。穿越越界直接 404——不落 SPA 兜底（防以 200 html
   *  掩盖探测）。免鉴权：GUI 壳非密钥材料，token 只保 API 面 */
  private async handleStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      this.send(res, 404, { error: 'not found', hint: GUI_ASSETS_HINT });
      return;
    }
    const target = path.normalize(path.join(this.staticRoot, rel));
    if (target !== this.staticRoot && !target.startsWith(this.staticRoot + path.sep)) {
      this.send(res, 404, { error: 'not found', hint: GUI_ASSETS_HINT });
      return;
    }
    const data = await readStaticFile(target);
    if (data !== null) {
      res.writeHead(200, { 'content-type': mimeOf(target) });
      res.end(data);
      return;
    }
    const index = await readStaticFile(path.join(this.staticRoot, 'index.html'));
    if (index !== null) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(index);
      return;
    }
    this.send(res, 404, { error: 'not found', hint: GUI_ASSETS_HINT });
  }

  /** body 读取 + JSON 解析：解析失败/超限统一以 {status, error} 回执，不抛出（dispatch 已兜 500，此处提前收口带准确码） */
  private async readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'payload too large' };
      chunks.push(chunk as Buffer);
    }
    try {
      return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
      return { ok: false, status: 400, error: 'invalid json body' };
    }
  }

  /** 会话解析单点：id=undefined 走激活别名（无 active 409 {no active session}——G3 裸端点兼容裁定）；
   *  显式 id 未知 404 {unknown session}。响应已发即回 undefined（调用方直返） */
  private sessionFor(res: http.ServerResponse, id: string | undefined): SessionRuntime | undefined {
    if (id === undefined) {
      const active = this.active !== undefined ? this.sessions.get(this.active) : undefined;
      if (active === undefined) {
        this.send(res, 409, { error: 'no active session' });
        return undefined;
      }
      return active;
    }
    const session = this.sessions.get(id);
    if (session === undefined) {
      this.send(res, 404, { error: 'unknown session' });
      return undefined;
    }
    return session;
  }

  /** POST /session/new {root}（spec §4.1）：root 必填（无 root 400+迁移提示——旧裸软重置语义让位
   *  /session/:id/reset）；createSession 单点（存在性/目录校验 INVALID_ARG → 400）→ 200 {ok,sessionId} */
  private async handleSessionNew(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const root = (parsed.body as { root?: unknown } | null)?.root;
    if (typeof root !== 'string' || root.length === 0) {
      this.send(res, 400, { error: ROOT_REQUIRED_HINT });
      return;
    }
    const r = this.createSession(root);
    if (!r.ok) {
      this.send(res, 400, { error: r.error.message });
      return;
    }
    this.send(res, 200, { ok: true, sessionId: r.value.sessionId });
  }

  /** submit 处理（会话维 + 裸别名共用）：goal 非空 string 校验 → 会话 run 锁（409 拒二次提交）→
   *  202 即回（受理面；run 异步收束细节见 SessionRuntime.submit） */
  private async handleSubmit(req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const goal = (parsed.body as { goal?: unknown } | null)?.goal;
    if (typeof goal !== 'string' || goal.length === 0) {
      this.send(res, 400, { error: 'goal must be a non-empty string' });
      return;
    }
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    const r = session.submit(goal);
    if (!r.ok) {
      this.send(res, r.status, { error: r.error });
      return;
    }
    this.send(res, 202, { ok: true });
  }

  /** interrupt 处理：无在跑 run 409；中止信号发出即 200（run 以 stopReason=interrupted 收束后清锁）。
   *  G4 裁定 3：中止后该会话全部未决挂起以 deny/dismissed 回填并清表——asker promise 不回填则被中止
   *  run 永不收束（僵尸 run） */
  private handleInterrupt(res: http.ServerResponse, id: string | undefined): void {
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    const r = session.interrupt();
    if (!r.ok) {
      this.send(res, 409, { error: r.error });
      return;
    }
    this.denyPendingFor(session.id);
    this.send(res, 200, { ok: true });
  }

  /** steer 处理（G3）：text 非空 string 校验（空白串与 enqueue 的 trim-忽略口径一致前置拒——静默
   *  no-op 的 200 比显式 400 更糟）→ 入该会话 steering → 恒 200 {ok:true}，无 409 分径（裁定：
   *  steering 非独占面，排队语义即承诺） */
  private async handleSteer(req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const text = (parsed.body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      this.send(res, 400, { error: 'text must be a non-empty string' });
      return;
    }
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    session.steer(text);
    this.send(res, 200, { ok: true });
  }

  /** reset 处理（旧 /session/new 软重置语义迁入）：中止在跑 run + 换新运行时 + 清投影/转录/缓冲，
   *  200 {ok:true}（语义面见 SessionRuntime.reset）。G4：中止前该会话挂起回填（deny/dismissed——
   *  同 interrupt 裁定 3，防僵尸 asker promise 拖住被中止 run）；收尾广播 `{kind:'reset', sessionId}`
   *  通知帧（裁定 7：GUI 清本地投影重播种；无 seq，不入单调序列） */
  private async handleReset(res: http.ServerResponse, id: string | undefined): Promise<void> {
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    this.denyPendingFor(session.id);
    await session.reset();
    this.broadcastFrame({ kind: 'reset', sessionId: session.id });
    this.send(res, 200, { ok: true });
  }

  /** POST /approval/:pid {decision}（G4）：挂起表命中且 kind 对 → resolve + notice 事件帧（经该会话
   *  pump，转录可见）+ 200 {ok:true}；未知 pid / 已决（重复回执）/ kind 不符（ask 挂起错打 approval
   *  端点）统一 404；decision 非法字面 400（ApprovalDecision = 'allow'|'always'|'deny'） */
  private async handleApprovalReply(req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const decision = (parsed.body as { decision?: unknown } | null)?.decision;
    if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') {
      this.send(res, 400, { error: 'decision must be one of: allow, always, deny' });
      return;
    }
    const entry = this.pending.get(pid);
    if (entry === undefined || entry.kind !== 'approval') {
      this.send(res, 404, { error: 'unknown pending approval' });
      return;
    }
    this.pending.delete(pid);
    entry.resolve(decision);
    this.noticePending(entry, `approval ${pid} resolved: ${decision}`);
    this.send(res, 200, { ok: true });
  }

  /** POST /ask/:pid/reply {answer}（G4）：同构 approval 回执——AskUserAnswer 三态载荷校验（400）→
   *  命中且 kind 对 resolve + notice（`ask <pid> answered`）+ 200；未知/已决/kind 不符 404 */
  private async handleAskReply(req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const answer = parseAskAnswer((parsed.body as { answer?: unknown } | null)?.answer);
    if (answer === null) {
      this.send(res, 400, { error: 'invalid answer: expected {type:"selected",labels} | {type:"custom",text} | {type:"dismissed"}' });
      return;
    }
    const entry = this.pending.get(pid);
    if (entry === undefined || entry.kind !== 'ask') {
      this.send(res, 404, { error: 'unknown pending ask' });
      return;
    }
    this.pending.delete(pid);
    entry.resolve(answer);
    this.noticePending(entry, `ask ${pid} answered`);
    this.send(res, 200, { ok: true });
  }

  /** snapshot 处理：会话快照单点（载荷形态见 SessionRuntime.snapshotResponse） */
  private handleSnapshot(res: http.ServerResponse, id: string | undefined): void {
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    this.send(res, 200, session.snapshotResponse());
  }

  /** POST /session/:id/attach {journalId}（T2）：journalId 非空 string 校验 → 未知 :id 404 →
   *  attach 单点（INVALID_ARG→400 / INVALID_STATE→409）→ 200 {ok,sessionId}（并置激活） */
  private async handleAttach(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const journalId = (parsed.body as { journalId?: unknown } | null)?.journalId;
    if (typeof journalId !== 'string' || journalId.length === 0) {
      this.send(res, 400, { error: 'journalId must be a non-empty string' });
      return;
    }
    if (this.sessions.get(id) === undefined) {
      this.send(res, 404, { error: 'unknown session' });
      return;
    }
    const r = this.attach(id, journalId);
    if (!r.ok) {
      this.send(res, r.error.code === 'INVALID_STATE' ? 409 : 400, { error: r.error.message });
      return;
    }
    this.send(res, 200, { ok: true, sessionId: r.value.sessionId });
  }

  /** POST /session/:id/delete（T2 会话回收，GUI Home 消费）：未知 :id 404；running 409（回收前必须
   *  先收 run——teardown 会中止在跑 run，静默中止比显式 409 更糟）；idle → 有界 teardown（该会话
   *  挂起回填 deny/dismissed（同 interrupt 裁定 3，防僵尸 asker）+ abortAndSettle + dispose（含
   *  journal seal））→ 注册表移出（后续 :id 访问 404、WS 补发不再含该会话）；active 指向该会话即清
   *  undefined（裸端点回 409 面）；journal 文件保留——磁盘档案非 daemon 生命周期资产，/sessions 列档
   *  与后续 attach 重开仍可消费 */
  private async handleDelete(res: http.ServerResponse, id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      this.send(res, 404, { error: 'unknown session' });
      return;
    }
    if (session.status() === 'running') {
      this.send(res, 409, { error: 'cannot delete while a run is in progress' });
      return;
    }
    this.denyPendingFor(id);
    await session.teardown();
    this.sessions.delete(id);
    if (this.active === id) this.active = undefined;
    this.send(res, 200, { ok: true });
  }

  /** GET /workspaces（T2）：扫 projectsRoot() 下各 `<slug>/data` 存在者——root 经 workspace.json
   *  反解（历史工作区无档 → slug-only 行不可 attach）；mtime=dataDir mtime；sessionCount=sessions
   *  子目录 jsonl 计数（缺目录=0）。行序 mtime 降序（最近工作区在前，首页呈现序）；单目录/单档的
   *  扫描竞态（readdir 与 stat 之间被删）跳过该条目，不击穿整个列表 */
  private handleWorkspaces(res: http.ServerResponse): void {
    const rows: WorkspaceRow[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
    } catch {
      // projects 根不存在/不可读：空注册表（合法态——从未建过会话）
      this.send(res, 200, rows);
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dataDir = path.join(projectsRoot(), ent.name, 'data');
      let st: fs.Stats;
      try {
        st = fs.statSync(dataDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      let root: string | undefined;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')) as { root?: unknown };
        if (typeof raw?.root === 'string' && raw.root.length > 0) root = raw.root;
      } catch {
        // 历史工作区无档/坏档 → slug-only（root undefined，前端不可 attach）
      }
      let sessionCount = 0;
      try {
        sessionCount = fs.readdirSync(path.join(dataDir, 'sessions')).filter((f) => f.endsWith('.jsonl')).length;
      } catch {
        // sessions 目录不存在 = 0
      }
      rows.push({ ...(root !== undefined ? { root } : {}), slug: ent.name, mtime: st.mtimeMs, sessionCount });
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    this.send(res, 200, rows);
  }

  /** GET /sessions?root=（T2）：root 必填（缺省 400——无 root 无法定位 dataDir）→ listSessions
   *  （TUI /resume 同源导出：id/file/updatedAt mtime 降序/firstUser 首条用户输入摘要）原样回执 */
  private handleSessions(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const root = url.searchParams.get('root');
    if (root === null || root.length === 0) {
      this.send(res, 400, { error: 'root query param required' });
      return;
    }
    this.send(res, 200, listSessions(resolveDataDir(root)));
  }

  /** GET /dirpicker?path=（T2 服务端目录选择）：path 缺省 os.homedir()；不存在/非目录 400；
   *  dirs=readdirSync withFileTypes 只目录 + 排序；parent=resolve('..')（盘根时=自身） */
  private handleDirpicker(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const abs = path.resolve(url.searchParams.get('path') ?? os.homedir());
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      this.send(res, 400, { error: `path does not exist: ${abs}` });
      return;
    }
    if (!st.isDirectory()) {
      this.send(res, 400, { error: `path is not a directory: ${abs}` });
      return;
    }
    let dirs: string[];
    try {
      dirs = fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      this.send(res, 400, { error: `path is not readable: ${abs}` });
      return;
    }
    this.send(res, 200, { path: abs, parent: path.resolve(abs, '..'), dirs });
  }

  private send(res: http.ServerResponse, status: number, body: object): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
