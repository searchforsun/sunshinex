import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import type { McpServerConfig } from '../types';

/** 内置插件单进程宿主(2026-11-03):每个进程(daemon/CLI)每个插件只起一个宿主,全部会话经 HTTP
 *  各连一条 MCP 连接,会话键/项目数据目录随连接 URL 下发,宿主按连接隔离会话态——
 *  - browser-use:server/host.js(每会话专属浏览器上下文,状态按会话持久)
 *  - computer-use:server/index.js --http(桌面共享;每会话「最近截图坐标系」与截图目录隔离)
 *  宿主 stdin 管道由本进程持有,进程退出即宿主收尾退出。 */
export type BrowserHostMode = 'builtin' | 'default' | 'headless';

/** 浏览器插件 server 名(manifest mcpServers 键) */
export const BROWSER_SERVER_NAME = 'browser-use';

/** 单进程宿主化的插件 server(manifest mcpServers 键)→ 宿主启动脚本与参数 */
const HOSTED: Record<string, { script: string; args: () => string[] }> = {
  [BROWSER_SERVER_NAME]: { script: path.join('server', 'host.js'), args: () => ['--mode', browserHostMode()] },
  'computer-use': { script: path.join('server', 'index.js'), args: () => ['--http'] },
};

export function isHostedServer(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HOSTED, name);
}

/** 运行环境→浏览器形态(用户不可选):桌面壳(daemon 在 Electron 主进程)=内置侧栏;
 *  sunshinex serve(网页端)=系统默认浏览器;其余(TUI/CLI)=无头 */
export function browserHostMode(): BrowserHostMode {
  if (process.versions.electron !== undefined) return 'builtin';
  if (process.env.SUNSHINEX_HOST === 'serve') return 'default';
  return 'headless';
}

/** 宿主启动上限:超时视为失败(本轮不挂浏览器工具,下轮重试) */
const HOST_START_TIMEOUT_MS = 10_000;

const hosts = new Map<string, Promise<{ port: number; token: string }>>();

function startHost(name: string, pluginDir: string): Promise<{ port: number; token: string }> {
  const token = randomBytes(16).toString('hex');
  const spec = HOSTED[name]!;
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(pluginDir, spec.script), ...spec.args(), '--token', token], {
      cwd: pluginDir,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let settled = false;
    const fail = (msg: string): void => {
      if (settled) return;
      settled = true;
      hosts.delete(name);
      child.kill();
      reject(new Error(`${name} host failed to start: ${msg}`));
    };
    const timer = setTimeout(() => fail(`no response within ${HOST_START_TIMEOUT_MS}ms`), HOST_START_TIMEOUT_MS);
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0 || settled) return;
      try {
        const port = (JSON.parse(buf.slice(0, nl)) as { port?: unknown }).port;
        if (typeof port !== 'number') throw new Error('bad handshake');
        settled = true;
        clearTimeout(timer);
        resolve({ port, token });
      } catch (e) {
        clearTimeout(timer);
        fail(e instanceof Error ? e.message : String(e));
      }
    });
    child.on('error', (e) => { clearTimeout(timer); fail(e.message); });
    // 宿主退出(崩溃/被杀):清缓存,下次装配重启(端口变→连接签名变→宿主侧会话重连)
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled) fail(`exited with code ${code}`);
      else hosts.delete(name);
    });
    child.unref();
    // stdio 流运行时有 unref(Node 计数面)但 @types/node 的流类型未声明——窄断言+可选调用,daemon 不被插件管道钉活
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
  });
}

function ensureHost(name: string, pluginDir: string): Promise<{ port: number; token: string }> {
  let h = hosts.get(name);
  if (h === undefined) {
    h = startHost(name, pluginDir);
    hosts.set(name, h);
  }
  return h;
}

/** 把单进程宿主化插件的 manifest server(stdio 占位)改写为宿主 HTTP 连接:URL 携带本会话键/座位/
 *  项目数据目录(浏览器另带桌面 facade 端点),宿主据此给出该会话的隔离态与输出目录 */
export async function hostedPluginServer(
  cfg: McpServerConfig,
  session: { key: string; seat: string },
  dataDir: string,
): Promise<McpServerConfig> {
  if (cfg.cwd === undefined) throw new Error(`${cfg.name} plugin directory unknown`);
  const h = await ensureHost(cfg.name, cfg.cwd);
  const q = new URLSearchParams({ key: session.key, seat: session.seat, dataDir });
  const cdp = process.env.SUNSHINEX_BUILTIN_CDP;
  if (cfg.name === BROWSER_SERVER_NAME && browserHostMode() === 'builtin' && cdp !== undefined && cdp !== '') q.set('cdp', cdp);
  return {
    name: cfg.name,
    transport: 'http',
    url: `http://127.0.0.1:${h.port}/mcp?${q.toString()}`,
    headers: { Authorization: `Bearer ${h.token}` },
    ...(cfg.disabledTools !== undefined ? { disabledTools: cfg.disabledTools } : {}),
  };
}
