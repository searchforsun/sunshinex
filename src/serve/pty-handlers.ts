import * as http from 'node:http';
import * as os from 'node:os';
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
    // owner=journalId(2026-10-31 用户实测切换会话「pty not found for session」根因修):运行时 id
    // 每次打开重铸( ephemeral),journalId 才是稳定锚——切会话/收编换壳后终端凭 ptyId 重连不失效
    owner: session.attachedJournalId ?? session.id,
    env: process.env as Record<string, string>,
  });
  io.send(res, 200, { ptyId });
}

export function handlePtyKill(io: PtyHandlerIo, res: http.ServerResponse, id: string, ptyId: string): void {
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const owner = io.ptyManager.ownerOf(ptyId);
  if (owner !== undefined && owner !== session.id && owner !== session.attachedJournalId) {
    io.send(res, 404, { error: 'pty not found for session' });
    return;
  }
  io.ptyManager.kill(ptyId);
  io.send(res, 200, { ok: true });
}

/** App 级 pty 分配（2026-10-27 用户裁定:欢迎页全局草稿——终端页签不绑会话）:root 直供 cwd
 *  （缺省落临时目录）,owner='@app'（与会话 pty 分域;回收走 handleAppPtyKill） */
export async function handleAppPtyAlloc(io: PtyHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { root?: unknown; cols?: unknown; rows?: unknown } | null;
  const cols = body?.cols ?? 80;
  const rows = body?.rows ?? 24;
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1 || typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1) {
    io.send(res, 400, { error: 'cols and rows must be positive integers' });
    return;
  }
  const root = typeof body?.root === 'string' && body.root !== '' ? body.root : os.tmpdir();
  const ptyId = io.nextPtyId();
  const file = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
  io.ptyManager.spawn(ptyId, {
    file,
    args: [],
    cwd: root,
    cols,
    rows,
    owner: '@app',
    env: process.env as Record<string, string>,
  });
  io.send(res, 200, { ptyId });
}

/** App 级 pty 回收:不校验 owner（'@app' 域无会话寻址）——ptyId 直杀,幂等 */
export function handleAppPtyKill(io: PtyHandlerIo, res: http.ServerResponse, ptyId: string): void {
  io.ptyManager.kill(ptyId);
  io.send(res, 200, { ok: true });
}
