import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createRuntime, TuiRuntime } from '../tui/runtime';
import { ModelAdapter } from '../model/adapter';
import { SessionEvent } from '../types';
import { applyBoardEvent, emptyBoard } from '../taskboard/model';
import type { TaskBoardState } from '../taskboard/model';
import { applyDelegation } from '../delegation/projection';
import type { Delegation } from '../delegation/projection';
import { boardEventFrom } from '../tui/session';
import { TranscriptCollector } from './transcript';
import type { TranscriptEntry } from './transcript';

/** GUI daemon 构造面：root 为项目目录；model 与 CLI buildModel/TUI 同源注入（三面同一 ModelAdapter 契约）；
 *  staticRoot 为 GUI 静态产物目录（G3 静态挂载），缺省 cwd 相对 dist-gui——serve 命令从仓库根跑即对，
 *  测试注入 tmp 路径保持 hermetic */
export interface GuiDaemonOpts {
  root: string;
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

/** 单 run 锁的在场票据：abort 句柄持有即「运行中」，run 收束（含中断/失败）即清位；done 为 run promise
 *  本体——teardown 步骤 0 有界等待的锚点（被中止 run 的 settle 收口等待经它观测） */
interface CurrentRun {
  abort: AbortController;
  done: Promise<void>;
}

/** JSON body 上限（1MB）：防无界 body 撑爆 daemon 内存；超限即断连收口 */
const MAX_BODY_BYTES = 1024 * 1024;

/** 事件环形缓冲容量（重连补发窗口）：满即丢最老——daemon 长跑不无界涨内存 */
const EVENT_BUFFER_CAP = 512;

/** WS 保活节拍：30s 一 ping；pong 静默超 60s 即 terminate（close 事件统一清理） */
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

/** teardown 步骤 0 有界等待上限（终审裁定）：被中止 run 的 settle 钩子（沉淀入队）收口窗口，2s 防
 *  signal 无视的工具悬挂 teardown；超时即放行进后续步骤 */
const ABORTED_RUN_SETTLE_MS = 2_000;

/** 静态缺失提示（G1 裁定恒定文案；G3 起 dist-gui 在场则 GET 挂静态，缺场仍回此形态） */
const GUI_ASSETS_HINT = 'GUI assets not built — run pnpm --filter gui build (G2)';

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

/** 环形缓冲的帧载体（G3 seq 协议）：补发帧各自携带入泵时刻的 seq——重连客户端凭 seq 判缺口 */
interface BufferedEvent {
  seq: number;
  e: SessionEvent;
}

/**
 * GUI daemon 核心（spec §3）：HTTP 控制面 + WS 事件面 + 会话生命周期。装配零旁路——与 TUI 同一
 * `createRuntime` 单点（mode 恒 dontAsk：GUI v1 无终端交互面，审批/问询走回执端点，T3 接线），
 * `harness` 公开面（tasks/pipeline/mcpClose）只在 teardown 消费。HTTP 面：healthz 免鉴权 +
 * submit/interrupt 经 Bearer token 鉴权（§4.3：仅回环 + token，远程暴露为 v1 非目标）。WS 事件面
 * （T2）：onEvent 单点泵入 → `{kind:'event'}` 帧广播全部连接 + 512 环形缓冲，连接建立即补发缓冲
 * 全量（断线重连恢复窗口）；升级同走 Bearer 头鉴权。
 */
export class GuiDaemon {
  private readonly runtime: TuiRuntime;
  private current?: CurrentRun;
  private server?: http.Server;
  /** 幂等收口：首调落链，后续调用复用同一 Promise（close 链只走一遍） */
  private closePromise?: Promise<void>;
  /** 事件环形缓冲（补发窗口）：pump 单点写入，连接建立即全量逐帧补发；帧各自带 seq（G3 重连协议） */
  private readonly eventBuffer: BufferedEvent[] = [];
  /** seq 泵计数（G3）：计数在先帧在后（首帧 seq=1），跨 run 全局单调不重置；snapshot.lastSeq 同源 */
  private seqCounter = 0;
  /** WS 面：noServer 挂 http server upgrade；连接 Set=pump 广播面 */
  private wss?: WebSocketServer;
  private readonly wsClients = new Set<WebSocket>();
  /** 每 pong 时间戳（WeakMap 旁挂，不入连接对象）：ping 心跳判活依据 */
  private readonly wsLastPong = new WeakMap<WebSocket, number>();
  private pingTimer?: NodeJS.Timeout;
  /** 影子投影（G2 snapshot 套件）：board/delegation 与 TUI session 同源纯件（boardEventFrom/
   *  applyBoardEvent / applyDelegation）从同一事件流推导——GUI 重连/刷新直接取快照，无需重放事件 */
  private board: TaskBoardState = emptyBoard();
  private delegations: Delegation[] = [];
  /** 粗粒度转录（spec G2 Ruling 1）：pump 同源喂入，/snapshot 的 messages 字段 */
  private readonly transcript = new TranscriptCollector();
  /** 单 run 锁外窥（测试/后续 /snapshot 消费）：current 在场即 running */
  readonly status: () => 'idle' | 'running' = () => (this.current ? 'running' : 'idle');
  /** GUI 静态产物根（G3）：opts 注入，缺省 cwd 相对 dist-gui */
  private readonly staticRoot: string;
  /** 静态面探测结果（start 时一次缓存）：index.html 在场才挂静态，缺场保持 API-only（404 hint 原样） */
  private staticReady = false;

  constructor(opts: GuiDaemonOpts) {
    this.staticRoot = opts.staticRoot ?? path.resolve('dist-gui');
    this.runtime = createRuntime({
      root: opts.root,
      model: opts.model,
      mode: 'dontAsk',
      onEvent: (e) => this.pump(e),
    });
  }

  /** 事件泵：seq 计数（在先）→ 环形缓冲写入（满 512 丢最老，帧自带 seq）→ 影子投影同步喂入 → 实时
   *  广播全部连接。序内裁定：计数先于影子先于广播——同 tick 读 /snapshot 时 lastSeq 恒 ≥ 任何已广播帧
   *  的 seq（影子态与 seq 无交错半态）。序列化一次逐连接 send——同一连接的帧恒按 pump 调用序到达
   *  （ws 内部发送缓冲有序，无需额外队列）。投影与广播同源同序：snapshot 取到的影子态恒等于已广播
   *  事件的累积（无连接时投影照走——影子不依赖消费面在场） */
  private pump(e: SessionEvent): void {
    this.seqCounter += 1;
    const buffered: BufferedEvent = { seq: this.seqCounter, e };
    this.eventBuffer.push(buffered);
    if (this.eventBuffer.length > EVENT_BUFFER_CAP) this.eventBuffer.shift();
    if (e.type.startsWith('task-') || e.type.startsWith('gate-')) this.board = applyBoardEvent(this.board, boardEventFrom(e));
    if (e.type.startsWith('delegation-')) this.delegations = applyDelegation(this.delegations, e);
    this.transcript.push(e);
    if (this.wsClients.size === 0) return;
    const frame = this.frameEvent(buffered);
    for (const ws of this.wsClients) ws.send(frame);
  }

  /** 下行帧单点：`{kind:'event', seq, e}` JSON 序列化（补发与实时共用同一帧形；approval/ask 挂起面
   *  帧不带 seq——G4 重连重发语义另行收口，不入单调序列） */
  private frameEvent(b: BufferedEvent): string {
    return JSON.stringify({ kind: 'event', seq: b.seq, e: b.e });
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

  /** 连接生命周期：入 Set（广播面）→ 补发缓冲全量 → pong 记时/close 清理。补发在 upgrade 回调内
   *  同步完成，与后续实时帧（pump 单点）天然无交错——帧序=缓冲序接事件序 */
  private onWsConnection(ws: WebSocket): void {
    this.wsClients.add(ws);
    this.wsLastPong.set(ws, Date.now());
    ws.on('pong', () => this.wsLastPong.set(ws, Date.now()));
    // error 必须挂 listener（EventEmitter 契约）：socket 错误细节不倒面，close 统一走清理
    ws.on('error', () => {});
    ws.on('close', () => this.wsClients.delete(ws));
    for (const b of this.eventBuffer) ws.send(this.frameEvent(b));
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

  /** 幂等 teardown：abort 在跑 run → 有界等待其 settle 收口（2s 上限）→ wss close（逐连接 1001）→
   *  http server close → tasks.stopAll → pipeline drain → mcpClose（序同 CLI teardownCliRun 现场，网络面先行关闭——
   *  不再接受新请求/新连接、在跑 run 中止后再动运行时内脏；细节裁定见各步骤行内注释） */
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.teardown();
    return this.closePromise;
  }

  private async teardown(): Promise<void> {
    // 0) 在跑 run 即刻中止（T1 评审裁定：close 时若 run 仍悬挂，其 promise 会拖住事件循环/测试收口；
    //    路径同 /interrupt——runTask 以 stopReason=interrupted 收束，finally 清 current）
    this.current?.abort.abort();
    // 被中止 run 的 settle 钩子（沉淀入队）需收口后才进 drain——2000ms 有界防 signal 无视的工具悬挂
    // teardown（终审裁定）；等待先于 stopAll/drain，run 侧入队完型后 drain 才是终态。done 先胜即清
    // 残留 timer，不给事件循环留 2s 尾巴
    if (this.current) {
      const current = this.current;
      let settleTimer: NodeJS.Timeout | undefined;
      const bail = new Promise<void>((resolve) => {
        settleTimer = setTimeout(resolve, ABORTED_RUN_SETTLE_MS);
      });
      await Promise.race([current.done, bail]);
      clearTimeout(settleTimer);
    }
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
    // 3) 停全部后台任务（同 CLI D24 理由：任务执行体先停、通道后关，stopAll 同步纯本地记账不抛）
    this.runtime.harness.tasks.stopAll();
    // 4) 排空后台沉淀管线（此时无新入队源，drain 即终态）
    await this.runtime.harness.pipeline.drain();
    // 5) MCP 连接收口：关闭 stdio 子进程，防悬挂事件循环
    await this.runtime.harness.mcpClose();
  }

  /** 内部路由表（G2 增 /snapshot；G3 增 /steer；静态资源走 dispatch 的 GET 兜底分支，不占路由表） */
  private readonly routes: ReadonlyArray<{ method: string; path: string; auth: boolean; run: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> }> = [
    { method: 'GET', path: '/healthz', auth: false, run: async (_req, res) => this.send(res, 200, { ok: true }) },
    { method: 'POST', path: '/submit', auth: true, run: (req, res) => this.handleSubmit(req, res) },
    { method: 'POST', path: '/interrupt', auth: true, run: async (_req, res) => this.handleInterrupt(res) },
    { method: 'POST', path: '/steer', auth: true, run: (req, res) => this.handleSteer(req, res) },
    { method: 'GET', path: '/snapshot', auth: true, run: async (_req, res) => this.send(res, 200, this.snapshot()) },
  ];

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = this.routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (route) {
      // 鉴权（§4.3）：除 healthz 外恒验 Bearer token——恒时比较不做（token 非密钥材料，回环面时序侧信道无实义）
      if (route.auth && req.headers.authorization !== `Bearer ${token}`) {
        this.send(res, 401, { error: 'unauthorized' });
        return;
      }
      route.run(req, res).catch((err) => {
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

  private async handleSubmit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
    // 单 run 锁（v1 一 daemon 一会话）：运行中拒新提交（409），不排队——GUI 侧无队列语义，排队会静默吞掉用户意图
    if (this.current) {
      this.send(res, 409, { error: 'run in progress' });
      return;
    }
    const abort = new AbortController();
    // 202 即回：run 异步走主链入口 runTask（同 TUI /goal 路径），失败吞错转 stderr 日志行（daemon 不因单 run 失败倒面），
    // finally 清锁——中断（stopReason=interrupted）与正常收束同路径清位；promise 本体（.then 归一 void）存入票据
    // done，teardown 步骤 0 的有界等待经它观测收口。user 条入转录在锁检查之后——409 拒绝的提交不留痕
    this.transcript.submit(goal);
    const p: Promise<void> = this.runtime
      .runTask(goal, { signal: abort.signal })
      .catch((err) => {
        console.error('[serve] run failed:', err);
      })
      .then(() => undefined)
      .finally(() => {
        this.current = undefined;
      });
    this.current = { abort, done: p };
    this.send(res, 202, { ok: true });
  }

  private handleInterrupt(res: http.ServerResponse): void {
    if (!this.current) {
      this.send(res, 409, { error: 'no run in progress' });
      return;
    }
    // 步边界/在途模型调用经 signal 即刻中止（reactor 既有语义），runTask 以 stopReason=interrupted 收束后 finally 清锁
    this.current.abort.abort();
    this.send(res, 200, { ok: true });
  }

  /** POST /steer（G3）：text 非空 string 校验后入 runtime.harness.steering（现场核对：SteeringChannel
   *  纯内存 FIFO——enqueue 不做运行态检查，运行中步边界 drain 消费、空闲入队下一轮生效）→ 恒 200
   *  {ok:true}，无 409 分径（裁定：steering 非独占面，排队语义即承诺） */
  private async handleSteer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const text = (parsed.body as { text?: unknown } | null)?.text;
    // 空白串与 enqueue 的 trim-忽略口径一致前置拒（静默 no-op 的 200 比显式 400 更糟）
    if (typeof text !== 'string' || text.trim().length === 0) {
      this.send(res, 400, { error: 'text must be a non-empty string' });
      return;
    }
    this.runtime.harness.steering.enqueue(text);
    this.send(res, 200, { ok: true });
  }

  /** 会话快照（G2 /snapshot 载荷单点；G3 增 lastSeq）：粗粒度转录 + board/delegations 影子投影 +
   *  运行态 + 事件序列水位——GUI 冷启动/刷新经一次拉取恢复全景，细粒度实时面仍走 WS 事件流（两轨
   *  分工，spec G2 Ruling 1）；lastSeq 与影子态同 tick 读取（pump 序内先影子后广播）——客户端以
   *  「重连后首帧 seq > snapshot.lastSeq ⇒ 无缺口」判重连补发完备（G4 消费） */
  private snapshot(): { messages: TranscriptEntry[]; board: TaskBoardState; delegations: Delegation[]; status: 'idle' | 'running'; lastSeq: number } {
    return { messages: this.transcript.entries(), board: this.board, delegations: this.delegations, status: this.status(), lastSeq: this.seqCounter };
  }

  private send(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
