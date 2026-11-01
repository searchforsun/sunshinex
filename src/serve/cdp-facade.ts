/**
 * 内置浏览器 CDP facade v2(2026-11-01 M2 融合,用户裁定「插件打开的也是普通页签,我也可以点击」):
 * 壳主进程经 `--remote-debugging-port=0` 开**真实 CDP**(DevToolsActivePort 文件回读端口),本服务
 * 起一个仅绑回环的**过滤代理**:Playwright(插件 server --cdp-endpoint connectOverCDP)接 facade,
 * 消息双向透传到真实端点,但 target 面经白名单闸过滤——只放行侧栏 <webview> guest,应用自身 UI
 * (BrowserWindow 渲染层,daemon origin)与 chrome/devtools 内面永不可见,agent 摸不到壳。
 * 为何弃 webContents.debugger 桥(实测):Electron 该接口只回**命令应答**、不向 'message' 转发
 * 协议事件(Page/Runtime 域事件全无)——Playwright 事件驱动(Frame/lifecycle),命令直答不够用;
 * 真实调试口则全事件可用,且主帧 id==targetId 原生成立,无需任何帧 id 改写。
 * 闸语义:createTarget/closeTarget 拒绝(页签生命周期归 GUI),非白名单 target 的 attach/事件一律
 * 摘除(模型侧完全无感)。daemon 与壳同进程(壳主进程即 daemon 宿主),electron 经 require 就地取;
 * 纯 node 环境(npm 包字符串/缺包)降级 undefined。
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';

const json = (v: unknown): string => JSON.stringify(v);

export interface FacadeOpts {
  /** 壳 userData 路径(读 DevToolsActivePort) */
  userDataDir: string;
  /** daemon 自身 origin 前缀(如 http://127.0.0.1:57677)——GUI 渲染层 target 按此前缀过滤 */
  localOriginPrefix: string;
  log?: (msg: string) => void;
}

export class BuiltinFacade {
  private wss: WebSocketServer | undefined;
  private httpSrv: http.Server | undefined;
  private port = 0;
  private realPort = 0;
  private realBrowserPath = 'devtools/browser';
  /** 非白名单 target 记账:attachedToTarget 被吞的 target 的 destroyed 事件同吞 */
  private readonly blockedSeen = new Set<string>();

  constructor(private readonly opts: FacadeOpts) {}

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  /** 非白名单判定:GUI 渲染层(daemon origin)与 chrome/devtools 内面 */
  private blockedUrl(url: string | undefined): boolean {
    if (url === undefined) return true;
    const u = url.toLowerCase();
    return u.startsWith(this.opts.localOriginPrefix.toLowerCase()) || u.startsWith('chrome://') || u.startsWith('devtools:');
  }

  private realHttp(): string {
    return `http://127.0.0.1:${this.realPort}`;
  }

  /** DevToolsActivePort 解析:首行=端口,次行=browser 路径;缺席/未启调试口=降级 undefined */
  private readRealEndpoint(): { port: number; browserPath: string } | undefined {
    try {
      const raw = fs.readFileSync(path.join(this.opts.userDataDir, 'DevToolsActivePort'), 'utf8');
      const [portLine, pathLine] = raw.split('\n').map((x) => x.trim());
      const port = Number(portLine);
      if (!Number.isFinite(port) || port <= 0) return undefined;
      return { port, browserPath: pathLine !== undefined && pathLine !== '' ? pathLine : 'devtools/browser' };
    } catch {
      return undefined;
    }
  }

  async start(): Promise<void> {
    const real = this.readRealEndpoint();
    if (real === undefined) throw new Error('DevToolsActivePort 不可读——壳未开 --remote-debugging-port(M2 需要)');
    this.realPort = real.port;
    this.realBrowserPath = real.browserPath;
    this.log(`real CDP endpoint: 127.0.0.1:${this.realPort}/${this.realBrowserPath}`);
    this.httpSrv = http.createServer((req, res) => {
      // HTTP 面:GUI 代理(handleCdpTargets)消费 /json/list——透传真实列表并按白名单过滤
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/json/list' || url.pathname === '/json' || url.pathname === '/json/version') {
        void (async () => {
          try {
            const sub = url.pathname === '/json/version' ? '/json/version' : '/json/list';
            const r = await fetch(`${this.realHttp()}${sub}`, { signal: AbortSignal.timeout(2000) });
            const text = await r.text();
            res.writeHead(200, { 'content-type': 'application/json' });
            if (url.pathname === '/json/version') { res.end(text); return; }
            const arr = JSON.parse(text) as Array<{ url?: string; type?: string }>;
            res.end(json(arr.filter((t) => !(t.type === 'page' && this.blockedUrl(t.url)))));
          } catch {
            res.writeHead(502);
            res.end(json({ error: 'real CDP endpoint unreachable' }));
          }
        })();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.httpSrv.on('upgrade', (req, socket, head) => {
      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        this.clientSockets.add(ws);
        ws.on('close', () => this.clientSockets.delete(ws));
        this.attachReal(ws);
      });
    });
    return new Promise((resolve) => {
      this.httpSrv?.listen(0, '127.0.0.1', () => {
        const addr = this.httpSrv?.address();
        this.port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve();
      });
    });
  }

  /** playwright ws ↔ 真实浏览器 ws 透传 + 白名单过滤:
   *  - ws→real:createTarget/closeTarget 拒面(页签生命周期归 GUI);
   *  - real→ws:getTargets/getTargetInfo 应答摘非白名单 target;attachedToTarget/targetInfoChanged
   *    携非白名单 targetInfo 整事件吞(targetDestroyed 同步记账);destroyed 同吞 */
  private attachReal(ws: WebSocket): void {
    // 待发队列:playwright 首命令可在 real open 前到达(实测竞窗)——open 前缓存,open 即冲刷
    const outbox: string[] = [];
    const real = new WebSocket(`ws://127.0.0.1:${this.realPort}/${this.realBrowserPath}`);
    real.on('message', (data) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
      try { msg = JSON.parse(String(data)); } catch { return; }
      // 应答过滤:getTargets/getTargetInfo 摘除非白名单 target
      const result = (msg.result ?? {}) as { targetInfos?: Array<{ targetId?: string; url?: string; type?: string }>; targetInfo?: { targetId?: string; url?: string; type?: string } };
      if (result.targetInfos !== undefined) {
        for (const t of result.targetInfos) {
          if (typeof t.targetId === 'string' && this.blockedUrl(t.url) && t.type === 'page') this.blockedSeen.add(t.targetId);
        }
        result.targetInfos = result.targetInfos.filter((t) => !(t.type === 'page' && this.blockedUrl(t.url)));
      }
      if (result.targetInfo !== undefined && result.targetInfo.type === 'page' && this.blockedUrl(result.targetInfo.url)) {
        if (typeof result.targetInfo.targetId === 'string') this.blockedSeen.add(result.targetInfo.targetId);
        delete result.targetInfo;
      }
      // 事件过滤:非白名单 target 的 attach/info/destroyed 事件整吞
      if (msg.method !== undefined) {
        const p = msg.params as { targetInfo?: { targetId?: string; url?: string; type?: string }; targetId?: string } | undefined;
        const info = p?.targetInfo;
        if (info !== undefined) {
          if (typeof info.targetId === 'string' && info.type === 'page' && this.blockedUrl(info.url)) this.blockedSeen.add(info.targetId);
          if (info.type === 'page' && this.blockedUrl(info.url)) return;
        }
        if (msg.method === 'Target.targetDestroyed' && typeof p?.targetId === 'string' && this.blockedSeen.has(p.targetId)) {
          this.blockedSeen.delete(p.targetId);
          return;
        }
      }
      this.sendTo(ws, msg);
    });
    real.on('open', () => { for (const m of outbox.splice(0)) real.send(m); });
    real.on('close', () => ws.close());
    real.on('error', () => ws.close());
    ws.on('message', (data) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(String(data)); } catch { return; }
      // 拒面:页签生命周期归 GUI(模型不可开/关 target)
      if (msg.method === 'Target.createTarget' || msg.method === 'Target.closeTarget') {
        this.sendTo(ws, { id: msg.id, error: { code: -32000, message: '内置浏览器页签由侧栏管理(不支持 create/close target)' } });
        return;
      }
      // attach 面兜底:即使真实列表漏过滤,attach 到记账过的非白名单 id 报确定错误
      if (msg.method === 'Target.attachToTarget') {
        const tid = typeof msg.params?.targetId === 'string' ? msg.params.targetId : '';
        if (this.blockedSeen.has(tid)) {
          this.sendTo(ws, { id: msg.id, error: { code: -32000, message: 'target not allowed' } });
          return;
        }
      }
      if (real.readyState === WebSocket.OPEN) real.send(String(data));
      else if (real.readyState === WebSocket.CONNECTING) outbox.push(String(data));
    });
    ws.on('close', () => real.close());
  }

  private readonly clientSockets = new Set<WebSocket>();

  private sendTo(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(json(payload));
  }

  stop(): void {
    for (const ws of [...this.clientSockets]) ws.terminate();
    this.wss?.close();
    this.httpSrv?.closeAllConnections();
    this.httpSrv?.close();
  }

  get endpoint(): string {
    return `ws://127.0.0.1:${this.port}/devtools/browser`;
  }
}

/** 壳内启动入口:electron 面就地 require(守护同进程假设);纯 node(npm 包字符串/缺包)降级 undefined。
 *  前置:壳以 --remote-debugging-port 开真实调试口(app.commandLine,main.ts 装配) */
export function startBuiltinFacade(log?: (msg: string) => void): Promise<{ facade: BuiltinFacade; ws: string } | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let electron: unknown;
  try { electron = require('electron'); } catch { return Promise.resolve(undefined); }
  if (typeof electron !== 'object' || electron === null) return Promise.resolve(undefined);
  const et = electron as {
    app?: { getPath(name: string): string; commandLine?: { hasSwitch?(s: string): boolean } };
  };
  if (et.app === undefined) return Promise.resolve(undefined); // node 环境(npm 包字符串/缺 app)
  if (!et.app.commandLine?.hasSwitch?.('remote-debugging-port')) {
    log?.('facade: 壳未开 remote-debugging-port,内置浏览器融合面停用');
    return Promise.resolve(undefined);
  }
  const userData = et.app.getPath('userData');
  const port = process.env.SUNSHINEX_DAEMON_PORT ?? '';
  const facade = new BuiltinFacade({ userDataDir: userData, localOriginPrefix: `http://127.0.0.1:${port}`, log });
  return facade.start().then(() => ({ facade, ws: facade.endpoint })).catch((err) => {
    log?.(`facade start failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
}
