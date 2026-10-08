import * as path from 'node:path';
import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeImage, Tray } from 'electron';
import { resolveDaemonPaths } from './lib/paths';
import { appUrl } from './lib/app-url';
import { parseSmokeArgv } from './lib/smoke';
import { shouldHideOnClose, trayMenu } from './lib/lifecycle';
import { TRAY_ICON_DATA_URL } from './lib/tray-icon';
import { startDaemon } from './daemon';
import type { ShellDaemon } from './daemon';

/** smoke 收口总超时（ms）：ready-to-show 未至 / 收口悬挂的整体守卫，超时按失败退 1（T4 门禁判据） */
const SMOKE_TOTAL_TIMEOUT_MS = 45_000; // 满载机器(发版验证链后)冷启余量:15s 曾在发布环境瞬态超时,45s 仍远小于外层门
/** daemon close 的有界等待（ms）：close 悬挂不阻塞退出——有界等待完仍按正常收口走 quit。
 *  H2-T2 抽公共：smoke 收口与 runQuit 退出序共用同一有界口径（原 SMOKE_CLOSE_TIMEOUT_MS）。 */
const DAEMON_CLOSE_TIMEOUT_MS = 5_000;

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
  mainWindow.show();
  mainWindow.focus();
}

// 单实例锁（spec H §3）：二实例拿锁失败即退；首实例经 'second-instance' 收编呈现
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(async () => {
    try {
      // 两态路径：打包态以 resourcesPath 为根；开发态 getAppPath()=shell 目录（仓根直接子包），
      // 上溯一级即仓库根（T4 冒烟红首因：原上溯两级落到仓父目录，dist 解析必 404）
      const paths = resolveDaemonPaths(
        app.isPackaged,
        process.resourcesPath,
        path.resolve(app.getAppPath(), '..'),
      );
      daemon = await startDaemon(paths);
    } catch (err) {
      // 同步记日志再弹原生错误框（Windows 上 showErrorBox 阻塞至确认）；exit 1 携码强退
      // （app.quit 无携码形参，退出码语义由 app.exit 承担）
      console.error('[shell] daemon 启动失败:', err);
      dialog.showErrorBox('sunshinex', `daemon 启动失败: ${err instanceof Error ? err.message : String(err)}`);
      app.exit(1);
      return;
    }
    // 入口提示一行（沿 serve 惯例：port + token）
    console.log(`[shell] daemon listening at http://127.0.0.1:${daemon.port} (token: ${daemon.token})`);

    const win = new BrowserWindow({ width: 1200, height: 800, minWidth: 960, minHeight: 600 });
    mainWindow = win;
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

    // 托盘（spec §1 生命周期）：图标=内嵌 16x16 PNG data URL；tooltip+两件套菜单。
    // 菜单建成即静态（trayMenu(false)）——退出流程中的重复触发由 runQuit 幂等守卫吸收。
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
    tray.setToolTip('sunshinex');
    tray.setContextMenu(
      Menu.buildFromTemplate(
        trayMenu(false).map((item) => ({
          label: item.label,
          enabled: item.enabled,
          click: item.id === 'show' ? focusMainWindow : runQuit,
        })),
      ),
    );

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
