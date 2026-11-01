/**
 * CDP WebSocket 透明中继（2026-11-01 内置浏览器侧栏镜像）：GET /app/cdp-ws?root=&target= 升级请求
 * 原样转发到 builtin 桥的 DevTools 面。为何要中继：Chrome DevTools 的 WS 升级**拒绝带非空 Origin
 * 的连接**（防 DNS-rebinding 保护）——渲染层页面 origin=http://127.0.0.1:<daemon 端口> 恒非空，
 * 直连 ws://127.0.0.1:<cdp 端口>/devtools/... 恒被拒（实测复现 readyState=3 秒断）；daemon（Node
 * fetch/ws 客户端无 Origin 头）不受限，故在此剥 Origin 改写 Host 代为握手，握手完成后字节级双通。
 * target 白名单=^devtools/（页面/浏览器端点形态），防借道探本机任意 WS 面。
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import type { Duplex } from 'stream';
import * as path from 'path';
import { resolveDataDir } from '../config/data-dir';

export function relayCdpUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
  const fail = (msg: string): void => {
    try { socket.write(`HTTP/1.1 400 Bad Request\r\n\r\n${msg}`); } catch { /* 尽力 */ }
    socket.destroy();
  };
  const root = url.searchParams.get('root') ?? '';
  const target = url.searchParams.get('target') ?? '';
  if (root === '' || /^devtools\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/.exec(target) === null) {
    fail('root/target required (target must be a devtools endpoint)');
    return;
  }
  let meta: { ws?: unknown };
  try {
    meta = JSON.parse(fs.readFileSync(path.join(resolveDataDir(root), 'plugins', 'browser-use', 'builtin-cdp.json'), 'utf8')) as { ws?: unknown };
  } catch {
    fail('builtin browser not running');
    return;
  }
  const port = typeof meta.ws === 'string' ? /:(\d+)\//.exec(meta.ws)?.[1] : undefined;
  if (port === undefined) { fail('no cdp endpoint in meta'); return; }
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (typeof key !== 'string' || typeof version !== 'string') { fail('not a websocket upgrade'); return; }
  const upstream = net.connect(Number(port), '127.0.0.1');
  upstream.on('connect', () => {
    // 重写升级首部:Host 指向 DevTools;剥 Origin/Referer(DevTools 拒非空 Origin)——其余握手面
    // (Key/Version/Protocol 原样)透传,握手后字节级 pipe 双通,帧协议与直连完全一致
    const lines = [
      `GET /${target} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: ${version}`,
    ];
    const proto = req.headers['sec-websocket-protocol'];
    if (typeof proto === 'string') lines.push(`Sec-WebSocket-Protocol: ${proto}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const teardown = (): void => { upstream.destroy(); socket.destroy(); };
  upstream.on('error', teardown);
  upstream.on('close', () => socket.destroy());
  socket.on('error', teardown);
  socket.on('close', () => upstream.destroy());
  req.on('error', teardown);
}
