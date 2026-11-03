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

/** 侧栏 <webview> guest 在真实端点报 type:'webview',Playwright 只认 'page'(实测 webview target 被整体
 *  忽略,插件看不到侧栏页签)——对外统一改报 'page' */
const asPage = (t: { type?: string }): void => {
  if (t.type === 'webview') t.type = 'page';
};

export interface FacadeOpts {
  /** 壳 userData 路径(读 DevToolsActivePort) */
  userDataDir: string;
  /** daemon 自身 origin 前缀(如 http://127.0.0.1:57677)——GUI 渲染层 target 按此前缀过滤 */
  localOriginPrefix: string;
  log?: (msg: string) => void;
  /** 模型开新页(Target.createTarget)→ 让 GUI 开一个侧栏浏览器页签(会话连接带 scope:开在该会话
   *  座位、用该会话分区);缺省=拒绝 createTarget */
  openTab?: (url: string, scope?: SessionScope) => void;
  /** target 是否属于会话浏览器键对应的持久分区(persist:sx-<key>)——会话连接的可见性闸 */
  belongs?: (targetId: string, key: string) => boolean;
  /** 模型关页(Target.closeTarget)→ 让 GUI 关掉该 target 对应的侧栏页签;缺省=拒绝 closeTarget */
  closeTab?: (targetId: string) => boolean;
  /** 文本输入前后让 GUI 聚焦/归还该 target 的侧栏 webview:guest 只在宿主 webview 元素持有焦点时
   *  收文本输入(实测 Input.insertText/char 键事件在未聚焦时静默丢失=fill 后值为空) */
  focusTab?: (targetId: string, phase: 'begin' | 'end') => boolean;
  /** agent 驱动某 target(导航/输入/截图)时让 GUI 切到对应侧栏页签——隐藏页签(display:none)的
   *  webview 停止绘制,截图黑屏;且用户看的页签与 agent 操作的页签须一致 */
  activateTab?: (targetId: string) => void;
  /** agent 驱动时确保主窗可见:最小化窗口 Chromium 不出帧(截图超时/画面冻结),不抢焦点地还原 */
  ensureVisible?: () => void;
}

/** 会话连接身份(2026-11-03 浏览器状态按会话隔离):key=浏览器键(journalId,分区 persist:sx-<key>),
 *  seat=GUI 页签座位(运行时会话 id)。连接路径 /session/<key>?seat=<seat> */
export interface SessionScope {
  key: string;
  seat: string;
}

/** 会话连接一律拒绝的命令:关整个浏览器(=关应用)/建删浏览器上下文(上下文=会话分区,归 GUI 管) */
const FORBIDDEN_METHODS = new Set(['Browser.close', 'Browser.crash', 'Browser.crashGpuProcess', 'Target.createBrowserContext', 'Target.disposeBrowserContext']);

export function parseScope(url: string | undefined): SessionScope | undefined {
  const u = new URL(url ?? '/', 'http://127.0.0.1');
  const m = /^\/session\/([^/]+)$/.exec(u.pathname);
  if (m === null) return undefined;
  return { key: decodeURIComponent(m[1]!), seat: u.searchParams.get('seat') ?? '' };
}

/** 触发侧栏切页的「驱动型」命令(读 DOM/求值不切,避免后台查询抢走用户视图) */
const DRIVING_METHODS = new Set(['Page.navigate', 'Page.reload', 'Page.captureScreenshot', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchTouchEvent']);

/** 聚焦 IPC 到渲染层生效的余量(焦点切换走 GUI 进程,先于 insertText 落到 guest) */
const FOCUS_SETTLE_MS = 50;

/** createTarget 应答前等本连接收到该 target 的 attachedToTarget 的上限(Playwright newPage 在应答
 *  后立即按 targetId 取已附加页,真实 Chrome 恒先发 attach 后应答——不等即 '_page' of undefined) */
const ATTACH_WAIT_MS = 5_000;

/** createTarget 等新侧栏 webview 出现的上限(GUI 无会话页/渲染层卡住时不无限等) */
const CREATE_TARGET_TIMEOUT_MS = 10_000;

export class BuiltinFacade {
  private wss: WebSocketServer | undefined;
  private httpSrv: http.Server | undefined;
  private port = 0;
  private realPort = 0;
  private realBrowserPath = 'devtools/browser';

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
      return { port, browserPath: pathLine !== undefined && pathLine !== '' ? pathLine.replace(/^\/+/, '') : 'devtools/browser' };
    } catch {
      return undefined;
    }
  }

  async start(): Promise<void> {
    const real = this.readRealEndpoint();
    if (real === undefined) throw new Error('DevToolsActivePort 不可读——壳未开 --remote-debugging-port(M2 需要)');
    this.realPort = real.port;
    this.realBrowserPath = real.browserPath;
    // DevToolsActivePort 可能是旧实例残留(本实例调试口绑定失败时不会改写)——不通即不启动,
    // 由 daemon 周期重试;否则 facade 代理到死端口,插件每轮拿到 502 白等
    try {
      const r = await fetch(`${this.realHttp()}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      throw new Error(`real CDP endpoint 127.0.0.1:${this.realPort} unreachable (${e instanceof Error ? e.message : String(e)})`);
    }
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
            for (const t of arr) asPage(t);
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
        this.attachReal(ws, parseScope(req.url));
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
  private attachReal(ws: WebSocket, scope?: SessionScope): void {
    /** 本连接可见性:GUI 自身页恒滤;会话连接只放行本会话分区的 target(首个命中即学到其
     *  browserContextId,此后同上下文的 iframe/worker 一并放行,他会话上下文一律不可见) */
    let scopeCtx: string | undefined;
    const blocked = new Set<string>();
    const allow = (t: { targetId?: string; url?: string; type?: string; browserContextId?: string }): boolean => {
      if (t.type === 'page' && this.blockedUrl(t.url)) return false;
      if (scope === undefined) return true;
      if (scopeCtx !== undefined) return t.browserContextId === scopeCtx;
      if (typeof t.targetId === 'string' && this.opts.belongs?.(t.targetId, scope.key) === true) {
        scopeCtx = t.browserContextId;
        return true;
      }
      return false;
    };
    // 待发队列:playwright 首命令可在 real open 前到达(实测竞窗)——open 前缓存,open 即冲刷
    const outbox: string[] = [];
    const attached = new Set<string>();
    /** flatten 会话 id → targetId(Input.* 命令带 sessionId,据此找到对应侧栏页签) */
    const sessionTargets = new Map<string, string>();
    /** 已聚焦待归还的 insertText 命令 id → targetId(应答到达即归还焦点) */
    const focusPending = new Map<number, string>();
    let lastActivated: string | undefined;
    const attachWaiters = new Map<string, () => void>();
    const waitAttached = (targetId: string): Promise<void> =>
      attached.has(targetId)
        ? Promise.resolve()
        : new Promise((resolve) => {
            const timer = setTimeout(() => { attachWaiters.delete(targetId); resolve(); }, ATTACH_WAIT_MS);
            attachWaiters.set(targetId, () => { clearTimeout(timer); resolve(); });
          });
    const real = new WebSocket(`ws://127.0.0.1:${this.realPort}/${this.realBrowserPath}`);
    real.on('message', (data) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
      try { msg = JSON.parse(String(data)); } catch { return; }
      // 应答过滤:getTargets/getTargetInfo 摘除非白名单 target
      type Info = { targetId?: string; url?: string; type?: string; browserContextId?: string };
      const result = (msg.result ?? {}) as { targetInfos?: Info[]; targetInfo?: Info };
      if (result.targetInfos !== undefined) {
        for (const t of result.targetInfos) asPage(t);
        result.targetInfos = result.targetInfos.filter((t) => {
          const ok = allow(t);
          if (!ok && typeof t.targetId === 'string') blocked.add(t.targetId);
          return ok;
        });
      }
      if (result.targetInfo !== undefined) {
        asPage(result.targetInfo);
        if (!allow(result.targetInfo)) {
          if (typeof result.targetInfo.targetId === 'string') blocked.add(result.targetInfo.targetId);
          delete result.targetInfo;
        }
      }
      // 事件过滤:不可见 target 的 attach/info/destroyed 事件整吞
      if (msg.method !== undefined) {
        const p = msg.params as { targetInfo?: Info; targetId?: string } | undefined;
        const info = p?.targetInfo;
        if (info !== undefined) {
          asPage(info);
          if (!allow(info)) {
            if (typeof info.targetId === 'string') blocked.add(info.targetId);
            return;
          }
        }
        if (msg.method === 'Target.targetDestroyed' && typeof p?.targetId === 'string' && blocked.has(p.targetId)) {
          blocked.delete(p.targetId);
          return;
        }
      }
      this.sendTo(ws, msg);
      if (typeof msg.id === 'number' && focusPending.has(msg.id)) {
        this.opts.focusTab?.(focusPending.get(msg.id)!, 'end');
        focusPending.delete(msg.id);
      }
      if (msg.method === 'Target.attachedToTarget') {
        const ap = msg.params as { sessionId?: string; targetInfo?: { targetId?: string } } | undefined;
        const tid = ap?.targetInfo?.targetId;
        if (typeof tid === 'string') {
          if (typeof ap?.sessionId === 'string') sessionTargets.set(ap.sessionId, tid);
          attached.add(tid);
          attachWaiters.get(tid)?.();
          attachWaiters.delete(tid);
        }
      }
    });
    real.on('open', () => { for (const m of outbox.splice(0)) real.send(m); });
    real.on('close', () => ws.close());
    real.on('error', () => ws.close());
    ws.on('message', (data) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(String(data)); } catch { return; }
      // 拒面:页签生命周期归 GUI(模型不可开/关 target)
      if (msg.method !== undefined && FORBIDDEN_METHODS.has(msg.method)) {
        this.sendTo(ws, { id: msg.id, error: { code: -32000, message: `${msg.method} is not allowed on the sidebar browser` } });
        return;
      }
      if (msg.method === 'Target.createTarget' && this.opts.openTab !== undefined) {
        const url = typeof msg.params?.url === 'string' && msg.params.url !== '' ? msg.params.url : 'about:blank';
        void this.createViaGui(url, scope).then(
          async (targetId) => {
            await waitAttached(targetId);
            this.sendTo(ws, { id: msg.id, result: { targetId } });
          },
          (err: unknown) => this.sendTo(ws, { id: msg.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }),
        );
        return;
      }
      if (msg.method === 'Target.closeTarget' && this.opts.closeTab !== undefined) {
        const tid = typeof msg.params?.targetId === 'string' ? msg.params.targetId : '';
        // 关页=关侧栏页签(webview 卸载→真实端点自然发 targetDestroyed,Playwright 据此收口)
        const ok = !blocked.has(tid) && this.opts.closeTab(tid);
        this.sendTo(ws, ok ? { id: msg.id, result: { success: true } } : { id: msg.id, error: { code: -32000, message: `no sidebar browser tab for target ${tid}` } });
        return;
      }
      if (msg.method === 'Target.createTarget' || msg.method === 'Target.closeTarget') {
        this.sendTo(ws, { id: msg.id, error: { code: -32000, message: 'sidebar browser tabs are managed by the GUI (create/close target not supported)' } });
        return;
      }
      // attach 面兜底:即使真实列表漏过滤,attach 到记账过的非白名单 id 报确定错误
      if (msg.method === 'Target.attachToTarget') {
        const tid = typeof msg.params?.targetId === 'string' ? msg.params.targetId : '';
        if (blocked.has(tid)) {
          this.sendTo(ws, { id: msg.id, error: { code: -32000, message: 'target not allowed' } });
          return;
        }
      }
      const forward = (): void => {
        if (real.readyState === WebSocket.OPEN) real.send(String(data));
        else if (real.readyState === WebSocket.CONNECTING) outbox.push(String(data));
      };
      const sid = (msg as { sessionId?: unknown }).sessionId;
      if (msg.method !== undefined && DRIVING_METHODS.has(msg.method) && typeof sid === 'string') {
        this.opts.ensureVisible?.();
        const driven = sessionTargets.get(sid);
        // 只在 agent 换了目标页签时切(同页连续操作不重复发 IPC;用户中途手动切走后,agent 下一次换页才拉回)
        if (driven !== undefined && driven !== lastActivated) {
          lastActivated = driven;
          this.opts.activateTab?.(driven);
        }
      }
      const tid = msg.method === 'Input.insertText' && typeof sid === 'string' ? sessionTargets.get(sid) : undefined;
      if (tid !== undefined && typeof msg.id === 'number' && this.opts.focusTab?.(tid, 'begin') === true) {
        focusPending.set(msg.id, tid);
        setTimeout(forward, FOCUS_SETTLE_MS);
        return;
      }
      forward();
    });
    ws.on('close', () => real.close());
  }

  private readonly clientSockets = new Set<WebSocket>();

  private async webviewIds(): Promise<Array<{ id: string; url: string }>> {
    const r = await fetch(`${this.realHttp()}/json/list`, { signal: AbortSignal.timeout(2000) });
    const arr = JSON.parse(await r.text()) as Array<{ id?: string; type?: string; url?: string }>;
    return arr.filter((t) => t.type === 'webview' && typeof t.id === 'string').map((t) => ({ id: t.id as string, url: t.url ?? '' }));
  }

  /** 新页签由 GUI 开(页签生命周期归侧栏),轮询真实列表等新 webview target 出现;超时报错 */
  private async createViaGui(url: string, scope?: SessionScope): Promise<string> {
    const mine = (id: string): boolean => scope === undefined || this.opts.belongs?.(id, scope.key) === true;
    const before = new Set((await this.webviewIds()).map((t) => t.id));
    this.opts.openTab?.(url, scope);
    const deadline = Date.now() + CREATE_TARGET_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const fresh = (await this.webviewIds().catch(() => [])).find((t) => !before.has(t.id) && mine(t.id));
      if (fresh !== undefined) return fresh.id;
    }
    // 页签按 url 判重:已有空白页签时 GUI 聚焦旧签而非新开,复用它
    const blank = (await this.webviewIds().catch(() => [])).find((t) => (t.url === 'about:blank' || t.url === url) && mine(t.id));
    if (blank !== undefined) return blank.id;
    throw new Error('failed to open a sidebar browser tab (open a session first)');
  }

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
    BrowserWindow?: { getAllWindows(): Array<{ isDestroyed(): boolean; isMinimized(): boolean; showInactive(): void; webContents: { getURL(): string; send(ch: string, ...a: unknown[]): void } }> };
    webContents?: { fromDevToolsTargetId?(id: string): { id: number; session?: unknown } | undefined };
    session?: { fromPartition(partition: string): unknown };
  };
  if (et.app === undefined) return Promise.resolve(undefined); // node 环境(npm 包字符串/缺 app)
  if (!et.app.commandLine?.hasSwitch?.('remote-debugging-port')) {
    log?.('facade: shell has no remote-debugging-port switch, builtin browser fusion disabled');
    return Promise.resolve(undefined);
  }
  const userData = et.app.getPath('userData');
  const port = process.env.SUNSHINEX_DAEMON_PORT ?? '';
  // 端口空=启动序异常(正常调用序 daemon listen 回调先落槽)——空端口使 origin 前缀退化为
  // 'http://127.0.0.1:':GUI 窗判定与 blockedUrl 过滤双双过宽(本机全部回环页被当 GUI 自身滤掉),
  // 显式停用融合面优于过宽过滤
  if (port === '') {
    log?.('facade: daemon port unknown, builtin browser fusion disabled');
    return Promise.resolve(undefined);
  }
  const origin = `http://127.0.0.1:${port}`;
  // 主窗=加载 daemon origin 的窗口(排除独立 DevTools 窗);同 popup 转发通道 builtin:open-url
  const guiWindow = () => et.BrowserWindow?.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith(origin));
  // 会话连接开页:带座位+浏览器键,GUI 开在该会话座位并用其分区(用户当前看的会话不受影响)
  const openTab = (url: string, scope?: SessionScope): void => {
    guiWindow()?.webContents.send('builtin:open-url', url, scope !== undefined ? { seat: scope.seat, key: scope.key } : undefined);
  };
  // 分区归属:Electron 同名分区 session 对象唯一(fromPartition 缓存),按对象同一性判定
  const belongs = (targetId: string, key: string): boolean => {
    const wc = et.webContents?.fromDevToolsTargetId?.(targetId);
    return wc !== undefined && et.session !== undefined && wc.session === et.session.fromPartition(`persist:sx-${key}`);
  };
  // CDP targetId → guest webContents id(GUI 侧 webview.getWebContentsId() 同值)→ GUI 关对应页签
  const closeTab = (targetId: string): boolean => {
    const wc = et.webContents?.fromDevToolsTargetId?.(targetId);
    const gui = guiWindow();
    if (wc === undefined || gui === undefined) return false;
    gui.webContents.send('builtin:close-webcontents', wc.id);
    return true;
  };
  const focusTab = (targetId: string, phase: 'begin' | 'end'): boolean => {
    const wc = et.webContents?.fromDevToolsTargetId?.(targetId);
    const gui = guiWindow();
    if (wc === undefined || gui === undefined) return false;
    gui.webContents.send('builtin:focus-webcontents', wc.id, phase);
    return true;
  };
  const activateTab = (targetId: string): void => {
    const wc = et.webContents?.fromDevToolsTargetId?.(targetId);
    if (wc !== undefined) guiWindow()?.webContents.send('builtin:activate-webcontents', wc.id);
  };
  const ensureVisible = (): void => {
    const gui = guiWindow();
    if (gui !== undefined && gui.isMinimized()) gui.showInactive();
  };
  const facade = new BuiltinFacade({ userDataDir: userData, localOriginPrefix: origin, log, openTab, belongs, closeTab, focusTab, activateTab, ensureVisible });
  return facade.start().then(() => ({ facade, ws: facade.endpoint })).catch((err) => {
    log?.(`facade start failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
}
