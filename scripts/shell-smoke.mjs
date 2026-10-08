#!/usr/bin/env node
/**
 * H1-T4 壳冒烟门禁：electron 启动 → 窗口 ready-to-show → 有序退，以退出码判据。
 *
 * 判据（spec H §冒烟门禁）：主进程 --shell-smoke 分支在窗口首帧（ready-to-show）后
 * 有序收口 daemon 并 app.exit(0)；15s 主进程内守卫兜任何悬挂退 1。本脚本只做三件事：
 *   1. 前置检查构建产物四件在场（daemon 三件 + 壳主进程束 out/main.cjs；不在场不自动构建——stderr 提示命令，exit 1）；
 *   2. spawn `pnpm --filter sunshinex-shell exec electron . --shell-smoke`（cwd=仓根，stdio 继承）；
 *   3. 总超时 30s（超时杀进程树 → exit 1）；子进程退出码透传（0=过 / 非 0=败）。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 预检四件（resolveDaemonPaths 开发态形状 + 壳主进程束）：缺任一即红，附对应构建命令 */
const REQUIRED_ARTIFACTS = [
  { file: path.join(repoRoot, 'dist', 'serve', 'daemon.js'), build: 'pnpm build' },
  { file: path.join(repoRoot, 'dist', 'runtime.js'), build: 'pnpm build' },
  { file: path.join(repoRoot, 'dist-gui', 'index.html'), build: 'pnpm --dir gui run build' },
  { file: path.join(repoRoot, 'shell', 'out', 'main.cjs'), build: 'pnpm --filter sunshinex-shell run build' },
];

/** 外层总超时（ms）：正常路径窗口闪现即退（主进程内 15s 守卫先行），30s 只兜 spawn 层悬挂 */
const TOTAL_TIMEOUT_MS = 90_000;

const missing = REQUIRED_ARTIFACTS.filter((a) => !fs.existsSync(a.file));
if (missing.length > 0) {
  console.error('[shell-smoke] 缺少构建产物（先构建再跑门禁）:');
  for (const a of missing) {
    console.error(`  ${path.relative(repoRoot, a.file)}  <-  ${a.build}`);
  }
  process.exit(1);
}

// 直呼 electron 发行二进制（等价 `electron .`，cli.js 只做转发）——发布链曾现 pnpm exec
// bin 解析瞬态失败（ERR_PNPM "Command electron not found"，实跑已起、门禁误杀），关键门禁不经包管器。
const ELECTRON_EXE = path.join(repoRoot, 'shell', 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON_EXE)) {
  console.error(`[shell-smoke] 未找到 ${ELECTRON_EXE}（先 pnpm install + 保留 electron 二进制）`);
  process.exit(1);
}
const child = spawn(ELECTRON_EXE, ['.', '--shell-smoke'], {
  cwd: path.join(repoRoot, 'shell'),
  stdio: 'inherit',
  env: process.env,
  detached: process.platform !== 'win32',
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error('[shell-smoke] 总超时 30s，杀进程树，exit 1');
  if (process.platform === 'win32') {
    // shell:true 时直接子是 cmd.exe，须 taskkill /T 连带 electron 一并杀
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
  console.error('[shell-smoke] 启动失败:', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (timedOut) process.exit(1);
  if (code !== null) process.exit(code);
  // 非本脚本超时所引的信号终止（外部 kill 等）——按败
  console.error(`[shell-smoke] 子进程被信号终止: ${signal ?? 'unknown'}，exit 1`);
  process.exit(1);
});
