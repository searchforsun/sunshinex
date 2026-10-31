#!/usr/bin/env node
'use strict';
/**
 * browser-use 桥接入口(2026-11-01 用户裁定「内置侧栏浏览器」档):plugin.json 的 command 指向本桥,
 * 默认形态透明转发 server/index.js(参数原样);`--builtin` 形态先起一个有头 Chromium
 * (--remote-debugging-port=0,stderr 解析 DevTools ws 地址),再把 `--cdp-endpoint <ws>` 注给
 * 真 server——Playwright 附着其上自动化,GUI 侧栏「内置浏览器」页按 --builtin-meta 指向的
 * JSON(cd p ws 地址)直连同一浏览器做 screencast 镜像+点击,两眼同一只浏览器。
 * Chromium 生命周期跟随 server:server 退场即杀浏览器(防孤儿窗口)。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const takeWithArg = (name) => {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const hasFlag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};

const builtin = hasFlag('--builtin');
const metaPath = takeWithArg('--builtin-meta');
const serverJs = path.join(__dirname, 'index.js');

if (!builtin) {
  const child = spawn(process.execPath, [serverJs, ...argv], { stdio: 'inherit' });
  child.on('exit', (c) => process.exit(c ?? 0));
  return;
}

// ---- builtin 档:起浏览器 → 注 cdp-endpoint → 落 meta ----
function findChrome() {
  const candidates = process.env.PROCESSOR_ARCHITECTURE !== undefined && process.platform === 'win32'
    ? [
        path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* 探测失败换下一个 */ }
  }
  return 'chrome'; // PATH 兜底
}

const chromePath = findChrome();
const profileDir = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'sunshinex-builtin-')), 'profile');
const chrome = spawn(chromePath, ['--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profileDir}`, 'about:blank'], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let wsUrl;
let settled = false;
const fail = (msg) => {
  if (settled) return;
  settled = true;
  process.stderr.write(`builtin bridge: ${msg}\n`);
  try { chrome.kill(); } catch { /* ignore */ }
  process.exit(1);
};
chrome.stderr.on('data', (d) => {
  const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
  if (m === null || settled) return;
  settled = true;
  wsUrl = m[1];
  if (metaPath !== undefined) {
    try {
      fs.mkdirSync(path.dirname(metaPath), { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify({ ws: wsUrl, pid: chrome.pid, startedAt: Date.now() }));
    } catch { /* 尽力落盘 */ }
  }
  const server = spawn(process.execPath, [serverJs, ...argv, '--cdp-endpoint', wsUrl], { stdio: 'inherit' });
  const killChrome = () => { try { spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { chrome.kill('SIGKILL'); } catch { /* ignore */ } } };
  server.on('exit', () => { killChrome(); process.exit(0); });
  chrome.on('exit', () => { try { server.kill(); } catch { /* ignore */ } process.exit(0); });
});
chrome.on('error', (e) => fail(`chrome launch failed: ${e.message}`));
setTimeout(() => fail('chrome DevTools endpoint not observed in 15s'), 15_000);
