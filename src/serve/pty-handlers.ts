import * as http from 'node:http';
import type { SessionRuntime } from './session';
import type { PtyManager } from './pty';

/** pty 面 HTTP 处理器（D31 批3 拆分自 daemon.ts 类）：alloc（会话内分配伪终端，ptyId 铸造经 io
 *  回调注入——daemon 持单调 seq）/kill。WS 帧中继不在此（attachWs 升级路径留 daemon 传输域）。
 */

export interface PtyHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage, cap?: number): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  sessionFor(res: http.ServerResponse, id: string | undefined): SessionRuntime | undefined;
  ptyManager: PtyManager;
  nextPtyId(): string;
}

export async function handlePtyAlloc(io: PtyHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { cols?: unknown; rows?: unknown } | null;
  const cols = body?.cols ?? 80;
  const rows = body?.rows ?? 24;
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1 || typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1) {
    io.send(res, 400, { error: 'cols and rows must be positive integers' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const ptyId = io.nextPtyId();
  const file = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
  io.ptyManager.spawn(ptyId, {
    file,
    args: [],
    cwd: session.root,
    cols,
    rows,
    owner: session.id,
    env: process.env as Record<string, string>,
  });
  io.send(res, 200, { ptyId });
}

export function handlePtyKill(io: PtyHandlerIo, res: http.ServerResponse, id: string, ptyId: string): void {
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const owner = io.ptyManager.ownerOf(ptyId);
  if (owner !== undefined && owner !== session.id) {
    io.send(res, 404, { error: 'pty not found for session' });
    return;
  }
  io.ptyManager.kill(ptyId);
  io.send(res, 200, { ok: true });
}
