#!/usr/bin/env node
/**
 * GUI 桌面端部署脚本(2026-10-29):verify 验证 / deploy 渲染层推装 / reinstall 卸载重装,一条命令直达。
 *
 * 用法(仓库根执行):
 *   node scripts/deploy-gui.mjs verify              # gui typecheck(快速门禁;--tests 加跑全量 vitest)
 *   node scripts/deploy-gui.mjs deploy  [--dir ...] # 构建 gui → 推装 dist-gui → 重启应用(壳不变,日常改动用)
 *   node scripts/deploy-gui.mjs reinstall [--dir ...] [--setup ...]
 *                                                   # 全链:gui+壳构建→重打包 setup→卸载→装→启动(壳变更用)
 *
 * 参数:
 *   --dir <path>     桌面端安装目录(默认 D:\MyWorkSoftware\Sunshinex;须与首次安装路径一致,
 *                    NSIS /D 大小写不敏感但路径必须真实存在父目录)
 *   --setup <path>   安装包路径(reinstall 用,默认 shell/release/sunshinex-<ver>-setup.exe 取最新)
 *   --tests          verify 附带全量 vitest(既有基线红面见 CLAUDE.md,以基线对照为准)
 *   --no-build       deploy/reinstall 跳过构建,直接用现有产物
 *
 * 行为细则:
 *   - deploy:dist-gui 整目录轮换(旧→dist-gui.old 回滚点),重启前停 Sunshinex 进程,完成后
 *     ie4uinit 刷新图标缓存(exe 同路径替换后 Windows 缓存留白图标,轻量刷新即可)。
 *   - reinstall:静默卸载(Uninstall Sunshinex.exe /S)→ 残留清点 → 静默安装(/S /D=<dir>,
 *     /D 必须是最后一个参数)→ 启动;用户数据(%APPDATA%\sunshinex-shell)不受影响。
 *   - 壳变更(壳源码/新增 IPC)必须走 reinstall;纯 gui 改动走 deploy 即可(renderer 推装覆盖不到壳)。
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
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
  console.error('用法: node scripts/deploy-gui.mjs <verify|deploy|reinstall> [--dir <安装目录>] [--setup <安装包>] [--tests] [--no-build]');
  process.exit(2);
}

const installDir = path.resolve(opt('--dir') ?? 'D:\\MyWorkSoftware\\Sunshinex');
const installGui = path.join(installDir, 'resources', 'dist-gui');
const installExe = path.join(installDir, EXE_NAME);

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
  powershell(`Stop-Process -Name ${APP_NAME} -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2`);
};

const launchApp = () => {
  console.log('· 启动应用…');
  powershell(`Start-Process -FilePath "${installExe}" -WorkingDirectory "${installDir}"`);
  // Windows 图标缓存轻量刷新:exe 同路径反复替换后缓存留白图标(2026-10-29 实测),ie4uinit 重建即可
  powershell('ie4uinit.exe -show');
};

const latestSetup = () => {
  if (opt('--setup')) return opt('--setup');
  const releaseDir = path.join(SHELL_DIR, 'release');
  const setups = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter((f) => f.startsWith('sunshinex-') && f.endsWith('-setup.exe'))
    : [];
  if (setups.length === 0) {
    console.error('✗ shell/release 下无安装包;先跑 reinstall 的构建或手动提供 --setup');
    process.exit(1);
  }
  return path.join(releaseDir, setups[setups.length - 1]);
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
  pushDistGui();
  launchApp();
  console.log(`✓ deploy 完成:renderer 已推装至 ${installGui}`);
};

const reinstall = () => {
  if (!flag('--no-build')) {
    console.log('== reinstall: 全链构建(根 tsc → gui → 壳 esbuild)==');
    run('pnpm', ['run', 'build']);
    run('pnpm', ['--dir', 'gui', 'run', 'build']);
    run('pnpm', ['--filter', 'sunshinex-shell', 'run', 'build']);
    console.log('== reinstall: 重打包 setup(electron-builder,镜像 env 已设)==');
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
  launchApp();
  console.log(`✓ reinstall 完成:${installDir}`);
};

if (command === 'verify') verify();
if (command === 'deploy') deploy();
if (command === 'reinstall') reinstall();
