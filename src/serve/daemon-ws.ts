import * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { isShadowEvent, type EventFrame, type SessionRuntime } from './session';
import type { DaemonFrame } from './daemon-wire';
import { BATCH_FLUSH_MS, urlOf } from './daemon-wire';
import { safeDecode } from './daemon-static';
import type { PtyManager } from './pty';

/** WS 保活节拍：30s 一 ping；pong 静默超 60s 即 terminate（close 事件统一清理） */
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

/** pty 帧 S→C 下行单点（G8b T3）：readyState 判存——CLOSED/CLOSING 静默丢帧（断线窗口的输出
 *  靠重连 replay 补，不追赶） */
function sendPtyFrame(ws: WebSocket, frame: { t: 'data' | 'exit'; b?: string; code?: number }): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

/**
 * WS 传输域 hub（2026-10-27 技术债轮 自 daemon.ts 外提，D31 骨架域续批，行为零变化）：
 * 事件面连接生命周期 + batch 合帧窗 + 保活心跳 + pty 专用连接 + 泵广播面——传输状态
 * （wss/wsClients/wsLastPong/pingTimer/ptySockets）归本类私有，daemon 编排 teardown 序
 * （drain→stopAll→mcpClose，本类 close 为其步骤 1）。会话注册表与 pty manager 经 deps 注入
 * （补发遍历/pty 帧协议），teardown 启动判据经 isClosing 注入（升级拒绝面同判）。
 */
export interface WsHubDeps {
  readonly sessions: Map<string, SessionRuntime>;
  readonly ptyManager: PtyManager;
  /** daemon close 链已落链（upgrade 拒新连接面与鉴权失败同拒） */
  readonly isClosing: () => boolean;
}

export class WsHub {
  private wss?: WebSocketServer;
  /** batch 客户端每连接合帧态：buf=窗内事件帧缓冲，timer=在途 flush 定时器（挂载即起表,flush 时清） */
  private readonly wsClients = new Map<WebSocket, { batch: boolean; buf: EventFrame[]; timer: NodeJS.Timeout | null }>();
  /** 每 pong 时间戳（WeakMap 旁挂，不入连接对象）：ping 心跳判活依据 */
  private readonly wsLastPong = new WeakMap<WebSocket, number>();
  private pingTimer?: NodeJS.Timeout;
  /** pty 专用 WS 连接面：与事件面 wsClients 独立（不参与事件广播；复用 heartbeat ping + 同一
   *  wsLastPong 计时；daemon close 随 wss.close 一并退场） */
  private readonly ptySockets = new Set<WebSocket>();

  constructor(private readonly deps: WsHubDeps) {}

  /** 泵广播面（daemon 级单点）：帧序列化一次逐连接 send——同一连接的帧恒按 pump 调用序到达（ws
   *  内部发送缓冲有序，无需额外队列）；连接层按 sessionId 分发/过滤（T3）。G4：签名放宽至 DaemonFrame
   *  全并集（挂起/reset 帧与事件帧共用本序列化路径）。
   *  P1 Task 6 分路：batch=1 客户端的事件帧进 30ms 合批窗（buf+timer，flush 打包单帧），挂起/reset
   *  帧与老客户端走原路直发——老客户端零行为变化（daemon.ws.test ⑥.1 为锚） */
  broadcastFrame(frame: DaemonFrame): void {
    if (this.wsClients.size === 0) return;
    const json = JSON.stringify(frame);
    for (const [ws, st] of this.wsClients) {
      if (st.batch && frame.kind === 'event') this.enqueueBatch(ws, st, frame);
      else ws.send(json);
    }
  }

  /** batch 客户端事件帧入窗：首帧入窗即起 flush 表（在途则跳过），窗内连发攒一帧 */
  private enqueueBatch(ws: WebSocket, st: { batch: boolean; buf: EventFrame[]; timer: NodeJS.Timeout | null }, frame: EventFrame): void {
    st.buf.push(frame);
    if (st.timer === null) {
      st.timer = setTimeout(() => {
        st.timer = null;
        this.flushBatch(ws);
      }, BATCH_FLUSH_MS);
    }
  }

  /** 合批窗收口：缓冲 splice 整帧下发（帧序=pump 序，内嵌数组保持）；连接已退场由 detach 清表兜底 */
  private flushBatch(ws: WebSocket): void {
    const st = this.wsClients.get(ws);
    if (st === undefined || st.buf.length === 0) return;
    ws.send(JSON.stringify({ kind: 'batch', frames: st.buf.splice(0) }));
  }

  /** 单连接帧投递（连接生命周期补发面）：batch 客户端事件帧走合帧窗，其余直发——挂起重发（无 seq
   *  幂等帧）不经窗，审批即时性优先 */
  private deliverTo(ws: WebSocket, frame: DaemonFrame): void {
    const st = this.wsClients.get(ws);
    if (st !== undefined && st.batch && frame.kind === 'event') this.enqueueBatch(ws, st, frame);
    else ws.send(JSON.stringify(frame));
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
  attach(server: http.Server, token: string | undefined): void {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const viaHeader = token !== undefined && req.headers.authorization === `Bearer ${token}`;
      const viaSubprotocol = token !== undefined && req.headers['sec-websocket-protocol'] === `bearer.${token}`;
      // teardown 已启动即不再收新连接（WS 先于 server close 退场，此处与鉴权失败同拒升级）
      // token undefined = 免鉴权档:升级径直放行(回环兜底)
      if (this.deps.isClosing() || (token !== undefined && !viaHeader && !viaSubprotocol)) {
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
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, urlOf(req).searchParams.get('batch') === '1'));
    });
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    this.wss = wss;
  }

  /** 连接生命周期：入 Set（广播面）→ 补发全部会话缓冲 + 重发全部未决挂起帧（G4 裁定 4）→ pong 记时/
   *  close 清理。补发在 upgrade 回调内同步完成，与后续实时帧（pump 单点）天然无交错——逐会话帧序=缓冲
   *  序接事件序；T1 裁定：全部会话（s1..sN 会话序，各内缓冲序），客户端按帧面 sessionId 过滤（T3
   *  onSessionEvent）——不收 `{"kind":"listen"}` 订阅消息（帧全带 sessionId 客户端自滤）。
   *  挂起重发无 seq：同 pid 帧可能重复到达（首播+重连），客户端以 pid 去重幂等（G4）。
   *  G14.2xx b shadow 帧不走红窗：板面/委派/子智能体帧（512 环窗对长会话子智能体流必溢出,且 GUI 刷新
   *  时本连接建立常先于会话 attach——回放面够不着）改由 HTTP /session/:id/shadow-events 水合恢复
   *  （会话打开/重连时 GUI 拉取 journal 全量）,本面只放实时与主链补发窗。 */
  private onConnection(ws: WebSocket, batch = false): void {
    this.wsClients.set(ws, { batch, buf: [], timer: null });
    this.wsLastPong.set(ws, Date.now());
    ws.on('pong', () => this.wsLastPong.set(ws, Date.now()));
    // error 必须挂 listener（EventEmitter 契约）：socket 错误细节不倒面，close 统一走清理
    ws.on('error', () => {});
    ws.on('close', () => this.detach(ws));
    for (const session of this.deps.sessions.values()) {
      // G14.2xx b shadow 帧不走红窗补发(512 环窗对长会话子智能体流必溢出,且 GUI 刷新时本连接
      // 建立常先于会话 attach——回放面够不着):恢复唯一入口=HTTP /session/:id/shadow-events
      // 水合(会话打开/重连时 GUI 拉取),本面只放实时与主链补发窗
      for (const f of session.bufferedFrames()) {
        if (isShadowEvent(f.e)) continue;
        this.deliverTo(ws, f); // batch 客户端经合帧窗(重连补发即成批),老客户端逐帧
      }
      for (const frame of session.pendingFrames()) this.deliverTo(ws, frame); // 挂起重发(P6 §4:表在会话)
    }
    // batch 客户端连接期补发即时收口：补发帧与老客户端同拍抵达(先于/同拍 open)——若留在 30ms 窗,
    // 补发将晚于上层 snapshot 水合(基线已抬高)到达,被客户端单调 seq 过滤丢弃(重连丢帧——e2e T4δ
    // 实证)。成批语义保持(整段补发单 batch 帧),30ms 窗只作用于实时泵帧
    this.flushBatch(ws);
  }

  /** 连接退场清理：合帧窗在途定时器先收（防 flush 触已死连接），再摘 Map 项（close 面单点） */
  private detach(ws: WebSocket): void {
    const st = this.wsClients.get(ws);
    if (st !== undefined && st.timer !== null) clearTimeout(st.timer);
    this.wsClients.delete(ws);
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
    const pty = this.deps.ptyManager.get(ptyId);
    ws.on('error', () => {}); // EventEmitter 契约：挂空 listener，socket 错误细节不倒面（同 onConnection）
    if (pty === undefined) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'error', message: 'pty not found' }));
      ws.close(1008);
      return;
    }
    // G8e-T4 归属校验：条目在但 owner ≠ 本会话 → 同 error 帧语义（'pty not found for session'）后
    // close(1008)——错位寻址 fail-closed 不串读；与 get() 同拍同步查，条目在场性一致
    if (this.deps.ptyManager.ownerOf(ptyId) !== sessionId) {
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
    for (const ws of this.wsClients.keys()) this.beat(ws, now);
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

  /** teardown 步骤 1（daemon 收口序内，序由 daemon 编排）：WS 面先收——停 ping 计时器，逐连接
   *  1001 Going Away 后 wss.close——先于 HTTP server close，升级连接与请求连接同序退场，server
   *  close 时无存活的升级套接字拖尾；pty 专用 WS（ptySockets）同拍退场（wss.close 统一收口两面的
   *  连接） */
  async close(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    const wss = this.wss;
    if (wss) {
      for (const ws of this.wsClients.keys()) {
        const st = this.wsClients.get(ws);
        if (st !== undefined && st.timer !== null) clearTimeout(st.timer);
        ws.close(1001);
      }
      for (const ws of this.ptySockets) ws.close(1001);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      this.wsClients.clear();
      this.ptySockets.clear();
    }
  }
}
