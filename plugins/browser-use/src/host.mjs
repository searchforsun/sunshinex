/**
 * browser-use 浏览器宿主(2026-11-03 浏览器状态按会话隔离;业界同构:一个浏览器进程 + 每会话一个
 * BrowserContext,持久化走每会话状态文件——agent-browser --restore / Browserbase Contexts 同法)。
 *
 * 一个宿主进程服务本环境的全部会话:Streamable HTTP MCP,每个会话一条 MCP 连接(查询参数带
 * key=浏览器键/seat=页签座位/dataDir=项目数据目录),经 @playwright/mcp createConnection(config,
 * contextGetter) 复用 Playwright MCP 全部工具,contextGetter 返回该会话专属上下文:
 * - builtin(桌面):connectOverCDP 到壳内 facade 的会话端点 /session/<key>——只见该会话分区
 *   persist:sx-<key> 的侧栏 webview,持久化由 Electron 分区承担(含 IndexedDB)。
 * - default(serve)/headless(TUI):本进程启动一个浏览器,每会话 newContext({storageState}),
 *   Cookie/本地存储每 30s 与关闭时落 <dataDir>/plugins/browser-use/state/<key>.json。
 * 输出文件按会话分目录:<dataDir>/plugins/browser-use/output/<key>/。
 * 生命周期:父进程(daemon/CLI)经 stdin 管道持有,管道断开即保存全部状态并退出。
 * 启动应答:stdout 首行 JSON {"port":N}。仅绑 127.0.0.1,Authorization: Bearer <token> 鉴权。
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createConnection } from '@playwright/mcp';
import { chromium } from 'playwright';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const MODE = arg('--mode', 'headless');
const TOKEN = arg('--token', '');
const AUTOSAVE_MS = 30_000;

/** 系统默认浏览器(Windows https UserChoice→ProgId→command);非 Chromium 系回落 Chrome 渠道 */
function defaultBrowserLaunch() {
  if (process.platform === 'win32') {
    const key = ['HKCU', 'Software', 'Microsoft', 'Windows', 'Shell', 'Associations', 'UrlAssociations', 'https', 'UserChoice'].join('\\');
    try {
      const progId = spawnSync('reg', ['query', key, '/v', 'ProgId'], { encoding: 'utf8', windowsHide: true }).stdout;
      const pid = /REG_SZ\s+(\S+)/.exec(progId)?.[1];
      if (pid !== undefined) {
        const cmd = spawnSync('reg', ['query', 'HKCR\\' + pid + '\\shell\\open\\command'], { encoding: 'utf8', windowsHide: true }).stdout;
        const m = /"([^"]+\.exe)"/i.exec(cmd);
        if (m !== null && fs.existsSync(m[1]) && /chrome|msedge|brave|vivaldi|chromium/i.test(path.basename(m[1]))) return { executablePath: m[1] };
      }
    } catch { /* 注册表探测失败回落 */ }
  }
  return { channel: 'chrome' };
}

let sharedBrowser;
async function launchedBrowser() {
  if (sharedBrowser === undefined) {
    const opts = MODE === 'default' ? { headless: false, ...defaultBrowserLaunch() } : { headless: true, channel: 'chrome' };
    sharedBrowser = chromium.launch(opts).catch((e) => { sharedBrowser = undefined; throw e; });
  }
  return sharedBrowser;
}

/** 每浏览器键一个上下文条目(同一会话多条 MCP 连接共享);引用计数归零即保存并释放 */
const entries = new Map();
const statePath = (dataDir, key) => path.join(dataDir, 'plugins', 'browser-use', 'state', `${key}.json`);

async function saveState(entry) {
  if (entry.statePath === undefined || entry.context === undefined) return;
  try {
    fs.mkdirSync(path.dirname(entry.statePath), { recursive: true });
    await entry.context.storageState({ path: entry.statePath });
  } catch { /* 上下文已关/浏览器已退:尽力而为 */ }
}

function acquire(key, seat, dataDir, cdp) {
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = { refs: 0, context: undefined, pending: undefined, timer: undefined, statePath: MODE === 'builtin' ? undefined : statePath(dataDir, key), cdpBrowser: undefined };
    entries.set(key, entry);
  }
  entry.refs += 1;
  const e = entry;
  const getter = async () => {
    if (e.context !== undefined) return e.context;
    if (e.pending === undefined) {
      e.pending = (async () => {
        if (MODE === 'builtin') {
          if (!cdp) throw new Error('built-in browser is not available (desktop app sidebar not ready)');
          e.cdpBrowser = await chromium.connectOverCDP(`${cdp}/session/${encodeURIComponent(key)}?seat=${encodeURIComponent(seat)}`, { timeout: 10_000 });
          return e.cdpBrowser.contexts()[0];
        }
        const browser = await launchedBrowser();
        const ctx = await browser.newContext({
          viewport: MODE === 'default' ? null : { width: 1280, height: 720 },
          ...(e.statePath !== undefined && fs.existsSync(e.statePath) ? { storageState: e.statePath } : {}),
        });
        e.timer = setInterval(() => void saveState(e), AUTOSAVE_MS);
        return ctx;
      })();
    }
    try {
      e.context = await e.pending;
      e.context.on('close', () => { e.context = undefined; e.pending = undefined; });
      return e.context;
    } catch (err) {
      e.pending = undefined;
      throw err;
    }
  };
  const release = async () => {
    e.refs -= 1;
    if (e.refs > 0) return;
    entries.delete(key);
    clearInterval(e.timer);
    await saveState(e);
    if (MODE === 'builtin') await e.cdpBrowser?.close().catch(() => {}); // CDP 连接只断开,不关应用
    else await e.context?.close().catch(() => {});
  };
  return { getter, release };
}

const transports = new Map();
const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(raw === '' ? undefined : JSON.parse(raw)); } catch { resolve(undefined); } });
});

const server = http.createServer(async (req, res) => {
  try {
    if (TOKEN !== '' && req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const sid = req.headers['mcp-session-id'];
    let t = typeof sid === 'string' ? transports.get(sid) : undefined;
    if (t === undefined) {
      if (req.method !== 'POST' || body?.method !== 'initialize') {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'unknown or missing MCP session' }, id: null }));
        return;
      }
      const key = url.searchParams.get('key') || `anon-${randomUUID().slice(0, 8)}`;
      const seat = url.searchParams.get('seat') ?? '';
      const dataDir = url.searchParams.get('dataDir') || process.cwd();
      const cdp = url.searchParams.get('cdp') ?? '';
      const { getter, release } = acquire(key, seat, dataDir, cdp);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId !== undefined) transports.delete(transport.sessionId);
        void release();
      };
      const outputDir = path.join(dataDir, 'plugins', 'browser-use', 'output', key);
      fs.mkdirSync(outputDir, { recursive: true });
      const conn = await createConnection({
        outputDir,
        filePaths: 'absolute',
        capabilities: ['testing'], // 断言族常开(技能文档依赖;能力组不再对用户暴露配置)
        allowUnrestrictedFileAccess: true,
        // 不设 browser.isolated:contextGetter 模式下 isolated 会让 Playwright 再 newContext(不支持);
        // 隔离已由 getter 按会话返回专属上下文承担
      }, getter);
      // 显式 filename 按「工作区根」解析,根取自 MCP 客户端 roots(缺省=宿主进程 cwd,全会话共用)——
      // 本连接对 Playwright 声明根=本会话输出目录,截图/快照等显式命名文件同落此处
      conn.getClientCapabilities = () => ({ roots: {} });
      conn.listRoots = async () => ({ roots: [{ uri: pathToFileURL(outputDir).href }] });
      await conn.connect(transport);
      t = transport;
    }
    await t.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(e?.message ?? e) }, id: null }));
  }
});

async function shutdown() {
  for (const e of entries.values()) { clearInterval(e.timer); await saveState(e); }
  try { await (await sharedBrowser)?.close(); } catch { /* 尽力 */ }
  process.exit(0);
}
process.stdin.on('end', () => void shutdown());
process.stdin.on('error', () => void shutdown());
process.stdin.resume();
process.on('SIGTERM', () => void shutdown());

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});
