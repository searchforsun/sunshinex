#!/usr/bin/env node
'use strict';
/**
 * browser-use 桥接入口(2026-11-01 用户裁定三形态单选 --mode):
 * - headless(默认):透明转发 server/index.js + 追加 --headless(Playwright 自起无头浏览器,存量行为)。
 * - default:解析**系统默认浏览器** exe(Windows 注册表 https UserChoice→ProgId→command;其余平台
 *   兜底 xdg-open 设置探测失败回落 chrome),带 --remote-debugging-port=0 启动 → stderr 解析 DevTools
 *   ws → 注 --cdp-endpoint 给真 server(自动化附着系统默认浏览器本体)。
 * - builtin:同 default,但浏览器固定 Chrome/Edge(侧栏镜像档,GUI 按 --builtin-meta 指向的 JSON
 *   直连同一浏览器 screencast 镜像+点击)。
 * 共用:--isolated=true → 一次性临时 profile;否则 profile 用 --user-data-dir(缺省持久目录由装配
 * {dataDir} 令牌落参)。浏览器生命周期跟随 server(server 退场即杀浏览器,防孤儿窗口)。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

const mode = takeWithArg('--mode') ?? 'headless';
const metaPath = takeWithArg('--builtin-meta');
const userDataDirArg = takeWithArg('--user-data-dir');
const isolated = hasFlag('--isolated');
const serverJs = path.join(__dirname, 'index.js');
// 非 headless 档:server 不自起浏览器——自起族旗标(--browser/--headless/--executable-path)与
// --cdp-endpoint 互斥,不剥即 server 参校验报错退出(插件「自动关闭」根因之一)
const serverArgs = mode === 'headless' ? [...argv] : argv.filter((a, i) => !['--browser', '--headless', '--executable-path'].includes(a) && argv[i - 1] !== '--browser' && argv[i - 1] !== '--executable-path');

// headless 档:server 自起浏览器,仅需补旗标(缺省形态=存量行为)
if (mode === 'headless') {
  if (!serverArgs.includes('--headless')) serverArgs.push('--headless');
  const child = spawn(process.execPath, [serverJs, ...serverArgs], { stdio: 'inherit' });
  child.on('exit', (c) => process.exit(c ?? 0));
  return;
}

// default/builtin 档:桥自起可见浏览器,CDP 注给 server
function defaultBrowserExe() {
  if (process.platform !== 'win32') return 'chrome';
  try {
    const progId = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { encoding: 'utf8' }).stdout;
    const pid = /REG_SZ\s+(\S+)/.exec(progId)?.[1];
    if (pid !== undefined) {
      const cmd = spawnSync('reg', ['query', `HKCR\\${pid}\\shell\\open\\command`], { encoding: 'utf8' }).stdout;
      const m = /"([^"]+\.exe)"/i.exec(cmd) ?? /([A-Za-z]:\\[^\s"]+\.exe)/i.exec(cmd);
      if (m !== null && fs.existsSync(m[1])) return m[1];
    }
  } catch { /* 注册表探测失败回落 */ }
  return 'chrome';
}

function fixedChrome() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* 换下一个 */ }
  }
  return 'chrome';
}

const exe = mode === 'default' ? defaultBrowserExe() : fixedChrome();
const profile = isolated === true
  ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-browser-')), 'profile')
  : userDataDirArg ?? path.join(os.tmpdir(), 'sunshinex-browser-profile'); // 持久缺省:登录态保留
const browser = spawn(exe, ['--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let settled = false;
const fail = (msg) => {
  if (settled) return;
  settled = true;
  process.stderr.write(`browser bridge: ${msg}\n`);
  try { browser.kill(); } catch { /* ignore */ }
  process.exit(1);
};
browser.stderr.on('data', (d) => {
  const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
  if (m === null || settled) return;
  settled = true;
  if (metaPath !== undefined) {
    try {
      fs.mkdirSync(path.dirname(metaPath), { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify({ ws: m[1], pid: browser.pid, mode, startedAt: Date.now() }));
    } catch { /* 尽力落盘 */ }
  }
  const server = spawn(process.execPath, [serverJs, ...serverArgs, '--cdp-endpoint', m[1]], { stdio: 'inherit' });
  const killBrowser = () => { try { spawnSync('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { browser.kill('SIGKILL'); } catch { /* ignore */ } } };
  server.on('exit', () => { killBrowser(); process.exit(0); });
  browser.on('exit', () => { try { server.kill(); } catch { /* ignore */ } process.exit(0); });
});
browser.on('error', (e) => fail(`browser launch failed: ${e.message}`));
setTimeout(() => fail('DevTools endpoint not observed in 15s'), 15_000);
