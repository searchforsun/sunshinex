import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { ModelAdapter } from '../model/adapter';
import { ok, fail } from '../result';
import type { Result } from '../result';
import { CodedToolError } from '../harness/tools';
import { SessionRuntime } from './session';
import type { EventFrame } from './session';

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

  constructor(opts: GuiDaemonOpts) {
    this.staticRoot = opts.staticRoot ?? path.resolve('dist-gui');
    this.model = opts.model;
  }

  /**
   * 创建会话（spec §7）：root 存在性/目录校验（INVALID_ARG）→ 按 root 装配 SessionRuntime（同 root
   * 多会话允许——各自独立主链，Ruling 2）→ 入注册表（s<n> 进程内单调）→ 置激活。Result 面：
   * daemon 级 API（serve --root 预选/后续工作区注册表消费），HTTP 面映射 400/200
   */
  createSession(root: string): Result<{ sessionId: string }> {
    const abs = path.resolve(root);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return fail('INVALID_ARG', `root does not exist: ${abs}`);
    }
    if (!st.isDirectory()) return fail('INVALID_ARG', `root is not a directory: ${abs}`);
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
    });
    this.sessions.set(id, session);
    this.active = id;
    return ok({ sessionId: id });
  }

  /** attach 恢复（spec §7）：journal 链回放重建（reduceJournal 播种）——T2 实装，本任务留桩 */
  attach(_journalId: string, _root: string): Result<{ sessionId: string }> {
    throw new CodedToolError('INVALID_STATE', 'attach lands in T2');
  }

  /** 会话外窥（测试/后续 T2+ 端点消费）：未知 id 回 undefined */
  get(id: string): SessionRuntime | undefined {
    return this.sessions.get(id);
  }

  /** 激活会话 id（无会话时 undefined——裸端点 409 的判据） */
  activeId(): string | undefined {
    return this.active;
  }

  /** 全会话收口（独立入口：daemon close 序内以分相形态并入；导出供 T2+ 会话回收类面复用）：
   *  逐会话完整 teardown 序（abort 有界等待→stopAll→drain→mcpClose），顺序并发 Promise.all */
  async teardownAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.teardown()));
  }

  /** 泵广播面（daemon 级单点）：帧序列化一次逐连接 send——同一连接的帧恒按 pump 调用序到达（ws
   *  内部发送缓冲有序，无需额外队列）；连接层按 sessionId 分发/过滤（T3） */
  private broadcastFrame(frame: EventFrame): void {
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

  /** 连接生命周期：入 Set（广播面）→ 补发全部会话缓冲 → pong 记时/close 清理。补发在 upgrade 回调内
   *  同步完成，与后续实时帧（pump 单点）天然无交错——逐会话帧序=缓冲序接事件序；T1 裁定：全部会话
   *  （s1..sN 会话序，各内缓冲序），客户端按帧面 sessionId 过滤（T3 onSessionEvent）——不收
   *  `{"kind":"listen"}` 订阅消息（帧全带 sessionId 客户端自滤） */
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
   *  网络面先行关闭——不再接受新请求/新连接、在跑 run 中止后再动运行时内脏（分相并入 =
   *  teardownAll 的逐会话序在会话维保序，daemon 维网络面插在两相之间）；细节裁定见各步骤行内注释 */
  private async teardown(): Promise<void> {
    // 0) 全会话在跑 run 即刻中止（并发）：与单会话序同理——悬挂 run 的 promise 会拖住事件循环/测试
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

  /** interrupt 处理：无在跑 run 409；中止信号发出即 200（run 以 stopReason=interrupted 收束后清锁） */
  private handleInterrupt(res: http.ServerResponse, id: string | undefined): void {
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    const r = session.interrupt();
    if (!r.ok) {
      this.send(res, 409, { error: r.error });
      return;
    }
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
   *  200 {ok:true}（语义面见 SessionRuntime.reset） */
  private async handleReset(res: http.ServerResponse, id: string | undefined): Promise<void> {
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    await session.reset();
    this.send(res, 200, { ok: true });
  }

  /** snapshot 处理：会话快照单点（载荷形态见 SessionRuntime.snapshotResponse） */
  private handleSnapshot(res: http.ServerResponse, id: string | undefined): void {
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    this.send(res, 200, session.snapshotResponse());
  }

  private send(res: http.ServerResponse, status: number, body: object): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
