import * as path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { resolveDaemonPaths } from './lib/paths';
import { appUrl } from './lib/app-url';
import { parseSmokeArgv } from './lib/smoke';
import { startDaemon } from './daemon';
import type { ShellDaemon } from './daemon';

/** smoke 收口总超时（ms）：ready-to-show 未至 / 收口悬挂的整体守卫，超时按失败退 1（T4 门禁判据） */
const SMOKE_TOTAL_TIMEOUT_MS = 15_000;
/** smoke 收口 daemon close 的有界等待（ms）：close 悬挂不阻塞退出判定——有界等待完仍按正常收口退 0 */
const SMOKE_CLOSE_TIMEOUT_MS = 5_000;

let daemon: ShellDaemon | undefined;
/** daemon 收口幂等守卫：smoke 收口与 will-quit 兜底共用——已发起则后续调用直接跳过 */
let daemonCloseInitiated = false;

/** 发起 daemon close（若未发起过且 daemon 在场），返回收口 Promise；已闭/无 daemon 返回 undefined */
function closeDaemon(): Promise<void> | undefined {
  if (daemon === undefined || daemonCloseInitiated) return undefined;
  daemonCloseInitiated = true;
  return daemon.close();
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
    win.loadURL(appUrl(daemon.port, daemon.token)).catch((err) => console.error('[shell] loadURL failed:', err));

    app.on('second-instance', () => {
      win.show();
      win.focus();
    });

    // smoke 分支（T4 冒烟门禁）：ready-to-show = 窗口首帧渲染完成，有序收口后 exit 0；
    // 15s 总超时守卫兜底任何一步悬挂（如 loadURL 失败 → ready-to-show 不至 → 守卫退 1），正常路径 clear
    if (parseSmokeArgv(process.argv).smoke) {
      const guard = setTimeout(() => {
        console.error('[shell] smoke total timeout — exit 1');
        app.exit(1);
      }, SMOKE_TOTAL_TIMEOUT_MS);
      win.once('ready-to-show', () => {
        clearTimeout(guard);
        const closing = closeDaemon();
        void Promise.race([
          closing ?? Promise.resolve(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), SMOKE_CLOSE_TIMEOUT_MS)),
        ]).then(
          () => app.exit(0),
          (err) => {
            // close 报错不掩盖冒烟主断言（窗口已渲染即通过面），记日志后仍按完成退 0
            console.error('[shell] smoke daemon close failed:', err);
            app.exit(0);
          },
        );
      });
    }
  });

  // 退出兜底：常规退出路径（用户关窗等）下确保 daemon close——幂等守卫已闭（smoke 收口先走）则跳过。
  // close 失败与 smoke 分支同裁定（T3 复核落实）：统一退 0——冒烟判据=「启动到窗口就绪」，
  // close 失败已日志、不属冒烟语义面，退码不对称会在门禁上制造假红。
  app.on('will-quit', (event) => {
    const closing = closeDaemon();
    if (closing === undefined) return;
    event.preventDefault();
    void closing.then(
      () => app.exit(0),
      (err) => {
        console.error('[shell] daemon close failed:', err);
        app.exit(0);
      },
    );
  });
}
