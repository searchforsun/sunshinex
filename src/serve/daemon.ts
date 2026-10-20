// 警告过滤必须首个 import（node:sqlite 实验横幅在 import 链内即发射）
import '../warning-filter';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { ModelAdapter } from '../model/adapter';
import { ok, fail } from '../result';
import type { Result } from '../result';
import { SessionRuntime } from './session';
import type { ApprovalDecision, AskUserAnswer } from '../types';
import { SessionJournal, parseJournalFile, readSessionMeta, reduceJournal, sessionsDir } from "../tui/session-journal";
import { reduceSteerRows, reduceSegRows } from '../session/seglog';
import { listCommands } from './commands';
import { COMMAND_SUPPORT } from './session-commands';
import { listChanges, changeContent, commitChanges, pushChanges, restoreChange, gitStatusMap, gitBranches, checkoutBranch, workspaceFiles } from './session-changes';
import { ModelSwitcher } from '../model/catalog';
import { resolveDataDir } from '../config/data-dir';
import {
  applySettings,
  getSelfFilledSlots,
  loadGlobalSettings,
  loadProjectSettings,
  resetSelfFilledSlots,
} from '../config/settings';
import { PtyManager } from './pty';
import * as configHandlers from './config-handlers';
import type { ConfigHandlerIo } from './config-handlers';
import * as sessionHandlers from './session-handlers';
import type { SessionHandlerIo } from './session-handlers';
import * as fileHandlers from './file-handlers';
import * as workspaceHandlers from './workspace-handlers';
import type { WorkspaceHandlerIo } from './workspace-handlers';
import * as ptyHandlers from './pty-handlers';
import type { PtyHandlerIo } from './pty-handlers';
import type { FileHandlerIo } from './file-handlers';
import {
  GUI_ASSETS_HINT,
  mimeOf,
  readStaticFile,
  safeDecode,
} from './daemon-static';
import {
  urlOf,
  LOOPBACK_HOST,
  type DaemonFrame,
} from './daemon-wire';

export { LOOPBACK_HOST } from './daemon-wire';
export type { ApprovalFrame, AskFrame, ResetFrame, DaemonFrame } from './daemon-wire';

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
  /** undefined = 免鉴权档(G10:本地 serve 缺省);显式 --token 启用时为该值 */
  token: string | undefined;
  close(): Promise<void>;
}

/** 旁车 fork/ask 一次性调用墙钟上限：旁车与主链长任务预算解耦，到点 abort 收口（fork 问询面唯一消费） */
/** GET /workspaces 行（T2 工作区注册表）：slug=projectsRoot 下工作区目录名；root 经 createSession
 *  落档的 `<dataDir>/workspace.json` 反解——历史工作区（TUI 时代档）无此档 → root undefined（前端
 *  不可 attach，仅统计展示）；mtime=dataDir mtime；sessionCount=sessions 目录 jsonl 数（缺目录=0） */
export interface WorkspaceRow {
  root?: string;
  slug: string;
  mtime: number;
  sessionCount: number;
}


/** JSON body 上限（1MB）：防无界 body 撑爆 daemon 内存；超限即断连收口 */
const MAX_BODY_BYTES = 1024 * 1024;




/** WS 保活节拍：30s 一 ping；pong 静默超 60s 即 terminate（close 事件统一清理） */
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;


/** 旧 /session/new 裸软重置的迁移提示（G3 裸端点兼容裁定：无 root 的旧语义让位 /session/:id/reset） */

/** pty 帧 S→C 下行单点（G8b T3）：readyState 判存——CLOSED/CLOSING 静默丢帧（断线窗口的输出
 *  靠重连 replay 补，不追赶） */
function sendPtyFrame(ws: WebSocket, frame: { t: 'data' | 'exit'; b?: string; code?: number }): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
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
  /** 挂起 id 铸造计数（P6 §4：表下沉会话后 daemon 只留 pid 单调铸造——跨会话全局唯一的回执寻址键;
   *  guard 的 ap-N 是会话内序会撞,全局唯一由本单点保证） */
  private pendingSeq = 0;
  /** pty 面（G8b T3）：daemon 持 manager（serve 分层——session.ts 不引 pty，会话回收由 daemon
   *  在 delete/teardown 两处 killAllFor 插杀）；ptyId 铸造 `pty-<n>` 进程内单调、永不复用（防
   *  同 id 新会话撞旧缓冲/双连的竞态——T2 缓议裁定） */
  private readonly ptyManager = new PtyManager();
  private ptySeq = 0;
  /** pty 专用 WS 连接面：与事件面 wsClients 独立（不参与事件广播；复用 heartbeat ping + 同一
   *  wsLastPong 计时；daemon close 随 wss.close 一并退场） */
  private readonly ptySockets = new Set<WebSocket>();

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
  /** G14.10 B 方案:default 工作区锚定专用临时目录——root 字面 'default'(GUI 欢迎页非项目
   *  会话的缺省锚点)解析为 <tmp>/sunshinex-default(缺场 mkdir recursive):临时任务的文件
   *  落在系统临时目录,不再污染仓库/项目目录。非字面 root(显式项目路径)不经过此处。 */
  private defaultScratchRoot(): string {
    const dir = path.join(os.tmpdir(), 'sunshinex-default');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  createSession(root: string, opts?: { mode?: 'dontAsk' | 'manual' }): Result<{ sessionId: string }> {
    const abs = root === 'default' ? this.defaultScratchRoot() : path.resolve(root);
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
    // P6 §4 挂起表下沉会话:daemon 只注入网络寻址两接缝(mintPid/broadcast)——注册/守卫(ghost 硬化
    // isAborted/manual 档位判定)/组帧/回执全部在 SessionRuntime 挂起面(suspendApproval/suspendAsk)
    const session = new SessionRuntime({
      id,
      root: abs,
      model: this.model,
      ...(this.model instanceof ModelSwitcher ? { modelSwitcher: this.model } : {}),
      nextSeq: () => {
        this.seqCounter += 1;
        return this.seqCounter;
      },
      broadcast: (frame) => this.broadcastFrame(frame),
      ...(opts?.mode === 'manual' ? { mode: 'manual' as const } : {}),
      mintPid: () => {
        this.pendingSeq += 1;
        return `p${this.pendingSeq}`;
      },
    });
    this.sessions.set(id, session);
    this.active = id;
    // T2 出生 journal：挂载即接 onContextChange 续写链（惰性建档，见 createSession 注释）
    session.attachJournal(new SessionJournal(dataDir));
    return ok({ sessionId: id });
  }

  /**
   * attach 恢复（spec §4b 装载序 + 渲染中立 spec v3）：会话 root 的 dataDir 下定位 `<journalId>.jsonl`（未知 id
   * INVALID_ARG）→ parseJournalFile → 版本守卫（v3 段级词汇;v1/v2 旧档拒载,dev 用 purge 脚本清理）→
   * 装载双读面:reduceJournal(chain/compact → restoreSession 上下文;model/todos/view 参数面不动) +
   * reduceSegRows(seg/seg-update/run-open/runmeta/truncate → kernel.seed 转录投影,seq 原样沿用)→
   * SessionJournal attach 续挂 + SessionRuntime.attachJournal 挂订阅（后续 run 的 chain 行与段级行
   * 续落同档,teardown seal）→ 置激活。双挂/运行中挂 INVALID_STATE（播种会击穿在飞 run 的链）。
   */
  attach(id: string, journalId: string): Result<{ sessionId: string }> {
    const session = this.sessions.get(id);
    if (session === undefined) return fail('INVALID_ARG', `unknown session: ${id}`);
    if (session.attachedJournalId !== undefined) return fail('INVALID_STATE', 'session already has an attached journal');
    if (session.status() === 'running') return fail('INVALID_STATE', 'cannot attach while a run is in progress');
    const dataDir = resolveDataDir(session.root);
    const file = path.join(sessionsDir(dataDir), `${journalId}.jsonl`);
    if (!fs.existsSync(file)) return fail('INVALID_ARG', `unknown journalId: ${journalId}`);
    const replayEvents = parseJournalFile(file).events;
    const replay = reduceJournal(replayEvents);
    if (replay.version !== 3) return fail('INVALID_ARG', `unsupported journal version: ${String(replay.version)} (v3 required — legacy sessions: node scripts/purge-legacy-sessions.mjs --delete)`);
    session.runtime.harness.context.restoreSession({ chain: replay.chain, chainFrom: replay.chainFrom, compacted: replay.compacted });
    // 转录装载:seg 面重放入核(no-compat——v1 的 msg 行/链派生播种已随 collector 退役)
    session.kernelSeed(reduceSegRows(replayEvents));
    // 等待队列装载(P5 spec §12):末条 steer 行整列回种(无行=空队列)
    session.steerSeed(reduceSteerRows(replayEvents));
    // 影子投影装载(G14.2xx 断线重连):board/delegation 事件行回种——重启后快照/补发不再空板空委派
    session.seedShadow(replayEvents);
    // 会话选择面回放(G14.2xx 公共持久化归位):model/effort/mode 运行中切换即落 meta 旁车,
    // attach 按档归位——重启/重开不再回落装配缺省(CLAUDE.md §13 持久化分层口径)
    const selMeta = readSessionMeta(dataDir, journalId);
    if (selMeta.effort !== undefined) session.setEffort(selMeta.effort);
    if (selMeta.model !== undefined) session.setModel(selMeta.model);
    if (selMeta.mode === 'dontAsk' || selMeta.mode === 'manual' || selMeta.mode === 'plan') session.setMode(selMeta.mode);
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

  /** 会话维挂起回填（G4 裁定 3：interrupt/reset=deny 回填）：P6 §4 表在会话——薄委托 denyPending
   *  （approval→deny、ask→dismissed 清表,不发 notice）;未知会话静默（与旧全表过滤等价） */
  private denyPendingFor(sessionId: string): void {
    this.sessions.get(sessionId)?.denyPending();
  }

  /** 全表回填（close 序步骤 0，同构裁定 3——分会话 denyPending 的全表形态） */
  private denyAllPending(): void {
    for (const session of this.sessions.values()) session.denyPending();
  }

  /** 挂起回执路由（P6 §4）：pid 无会话前缀（`p<n>` 全局票据）——迭代各会话表寻址;命中 false 即
   *  404（未知 pid / kind 错配 / 已回执删除） */
  private resolveApproval(pid: string, decision: ApprovalDecision): boolean {
    for (const session of this.sessions.values()) {
      if (session.resolvePendingApproval(pid, decision)) return true;
    }
    return false;
  }

  private resolveAsk(pid: string, answer: AskUserAnswer): boolean {
    for (const session of this.sessions.values()) {
      if (session.resolvePendingAsk(pid, answer)) return true;
    }
    return false;
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
    // token 语义(G10 后裁定):undefined = 免鉴权档(服务恒绑 127.0.0.1,本地工具不设密);显式传入才启用鉴权
    const token = opts?.token;
    const server = http.createServer((req, res) => this.dispatch(req, res, token));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts?.port ?? 0, LOOPBACK_HOST, () => resolve());
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
   *  G8b T3：`^/session/:sid/pty/:ptyId` 路径分支到 pty 专用连接（帧协议 replay/data/exit/error 与
   *  事件面完全不同，不分支会串协议）；鉴权同双形态先行。
   *  升级响应回显由 ws 库默认行为承担：completeUpgrade 未设 handleProtocols 时取请求协议列表首个
   *  （websocket-server.js `protocols.values().next().value`）写回 Sec-WebSocket-Protocol——客户端
   *  恰好只带一个协议（bearer.<token>），回显即原值，客户端 ws.protocol 可直接校验。30s ping 保活
   *  计时器在此启动，close 时清 */
  private attachWs(server: http.Server, token: string | undefined): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const viaHeader = token !== undefined && req.headers.authorization === `Bearer ${token}`;
      const viaSubprotocol = token !== undefined && req.headers['sec-websocket-protocol'] === `bearer.${token}`;
      // teardown 已启动即不再收新连接（WS 先于 server close 退场，此处与鉴权失败同拒升级）
      // token undefined = 免鉴权档:升级径直放行(回环兜底)
      if (this.closePromise || (token !== undefined && !viaHeader && !viaSubprotocol)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const pathname = urlOf(req).pathname;
      const m = /^\/session\/([^/]+)\/pty\/([^/]+)$/.exec(pathname);
      if (m) {
        // 段解码失败按字面处理（get 未命中 → error 帧，fail-closed 不放行错位寻址）
        wss.handleUpgrade(req, socket, head, (ws) => this.onPtyConnection(ws, safeDecode(m[1]), safeDecode(m[2])));
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
      for (const frame of session.pendingFrames()) ws.send(JSON.stringify(frame)); // 挂起重发(P6 §4:表在会话)
    }
  }

  /** pty 专用 WS 连接生命周期（G8b T3，帧协议逐字 spec §终端目录）：
   *  - 未知 ptyId：升级后即发 `{"t":"error","message":"pty not found"}` 后 close(1008)
   *  - ptyId 存在但不属本会话（G8e-T4 ownerOf 校验）：同 error 帧 `pty not found for session` 后
   *    close(1008)——错位寻址（会话 B 连会话 A 的终端）fail-closed，不串读他人终端
   *  - attach 即重放：首帧 `{"t":"replay","b":base64(环形缓冲)}`（断线重连重放，U-D5）
   *  - 下行：onData → `{"t":"data","b"}` / onExit → `{"t":"exit","code"}` + ws.close(1000)
   *  - 上行：`{"t":"in","b"}` → write（base64 解 UTF-8）/ `{"t":"resize","cols","rows"}` → resize
   *    （正整数校验，坏帧/非法形态静默忽略）
   *  - ws close ≠ kill：断线保活（kill 只走 DELETE / 两处 teardown 插杀），重连靠 replay 补窗；
   *    T2 回调不可注销——close 置 attached=false 门 + sendPtyFrame readyState 判存双保险
   *  - resize/write 对已退出会话是 no-op（T2 内建防崩，daemon 侧不 try/catch） */
  private onPtyConnection(ws: WebSocket, sessionId: string, ptyId: string): void {
    const pty = this.ptyManager.get(ptyId);
    ws.on('error', () => {}); // EventEmitter 契约：挂空 listener，socket 错误细节不倒面（同 onWsConnection）
    if (pty === undefined) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'error', message: 'pty not found' }));
      ws.close(1008);
      return;
    }
    // G8e-T4 归属校验：条目在但 owner ≠ 本会话 → 同 error 帧语义（'pty not found for session'）后
    // close(1008)——错位寻址 fail-closed 不串读；与 get() 同拍同步查，条目在场性一致
    if (this.ptyManager.ownerOf(ptyId) !== sessionId) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'error', message: 'pty not found for session' }));
      ws.close(1008);
      return;
    }
    this.ptySockets.add(ws);
    this.wsLastPong.set(ws, Date.now());
    ws.on('pong', () => this.wsLastPong.set(ws, Date.now()));
    ws.send(JSON.stringify({ t: 'replay', b: Buffer.from(pty.replay(), 'utf8').toString('base64') }));
    let attached = true;
    pty.onData((d) => {
      if (attached) sendPtyFrame(ws, { t: 'data', b: Buffer.from(d, 'utf8').toString('base64') });
    });
    pty.onExit((code) => {
      if (!attached) return;
      sendPtyFrame(ws, { t: 'exit', code });
      ws.close(1000);
    });
    ws.on('message', (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // 坏帧忽略：非 JSON/半截帧静默丢弃
      }
      const f = frame as { t?: unknown; b?: unknown; cols?: unknown; rows?: unknown } | null;
      if (f === null || typeof f !== 'object') return;
      if (f.t === 'in' && typeof f.b === 'string') {
        pty.write(Buffer.from(f.b, 'base64').toString('utf8'));
        return;
      }
      if (f.t === 'resize' && Number.isInteger(f.cols) && (f.cols as number) > 0 && Number.isInteger(f.rows) && (f.rows as number) > 0) {
        pty.resize(f.cols as number, f.rows as number);
      }
    });
    ws.on('close', () => {
      attached = false;
      this.ptySockets.delete(ws);
    });
  }

  /** 保活心跳：逐连接判活——pong 静默超 60s 即 terminate（close 事件统一清理 Set），否则发 ping；
   *  G8b T3：pty 专用 WS 共用本面（ptySockets 独立 Set + 同一 wsLastPong 计时） */
  private heartbeat(): void {
    const now = Date.now();
    for (const ws of this.wsClients) this.beat(ws, now);
    for (const ws of this.ptySockets) this.beat(ws, now);
  }

  /** 单连接保活判定（heartbeat 内联步）：超时 terminate / 存活 ping */
  private beat(ws: WebSocket, now: number): void {
    if (now - (this.wsLastPong.get(ws) ?? now) > PONG_TIMEOUT_MS) {
      ws.terminate();
      return;
    }
    ws.ping();
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
    // 0c) pty 全量插杀（G8b T3，teardown 插杀处之二）：逐会话 killAllFor 覆盖全部条目（owner 恒为
    //     会话 id——daemon 持 manager、session.ts 不引 pty 的 serve 分层面）。kill 同步注销，exit 帧
    //     异步送达在线 pty WS（尽力投递，网络面下一拍收口）；防孤儿 conpty 拖住 daemon close
    for (const id of [...this.sessions.keys()]) this.ptyManager.killAllFor(id);
    // 1) WS 面先收：停 ping 计时器，逐连接 1001 Going Away 后 wss.close——先于 HTTP server close，
    //    升级连接与请求连接同序退场，server close 时无存活的升级套接字拖尾；pty 专用 WS（ptySockets）
    //    同拍退场（wss.close 统一收口两面的连接）
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    const wss = this.wss;
    if (wss) {
      for (const ws of this.wsClients) ws.close(1001);
      for (const ws of this.ptySockets) ws.close(1001);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      this.wsClients.clear();
      this.ptySockets.clear();
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
    { method: 'GET', path: '/session/:id/model', auth: true, run: async (_req, res, p) => this.handleSessionModelGet(res, p.id) },
    { method: 'POST', path: '/session/:id/model', auth: true, run: (req, res, p) => this.handleSessionModel(req, res, p.id) },
    { method: 'POST', path: '/session/:id/tier', auth: true, run: async (req, res, p) => this.handleSessionTierEffort(req, res, p.id, 'tier') },
    { method: 'POST', path: '/session/:id/effort', auth: true, run: async (req, res, p) => this.handleSessionTierEffort(req, res, p.id, 'effort') },
    { method: 'POST', path: '/session/:id/mode', auth: true, run: (req, res, p) => this.handleSessionMode(req, res, p.id) },
    // G14.2xx GUI 面私有态存取(标签页等;CLAUDE.md §13 持久化分层——<slug>/gui/sessions/<id>.json)
    { method: 'GET', path: '/session/:id/gui-state', auth: true, run: async (_req, res, p) => sessionHandlers.handleGuiStateGet(this.sessionIo, res, p.id) },
    { method: 'PUT', path: '/session/:id/gui-state', auth: true, run: async (req, res, p) => sessionHandlers.handleGuiStatePut(this.sessionIo, req, res, p.id) },
    // G14.2xx 应用级指针档(恢复现场入口:刷新后据此重放 lastRoot/lastJournalId 打开链)
    { method: 'GET', path: '/app/gui-state', auth: true, run: async (_req, res) => sessionHandlers.handleAppGuiStateGet(this.sessionIo, res) },
    { method: 'PUT', path: '/app/gui-state', auth: true, run: async (req, res) => sessionHandlers.handleAppGuiStatePut(this.sessionIo, req, res) },
    // G10-C7 标题总结面：模型一次性概括首条用户消息(≤20 字,无状态不落盘)——落盘走 rename(G14.16)
    { method: 'POST', path: '/session/:id/title', auth: true, run: (req, res, p) => this.handleSessionTitle(req, res, p.id) },
    // G14.16 标题统一流：rename 落旁车 <id>.meta.json(侧栏/TUI 列表同源)；GET 回读(重开回显)
    { method: 'POST', path: '/session/:id/rename', auth: true, run: (req, res, p) => this.handleSessionRename(req, res, p.id) },
    { method: 'GET', path: '/session/:id/title/get', auth: true, run: async (_req, res, p) => this.handleSessionTitleGet(res, p.id) },
    // G10-C11 建项目面：原生文件选择器选完自动建项目——name=浏览器态(projectsRoot 下建目录+初始化)、
    // path=桌面壳态(系统对话框回全路径,直接注册外部根);同名幂等返回既有行
    { method: 'POST', path: '/workspace/create', auth: true, run: (req, res) => this.handleWorkspaceCreate(req, res) },
    // G14.69 原生选择定位:浏览器态 showDirectoryPicker 拿不到绝对路径——GUI 在所选目录落标记
    // 文件,daemon 全盘 BFS 找标记即得绝对路径(限时/噪声目录跳过/roots 可覆写供测试)
    { method: 'POST', path: '/workspace/locate', auth: true, run: (req, res) => this.handleWorkspaceLocate(req, res) },
    { method: 'POST', path: '/session/:id/steer/cancel', auth: true, run: async (req, res, p) => this.handleSteerCancel(req, res, p.id) },
    { method: 'POST', path: '/session/:id/steer/move', auth: true, run: async (req, res, p) => this.handleSteerMove(req, res, p.id) },
    { method: 'POST', path: '/session/:id/steer/front', auth: true, run: async (req, res, p) => this.handleSteerFront(req, res, p.id) },
    { method: 'POST', path: '/session/:id/steer/edit', auth: true, run: async (req, res, p) => this.handleSteerEdit(req, res, p.id) },
    { method: 'GET', path: '/session/:id/anchors', auth: true, run: async (_req, res, p) => this.handleAnchors(res, p.id) },
    { method: 'POST', path: '/session/:id/rewind', auth: true, run: async (req, res, p) => this.handleBranch(req, res, p.id, 'rewind') },
    { method: 'POST', path: '/session/:id/fork', auth: true, run: async (req, res, p) => this.handleBranch(req, res, p.id, 'fork') },
    // G14.29 辅助问答：fork 整档旁路 + 隔离一轮，主会话零污染（TUI /btw 同机制）
    { method: 'POST', path: '/session/:id/btw', auth: true, run: (req, res, p) => this.handleSessionBtw(req, res, p.id) },
    { method: 'POST', path: '/memory/rm', auth: true, run: (req, res) => this.handleMemoryRm(req, res) },
    { method: 'GET', path: '/memory', auth: true, run: async (req, res) => this.handleMemoryList(req, res) },
    { method: 'GET', path: '/session/:id/tasks', auth: true, run: async (_req, res, p) => this.handleSessionTasks(res, p.id) },
    { method: 'GET', path: '/session/:id/context', auth: true, run: async (_req, res, p) => this.handleSessionContext(res, p.id) },
    // G6 文件预览面：会话 root 内只读文本预览（Files 页消费；判界/二进制/512KB 截断语义见 handleFile）
    { method: 'GET', path: '/session/:id/file', auth: true, run: async (req, res, p) => this.handleFile(req, res, p.id) },
    // G7 diff 面：write 调用 pre-image ↔ 磁盘现文件双内容（Chat write 展开消费；查询面见 handleDiff）
    { method: 'GET', path: '/session/:id/diff', auth: true, run: async (req, res, p) => this.handleDiff(req, res, p.id) },
    // G8b T4 tree 面：会话 root 内单层目录列举（Files 页树消费；忽略集/500 上限/判界语义见 handleTree）
    { method: 'GET', path: '/session/:id/tree', auth: true, run: async (req, res, p) => this.handleTree(req, res, p.id) },
    // G5 看板服务面：lead 审批映射（gated 审批解锁 / in-review 关单——GUI Board 页消费）
    { method: 'POST', path: '/session/:id/board/review', auth: true, run: (req, res, p) => this.handleBoardReview(req, res, p.id) },
    { method: 'POST', path: '/session/:id/attach', auth: true, run: (req, res, p) => this.handleAttach(req, res, p.id) },
    // T2 会话回收：running 409（先收 run 再删）；journal 文件保留（磁盘档案非 daemon 生命周期资产）
    { method: 'POST', path: '/session/:id/delete', auth: true, run: async (_req, res, p) => this.handleDelete(res, p.id) },
    // G8b T3 pty 面：分配（shell 探测 daemon 内定，cols/rows 缺省 80/24）+ kill（幂等）
    { method: 'POST', path: '/session/:id/pty', auth: true, run: (req, res, p) => this.handlePtyAlloc(req, res, p.id) },
    { method: 'DELETE', path: '/session/:id/pty/:ptyId', auth: true, run: async (_req, res, p) => this.handlePtyKill(res, p.id, p.ptyId) },
    // G4 挂起回执面：pid 为 daemon 级挂起票据（会话无关路由——pid 本身寻址，无会话维前缀）
    { method: 'POST', path: '/approval/:pid', auth: true, run: (req, res, p) => this.handleApprovalReply(req, res, p.pid) },
    { method: 'POST', path: '/ask/:pid/reply', auth: true, run: (req, res, p) => this.handleAskReply(req, res, p.pid) },
    // T2 工作区注册表 + 恢复面：workspaces 扫描 / sessions 列档 / dirpicker 目录选择
    { method: 'GET', path: '/workspaces', auth: true, run: async (_req, res) => this.handleWorkspaces(res) },
    { method: 'GET', path: '/sessions', auth: true, run: async (req, res) => this.handleSessions(req, res) },
    { method: 'GET', path: '/sessions/recent', auth: true, run: async (_req, res) => this.handleSessionsRecent(res) },
    { method: 'GET', path: '/commands', auth: true, run: async (_req, res) => this.send(res, 200, { ...listCommands(), supported: COMMAND_SUPPORT }) },
    { method: 'GET', path: '/session/:id/skill-commands', auth: true, run: async (_req, res, p) => this.send(res, 200, this.sessionFor(res, p.id)?.skillCommands() ?? []) },
    // G14.113 分支清单/切换(欢迎页分支选择弹窗;root 必传 query/body)
    { method: 'GET', path: '/git/branches', auth: true, run: async (req, res) => {
        const root = urlOf(req).searchParams.get('root') ?? '';
        if (root === '') return this.send(res, 400, { error: 'root query param required' });
        this.send(res, 200, await gitBranches(path.resolve(root)));
      } },
    // G14.121 工作区文件索引(@ 文件面板;root 必传,文件按 mtime 倒序=最近改动优先;dirs=尾斜杠目录清单,@面板滤目录用)
    { method: 'GET', path: '/workspace/files', auth: true, run: async (req, res) => {
        const root = urlOf(req).searchParams.get('root') ?? '';
        if (root === '') return this.send(res, 400, { error: 'root query param required' });
        const idx = await workspaceFiles(path.resolve(root));
        this.send(res, 200, { files: idx.files, dirs: idx.dirs });
      } },
    { method: 'POST', path: '/git/checkout', auth: true, run: async (req, res) => {
        const parsed = await this.readJson(req);
        if (!parsed.ok) return this.send(res, parsed.status, { error: parsed.error });
        const root = (parsed.body as { root?: unknown }).root;
        const branch = (parsed.body as { branch?: unknown }).branch;
        if (typeof root !== 'string' || typeof branch !== 'string') return this.send(res, 400, { error: 'root and branch required' });
        const r = await checkoutBranch(path.resolve(root), branch);
        if (!r.ok) return this.send(res, 400, { error: r.error });
        this.send(res, 200, { ok: true });
      } },
    { method: 'GET', path: '/session/:id/git-status', auth: true, run: async (_req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const res2 = await gitStatusMap(session.root);
        if (!res2.ok) return this.send(res, 500, { error: res2.error });
        this.send(res, 200, res2.value);
      } },
    // G14.99 工作区未提交变动面（Diff 标签数据源）：git 只读清单/单文件内容/提交/推送
    { method: 'GET', path: '/session/:id/changes', auth: true, run: async (_req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const r = await listChanges(session.root);
        if (!r.ok) return this.send(res, 500, { error: r.error });
        this.send(res, 200, r.value);
      } },
    { method: 'GET', path: '/session/:id/changes/content', auth: true, run: async (req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const rel = urlOf(req).searchParams.get('path') ?? '';
        const r = await changeContent(session.root, rel);
        if (!r.ok) return this.send(res, 400, { error: r.error });
        this.send(res, 200, r.value);
      } },
    { method: 'POST', path: '/session/:id/changes/commit', auth: true, run: async (req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const parsed = await this.readJson(req);
        if (!parsed.ok) return this.send(res, parsed.status, { error: parsed.error });
        const message = (parsed.body as { message?: unknown }).message;
        if (typeof message !== 'string') return this.send(res, 400, { error: 'message required' });
        const r = await commitChanges(session.root, message);
        if (!r.ok) return this.send(res, 400, { error: r.error });
        this.send(res, 200, { ok: true, out: r.value.out });
      } },
    { method: 'POST', path: '/session/:id/changes/push', auth: true, run: async (_req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const r = await pushChanges(session.root);
        if (!r.ok) return this.send(res, 400, { error: r.error });
        this.send(res, 200, { ok: true, out: r.value.out });
      } },
    { method: 'POST', path: '/session/:id/changes/restore', auth: true, run: async (req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const parsed = await this.readJson(req);
        if (!parsed.ok) return this.send(res, parsed.status, { error: parsed.error });
        const pathArg = (parsed.body as { path?: unknown }).path;
        if (typeof pathArg !== 'string') return this.send(res, 400, { error: 'path required' });
        const r = await restoreChange(session.root, pathArg);
        if (!r.ok) return this.send(res, 400, { error: r.error });
        this.send(res, 200, { ok: true });
      } },
    { method: 'POST', path: '/session/:id/command', auth: true, run: (req, res, p) => this.handleSessionCommand(req, res, p.id) },
    { method: 'GET', path: '/dirpicker', auth: true, run: async (req, res) => this.handleDirpicker(req, res) },
    // G8c T2 settings 面：effective 视图（来源分层 env>project>global>default）+ 项目级结构化改写
    // （含注释 409 引流 raw 编辑面；成功后清自填槽重载链，新会话即刻生效）
    { method: 'GET', path: '/settings', auth: true, run: async (req, res) => this.handleSettingsGet(req, res) },
    { method: 'PUT', path: '/settings', auth: true, run: (req, res) => this.handleSettingsPut(req, res) },
    // G8c T3 raw 双文件面：settings.json/mcp.json 原文编辑（JSONC 注释保真）——GET 原文复读 + PUT
    // 服务端验证拒存（验证口径=装载口径）+ 原子写；T2 结构化改写 409（含注释/畸形）的引流目标端点
    { method: 'GET', path: '/settings/raw', auth: true, run: async (req, res) => this.handleSettingsRawGet(req, res) },
    { method: 'PUT', path: '/settings/raw', auth: true, run: (req, res) => this.handleSettingsRawPut(req, res) },
    // G8c T4 mcp 面：两级遮蔽视图 + 单台真探测 + 项目级结构化写（mcp 装配期语义——写盘不触发
    // settings reload，新会话/下次装配生效）
    { method: 'GET', path: '/settings/mcp', auth: true, run: async (req, res) => this.handleMcpGet(req, res) },
    { method: 'POST', path: '/settings/mcp/probe', auth: true, run: (req, res) => this.handleMcpProbe(req, res) },
    { method: 'PUT', path: '/settings/mcp', auth: true, run: (req, res) => this.handleMcpPut(req, res) },
    // G8c T5 agents 面：两级宽容清单 + builtins 四角色 / 表单增删改（upsert 写后回读验证——装配
    // fail-fast 的写盘前防线；delete 幂等；agents 装配期读取，写盘不触发 settings reload）
    { method: 'GET', path: '/settings/agents', auth: true, run: async (req, res) => this.handleAgentsGet(req, res) },
    { method: 'PUT', path: '/settings/agents', auth: true, run: (req, res) => this.handleAgentsPut(req, res) },
    // G8d T3 agents 全文面：agent.md frontmatter 后正文全文（AgentsPane 编辑播种升级——清单面
    // bodyPreview 200 帽的引流端点；id/scope 守卫与定位裁定同 PUT 面）
    { method: 'GET', path: '/settings/agents/body', auth: true, run: async (req, res) => this.handleAgentsBodyGet(req, res) },
    // G8c T6 skills/memory-stats 面：三源分组清单（project 五根合并一组/user 全局/learned 工作区锚定；
    // 组内沿装载序去重、跨组不去重——展示面重复 id 保留）+ 主域记忆概览（条数+最近写入，只读零副作用）
    { method: 'GET', path: '/settings/skills', auth: true, run: async (req, res) => this.handleSkillsGet(req, res) },
    { method: 'GET', path: '/settings/memory-stats', auth: true, run: async (req, res) => this.handleMemoryStatsGet(req, res) },
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

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse, token: string | undefined): void {
    const url = urlOf(req);
    const matched = this.matchRoute(req.method ?? 'GET', url.pathname);
    if (matched) {
      // 鉴权（§4.3/G10 收敛）：token 在场才验 Bearer（undefined=免鉴权档，恒绑回环兜底）；401 先于
      // 会话解析（不泄露会话语义）——恒时比较不做（token 非密钥材料，回环面时序侧信道无实义）
      if (token !== undefined && matched.route.auth && req.headers.authorization !== `Bearer ${token}`) {
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
      // G14.95 no-cache:index.html 恒回源(assets 文件名带内容 hash 可长缓存)——开发迭代不再踩旧壳缓存
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
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

  /** POST /session/new {root, mode?}（spec §4.1）：root 必填（无 root 400+迁移提示——旧裸软重置语义让位
   *  /session/:id/reset）；可选 mode:'manual' 透传 createSession（G4 补面：HTTP 建 manual 会话——CLI
   *  --manual 只作用预选会话,无此面 e2e/客户端无法经 HTTP 装配 manual;其余值含缺省 = dontAsk 零变化）；
   *  createSession 单点（存在性/目录校验 INVALID_ARG → 400）→ 200 {ok,sessionId} */

  /** submit 处理（会话维 + 裸别名共用）：goal 非空 string 校验 → 会话 run 锁（409 拒二次提交）→
   *  202 即回（受理面；run 异步收束细节见 SessionRuntime.submit） */

  /** interrupt 处理：无在跑 run 409；中止信号发出即 200（run 以 stopReason=interrupted 收束后清锁）。
   *  G4 裁定 3：中止后该会话全部未决挂起以 deny/dismissed 回填并清表——asker promise 不回填则被中止
   *  run 永不收束（僵尸 run） */

  /** steer 处理（G3）：text 非空 string 校验（空白串与 enqueue 的 trim-忽略口径一致前置拒——静默
   *  no-op 的 200 比显式 400 更糟）→ 入该会话 steering → 恒 200 {ok:true}，无 409 分径（裁定：
   *  steering 非独占面，排队语义即承诺） */

  /** reset 处理（旧 /session/new 软重置语义迁入）：中止在跑 run + 换新运行时 + 清投影/转录/缓冲，
   *  200 {ok:true}（语义面见 SessionRuntime.reset）。G4：中止前该会话挂起回填（deny/dismissed——
   *  同 interrupt 裁定 3，防僵尸 asker promise 拖住被中止 run）；收尾广播 `{kind:'reset', sessionId}`
   *  通知帧（裁定 7：GUI 清本地投影重播种；无 seq，不入单调序列） */

  /** POST /approval/:pid {decision}（G4）：挂起表命中且 kind 对 → resolve + notice 事件帧（经该会话
   *  pump，转录可见）+ 200 {ok:true}；未知 pid / 已决（重复回执）/ kind 不符（ask 挂起错打 approval
   *  端点）统一 404；decision 非法字面 400（ApprovalDecision = 'allow'|'always'|'deny'） */

  /** POST /ask/:pid/reply {answer}（G4）：同构 approval 回执——AskUserAnswer 三态载荷校验（400）→
   *  命中且 kind 对 resolve + notice（`ask <pid> answered`）+ 200；未知/已决/kind 不符 404 */

  /** snapshot 处理：会话快照单点（载荷形态见 SessionRuntime.snapshotResponse）。G5 增挂起段——
   *  daemon 侧合并（snapshotResponse 保持 session 内聚不持挂起表）：本会话过滤（entry.sessionId）
   *  → [{pid, kind, req}]（G7 增 req=挂起表 entry.req 直序列化——连接层 pid 去重拦了重连重发帧，
   *  snapshot.pending 是 GUI 刷新/reseed 后卡内容的唯一来源），跨会话卡恢复（GUI 刷新/重连后重放
   *  挂起面）的基座 */
  /** POST /session/:id/title {text}(G10-C7):模型一次性总结会话标题(≤20 字,只回标题本身);
   *  无状态不落盘——标题缓存与编辑态由客户端 localStorage 承载;模型未接线/调用失败 503 降级 */

  /** 会话 id 形验（旁车文件名面）：newSessionId 产物字符集（时间戳+随机尾/attach journal id 同源），
   *  拒路径序列——旁车按 id 拼 sessionsDir 路径，越界 id 不得穿透 */
  /** POST /session/:id/btw {question}(G14.29 辅助问答,对标 Codex /side /btw):fork 整档旁路
   *  (side 标记,列表滤除)+ 一次性隔离 runtime 跑一轮问答,reply 直接回执——主会话上下文零污染。
   *  超时 180s 兜底;runtime 用完即弃(mcpClose 收口) */

  /** POST /session/:id/rename {title}(G14.16 标题统一流)：旁车 <journalId>.meta.json 落盘——
   *  键用 attachedJournalId(列表 listSessions 以 journal 档为行,rename 必须同键才可见)；
   *  无档会话 409(空会话零落盘不变式不破——GUI 乐观上屏静默降级,首轮建档后再改即持久)。
   *  title trim 非空、帽 80 字 */

  /** GET /session/:id/title/get(G14.16)：旁车标题回读(重开回显;无档/无旁车 = 无自定义名,
   *  title 缺省回空对象——客户端回落摘要,不当作错误) */

  /** POST /workspace/create {name}|{path}(G10-C11):原生文件选择器确认后自动建项目。
   *  name=浏览器态(showDirectoryPicker 只回名字):projectsRoot 下建 <name>/ 并初始化
   *  data/sessions + data/workspace.json{root:<name> 目录};path=桌面壳态:注册该既有目录为
   *  项目根(workspace.json 落 projectsRoot/<basename>/data)。同名/同根幂等返回既有行 */
  /** POST /workspace/locate {token, roots?}(G14.69 原生选择定位):浏览器 File System Access
   *  只回目录名不回路径——GUI 在用户所选目录写一枚标记文件,daemon 从各盘根 BFS 找同名标记文件,
   *  所在目录即所选文件夹绝对路径。roots 覆写供测试/加速;超时/未找到回 path:null(GUI 回退自建浏览) */

  /** POST /session/:id/rewind|fork {turn}(G10-C1d):1-based 轮锚点;不可变分档(branchFrom,源档零改动)。
   *  rewind=本会话切到新档(attach 重播种,原时间线保留可 /resume);fork=新会话分叉,源会话不动 */

  /** POST /session/:id/tier {tier} / …/effort {effort}(G10-C2b):per-run 覆盖,下一轮生效;
   *  'default'/缺省字段=清除覆盖回缺省;非法值 400 */

  /** POST /session/:id/model {model?: string}(G10-C1b):运行中模型切换,daemon 级共享切换器;
   *  无切换器 409 not switchable / 未知 id 400 unknown model(不动现状) */

  /** GET /session/:id/file?path=（G6 预览面，Files 页消费）：query path 必填（400）→ 会话解析
   *  （未知 :id 404）→ path.resolve(session.root, path) 归一（相对/绝对均可）→ 判界（本会话
   *  harness.safety 的路径判定面——insideTrustedRoots 单点，/diff 同口径）→ 越界 403 {path
   *  outside trusted roots} → readFileBounded（G7 抽取共用：missing 404 / binary 415 / >512KB
   *  截断 truncated:true）→ 200 {path, content, truncated?}。仅 GET（路由表 method 精确匹配） */

  /** GET /session/:id/diff?callId=（G7 收口交接，Chat write 展开/Files 消费）：write 调用的
   *  pre-image ↔ 磁盘现文件双内容。查询面现场核结论——daemon 会话的 write 影子快照 drain 仅在
   *  dispose/reset（清单随 seal 落 journal），会话存续期内 sink 内存清单常驻：**run 中与 run 后
   *  均查内存实时可得**（blob 落盘 <dataDir>/sessions/_blobs/<sha256> 即时可见）。callId → 调用
   *  对位：帧缓冲（512 环）内按序扫 tool-call 帧——首枚命中 callId 的帧即目标（text=注册名须
   *  'write'，payload.input.path 解析绝对路径）；同路径此前 write 调用的位次=该次 pre-image 在
   *  sink 清单的序（nthFor 按调用序对位，同路径多次写各自取写前态）。响应
   *  200 {path, oldContent?, newContent, truncated?}：oldContent=sink pre-image blob（512KB 截断；
   *  新建写无 blob 缺场）；newContent=磁盘现文件（readFileBounded——判界/截断/二进制同 /file）；
   *  truncated=任一侧截断。404 面：未知会话 / callId 无帧（含缓冲环已裁）/ 非 write / 无快照
   *  （root 外写不入清单）→ {error:'no snapshot'}；400：缺 callId。帧环裁剪的退化：目标帧若已被
   *  环裁（>512 事件）即 404——GUI 退单列现内容（调用方回执 input.content），记档报告 */

  /** GET /session/:id/tree?path=<rel>（G8b T4 目录树面，Files 页消费）：path 缺省 ''=会话 root →
   *  判界样板同 /file（realPathOf 归一 ?? 字面兜底 → insideTrustedRoots，越界 403 恒定文案）→
   *  statSync 跟随后实态（不存在 404 / 非目录 400）→ readdirSync withFileTypes 单层列举：IGNORED
   *  名不枚举；symlink/junction 条目按跟随实态分型（dirent 对链接按链接本体分类——指向目录的
   *  链接 isDirectory()=false，win32 junction 同理，须 statSync 校正；断链/竞态消失的条目跳过）；
   *  排序=目录段先于文件段、同段 name 码点序；超 TREE_MAX_ENTRIES 截断+truncated:true →
   *  200 {entries:[{name,kind:'dir'|'file'}],truncated?} */

  /** POST /session/:id/board/review {taskId, approved}（G5 看板服务面）：body 校验（taskId 非空
   *  string + approved boolean → 400）→ 该会话 taskboard.review 双语义（gated → 审批：approved
   *  解锁派发 / 拒绝维持；in-review → 关单：approved=done / 拒=failed）→ r.ok 200 {ok:true} /
   *  fail 400 {error: r.error.message}（未知任务/状态不符直译）；未知 :id 404（sessionFor 单点）。
   *  review 触发的 gate-resolved/task-status 事件经该会话 pump 自然广播（既有链，零新协议） */

  /** POST /session/:id/attach {journalId}（T2）：journalId 非空 string 校验 → 未知 :id 404 →
   *  attach 单点（INVALID_ARG→400 / INVALID_STATE→409）→ 200 {ok,sessionId}（并置激活） */

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
    // G8b T3 插杀（单会话回收处）：会话回收连带清杀其全部 pty（daemon 持 manager——serve 分层，
    // session.ts 不引 pty）；kill 同步注销 → 该会话 pty 的后续 WS 连入收 error 'pty not found'
    this.ptyManager.killAllFor(id);
    if (this.active === id) this.active = undefined;
    this.send(res, 200, { ok: true });
  }

  /** POST /session/:id/pty {cols?,rows?}（G8b T3 分配面）：cols/rows 缺省 80/24，在场须正整数
   *  （400）→ 会话解析（未知 :id 404，sessionFor 单点）→ shell 探测 daemon 内定（win32
   *  powershell.exe / 其余 process.env.SHELL ?? /bin/bash）→ PtyManager.spawn（cwd=session.root、
   *  owner=:id、env 继承 process.env）→ 200 {ptyId}（`pty-<n>` 单调永不复用）。T5/T6 拿 ptyId 连
   *  `/session/:id/pty/:ptyId` 专用 WS 升级路径（本文件 attachWs 分支） */

  /** DELETE /session/:id/pty/:ptyId（G8b T3 kill 面）：PtyManager.kill 幂等（无此 id 静默）——重复
   *  DELETE / 自然退出后再删均 200 {ok:true}；kill 同步注销（has→false 立即），exit 帧异步送达在线
   *  pty WS。会话解析先行（未知 :id 404，sessionFor 单点——路由面会话维语义一致性）。
   *  G8e-T4 归属校验：条目在但 owner ≠ :id → 404 'pty not found for session'（跨会话删他人终端
   *  拒绝且不误杀）；条目不在 → 200 幂等面维持（kill 幂等语义不因校验收紧而回退） */

  /** GET /workspaces（T2）：扫 projectsRoot() 下各 `<slug>/data` 存在者——root 经 workspace.json
   *  反解（历史工作区无档 → slug-only 行不可 attach）；mtime=dataDir mtime；sessionCount=sessions
   *  子目录 jsonl 计数（缺目录=0）。行序 mtime 降序（最近工作区在前，首页呈现序）；单目录/单档的
   *  扫描竞态（readdir 与 stat 之间被删）跳过该条目，不击穿整个列表 */

  /** GET /sessions/recent(G10-C2):跨工作区扁平最近会话(侧栏 Recents 区数据源)——遍历注册表
   *  逐 dataDir listSessions 归并,updatedAt 降序取前 20;每条附 root/slug(attach 两步寻址用) */

  /** GET /sessions?root=（T2）：root 必填（缺省 400——无 root 无法定位 dataDir）→ listSessions
   *  dirs=readdirSync withFileTypes 只目录 + 排序；parent=resolve('..')（盘根时=自身） */


  // ---------- D31 分域拆分：配置面处理器迁 config-handlers.ts（io 注入 send/readJson/
  //  reloadSettingsChain 三面——配置块对类状态的全部触点）；本类保留路由表与薄委托，行为零变化
  //  （daemon.test 全量为锚）。wire/static/config-helpers 助手域随批迁叶子模块 ----------
  private get configIo(): ConfigHandlerIo {
    return {
      send: (res, status, body) => this.send(res, status, body),
      readJson: (req) => this.readJson(req),
      reloadSettingsChain: (root) => this.reloadSettingsChain(root),
    };
  }

  /** PUT /settings 成功后的链重载（G8c T2）：清全部自填槽（env 槽 + 登记集，清集在删槽后、重装前）
   *  → 按项目→全局序重装（applySettings 只填缺省：真导出环境变量恒最优先，重载天然不触碰）。
   *  逐级 try/catch：PUT 已写盘成功是既成事实——重装时任一级文件畸形（如全局 settings 坏）不能让
   *  PUT 回 500（写成功却报失败误导；且坏文件会结构性死锁一切后续结构化改写）。该级跳过、错误经
   *  stderr 透出（与 warnings 同通道）；畸形文件的 fail-fast 属装载链入口（CLI）职责，不在此处。
   *  窄缝：进程内链可能来自其他 root 的项目文件——本重载以 PUT 目标 root 为准重装，跨 root 场景
   *  以最近编辑为准；root 缺省（scope=global 结构化写）只重装全局面 */
  private reloadSettingsChain(root: string | undefined): void {
    for (const slot of getSelfFilledSlots()) delete process.env[slot];
    resetSelfFilledSlots();
    for (const filePath of [...(root !== undefined ? [loadProjectSettings(root)] : []), loadGlobalSettings()]) {
      try {
        for (const w of applySettings(filePath).warnings) console.error(`[serve] ${w}`);
      } catch (err) {
        console.error(`[serve] settings reload failed (${filePath}):`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private handleSettingsGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleSettingsGet(this.configIo, req, res);
  }

  private async handleSettingsPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleSettingsPut(this.configIo, req, res);
  }

  private handleSettingsRawGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleSettingsRawGet(this.configIo, req, res);
  }

  private async handleSettingsRawPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleSettingsRawPut(this.configIo, req, res);
  }

  private handleMcpGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleMcpGet(this.configIo, req, res);
  }

  private async handleMcpProbe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleMcpProbe(this.configIo, req, res);
  }

  private async handleMcpPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleMcpPut(this.configIo, req, res);
  }

  private handleAgentsGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleAgentsGet(this.configIo, req, res);
  }

  private async handleAgentsPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleAgentsPut(this.configIo, req, res);
  }

  private handleAgentsBodyGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleAgentsBodyGet(this.configIo, req, res);
  }

  private handleSkillsGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleSkillsGet(this.configIo, req, res);
  }

  private handleMemoryStatsGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleMemoryStatsGet(this.configIo, req, res);
  }

  // ---------- D31 批2 分域：会话控制面迁 session-handlers.ts（io 九面：send/readJson/sessionFor/
  //  sessions/denyPendingFor/broadcastFrame/pending/model/attach），文件面迁 file-handlers.ts
  //  （io 两面）；本类保留路由表与薄委托，行为零变化（daemon.test 为锚） ----------
  private get sessionIo(): SessionHandlerIo {
    return {
      send: (res, status, body) => this.send(res, status, body),
      readJson: (req) => this.readJson(req),
      sessionFor: (res, id) => this.sessionFor(res, id),
      sessions: this.sessions,
      denyPendingFor: (sessionId) => this.denyPendingFor(sessionId),
      broadcastFrame: (frame) => this.broadcastFrame(frame),
      model: this.model,
      attach: (id, journalId) => this.attach(id, journalId),
      createSession: (root, opts) => this.createSession(root, opts),
      defaultScratchRoot: () => this.defaultScratchRoot(),
      resolveApproval: (pid, decision) => this.resolveApproval(pid, decision),
      resolveAsk: (pid, answer) => this.resolveAsk(pid, answer),
    };
  }

  private get fileIo(): FileHandlerIo {
    return {
      send: (res, status, body) => this.send(res, status, body),
      sessionFor: (res, id) => this.sessionFor(res, id),
    };
  }

  // ---------- D31 批3 分域：工作区面迁 workspace-handlers.ts（io 两面）、pty 面迁 pty-handlers.ts
  //  （io 五面，ptyId 铸造经 nextPtyId 回调持守类内单调 seq）、memory 两处理器并入 config-handlers ——
  //  本类保留路由表与薄委托，行为零变化（daemon.test 为锚） ----------
  private get workspaceIo(): WorkspaceHandlerIo {
    return {
      send: (res, status, body) => this.send(res, status, body),
      readJson: (req) => this.readJson(req),
    };
  }

  private get ptyIo(): PtyHandlerIo {
    return {
      send: (res, status, body) => this.send(res, status, body),
      readJson: (req) => this.readJson(req),
      sessionFor: (res, id) => this.sessionFor(res, id),
      ptyManager: this.ptyManager,
      nextPtyId: () => `pty-${(this.ptySeq += 1)}`,
    };
  }
  private async handleWorkspaceLocate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await workspaceHandlers.handleWorkspaceLocate(this.workspaceIo, req, res);
  }

  private async handleWorkspaceCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await workspaceHandlers.handleWorkspaceCreate(this.workspaceIo, req, res);
  }

  private handleWorkspaces(res: http.ServerResponse): void {
    workspaceHandlers.handleWorkspaces(this.workspaceIo, res);
  }

  private handleDirpicker(req: http.IncomingMessage, res: http.ServerResponse): void {
    workspaceHandlers.handleDirpicker(this.workspaceIo, req, res);
  }

  private async handleMemoryRm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleMemoryRm(this.configIo, req, res);
  }

  private handleMemoryList(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleMemoryList(this.configIo, req, res);
  }

  private async handlePtyAlloc(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await ptyHandlers.handlePtyAlloc(this.ptyIo, req, res, id);
  }

  private handlePtyKill(res: http.ServerResponse, id: string, ptyId: string): void {
    ptyHandlers.handlePtyKill(this.ptyIo, res, id, ptyId);
  }
  private async handleSessionNew(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await sessionHandlers.handleSessionNew(this.sessionIo, req, res);
  }

  private async handleApprovalReply(req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
    await sessionHandlers.handleApprovalReply(this.sessionIo, req, res, pid);
  }

  private async handleAskReply(req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
    await sessionHandlers.handleAskReply(this.sessionIo, req, res, pid);
  }

  private async handleSessionBtw(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionBtw(this.sessionIo, req, res, id);
  }

  private async handleBranch(req: http.IncomingMessage, res: http.ServerResponse, id: string, kind: 'rewind' | 'fork'): Promise<void> {
    await sessionHandlers.handleBranch(this.sessionIo, req, res, id, kind);
  }

  private handleSessionsRecent(res: http.ServerResponse): void {
    sessionHandlers.handleSessionsRecent(this.sessionIo, res);
  }

  private handleSessions(req: http.IncomingMessage, res: http.ServerResponse): void {
    sessionHandlers.handleSessions(this.sessionIo, req, res);
  }
  private async handleSubmit(req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
    await sessionHandlers.handleSubmit(this.sessionIo, req, res, id);
  }

  private handleInterrupt(res: http.ServerResponse, id: string | undefined): void {
    sessionHandlers.handleInterrupt(this.sessionIo, res, id);
  }

  private async handleSteer(req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
    await sessionHandlers.handleSteer(this.sessionIo, req, res, id);
  }

  private async handleReset(res: http.ServerResponse, id: string | undefined): Promise<void> {
    await sessionHandlers.handleReset(this.sessionIo, res, id);
  }

  private async handleSessionCommand(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionCommand(this.sessionIo, req, res, id);
  }

  private handleSessionTasks(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleSessionTasks(this.sessionIo, res, id);
  }

  private handleSessionContext(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleSessionContext(this.sessionIo, res, id);
  }

  private handleAnchors(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleAnchors(this.sessionIo, res, id);
  }

  private handleSnapshot(res: http.ServerResponse, id: string | undefined): void {
    sessionHandlers.handleSnapshot(this.sessionIo, res, id);
  }

  private async handleSteerMove(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSteerMove(this.sessionIo, req, res, id);
  }

  private async handleSteerFront(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSteerFront(this.sessionIo, req, res, id);
  }

  private async handleSteerCancel(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSteerCancel(this.sessionIo, req, res, id);
  }

  private async handleSteerEdit(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSteerEdit(this.sessionIo, req, res, id);
  }

  private async handleSessionTierEffort(req: http.IncomingMessage, res: http.ServerResponse, id: string, kind: 'tier' | 'effort'): Promise<void> {
    await sessionHandlers.handleSessionTierEffort(this.sessionIo, req, res, id, kind);
  }

  private handleSessionModelGet(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleSessionModelGet(this.sessionIo, res, id);
  }

  private async handleSessionModel(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionModel(this.sessionIo, req, res, id);
  }

  private async handleSessionMode(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionMode(this.sessionIo, req, res, id);
  }

  private async handleBoardReview(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleBoardReview(this.sessionIo, req, res, id);
  }

  private async handleSessionRename(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionRename(this.sessionIo, req, res, id);
  }

  private handleSessionTitleGet(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleSessionTitleGet(this.sessionIo, res, id);
  }

  private async handleSessionTitle(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionTitle(this.sessionIo, req, res, id);
  }

  private async handleAttach(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleAttach(this.sessionIo, req, res, id);
  }

  private handleFile(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    fileHandlers.handleFile(this.fileIo, req, res, id);
  }

  private handleDiff(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    fileHandlers.handleDiff(this.fileIo, req, res, id);
  }

  private handleTree(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    fileHandlers.handleTree(this.fileIo, req, res, id);
  }


  private send(res: http.ServerResponse, status: number, body: object): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
