import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

/** CDP 调试口偏好档与选口策略(M2 内置浏览器融合)。
 *  remote-debugging-port 须在 ready 前定下,而 ready 前主线程任何同步阻塞都会推迟消息循环——
 *  安装器「完成并运行」经 ShellExecute 拉起应用会等它进入输入空闲,阻塞期间安装框未响应。
 *  故 ready 前只做一次小文件读取;端口是否真绑上在 ready 后异步核验,失败则探一个空闲口
 *  写回偏好档,下次启动生效(本次融合面按 DevToolsActivePort 缺席走既有降级)。 */
export const DEBUG_PORT_DEFAULT = 57679;
export const DEBUG_PORT_FILE = 'debug-port.json';
const ACTIVE_PORT_FILE = 'DevToolsActivePort';

/** 读偏好端口:档缺席/损坏/越界(<1024 特权口、>65535)回落缺省口 */
export function readDebugPort(userData: string): number {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(userData, DEBUG_PORT_FILE), 'utf8')) as { port?: unknown };
    if (typeof saved.port === 'number' && Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535) return saved.port;
  } catch {
    // 首启无档
  }
  return DEBUG_PORT_DEFAULT;
}

/** DevToolsActivePort 首行=本次实际监听口;缺席/不可读 undefined */
export function readActivePort(userData: string): number | undefined {
  try {
    const n = Number(fs.readFileSync(path.join(userData, ACTIVE_PORT_FILE), 'utf8').split(/\r?\n/)[0]);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** 回环上探空闲口:先试 preferred,占用则交给系统分配 */
export function findFreePort(preferred: number): Promise<number> {
  const tryListen = (p: number): Promise<number> =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(-1));
      s.listen(p, '127.0.0.1', () => {
        const addr = s.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : -1;
        s.close(() => resolve(port));
      });
    });
  return tryListen(preferred).then((p) => (p > 0 ? p : tryListen(0)));
}

/** ready 后核验:限时内 DevToolsActivePort 指向 requested 即成功;否则(口被占绑定失败)
 *  探空闲口写回偏好档并返回新口,供下次启动使用 */
export async function verifyDebugPort(
  userData: string,
  requested: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ ok: true } | { ok: false; next: number }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const interval = opts.intervalMs ?? 200;
  for (;;) {
    if (readActivePort(userData) === requested) return { ok: true };
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, interval));
  }
  const next = await findFreePort(requested === DEBUG_PORT_DEFAULT ? 0 : DEBUG_PORT_DEFAULT);
  try {
    fs.writeFileSync(path.join(userData, DEBUG_PORT_FILE), JSON.stringify({ port: next }));
  } catch {
    // 写档失败:下次仍试旧口
  }
  return { ok: false, next };
}
