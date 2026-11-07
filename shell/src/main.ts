import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray, webContents } from 'electron';
import { resolveDaemonPaths } from './lib/paths';
import { clampSize, lockedDragBounds } from './lib/window-drag';
import { appUrl, LOOPBACK } from './lib/app-url';
import { parseSmokeArgv } from './lib/smoke';
import { resolveUiLang, resolveUiLangFromSetting, shouldHideOnClose, trayMenu, type UiLang } from './lib/lifecycle';
import { TRAY_ICON_DATA_URL } from './lib/tray-icon';
import { PRODUCT_LOGO_DATA_URL } from './lib/product-logo';
import { startDaemon } from './daemon';
import type { ShellDaemon } from './daemon';

// M2 内置浏览器融合:真实 CDP 调试口(Chromium 写 userData/DevToolsActivePort,daemon 内 facade
// 过滤代理只向插件暴露侧栏 <webview> target——应用自身 UI 永不可见)。ready 前装配。
// 不能用 port 0(实测写了 DevToolsActivePort 却不监听);固定口在重启竞态下会被旧实例占着,
// 调试服务器静默绑定失败,旧 DevToolsActivePort 残留指向死端口→插件每轮等满超时(实测发消息卡 10s+)。
// 故:ready 前同步探一个确实空闲的口(优先 57679),并删掉残留 DevToolsActivePort
const DEBUG_PORT_PREFERRED = 57679;
function pickDebugPort(): number {
  const script = `const n=require('net');const t=(p)=>new Promise((r)=>{const s=n.createServer();s.once('error',()=>r(-1));s.listen(p,'127.0.0.1',()=>{const a=s.address().port;s.close(()=>r(a));});});(async()=>{let p=await t(${DEBUG_PORT_PREFERRED});if(p<0)p=await t(0);process.stdout.write(String(p));})();`;
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 3000, windowsHide: true });
  const port = Number(r.stdout);
  return Number.isInteger(port) && port > 0 ? port : DEBUG_PORT_PREFERRED;
}
try { fs.rmSync(path.join(app.getPath('userData'), 'DevToolsActivePort'), { force: true }); } catch { /* 尽力 */ }
app.commandLine.appendSwitch('remote-debugging-port', String(pickDebugPort()));
// 侧栏 webview 遮挡/切后台后停画(DOM 存活、画面冻结/残留脏区):Windows 原生遮挡计算会把被盖住的
// 窗口判为不可见并停合成——关掉;配合 backgroundThrottling:false 保持后台/被遮挡时照常绘制
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/** smoke 收口总超时（ms）：ready-to-show 未至 / 收口悬挂的整体守卫，超时按失败退 1（T4 门禁判据） */
const SMOKE_TOTAL_TIMEOUT_MS = 45_000; // 满载机器(发版验证链后)冷启余量:15s 曾在发布环境瞬态超时,45s 仍远小于外层门
/** daemon close 的有界等待（ms）：close 悬挂不阻塞退出——有界等待完仍按正常收口走 quit。
 *  H2-T2 抽公共：smoke 收口与 runQuit 退出序共用同一有界口径（原 SMOKE_CLOSE_TIMEOUT_MS）。 */
const DAEMON_CLOSE_TIMEOUT_MS = 5_000;
/** 外观语言（D33 纪律⑤;2026-10-23 用户裁定改向):托盘是壳唯一用户可见文案面,跟随应用语言
 *  设置——SUNSHINEX_LANGUAGE 槽(GUI 设置页写入,reloadSettingsChain 运行时刷新)优先,
 *  OS locale 仅缺省兜底。取函数不取装配期常量:右键即取当前值,改语言无需重启。 */
const trayLang = (): UiLang => resolveUiLangFromSetting(process.env.SUNSHINEX_LANGUAGE) ?? resolveUiLang(app.getLocale());

let daemon: ShellDaemon | undefined;
/** daemon 收口幂等守卫：已发起则后续调用直接跳过（smoke 与 runQuit 共用同一路收口） */
let daemonCloseInitiated = false;
/** 驻留判定面：true=退出流程中，关窗放行真关闭。runQuit 与 before-quit（系统关机等）两处置位——双置幂等。 */
let quitting = false;
/** runQuit 单点幂等守卫（与驻留面分旗）：退出序「daemon 有界 close → app.quit」是否已发起。
 *  分旗原因：before-quit 先于 will-quit 置位 quitting，若 runQuit 守卫同旗，非 runQuit 路径
 *  （系统关机）落 will-quit 兜底时 runQuit 会误短路——收口漏做/挂起。 */
let quitInitiated = false;
/** 主窗引用：focusMainWindow 破窗守卫（null/isDestroyed）用；T3 快捷键复用同守卫版 */
let mainWindow: BrowserWindow | undefined;
/** 托盘引用必须模块级持有——局部变量无引用会被 GC 回收，托盘图标随之消失（Electron 文档坑） */
let tray: Tray | undefined;

/** 发起 daemon close（若未发起过且 daemon 在场），返回收口 Promise；已闭/无 daemon 返回 undefined */
function closeDaemon(): Promise<void> | undefined {
  if (daemon === undefined || daemonCloseInitiated) return undefined;
  daemonCloseInitiated = true;
  return daemon.close();
}

/** 有界收口（H2-T2 公共化）：daemon.close() 最多等 DAEMON_CLOSE_TIMEOUT_MS，悬挂到点放行；
 *  close 报错记日志不外抛（收口语义=尽力而为，不阻塞退出裁定）。 */
async function closeDaemonBounded(): Promise<void> {
  const closing = closeDaemon();
  if (closing === undefined) return;
  try {
    await Promise.race([
      closing,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DAEMON_CLOSE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.error('[shell] daemon close failed:', err);
  }
}

/** 退出序单点（H2-T2，顺序=QUIT_STEPS：先 daemon 有界 close，后 app 退出）：
 *  托盘「退出」/ smoke 收口 / will-quit 兜底共用；幂等（quitInitiated 守卫）；
 *  app.quit() 正常收口退出码 0。 */
const runQuit = (): void => {
  if (quitInitiated) return;
  quitInitiated = true;
  quitting = true; // 退出流程中：后续关窗事件放行真关闭（before-quit 再置为双置幂等）
  void closeDaemonBounded().finally(() => app.quit());
};

/** 破窗守卫版唤起（H1 已知跟进清偿；T3 快捷键复用同函数）：窗不在/已毁 → 日志一行返回；否则 show+focus */
function focusMainWindow(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    console.error('[shell] main window unavailable — cannot focus');
    return;
  }
  // 最小化先还原:Windows 下 show() 对最小化窗只点亮任务栏不还原窗体(2026-10-31 通知点击唤起实证口径)
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 单实例锁（spec H §3）：二实例拿锁失败即退；首实例经 'second-instance' 收编呈现
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(async () => {
    // 窗口最小宽按系统 DPI 缩放折算 DIP(minWidth 是 DIP,150% 显示缩放下数值×1.5 才是物理px)。
    // 手调入口(2026-10-24 用户裁定):改 PHYSICAL_MIN_W 一个数即改物理px 下限,当前 500
    const PHYSICAL_MIN_W = 500;
    const dpiScale = Math.max(1, screen.getPrimaryDisplay()?.scaleFactor ?? 1);
    const minWinWidth = Math.round(PHYSICAL_MIN_W / dpiScale);
    try {
      // 两态路径：打包态以 resourcesPath 为根；开发态 getAppPath()=shell 目录（仓根直接子包），
      // 上溯一级即仓库根（T4 冒烟红首因：原上溯两级落到仓父目录，dist 解析必 404）
      const paths = resolveDaemonPaths(
        app.isPackaged,
        process.resourcesPath,
        path.resolve(app.getAppPath(), '..'),
      );
      // 端口偏好落盘(2026-10-23):上次实际端口存 userData,本次优先复用——GUI origin 稳定,
      // localStorage(语言/主题等)跨 launch 存续;被占自动回落临时端口并覆写偏好
      const portFile = path.join(app.getPath('userData'), 'daemon-port.json');
      let preferredPort: number | undefined;
      try {
        const saved = JSON.parse(fs.readFileSync(portFile, 'utf8')) as { port?: unknown };
        // 1024=特权端口下限:低位端口非用户态可绑,档里出现异常值时当无偏好处理
        if (typeof saved.port === 'number' && Number.isInteger(saved.port) && saved.port >= 1024) preferredPort = saved.port;
      } catch {
        // 首启无档:回落临时端口
      }
      daemon = await startDaemon(paths, preferredPort);
      try {
        fs.writeFileSync(portFile, JSON.stringify({ port: daemon.port }));
      } catch {
        // 落盘失败不阻启动(下次再回落临时端口)
      }
    } catch (err) {
      // 同步记日志再弹原生错误框（Windows 上 showErrorBox 阻塞至确认）；exit 1 携码强退
      // （app.quit 无携码形参，退出码语义由 app.exit 承担）
      console.error('[shell] daemon 启动失败:', err);
      dialog.showErrorBox('Sunshinex', `daemon 启动失败: ${err instanceof Error ? err.message : String(err)}`);
      app.exit(1);
      return;
    }
    // 入口提示一行（沿 serve 惯例：port + token；回环字面量就地维护，见 lib/app-url.ts 头注）
    console.log(`[shell] daemon listening at http://${LOOPBACK}:${daemon.port} (token: ${daemon.token})`);

    // 2026-10-23 用户裁定三连:①窗口/任务栏图标=产品 logo;②原生菜单(File/Edit/View/Window)退役;
    // ③无边框化——原生标题栏隐身,−□× 由 GUI 自绘(应用按钮样式,preload 桥 IPC;WCO 方块样式退役)
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      // 首绘前底色=开机画面同值(index.html #boot 暗 #131313/亮 #f9f9f9)——窗口现形到 HTML 首绘之间
      // 不闪。按系统亮暗取色:外观缺省「跟随系统」(2026-11-07 用户裁定全新应用即跟随系统)
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#131313' : '#f9f9f9',
      minWidth: minWinWidth, // 物理px 下限=PHYSICAL_MIN_W(手调入口见上);极窄时主面 min-width 有视口守卫钳制不越界
      minHeight: 600,
      icon: nativeImage.createFromDataURL(PRODUCT_LOGO_DATA_URL),
      titleBarStyle: 'hidden',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        webviewTag: true, // M1 内置浏览器融合:GUI WebTab builtin 档以 <webview> 承载真实页面
        sandbox: false, // webview 标签不支持沙箱渲染器(实测:guest 创建瞬间渲染进程崩溃=全窗黑)
        backgroundThrottling: false,
      },
    });
    mainWindow = win;
    win.setMenu(null);
    Menu.setApplicationMenu(null); // 托盘右键菜单独立建template,不受应用菜单清空影响
    // webview guest 安全纪律(2026-11-01 M1 融合):禁 node/preload(guest 只是无痕页面容器)+
    // http(s)/about 之外的 src 拒挂;弹窗(window.open/_blank)不开原生子窗,转发 GUI 开新侧栏页签
    app.on('web-contents-created', (_event, wc) => {
      // will-attach-webview 由**宿主**(主窗 webContents)发出——挂在 guest 上永不触发(曾如此,
      // preload 剥离/非 http(s) src 拦截形同虚设)
      if (wc.getType() === 'window') {
        wc.on('will-attach-webview', (att, webPreferences, params) => {
          delete webPreferences.preload;
          webPreferences.nodeIntegration = false;
          webPreferences.backgroundThrottling = false;
          const src = typeof params.src === 'string' ? params.src : '';
          if (!/^https?:\/\//i.test(src) && src !== 'about:blank') att.preventDefault();
        });
        return;
      }
      if (wc.getType() !== 'webview') return;
      wc.setWindowOpenHandler(({ url }) => {
        // M2 融合(2026-11-02 用户裁定「页内超链接开新页签,和浏览器一样」):guest 弹窗不外开,
        // 转发 GUI 开新侧栏 web 页签(App onOpenWeb 消费,判重由 openTab 承担);非 http(s) 纯拒
        try {
          const u = new URL(url);
          const gui = mainWindow;
          const guiReady = gui !== undefined && !gui.isDestroyed();
          if ((u.protocol === 'http:' || u.protocol === 'https:') && guiReady) gui.webContents.send('builtin:open-url', url, { openerWebContentsId: wc.id });
        } catch { /* 非法 url 静默拒 */ }
        return { action: 'deny' };
      });
    });
    // 窗控 IPC(渲染层 −□× 按钮):最小化/最大化切换/关闭(关闭走 close 事件=驻留 hide 语义);
    // maximize/unmaximize 回推渲染层换 □/restore 字形
    ipcMain.on('win:minimize', () => mainWindow?.minimize());
    ipcMain.on('win:toggle-maximize', () => {
      if (mainWindow === undefined) return;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    });
    ipcMain.on('win:close', () => mainWindow?.close());
    // 通知点击唤起(2026-10-31 用户裁定「点击后要打开应用界面」):渲染层 Notification onclick 经桥
    // 唤起——hide-on-close/最小化窗 window.focus() 无效,须主进程 show+focus(focusMainWindow 破窗守卫)
    ipcMain.on('win:focus-main', () => focusMainWindow());
    // 程序化拖窗:渲染层在拖拽面上越过 4px 才发 drag-start,主进程再跟光标。
    // Windows 无边框窗的 setPosition 会把 thick frame 逐拍加进宽高,贴顶时还会被 Aero Snap
    // 拉成工作区大小——拖拽期锁死宽高,并用 setResizable(false) 挡住系统改尺寸。
    let dragTimer: ReturnType<typeof setInterval> | null = null;
    let dragSession = false;
    let dragLockSize: { width: number; height: number } | null = null;
    let normalBounds: { x: number; y: number; width: number; height: number } | null = null;
    const rememberNormal = (): void => {
      if (dragSession || mainWindow === undefined || mainWindow.isDestroyed() || mainWindow.isMaximized()) return;
      normalBounds = mainWindow.getBounds();
    };
    const stopWindowDrag = (): void => {
      if (dragTimer !== null) {
        clearInterval(dragTimer);
        dragTimer = null;
      }
      const lock = dragLockSize;
      dragLockSize = null;
      if (lock !== null && mainWindow !== undefined && !mainWindow.isDestroyed()) {
        const [x, y] = mainWindow.getPosition();
        mainWindow.setResizable(true);
        mainWindow.setBounds({ x, y, width: lock.width, height: lock.height }, false);
        if (!mainWindow.isMaximized()) normalBounds = mainWindow.getBounds();
      }
      dragSession = false;
    };
    ipcMain.on('win:drag-start', () => {
      if (!mainWindow || mainWindow.isDestroyed() || dragTimer !== null) return;
      dragSession = true;
      const start = screen.getCursorScreenPoint();
      let [wx, wy] = mainWindow.getPosition();
      let offX = start.x - wx;
      let offY = start.y - wy;
      let moved = false;
      const startedAt = Date.now();
      dragTimer = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed() || Date.now() - startedAt > 60_000) {
          stopWindowDrag();
          return;
        }
        const c = screen.getCursorScreenPoint();
        // 渲染层已做 4px 门槛;这里再守一道,纯点击(光标抖动未过线)不改窗口
        if (!moved && Math.hypot(c.x - start.x, c.y - start.y) < 4) return;
        if (!moved) {
          moved = true;
          if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
            if (normalBounds !== null) {
              mainWindow.setBounds(normalBounds, false);
            } else {
              const wa = screen.getPrimaryDisplay().workArea;
              const [rw, rh] = mainWindow.getSize();
              const next = clampSize({ width: rw, height: rh }, wa);
              if (next.width !== rw || next.height !== rh) mainWindow.setSize(next.width, next.height);
            }
            [wx, wy] = mainWindow.getPosition();
            offX = start.x - wx;
            offY = start.y - wy;
          }
          const [lockW, lockH] = mainWindow.getSize();
          dragLockSize = { width: lockW, height: lockH };
          mainWindow.setResizable(false);
          const [lx, ly] = mainWindow.getPosition();
          mainWindow.setBounds({ x: lx, y: ly, width: lockW, height: lockH }, false);
        }
        if (dragLockSize === null) return;
        const next = lockedDragBounds({ x: c.x, y: c.y }, { x: offX, y: offY }, dragLockSize);
        mainWindow.setBounds(next, false);
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
          mainWindow.setBounds(next, false);
        }
        const [aw, ah] = mainWindow.getSize();
        if (aw !== dragLockSize.width || ah !== dragLockSize.height) mainWindow.setBounds(next, false);
      }, 10);
    });
    ipcMain.on('win:drag-end', stopWindowDrag);
    win.on('resize', rememberNormal);
    win.on('move', rememberNormal);
    win.once('ready-to-show', rememberNormal);
    const notifyMaximized = (): void => {
      try {
        mainWindow?.webContents.send('win:maximized', mainWindow.isMaximized());
      } catch {
        // 窗毁后回推即弃(驻留 hide 面不改注册表)
      }
    };
    win.on('maximize', notifyMaximized);
    win.on('unmaximize', notifyMaximized);
    win.loadURL(appUrl(daemon.port, daemon.token)).catch((err) => console.error('[shell] loadURL failed:', err));

    // Web 标签「外开」（H2-T3）：window.open / target=_blank 一律放行为原生新窗（同 session——
    // 同 daemon 域 cookie/localStorage，token 持久面沿 G3）；v1 不做 deny 分流，
    // 非 http(s) 面（file:// 等）由 Electron 默认策略拒。url 参数留作后续分流钩子。
    win.webContents.setWindowOpenHandler(({ url }) => {
      void url;
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 1100, height: 800 },
      };
    });

    // 「在系统浏览器打开」（2026-10-25 用户报障:该钮走 window.open 落进 Electron 子窗,不是系统
    // 默认浏览器）:renderer 经 preload 桥调 shell.openExternal——由 OS 默认浏览器承接(用户配置
    // 的 Chrome)。仅放行 http(s),其余协议(向 shell 交给系统的 file:/自定义协议面)不外抛。
    ipcMain.handle('shell:open-external', async (_event, url: unknown): Promise<{ ok: boolean }> => {
      if (typeof url !== 'string' || url === '') return { ok: false };
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false };
        await shell.openExternal(url);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    });

    // 内置浏览器调试(2026-10-31 用户裁定「⋯菜单→打开调试工具」;2026-11-04 用户裁定改宗:
    // DevTools 只挂内置浏览器页签的 guest webContents——WebTab 迁 webview 后主窗 DevTools 只见
    // top 文档,检不到页签);renderer 传 webview webContentsId 直挂其 detach DevTools;
    // id 缺席(iframe 态/旧渲染)回退主窗。已开再点=关闭(toggle 语义)
    ipcMain.on('web:open-devtools', (_event, wcId: unknown) => {
      const guest = typeof wcId === 'number' ? webContents.fromId(wcId) : undefined;
      const wc = guest !== undefined && !guest.isDestroyed() ? guest : mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
      if (wc === undefined) return;
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: 'detach' });
    });

    // 元素拾取(2026-11-04 用户裁定「理论上任何页面都能选取元素,参考开源实现」):CDP Overlay
    // inspect 模式=DevTools 元素检视同源——高亮蓝框/showInfo 信息条(标签+尺寸+颜色+字体)/点击
    // 拦截全在浏览器层,不往页面注入脚本,任意 CSP/框架页面可用(注入版被页面环境卡死即此弃因)。
    // 流程:pick-start → setInspectMode(searchForNode) → 用户悬停原生高亮 → 点击
    // Overlay.inspectNodeRequested → 主进程 CDP 取节点数据(标签路径/outerHTML/页题址)发
    // renderer(builtin:pick-node) → 渲染层选择卡收口 → pick-stop 清检视态并脱挂 debugger
    // (webContents.debugger 单客户端,用完即还);Esc=inspectModeCanceled → 发 null=取消。
    // 高亮颜色对齐截图样式:content 淡蓝填充+蓝边框,showInfo 画 DevTools 同款信息条。
    type PickSession = {
      onMessage: (ev: { preventDefault: () => void; readonly defaultPrevented: boolean }, method: string, params: Record<string, unknown>, sessionId: string) => void;
      onDetached: (ev: { preventDefault: () => void; readonly defaultPrevented: boolean }, reason: string) => void;
    };
    const picks = new Map<number, PickSession>();
    const gatherPickNode = async (guest: Electron.WebContents, backendNodeId: number): Promise<{ path: string; html: string; url: string; title: string }> => {
      const send = <T>(method: string, params?: Record<string, unknown>): Promise<T> => guest.debugger.sendCommand(method, params) as Promise<T>;
      const node = await send<{ node: { nodeName: string; attributes?: string[]; localName?: string } }>('DOM.describeNode', { backendNodeId, depth: 0 });
      const tag = (node.node.localName ?? node.node.nodeName ?? 'div').toLowerCase();
      const attrs = node.node.attributes ?? [];
      let path = tag;
      const idV = attrs[attrs.indexOf('id') + 1];
      if (attrs.includes('id') && typeof idV === 'string' && idV !== '') path += `#${idV}`;
      const clsV = attrs[attrs.indexOf('class') + 1];
      if (attrs.includes('class') && typeof clsV === 'string' && clsV.trim() !== '') path += clsV.trim().split(/\s+/).slice(0, 2).map((c) => `.${c}`).join('');
      let html = '';
      try {
        html = (await send<{ outerHTML: string }>('DOM.getOuterHTML', { backendNodeId })).outerHTML.slice(0, 4000);
      } catch { /* 尽力 */ }
      return { path, html, url: guest.getURL(), title: guest.getTitle() };
    };
    ipcMain.handle('web:pick-start', async (_event, wcId: unknown): Promise<{ ok: boolean; error?: string }> => {
      const guest = typeof wcId === 'number' ? webContents.fromId(wcId) : undefined;
      if (guest === undefined || guest.isDestroyed()) return { ok: false, error: 'webview gone' };
      const dbg = guest.debugger;
      try {
        await dbg.attach('1.3');
        await dbg.sendCommand('DOM.enable');
        await dbg.sendCommand('CSS.enable');
        await dbg.sendCommand('Overlay.enable');
        await dbg.sendCommand('Overlay.setInspectMode', {
          mode: 'searchForNode',
          // showInfo=true(2026-11-04 用户裁定回归原生):信息条(标签/尺寸/颜色/字体)由 Chromium
          // 画在覆盖层——宿主自绘版悬停回投管线在检视态下有高亮框不显的 bug,整族拆除
          highlightConfig: {
            showInfo: true,
            contentColor: { r: 111, g: 168, b: 220, a: 0.55 },
            paddingColor: { r: 147, g: 196, b: 125, a: 0.44 },
            borderColor: { r: 111, g: 168, b: 220, a: 1 },
            marginColor: { r: 246, g: 178, b: 107, a: 0.55 },
          },
        });
      } catch (err) {
        try { dbg.detach(); } catch { /* 尽力 */ }
        return { ok: false, error: String(err) };
      }
      const id = guest.id;
      const sess: PickSession = { onMessage: () => {}, onDetached: () => {} };
      const onMessage = (_ev: { preventDefault: () => void; readonly defaultPrevented: boolean }, method: string, params: Record<string, unknown>, _sessionId: string): void => {
        if (mainWindow === undefined || mainWindow.isDestroyed()) return;
        if (method === 'Overlay.inspectNodeRequested') {
          const backendNodeId = typeof params.backendNodeId === 'number' ? params.backendNodeId : -1;
          if (backendNodeId < 0) return;
          void gatherPickNode(guest, backendNodeId).then(
            (info) => mainWindow?.webContents.send('builtin:pick-node', id, info),
            () => mainWindow?.webContents.send('builtin:pick-node', id, null),
          );
        } else if (method === 'Overlay.inspectModeCanceled') {
          mainWindow.webContents.send('builtin:pick-node', id, null);
        }
      };
      sess.onMessage = onMessage;
      const onDetached = (): void => {
        picks.delete(id);
      };
      dbg.on('message', onMessage);
      dbg.on('detach', onDetached);
      picks.set(id, sess);
      return { ok: true };
    });
    ipcMain.handle('web:pick-stop', (_event, wcId: unknown): void => {
      const guest = typeof wcId === 'number' ? webContents.fromId(wcId) : undefined;
      if (guest === undefined || guest.isDestroyed()) return;
      const sess = picks.get(guest.id);
      if (sess !== undefined) {
        guest.debugger.removeListener('message', sess.onMessage);
        guest.debugger.removeListener('detach', sess.onDetached);
        picks.delete(guest.id);
      }
      const dbg = guest.debugger;
      void Promise.allSettled([
        dbg.sendCommand('Overlay.setInspectMode', { mode: 'none' }),
        dbg.sendCommand('Overlay.disable'),
        dbg.sendCommand('DOM.disable'),
        dbg.sendCommand('CSS.disable'),
      ]).then(() => {
        try { dbg.detach(); } catch { /* 尽力 */ }
      });
    });

    // 「浏览文件夹」原生目录选择（2026-10-27 创建新项目慢修复）：preload 桥 window.sunshinex.pickFolder
    // →系统对话框选完即回绝对路径——GUI 两处创建入口（欢迎页/侧栏 pickAndAdd）探测到此桥即不再走
    // 浏览器态标记定位兜底（全盘 BFS 同步 readdir 阻塞 daemon 主线程，实测 3.7s+/深目录更劣）。
    // 破窗守卫：主窗缺席时退无窗形态（对话框仍可用，模态性放弃）。
    ipcMain.handle('shell:pick-folder', async (): Promise<string | null> => {
      const opts = { properties: ['openDirectory'] as Array<'openDirectory'> };
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const r = win !== undefined ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    });

    // 驻留序（H-D2）：非退出流程中关窗=preventDefault+hide（会话/PTY 不中断），退出流程放行真关闭
    win.on('close', (event) => {
      if (shouldHideOnClose(quitting)) {
        event.preventDefault();
        win.hide();
      }
    });

    // 二实例收编呈现：改走破窗守卫版（原裸 win.show/focus 在窗毁后即抛——H1 已知跟进清偿）
    app.on('second-instance', () => {
      focusMainWindow();
    });

    // 全局快捷键（H2-T3）：Alt+Shift+S 唤主窗——与 second-instance/托盘共用破窗守卫版
    // focusMainWindow；注册失败（快捷键被占/权限拒）仅记一行日志不炸，缺席不阻启动主流程。
    if (!globalShortcut.register('Alt+Shift+S', focusMainWindow)) {
      console.error('[shell] global shortcut Alt+Shift+S registration failed');
    }

    // 托盘（spec §1 生命周期）：图标=内嵌 PNG data URL；tooltip + 右键菜单。
    // 2026-10-23 用户裁定:左键单击即弹主窗——setContextMenu 会让左键被菜单占用(点图标只出菜单
    // 不出窗),故菜单改挂 right-click popUpContextMenu,left-click 单点 focusMainWindow。
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
    const appTray = tray; // 闭包内用局部快照:模块级 let 的收窄不过回调(tsc TS18048)
    appTray.setToolTip('Sunshinex');
    appTray.on('click', () => focusMainWindow());
    // 右键即取当前语言重建菜单(设置页改语言 reloadSettingsChain 刷 SUNSHINEX_LANGUAGE 槽,无需重启)
    appTray.on('right-click', () => {
      const popup = Menu.buildFromTemplate(
        trayMenu(trayLang()).map((item) => ({
          label: item.label,
          click: item.id === 'show' ? focusMainWindow : runQuit,
        })),
      );
      appTray.popUpContextMenu(popup);
    });

    // smoke 分支（T4 冒烟门禁）：就绪信号 = did-finish-load（页面加载完成——渲染器起+静态资源服务通，
    // 语义等价且确定；ready-to-show 系首绘事件，发布链 spawn 环境曾不触发（仪表实证 url 已载/visible/loading:false
    // 而事件不至，守卫误杀）。收口走 runQuit 单点（ready→daemon 有界 close→app.quit，退出码 0）；
    // 总超时守卫兜任何一步悬挂退 1。
    if (parseSmokeArgv(process.argv).smoke) {
      const guard = setTimeout(() => {
        console.error('[shell] smoke total timeout — exit 1', { url: (()=>{try{return mainWindow?.webContents.getURL()}catch{return 'n/a'}})(), visible: (()=>{try{return mainWindow?.isVisible()}catch{return 'n/a'}})(), loading: (()=>{try{return mainWindow?.webContents.isLoading()}catch{return 'n/a'}})() });
        app.exit(1);
      }, SMOKE_TOTAL_TIMEOUT_MS);
      const loaded = (): void => {
        clearTimeout(guard);
        runQuit();
      };
      win.webContents.once('did-finish-load', loaded);
      // 兜底：监听挂上前加载已毕（同 tick attach 后 loadURL 才发起，理论不可达；一行保险）
      if (!win.webContents.isLoading()) loaded();
    }
  });

  // 驻留翻面（系统关机等非 runQuit 路径）：before-quit 先于关窗事件——置位 quitting 放行真关闭，
  // 不阻关机；runQuit 路径已先行置位，此处重置幂等。
  app.on('before-quit', () => {
    quitting = true;
  });

  // 退出兜底（runQuit 语义）：非 runQuit 路径直落至此（如系统关机/他处 app.quit）时挂起 quit，
  // 转单点完成「daemon 收口→app.quit」；runQuit 路径已在途（quitInitiated）则直接放行——
  // 重入时守卫短路，幂等防环。
  app.on('will-quit', (event) => {
    // 快捷键随进程退场统一注销（H2-T3；unregisterAll 幂等——非 runQuit 路径 will-quit 可两度触发）
    globalShortcut.unregisterAll();
    if (quitInitiated) return;
    event.preventDefault();
    runQuit();
  });
}
