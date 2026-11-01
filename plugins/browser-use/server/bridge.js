#!/usr/bin/env node
'use strict';
/**
 * browser-use 桥接入口(2026-11-01 用户裁定三形态单选 --mode):
 * - headless(默认):透明转发 server/index.js + 追加 --headless(Playwright 自起无头浏览器,存量行为)。
 * - default:解析系统默认浏览器 exe(Windows 注册表 https UserChoice→ProgId→command;兜底 chrome)。
 * - builtin:同 default 但固定 Chrome/Edge + --headless=new(无弹窗,侧栏「浏览器」页签=唯一视图)。
 * default/builtin 主路径(2026-11-01「连不上 CDP」终稿):powershell Start-Process 隐藏启动 +
 * 固定空闲端口 + 轮询 CDP 就绪——不经桥的管道/stderr 解析(宿主=GUI 进程时 detached+pipe 派生
 * 曾被静默秒退 exit 21 stderr 全空,powershell=全新进程上下文,免疫父进程一切句柄/环境语义)。
 * 共用:
 * - 浏览器常驻(powershell 父进程即刻退出,浏览器成孤儿存活;mcpClose 树杀 bridge/server 不连坐),
 *   spawn 前探 meta 实例(CDP /json/version 应答)活着即直接复用端点——每条消息一次 run 不再起灭。
 * - profile 残留锁自愈:启动前清 Singleton 系锁文件;CDP 20s 未就绪则清 profile 重试一次。
 * - isolated=true → 一次性临时 profile;否则 --user-data-dir(缺省持久目录由装配 dataDir 令牌落参)。
 * - Windows 路径一律正斜杠(Node 全兼容;反斜杠经同步链路会被转义层吞掉,实测踩坑)。
 * - 宿主可能是 Electron 主进程(execPath=electron.exe):探活/轮询一律本进程原生 fetch,不外派。
 */
const { spawn, spawnSync } = require('child_process');
const net = require('net');
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

async function probeAlive(meta) {
  try {
    const port = /:(\d+)\//.exec(meta.ws);
    if (port === null) return false;
    const r = await fetch('http://127.0.0.1:' + port[1] + '/json/version', { signal: AbortSignal.timeout(1500) });
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

  // 残留锁清理:强杀实例留 Singleton 系锁文件会让 Chrome 直接退出
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.rmSync(path.join(profile, name), { force: true, recursive: true }); } catch { /* 尽力 */ }
  }

  let settled = false;
  let alive = true;
  const fail = (msg) => {
    if (settled) return;
    settled = true;
    alive = false;
    process.stderr.write('browser bridge: ' + msg + '\n');
    process.exit(1);
  };

  // 空闲端口单点(net listen(0) 占位即放,竞窗极小;轮询面兜未就绪)
  function freePort() {
    return new Promise((resolve, reject2) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
      srv.on('error', reject2);
    });
  }

  let attempts = 0;
  async function attempt() {
    attempts += 1;
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
      try { fs.rmSync(path.join(profile, name), { force: true, recursive: true }); } catch { /* 尽力 */ }
    }
    const port = await freePort();
    const args = [...headlessArgs, '--remote-debugging-port=' + port, '--no-first-run', '--no-default-browser-check', '--user-data-dir="' + profile + '"', 'about:blank'];
    // ArgumentList 单串形态:exe 引号包起,flags 原样(profile 带空格由引号承载)
    const argLine = '"' + exe + '" ' + args.join(' ');
    // ArgumentList 用 PS 单引号数组(值内单引号 doubling;规避反斜杠/双引号转义坑)
    const q = (a) => "'" + a.replace(/'/g, "''") + "'";
    const psArgs = [exe, ...args].map(q).join(',');
    const psCmd = '(Start-Process -FilePath ' + psArgs[0] + ' -ArgumentList @(' + psArgs + ') -WindowStyle Hidden -PassThru).Id';
    const psB64 = Buffer.from(psCmd, 'utf16le').toString('base64');
    const ps = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', psB64], { encoding: 'utf8', timeout: 15000 });
    const pid = parseInt((ps.stdout ?? '').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) fail('powershell launch failed: ' + ((ps.stderr ?? '') + (ps.stdout ?? '')).slice(-300) || 'no pid');
    // 轮询 CDP 就绪(最多 20s)
    let ws = '';
    for (let i = 0; i < 40; i += 1) {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) });
        if (r.ok) { ws = 'ws://127.0.0.1:' + port + '/devtools/browser/'; break; }
      } catch { /* 未就绪,继续轮询 */ }
      await new Promise((r2) => setTimeout(r2, 500));
    }
    if (!alive || ws === '') fail('CDP not ready in 20s (port ' + port + '); powershell stderr: ' + ((ps.stderr ?? '') || '(empty)'));
    settled = true;
    alive = false;
    writeMeta(ws, pid);
    const server = spawn(process.execPath, [serverJs, ...serverArgs, '--cdp-endpoint', ws], { stdio: 'inherit' });
    server.on('exit', () => process.exit(0)); // 浏览器常驻不随杀(下条消息经 probeAlive 复用)
  }

  const run = async () => {
    await attempt();
    if (!alive) return; // 失败面已收口
    // 重试一次(CDP 未就绪=残留锁/损坏):清 profile 换新再来
    if (attempts < 2) {
      try { fs.rmSync(profile, { force: true, recursive: true }); } catch { /* 尽力 */ }
      await run();
    }
  };
  await run().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}

main().catch((e) => {
  process.stderr.write('browser bridge: ' + (e instanceof Error ? e.message : String(e)) + '\n');
  process.exit(1);
});
