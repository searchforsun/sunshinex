#!/usr/bin/env node
/**
 * 安装包冒烟门禁（H3→v2：NSIS 单安装包，用户裁定合成一个安装包）：
 *   setup.exe /S /D=<tmp>（NSIS 静默装，/D 必须末参且路径无空格不引号）
 *   → 轮询 <tmp>/sunshinex.exe 就位（≤120s）
 *   → 运行 sunshinex.exe --shell-smoke（启动→窗口就绪→有序退，退出码判）
 * 退出码：0=过；1=缺产物/静默装失败/超时/冒烟非零。
 * win-only 门（NSIS /S 语义）；产物定位取 mtime 最新（多版本共存时）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'shell', 'release');
const INSTALL_TIMEOUT_MS = 120_000;
const SMOKE_TIMEOUT_MS = 60_000;
const MIRRORS_HINT =
  'ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ pnpm shell:dist';

const die = (msg) => {
  console.error(`dist-smoke: ${msg}`);
  process.exit(1);
};

// 1) 定位最新 setup.exe（release/ 下 sunshinex-<ver>-setup.exe，多版本取 mtime 最新）
if (!fs.existsSync(RELEASE)) die(`release/ 不存在（${RELEASE}）——先构建：${MIRRORS_HINT}`);
const setups = fs
  .readdirSync(RELEASE)
  .filter((f) => /^sunshinex-[\d.]+-setup\.exe$/i.test(f))
  .map((f) => ({ f, mtime: fs.statSync(path.join(RELEASE, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
if (setups.length === 0) die(`release/ 未找到 sunshinex-<ver>-setup.exe——先构建：${MIRRORS_HINT}`);
const SETUP = path.join(RELEASE, setups[0].f);
console.log(`dist-smoke: 安装包 ${setups[0].f}（${Math.round(fs.statSync(SETUP).size / 1024 / 1024)}MB）`);

// 2) 静默装到临时目录（/D 路径必须无空格不引号——含空格即 fail-fast 提示，不静默错装）
const TARGET = path.join(RELEASE, '.smoke-install');
if (TARGET.includes(' ')) die(`静默装目录路径含空格（NSIS /D 限制）：${TARGET}`);
fs.rmSync(TARGET, { recursive: true, force: true });
console.log(`dist-smoke: 静默装 → ${TARGET}`);
const inst = spawnSync(SETUP, ['/S', `/D=${TARGET}`], { encoding: 'utf8', windowsHide: true, timeout: INSTALL_TIMEOUT_MS });
if (inst.error) die(`静默装执行失败：${inst.error.message}`);

// 3) 轮询安装产物就位（NSIS /S 返回后写盘可能有瞬态滞后；electron-builder 应用主 exe = productName.exe）
const APP = path.join(TARGET, 'sunshinex.exe');
const pollStart = Date.now();
while (!fs.existsSync(APP)) {
  if (Date.now() - pollStart > INSTALL_TIMEOUT_MS) {
    die(`静默装后未出现 ${APP}（超时 ${INSTALL_TIMEOUT_MS / 1000}s）——安装器异常或产物布局变更`);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
console.log('dist-smoke: 安装就位，运行冒烟（--shell-smoke）');

// 4) 运行安装产物冒烟（退出码透传；win32 树杀超时兜底）
const child = spawn(APP, ['--shell-smoke'], { stdio: 'inherit', windowsHide: false });
const timer = setTimeout(() => {
  console.error(`dist-smoke: 冒烟超时 ${SMOKE_TIMEOUT_MS / 1000}s，终止进程树`);
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  process.exit(1);
}, SMOKE_TIMEOUT_MS);
child.on('error', (e) => {
  clearTimeout(timer);
  die(`冒烟进程启动失败：${e.message}`);
});
child.on('close', (code, signal) => {
  clearTimeout(timer);
  // 清理临时安装目录（best-effort；失败不阻断门禁——release/ 整体 gitignored）
  fs.rmSync(TARGET, { recursive: true, force: true });
  if (code !== null) {
    if (code === 0) {
      console.log('dist-smoke: 通过（静默装→安装产物冒烟 退出码 0）');
      process.exit(0);
    }
    die(`安装产物冒烟退出码 ${code}`);
  }
  die(`安装产物冒烟被信号终止：${signal}`);
});
