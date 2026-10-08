#!/usr/bin/env node
/**
 * H3-T3 打包态冒烟门禁：spawn shell/release/ 下 portable exe（--shell-smoke），退出码透传。
 *
 * 与 dev 态 scripts/shell-smoke.mjs 同判据（主进程 --shell-smoke 分支窗口首帧后有序收口退 0），
 * 但走打包链全量实证：asar 主进程束 + resources 三资源（app-dist daemon 束 / node-pty / dist-gui）。
 * portable 命名 = electron-builder `sunshinex X.Y.Z portable.exe`（含空格）——通配定位 *portable*.exe；
 * 多版本并存取 mtime 最新（幂等重跑不误旧产物）。portable 启动先自解压到临时目录，超时放宽至 60s。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(repoRoot, 'shell', 'release');

const isPortableExe = (f) => f.toLowerCase().includes('portable') && f.toLowerCase().endsWith('.exe');
const candidates = fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir).filter(isPortableExe) : [];

if (candidates.length === 0) {
  console.error(
    `[shell-dist-smoke] ${path.relative(repoRoot, releaseDir)} 下未找到 *portable*.exe——先跑 ` +
      `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ` +
      `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ ` +
      `pnpm shell:dist，exit 1`,
  );
  process.exit(1);
}
if (candidates.length > 1) {
  candidates.sort(
    (a, b) => fs.statSync(path.join(releaseDir, b)).mtimeMs - fs.statSync(path.join(releaseDir, a)).mtimeMs,
  );
}
const exe = path.join(releaseDir, candidates[0]);

/** 总超时（ms）：portable 自解压 + Electron 启动 + 首帧，正常几秒；60s 只兜悬挂 */
const TOTAL_TIMEOUT_MS = 60_000;

// exe 直 spawn（无 shell 拼装必要）；POSIX detached 建进程组（超时可整组 kill），
// win 下超时须 taskkill /T 连带 Electron 子进程树
const child = spawn(exe, ['--shell-smoke'], {
  cwd: path.dirname(exe),
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error('[shell-dist-smoke] 总超时 60s，杀进程树，exit 1');
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}, TOTAL_TIMEOUT_MS);
timer.unref?.();

child.on('error', (err) => {
  clearTimeout(timer);
  console.error('[shell-dist-smoke] 启动失败:', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (timedOut) process.exit(1);
  if (code !== null) process.exit(code);
  console.error(`[shell-dist-smoke] 子进程被信号终止: ${signal ?? 'unknown'}，exit 1`);
  process.exit(1);
});
