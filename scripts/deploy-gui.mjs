#!/usr/bin/env node
/**
 * GUI 桌面端部署脚本(2026-10-29):verify 验证 / deploy 渲染层推装 / reinstall 卸载重装,一条命令直达。
 *
 * 用法(仓库根执行):
 *   node scripts/deploy-gui.mjs verify              # gui typecheck(快速门禁;--tests 加跑全量 vitest)
 *   node scripts/deploy-gui.mjs deploy  [--dir ...] # 构建 gui → 推装 dist-gui → 重启应用(壳不变,日常改动用)
 *   node scripts/deploy-gui.mjs reinstall [--dir ...] [--setup ...] [--pristine]
 *
 *   打包输出目录(2026-11-14 用户裁定「应该只放到 shell/release 一个里面」):恒 shell/release
 *   (electron-builder.yml directories.output 单点,--setup 例外=外带现成包)。不同版本=目录内
 *   不同文件名并存(latestSetup 按 mtime 取本机架构最新),同版本=同名覆盖;禁止每轮
 *   -c.directories.output 换目录(fresh-NN 手动目录曾堆 29 份×560MB 残留,已清)
 *                                                   # 全链:gui+壳构建→重打包 setup→卸载→装→启动(壳变更用)
 *
 * 参数:
 *   --dir <path>     桌面端安装目录(默认 D:\MyWorkSoftware\Sunshinex;须与首次安装路径一致,
 *                    NSIS /D 大小写不敏感但路径必须真实存在父目录)
 *   --setup <path>   安装包路径(reinstall 用,默认取 shell/release 下本机系统/架构的最新安装包,如 sunshinex-<ver>-win-x64-setup.exe)
 *   --tests          verify 附带全量 vitest(既有基线红面见 CLAUDE.md,以基线对照为准)
 *   --no-build       deploy/reinstall 跳过构建,直接用现有产物
 *   --pristine       净装:清用户态历史——%APPDATA%\sunshinex-shell(Electron 缓存/Local Storage/
 *                    daemon-port 指针)与 ~/.sunshinex/gui(GUI 面私有 UI 态)。会话/转录等共享数据在
 *                    ~/.sunshinex/projects 不动;UI 偏好(缩放/标签布局/主题)回出厂。适用于
 *                    「重装后旧毛病仍在」的排除法:代码层已证一致时,剩下的只有这两个历史载体
 *
 * 行为细则:
 *   - deploy:dist-gui 整目录轮换(旧→dist-gui.old 回滚点),重启前停 Sunshinex 进程,完成后
 *     ie4uinit 刷新图标缓存(exe 同路径替换后 Windows 缓存留白图标,轻量刷新即可)。
 *   - reinstall:静默卸载(Uninstall Sunshinex.exe /S)→ 残留清点 → 静默安装(/S /D=<dir>,
 *     /D 必须是最后一个参数)→ 启动;用户数据(%APPDATA%\sunshinex-shell)不受影响。
 *   - 装配校验自动化(deploy/reinstall 共用):装后核 app.asar 壳束标志 + 安装目录 dist-gui
 *     渲染层标志,启动后核进程路径确从安装目录起——防「旧实例占住单例锁/装的是旧包」假安装。
 *   - 壳变更(壳源码/新增 IPC)必须走 reinstall;纯 gui 改动走 deploy 即可(renderer 推装覆盖不到壳)。
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeSetup, nativeTarget } from './release-artifacts.mjs';
import process from 'node:process';

const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'));
const GUI_DIR = path.join(REPO, 'gui');
const SHELL_DIR = path.join(REPO, 'shell');
const DIST_GUI = path.join(REPO, 'dist-gui');
const APP_NAME = 'Sunshinex';
const EXE_NAME = `${APP_NAME}.exe`;

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (command !== 'verify' && command !== 'deploy' && command !== 'reinstall') {
  console.error('用法: node scripts/deploy-gui.mjs <verify|deploy|reinstall> [--dir <安装目录>] [--setup <安装包>] [--tests] [--no-build] [--pristine]');
  process.exit(2);
}

const installDir = path.resolve(opt('--dir') ?? 'D:\\MyWorkSoftware\\Sunshinex');
const installGui = path.join(installDir, 'resources', 'dist-gui');
const installExe = path.join(installDir, EXE_NAME);
// 装配校验标志串:壳束 IPC 通道与渲染层拖拽契约(新束独有,旧束必无)
const SHELL_MARKER = 'lockedDragBounds'; // 拖拽锁宽高(2026-10-30);旧束只有 win:drag-start
const GUI_MARKER = 'data-drag-band';

const run = (cmd, cmdArgs, opts = {}) => {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: true, cwd: opts.cwd ?? REPO, env: { ...process.env, ...opts.env } });
  if (r.status !== 0) {
    console.error(`✗ 命令失败(exit ${r.status}): ${cmd} ${cmdArgs.join(' ')}`);
    process.exit(r.status ?? 1);
  }
};

const powershell = (script) => {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim() };
};

const stopApp = () => {
  console.log('· 停止 Sunshinex 进程…');
  powershell(`Stop-Process -Name ${APP_NAME} -Force -ErrorAction SilentlyContinue`);
  // 轮询到净而非固定 sleep:句柄不释放会卡卸载/换装;残留实例占住单例锁会把「新装启动」吞成「旧实例复活」
  for (let i = 0; i < 15; i++) {
    const { out } = powershell(`(Get-Process -Name ${APP_NAME} -ErrorAction SilentlyContinue | Measure-Object).Count`);
    if (out === '' || out === '0') return;
    powershell(`Stop-Process -Name ${APP_NAME} -Force -ErrorAction SilentlyContinue`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
};

const launchApp = () => {
  console.log('· 启动应用…');
  // 经 explorer 中转启动(2026-11-01 用户报障「builtin 浏览器连不上」根修):安装器是提权运行的,
  // Start-Process 直启会让应用继承**提权令牌**——无头 Chrome 在提权环境下 crashpad 初始化失败,
  // 静默秒退 exit 21(stderr 全空,与实测一致)。explorer 以当前登录用户的普通完整性代启,
  // 应用降权运行,子进程链恢复正常
  powershell(`Start-Process explorer.exe -ArgumentList '${installExe}'`);
  // Windows 图标缓存轻量刷新:exe 同路径反复替换后缓存留白图标(2026-10-29 实测),ie4uinit 重建即可
  powershell('ie4uinit.exe -show');
};

// 装配校验(CLAUDE.md 纪律自动化):新壳束/新渲染层标志必须在安装目录内,防「装的是旧包」假安装
const verifyAssembly = () => {
  const asar = path.join(installDir, 'resources', 'app.asar');
  if (!existsSync(asar) || !readFileSync(asar).includes(SHELL_MARKER)) {
    console.error('✗ 装配校验失败:app.asar 内未见新壳束标志(安装包过旧或安装未完成)');
    process.exit(1);
  }
  const assets = path.join(installGui, 'assets');
  const guiMarker = existsSync(assets) && readdirSync(assets).some((f) => readFileSync(path.join(assets, f)).includes(GUI_MARKER));
  if (!guiMarker) {
    console.error('✗ 装配校验失败:安装目录 dist-gui 未见新渲染层标志');
    process.exit(1);
  }
  console.log('✓ 装配校验:壳束+渲染层新束标志在位');
};

// 启动校验:进程必须真从安装目录起——单例锁被残留实例占住时,Start-Process 会静默落到旧进程
const verifyLaunchedFromInstallDir = () => {
  for (let i = 0; i < 15; i++) {
    const { out } = powershell(`(Get-Process -Name ${APP_NAME} -ErrorAction SilentlyContinue | Select-Object -First 1).Path`);
    if (out && out.toLowerCase().startsWith(installDir.toLowerCase())) {
      console.log(`✓ 启动校验:进程来自安装目录(${out})`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  console.error('✗ 启动校验失败:15s 内未见从安装目录启动的进程');
  process.exit(1);
};

// --pristine:清用户态历史载体。会话/转录/记忆等共享数据在 ~/.sunshinex/projects 不动;
// 只清 Electron userData(Chromium 缓存/Local Storage/Session Storage/daemon-port 指针)与
// ~/.sunshinex/gui(GUI 面私有 UI 态)——UI 偏好(缩放/标签布局/主题)回出厂,重装推不掉的旧渲染态在此
const wipeAppState = () => {
  console.log('· pristine:清用户态历史(userData + ~/.sunshinex/gui UI 态)…');
  const dirs = [path.join(process.env.APPDATA ?? '', 'sunshinex-shell'), path.join(os.homedir(), '.sunshinex', 'gui')];
  for (const dir of dirs) {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
};

const latestSetup = () => {
  if (opt('--setup')) return opt('--setup');
  const releaseDir = path.join(SHELL_DIR, 'release');
  // 命名单点解析(2026-11-09 多系统/架构命名):只认本机系统/架构的安装包——部署装错架构的包
  // 必然起不来;同版本/多版本并存按 mtime 最新(字典序会误选 0.10 < 0.9,历史教训)
  const setup = existsSync(releaseDir) ? nativeSetup(releaseDir) : undefined;
  if (setup === undefined) {
    const t = nativeTarget();
    console.error(`✗ shell/release 下无 ${t.os}-${t.arch} 安装包;先跑 reinstall 的构建或手动提供 --setup`);
    process.exit(1);
  }
  console.log(`· 选用安装包(本机 ${nativeTarget().os}-${nativeTarget().arch},按 mtime 最新): ${setup.name} (${new Date(statSync(setup.file).mtimeMs).toLocaleString()})`);
  return setup.file;
};

const verify = () => {
  console.log('== verify: gui typecheck ==');
  run('pnpm', ['--dir', 'gui', 'run', 'typecheck']);
  if (flag('--tests')) {
    console.log('== verify: 全量 vitest(既有基线红面以基线对照为准,见 CLAUDE.md)==');
    spawnSync('npx', ['vitest', 'run'], { stdio: 'inherit', cwd: GUI_DIR, shell: true });
  }
  console.log('✓ verify 完成');
};

const pushDistGui = () => {
  if (!existsSync(installGui)) {
    console.error(`✗ ${installGui} 不存在——目标目录未安装过桌面端?用 reinstall 子命令`);
    process.exit(1);
  }
  console.log('· 推装 dist-gui(旧目录轮换为 dist-gui.old 回滚点)…');
  const old = path.join(path.dirname(installGui), 'dist-gui.old');
  rmSync(old, { recursive: true, force: true });
  const retry = (fn) => {
    for (let i = 0; i < 10; i++) {
      try {
        fn();
        return true;
      } catch {
        // exe 同路径反复替换后文件句柄偶发占用:等 1s 重试
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
    }
    return false;
  };
  if (!retry(() => { rmSync(installGui, { recursive: true, force: true }); mkdirSync(path.dirname(installGui), { recursive: true }); cpSync(DIST_GUI, installGui, { recursive: true }); })) {
    console.error('✗ dist-gui 轮换失败(句柄占用未释放)');
    process.exit(1);
  }
};

const deploy = () => {
  if (!flag('--no-build')) {
    console.log('== deploy: 构建 gui ==');
    run('pnpm', ['--dir', 'gui', 'run', 'build']);
  }
  if (!existsSync(installExe)) {
    console.error(`✗ ${installExe} 不存在——用 reinstall 子命令先装`);
    process.exit(1);
  }
  stopApp();
  if (flag('--pristine')) wipeAppState();
  pushDistGui();
  verifyAssembly();
  launchApp();
  verifyLaunchedFromInstallDir();
  console.log(`✓ deploy 完成:renderer 已推装至 ${installGui}${flag('--pristine') ? '(pristine 用户态已清)' : ''}`);
};

const reinstall = () => {
  if (!flag('--no-build')) {
    console.log('== reinstall: 全链构建(根 tsc → gui → 壳 esbuild)==');
    run('pnpm', ['run', 'build']);
    run('pnpm', ['--dir', 'gui', 'run', 'build']);
    run('pnpm', ['--filter', 'sunshinex-shell', 'run', 'build']);
    // 打包输出恒 shell/release(electron-builder.yml directories.output 单点):不同版本=目录内
    // 不同 setup 文件名并存,同版本=同名覆盖——禁止每轮 -c.directories.output 换目录(2026-11-14
    // 用户裁定「应该只放到这一个里面」:fresh-NN 手动目录曾堆 29 份×560MB 残留)
    console.log('== reinstall: 重打包 setup(electron-builder,输出恒 shell/release,镜像 env 已设)==');
    run('pnpm', ['--filter', 'sunshinex-shell', 'run', 'dist'], {
      env: {
        ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
        ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
      },
    });
  }
  const setup = path.resolve(latestSetup());
  if (!existsSync(setup)) {
    console.error(`✗ 安装包不存在: ${setup}`);
    process.exit(1);
  }
  stopApp();
  if (flag('--pristine')) wipeAppState();
  const uninstaller = path.join(installDir, `Uninstall ${APP_NAME}.exe`);
  if (existsSync(uninstaller)) {
    console.log('· 静默卸载(/S)…');
    spawnSync(uninstaller, ['/S'], { stdio: 'ignore' });
    for (let i = 0; i < 30; i++) {
      if (!existsSync(installExe)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    // NSIS 卸载器把自身复制到 Temp 执行,目录残空壳常见;句柄释放后清残留
    if (existsSync(installDir)) {
      try { rmSync(installDir, { recursive: true, force: true }); } catch { /* cwd 占用残留空目录,安装器可覆盖 */ }
    }
  } else {
    console.log('· 无卸载器(非 NSIS 安装面),直接清目录…');
    try { rmSync(installDir, { recursive: true, force: true }); } catch { /* 残留空目录可被安装器覆盖 */ }
  }
  console.log(`· 静默安装(/S /D=${installDir})…`);
  // /D 必须是最后一个参数且不加引号(NSIS 约定)
  spawnSync(setup, ['/S', `/D=${installDir}`], { stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    if (existsSync(installExe) && existsSync(installGui)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (!existsSync(installExe)) {
    console.error('✗ 安装超时:未检出 Sunshinex.exe');
    process.exit(1);
  }
  // electron-builder NSIS 安装器每次都会把自身拷贝到 updater store(差量更新预留);本项目壳无
  // electron-updater 更新源,该副本是 129MB 死重,装后即清(将来若接自动更新,下载时会自动重建)
  const installerStore = path.join(process.env.LOCALAPPDATA ?? '', `${APP_NAME.toLowerCase()}-shell-updater`);
  if (existsSync(installerStore)) rmSync(installerStore, { recursive: true, force: true });
  verifyAssembly();
  launchApp();
  verifyLaunchedFromInstallDir();
  console.log(`✓ reinstall 完成:${installDir}${flag('--pristine') ? '(pristine 用户态已清)' : ''}`);
};

if (command === 'verify') verify();
if (command === 'deploy') deploy();
if (command === 'reinstall') reinstall();
