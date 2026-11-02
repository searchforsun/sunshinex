#!/usr/bin/env node
'use strict';
/**
 * browser-use 桥接入口(2026-11-01 用户裁定三形态单选 --mode):
 * - headless(默认):透明转发 server/index.js + 追加 --headless(Playwright 自起无头浏览器,存量行为)。
 * - default:解析系统默认浏览器 exe(Windows 注册表 https UserChoice→ProgId→command;兜底 chrome)。
 * - builtin:同 default 但固定 Chrome/Edge + --headless=new(无弹窗,侧栏「浏览器」页签=唯一视图)。
 * default/builtin 主路径(2026-11-01「exit 21 静默秒退」终案):经 **WMI Win32_Process.Create** 拉起
 * + 固定空闲端口 + 轮询 CDP 就绪——应用本体=Electron/Chromium,其进程身处 Job 对象,直派生(含
 * detached/PS Start-Process)的 Chrome 困在继承的 Job 里,沙箱初始化失败=秒退且零输出;WMI 服务在
 * Job 外,经它创建的进程不继承 Job,Chrome 沙箱正常。
 * 共用:
 * - 浏览器常驻(WMI 父进程即刻退出,浏览器成孤儿存活;mcpClose 树杀 bridge/server 不连坐),
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
// server 工作目录=输出目录(<项目 data>/plugins/browser-use/output):Playwright MCP 把显式文件名
// (如 browser_take_screenshot filename)解析到工作区根=cwd,cwd 若是插件目录,文件落进安装目录、
// 模型找不到;配合 --file-paths absolute,结果文本恒报绝对路径
const outIdx = argv.indexOf('--output-dir');
const serverCwd = outIdx >= 0 && argv[outIdx + 1] !== undefined ? argv[outIdx + 1] : process.cwd();
try { fs.mkdirSync(serverCwd, { recursive: true }); } catch { /* 尽力:失败时 spawn 报错可见 */ }
// 非 headless 档:server 不自起浏览器——自起族旗标与 --cdp-endpoint 互斥,不剥即 server 参校验报错退出
const serverArgs = mode === 'headless'
  ? [...argv, '--headless']
  : argv.filter((a, i) => !['--browser', '--headless', '--executable-path'].includes(a) && argv[i - 1] !== '--browser' && argv[i - 1] !== '--executable-path');

if (mode === 'headless') {
  const child = spawn(process.execPath, [serverJs, ...serverArgs], { stdio: 'inherit', cwd: serverCwd });
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

function writeMeta(ws, pid, extra) {
  // meta 是 builtin 档专用约定(侧栏镜像端点发现/退出收割都认它)——default 档拉起的是用户
  // 自己的可见浏览器,写了会诱导 GUI 镜像/收割挂错实例
  if (metaPath === undefined || mode !== 'builtin') return;
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({ ws, pid, mode, startedAt: Date.now(), ...extra }));
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
  // M2 融合档(2026-11-01 用户裁定「插件打开的也是普通页签」):builtin 档不再自起 Chrome——
  // meta 由 daemon(壳进程)周期落盘,ws=壳内 CDP facade(只暴露侧栏 webview 的附加面);
  // 探活成功即 spawn server 挂 facade,模型导航/点击的就是用户眼前的页签
  if (mode === 'builtin') {
    const meta = metaPath !== undefined && fs.existsSync(metaPath)
      ? (() => { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return undefined; } })()
      : undefined;
    if (meta !== undefined && typeof meta.ws === 'string' && (await probeAlive(meta))) {
      writeMeta(meta.ws, meta.pid ?? 0, { kind: 'shell' });
          const server = spawn(process.execPath, [serverJs, ...serverArgs, '--cdp-endpoint', meta.ws], { stdio: 'inherit', cwd: serverCwd });
      server.on('exit', () => process.exit(0));
      return;
    }
    process.stderr.write('browser bridge: builtin facade unavailable' + String.fromCharCode(10));
    process.exit(1);
  }
  const exe = mode === 'default' ? defaultBrowserExe() : fixedChrome();
  const profile = isolated === true
    ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-browser-')), 'profile')
    : userDataDirArg ?? path.join(os.tmpdir(), 'sunshinex-browser-profile');
  const headlessArgs = mode === 'builtin' ? ['--headless=new'] : [];

  // 常驻复用:meta 实例活着即直接注端点,不重启
  const existingMeta = metaPath !== undefined && fs.existsSync(metaPath)
    ? (() => { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return undefined; } })()
    : undefined;
  // 常驻复用:meta 实例活着即直接注端点,不重启——**仅 builtin 档**(用户裁定 2026-11-01「选了
  // 默认浏览器还走内置」根修:default 档语义=拉起用户自己的可见浏览器,复用块原先不分校形,
  // 内置 Chrome 活着就把它挂上=default 档永远走内置;default 档不读不写 builtin meta)
  if (mode === 'builtin' && existingMeta !== undefined && typeof existingMeta.ws === 'string' && (await probeAlive(existingMeta))) {
    writeMeta(existingMeta.ws, existingMeta.pid ?? 0);
      const server = spawn(process.execPath, [serverJs, ...serverArgs, '--cdp-endpoint', existingMeta.ws], { stdio: 'inherit', cwd: serverCwd });
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
    const args = [...headlessArgs, '--remote-debugging-port=' + port, '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + profile, 'about:blank'];
    // WMI Win32_Process.Create:经系统服务拉起(脱离应用 Job,Chrome 沙箱正常);单引号 PS 字符串
    // (内部双引号字面量合法;值内单引号 doubling)。非 Win32 直派生(POSIX 无 Job 困境)
    let pid = 0;
    if (process.platform === 'win32') {
      const cl = '"' + exe + '" ' + args.join(' ');
      const q = (a) => "'" + a.replace(/'/g, "''") + "'";
      const psCmd = '(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=' + q(cl) + '}).ProcessId';
      const ps = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(psCmd, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 });
      pid = parseInt((ps.stdout ?? '').trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) fail('WMI launch failed: ' + ((ps.stderr ?? '') + (ps.stdout ?? '')).slice(-300) || 'no pid');
    } else {
      const b = spawn(exe, args, { stdio: 'ignore', detached: true });
      b.unref();
      pid = b.pid;
    }
    // 轮询 CDP 就绪(最多 20s);就绪即从 /json/version 取**完整浏览器端点**(带 GUID——
    // WMI 路径无 stderr 可解析,缺 GUID 的裸地址 Playwright connect 会 404,实测踩坑)
    let ws = '';
    for (let i = 0; i < 40; i += 1) {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          const v = await r.json();
          if (typeof v.webSocketDebuggerUrl === 'string' && v.webSocketDebuggerUrl !== '') { ws = v.webSocketDebuggerUrl; break; }
        }
      } catch { /* 未就绪,继续轮询 */ }
      await new Promise((r2) => setTimeout(r2, 500));
    }
    if (!alive || ws === '') fail('CDP not ready in 20s (port ' + port + ')');
    settled = true;
    alive = false;
    writeMeta(ws, pid);
      const server = spawn(process.execPath, [serverJs, ...serverArgs, '--cdp-endpoint', ws], { stdio: 'inherit', cwd: serverCwd });
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
