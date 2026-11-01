#!/usr/bin/env node
'use strict';
/**
 * browser-use 桥接入口(2026-11-01 用户裁定三形态单选 --mode):
 * - headless(默认):透明转发 server/index.js + 追加 --headless(Playwright 自起无头浏览器,存量行为)。
 * - default:解析系统默认浏览器 exe(Windows 注册表 https UserChoice→ProgId→command;兜底 chrome),
 *   带 --remote-debugging-port=0 启动 → stderr 解析 DevTools ws → 注 --cdp-endpoint 给真 server。
 * - builtin:同 default 但固定 Chrome/Edge + --headless=new(无弹窗,侧栏「浏览器」页签=唯一视图)。
 * 共用:
 * - 浏览器常驻(detached 脱离桥进程树;mcpClose 树杀 bridge/server 不连坐;server 退场不杀浏览器),
 *   spawn 前探 meta 实例(CDP /json/version 应答)活着即直接复用端点——每条消息一次 run 不再起灭。
 * - profile 残留锁自愈:强杀实例留 Singleton 系锁文件会让 Chrome 直接退出(exit 21 无 DevTools 行)
 *   ——启动前清锁;启动即退则清 profile 重试一次。
 * - isolated=true → 一次性临时 profile;否则 --user-data-dir(缺省持久目录由装配 dataDir 令牌落参)。
 * 两个 Windows/宿主陷阱(实测踩坑):
 * - 本文件所有 Windows 路径一律正斜杠——反斜杠经同步链路会被转义层吞掉('C:\\Program Files'落盘
 *   成'C:Program Files',候选路径全 miss 即 spawn chrome ENOENT)。
 * - 宿主可以是 **Electron 主进程**(daemon 在壳内)——process.execPath=electron.exe 而非 node,
 *   探活脚本外派 node/electron -e 全不可靠;探活必须用本进程原生 fetch(Chrome DevTools HTTP 面)。
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
// 非 headless 档:server 不自起浏览器——自起族旗标与 --cdp-endpoint 互斥,不剥即 server 参校验报错退出
const serverArgs = mode === 'headless'
  ? [...argv, '--headless']
  : argv.filter((a, i) => !['--browser', '--headless', '--executable-path'].includes(a) && argv[i - 1] !== '--browser' && argv[i - 1] !== '--executable-path');

if (mode === 'headless') {
  const child = spawn(process.execPath, [serverJs, ...serverArgs], { stdio: 'inherit' });
  child.on('exit', (c) => process.exit(c ?? 0));
  return;
}

function defaultBrowserExe() {
  if (process.platform !== 'win32') return 'chrome';
  const key = ['HKCU', 'Software', 'Microsoft', 'Windows', 'Shell', 'Associations', 'UrlAssociations', 'https', 'UserChoice'].join('\\');
  try {
    const progId = spawnSync('reg', ['query', key, '/v', 'ProgId'], { encoding: 'utf8' }).stdout;
    const pid = /REG_SZ\s+(\S+)/.exec(progId)?.[1];
    if (pid !== undefined) {
      const cmd = spawnSync('reg', ['query', 'HKCR\\' + pid + '\\shell\\open\\command'], { encoding: 'utf8' }).stdout;
      const m = /"([^"]+\.exe)"/i.exec(cmd) ?? new RegExp('([A-Za-z]:\\\\[^\\s"]+\\.exe)', 'i').exec(cmd);
      if (m !== null && fs.existsSync(m[1])) return m[1];
    }
  } catch { /* 注册表探测失败回落 */ }
  return 'chrome';
}

function fixedChrome() {
  const candidates = process.platform === 'win32'
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        (process.env.LOCALAPPDATA ?? 'C:/Users/none/AppData/Local') + '/Google/Chrome/Application/chrome.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* 换下一个 */ }
  }
  return 'chrome';
}

function writeMeta(ws, pid) {
  if (metaPath === undefined) return;
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({ ws, pid, mode, startedAt: Date.now() }));
  } catch { /* 尽力落盘 */ }
}

/** 探活(本进程原生 fetch 直打 DevTools HTTP 面;宿主可能=Electron 主进程,外派 execPath 不可靠) */
async function probeAlive(meta) {
  try {
    const port = /:(\d+)\//.exec(meta.ws);
    if (port === null) return false;
    const r = await fetch(`http://127.0.0.1:${port[1]}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  const exe = mode === 'default' ? defaultBrowserExe() : fixedChrome();
  const profile = isolated === true
    ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-browser-')), 'profile')
    : userDataDirArg ?? path.join(os.tmpdir(), 'sunshinex-browser-profile');
  const headlessArgs = mode === 'builtin' ? ['--headless=new'] : [];

  // 常驻复用:meta 实例活着即直接注端点,不重启
  const existingMeta = metaPath !== undefined && fs.existsSync(metaPath)
    ? (() => { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return undefined; } })()
    : undefined;
  if (existingMeta !== undefined && typeof existingMeta.ws === 'string' && (await probeAlive(existingMeta))) {
    writeMeta(existingMeta.ws, existingMeta.pid ?? 0);
    const server = spawn(process.execPath, [serverJs, ...serverArgs, '--cdp-endpoint', existingMeta.ws], { stdio: 'inherit' });
    server.on('exit', () => process.exit(0));
    return;
  }

  // 残留锁清理:强杀实例留 Singleton 系锁文件会让 Chrome 直接退出(exit 21 无 DevTools 行)
  function clearLocks(dir) {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
      try { fs.rmSync(path.join(dir, name), { force: true, recursive: true }); } catch { /* 尽力 */ }
    }
  }
  clearLocks(profile);

  let settled = false;
  let attempts = 0;
  const fail = (msg) => {
    if (settled) return;
    settled = true;
    process.stderr.write(`browser bridge: ${msg}\n`);
    process.exit(1);
  };

  function attempt() {
    attempts += 1;
    clearLocks(profile);
    const browser = spawn(exe, [...headlessArgs, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true, // 常驻:脱离桥进程树(mcpClose 树杀 bridge/server 不连坐浏览器)
    });
    browser.unref();
    browser.on('error', (e) => fail(`browser launch failed: ${e.message}`));
    browser.stderr.on('data', (d) => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
      if (m === null || settled) return;
      settled = true;
      writeMeta(m[1], browser.pid);
      const server = spawn(process.execPath, [serverJs, ...serverArgs, '--cdp-endpoint', m[1]], { stdio: 'inherit' });
      server.on('exit', () => process.exit(0)); // 浏览器不随杀(常驻,下条消息经 probeAlive 复用)
    });
    browser.on('exit', (code) => {
      if (settled) return;
      // 未打印 DevTools 即退出=profile 残留锁/损坏:清 profile 重试一次(仅一次,防循环)
      if (attempts < 2) {
        process.stderr.write('browser bridge: browser exited without DevTools endpoint — retrying with fresh profile\n');
        try { fs.rmSync(profile, { force: true, recursive: true }); } catch { /* 尽力 */ }
        attempt();
        return;
      }
      fail(`browser exited (code ${code}) without DevTools endpoint`);
    });
    // DevTools 行从未到且浏览器未退(极端挂死):15s 收口
    setTimeout(() => { if (!settled) fail('DevTools endpoint not observed in 15s'); }, 15000);
  }

  attempt();
}

main().catch((e) => {
  process.stderr.write(`browser bridge: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
