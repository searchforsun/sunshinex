import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import type { McpServerConfig } from '../types';

/** 浏览器插件宿主(2026-11-03 浏览器状态按会话隔离):每个进程(daemon/CLI)只起一个宿主,
 *  全部会话经 HTTP 各连一条 MCP 连接(宿主 createConnection+contextGetter 给每会话专属上下文)。
 *  宿主=插件内 server/host.js(stdin 管道由本进程持有,进程退出即宿主保存状态退出)。 */
export type BrowserHostMode = 'builtin' | 'default' | 'headless';

/** 浏览器插件 server 名(manifest mcpServers 键):装配期改写为宿主 HTTP 连接 */
export const BROWSER_SERVER_NAME = 'browser-use';

/** 运行环境→浏览器形态(用户不可选):桌面壳(daemon 在 Electron 主进程)=内置侧栏;
 *  sunshinex serve(网页端)=系统默认浏览器;其余(TUI/CLI)=无头 */
export function browserHostMode(): BrowserHostMode {
  if (process.versions.electron !== undefined) return 'builtin';
  if (process.env.SUNSHINEX_HOST === 'serve') return 'default';
  return 'headless';
}

/** 宿主启动上限:超时视为失败(本轮不挂浏览器工具,下轮重试) */
const HOST_START_TIMEOUT_MS = 10_000;

let host: Promise<{ port: number; token: string }> | undefined;

function startHost(pluginDir: string): Promise<{ port: number; token: string }> {
  const token = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(pluginDir, 'server', 'host.js'), '--mode', browserHostMode(), '--token', token], {
      cwd: pluginDir,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let settled = false;
    const fail = (msg: string): void => {
      if (settled) return;
      settled = true;
      host = undefined;
      child.kill();
      reject(new Error(`browser host failed to start: ${msg}`));
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
      else host = undefined;
    });
    child.unref();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
  });
}

function ensureHost(pluginDir: string): Promise<{ port: number; token: string }> {
  host ??= startHost(pluginDir);
  return host;
}

/** 把插件 manifest 的浏览器 server(stdio 占位)改写为宿主 HTTP 连接:URL 携带本会话浏览器键/座位/
 *  项目数据目录(+桌面 facade 端点),宿主据此给出该会话的专属浏览器上下文与输出目录 */
export async function browserHostServer(
  cfg: McpServerConfig,
  session: { key: string; seat: string },
  dataDir: string,
): Promise<McpServerConfig> {
  if (cfg.cwd === undefined) throw new Error('browser plugin directory unknown');
  const h = await ensureHost(cfg.cwd);
  const q = new URLSearchParams({ key: session.key, seat: session.seat, dataDir });
  const cdp = process.env.SUNSHINEX_BUILTIN_CDP;
  if (browserHostMode() === 'builtin' && cdp !== undefined && cdp !== '') q.set('cdp', cdp);
  return {
    name: cfg.name,
    transport: 'http',
    url: `http://127.0.0.1:${h.port}/mcp?${q.toString()}`,
    headers: { Authorization: `Bearer ${h.token}` },
    ...(cfg.disabledTools !== undefined ? { disabledTools: cfg.disabledTools } : {}),
  };
}
