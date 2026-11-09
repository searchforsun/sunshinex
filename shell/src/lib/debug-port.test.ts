import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEBUG_PORT_DEFAULT, DEBUG_PORT_FILE, readDebugPort, verifyDebugPort } from './debug-port';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-debug-port-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readDebugPort', () => {
  it('无档/坏档/越界回落缺省口', () => {
    expect(readDebugPort(dir)).toBe(DEBUG_PORT_DEFAULT);
    fs.writeFileSync(path.join(dir, DEBUG_PORT_FILE), '{bad');
    expect(readDebugPort(dir)).toBe(DEBUG_PORT_DEFAULT);
    fs.writeFileSync(path.join(dir, DEBUG_PORT_FILE), JSON.stringify({ port: 80 }));
    expect(readDebugPort(dir)).toBe(DEBUG_PORT_DEFAULT);
  });
  it('合法偏好口原样返回', () => {
    fs.writeFileSync(path.join(dir, DEBUG_PORT_FILE), JSON.stringify({ port: 50123 }));
    expect(readDebugPort(dir)).toBe(50123);
  });
});

describe('verifyDebugPort', () => {
  it('DevToolsActivePort 指向请求口即成功,不改偏好档', async () => {
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${DEBUG_PORT_DEFAULT}\n/devtools/browser/x`);
    expect(await verifyDebugPort(dir, DEBUG_PORT_DEFAULT, { timeoutMs: 50, intervalMs: 10 })).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, DEBUG_PORT_FILE))).toBe(false);
  });
  it('超时未绑上:探出空闲新口写回偏好档,下次 readDebugPort 读到它', async () => {
    const r = await verifyDebugPort(dir, DEBUG_PORT_DEFAULT, { timeoutMs: 30, intervalMs: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.next).not.toBe(DEBUG_PORT_DEFAULT);
    expect(readDebugPort(dir)).toBe(r.next);
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(r.next, '127.0.0.1', () => s.close(() => resolve()));
    });
  });
});
