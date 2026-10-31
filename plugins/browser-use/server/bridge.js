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
const headlessArgs = mode === 'builtin' ? ['--headless=new'] : []; // builtin=侧栏即唯一视图,无弹窗(2026-11-01 用户裁定)

// 常驻复用(2026-11-01 用户报障「每发一条消息弹一个浏览器」):run 收口 mcpClose 树杀 bridge,
// 浏览器若为其子进程即连坐=每消息起灭。两件保常驻:①browser detached 独立起(脱离桥的树,
// 树杀不连坐)②spawn 前先探 meta 实例:活着(CDP /json/version 应答)即不重启直接复用端点。
function probeAlive(meta) {
  try {
    const port = /:(\d+)\//.exec(meta.ws);
    if (port === null) return false;
    const r = spawnSync('node', ['-e', "fetch('http://127.0.0.1:" + port[1] + "/json/version',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { timeout: 3000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function writeMeta(ws, pid) {
  if (metaPath === undefined) return;
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({ ws, pid, mode, startedAt: Date.now() }));
  } catch { /* 尽力落盘 */ }
}

const existingMeta = metaPath !== undefined && fs.existsSync(metaPath)
  ? (() => { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return undefined; } })()
  : undefined;
if (existingMeta !== undefined && typeof existingMeta.ws === 'string' && probeAlive(existingMeta)) {
  // 复用:直接注端点给 server;server 退场不动浏览器(常驻,下条消息继续用)
  writeMeta(existingMeta.ws, existingMeta.pid ?? 0);
  const server = spawn(process.execPath, [serverJs, ...serverArgs, '--cdp-endpoint', existingMeta.ws], { stdio: 'inherit' });
  server.on('exit', () => process.exit(0));
  return;
}

const browser = spawn(exe, [...headlessArgs, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: true, // 常驻:脱离桥进程树(mcpClose 树杀 bridge/server 不连坐浏览器)
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
  writeMeta(m[1], browser.pid);
  browser.unref(); // 常驻:与桥解耦(mcpClose 树杀不连坐)
  const server = spawn(process.execPath, [serverJs, ...serverArgs, '--cdp-endpoint', m[1]], { stdio: 'inherit' });
  server.on('exit', () => process.exit(0)); // 浏览器不随杀(常驻,下条消息经 probeAlive 复用)
  browser.on('exit', () => { try { server.kill(); } catch { /* ignore */ } process.exit(0); });
});
browser.on('error', (e) => fail(`browser launch failed: ${e.message}`));
setTimeout(() => fail('DevTools endpoint not observed in 15s'), 15_000);
