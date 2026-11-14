import * as http from 'node:http';
import * as os from 'node:os';
import { clearReplay, loadReplay, saveReplay } from './pty-replay-store';
import { defaultScratchRoot } from './session-lifecycle';
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

/** alloc 公共尾段（D67 收敛，2026-11-07——此前会话/App 两 alloc 校验与 spawn 编排逐行双写，
 *  b5a40544 shellArgs 改动被迫双改）：cols/rows 缺省 80/24（非正整数 400）→ prevPtyId 回放回种
 *  （死档环=新 pty 初始环，滚动区跨 daemon 视觉连续）→ spawn（env 整份继承）→ 回种源清档（已
 *  迁入新环）→ 200 {ptyId}。cwd/owner 两面差异经参注入。 */
async function allocPty(
  io: PtyHandlerIo,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  /** 校验后调用(错误优先级保序:400 形状错先于 404 定位错);undefined=已回 404。
   *  2026-11-14 用户实测「欢迎页终端默认打开报错」根修:resolve 改收单次 readJson 的解析体——
   *  此前 handleAppPtyAlloc 自读一次(root)+本函数再读一次(cols/rows),请求流只可消费一次,
   *  第二读恒空流 400 'invalid json body',/app/pty 全坏(cols/rows 进 allocPty 起未再被测) */
  resolve: (body: { cols?: unknown; rows?: unknown; prevPtyId?: unknown; root?: unknown } | null) => { cwd: string; owner: string } | undefined,
): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { cols?: unknown; rows?: unknown; prevPtyId?: unknown; root?: unknown } | null;
  const cols = body?.cols ?? 80;
  const rows = body?.rows ?? 24;
  const located = resolve(body);
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1 || typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1) {
    io.send(res, 400, { error: 'cols and rows must be positive integers' });
    return;
  }
  if (located === undefined) return;
  const ptyId = io.nextPtyId();
  // 回放回种(2026-11-07 用户裁定「要看连续」):GUI 持有的死档 ptyId(prev)→ 落盘环形缓冲回种为
  // 新 pty 初始环=滚动区跨 daemon 视觉连续(shell 不能跨 daemon 存活,与 VSCode 同边界)
  const prev = typeof body?.prevPtyId === 'string' && body.prevPtyId !== '' ? body.prevPtyId : undefined;
  const seed = prev !== undefined ? loadReplay(prev) : undefined;
  const file = shellFile();
  io.ptyManager.spawn(ptyId, {
    file,
    args: shellArgs(),
    cwd: located.cwd,
    cols,
    rows,
    owner: located.owner,
    env: process.env as Record<string, string>,
    seed,
  });
  if (prev !== undefined) clearReplay(prev);
  io.send(res, 200, { ptyId });
}

export async function handlePtyAlloc(io: PtyHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  return allocPty(io, req, res, () => {
    const session = io.sessionFor(res, id);
    if (session === undefined) return undefined;
    // owner=journalId(2026-10-31 用户实测切换会话「pty not found for session」根因修):运行时 id
    // 每次打开重铸( ephemeral),journalId 才是稳定锚——切会话/收编换壳后终端凭 ptyId 重连不失效
    return { cwd: session.root, owner: session.attachedJournalId ?? session.id };
  });
}

export function handlePtyKill(io: PtyHandlerIo, res: http.ServerResponse, id: string, ptyId: string): void {
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const alive = io.ptyManager.get(ptyId);
  if (alive !== undefined) saveReplay(ptyId, alive.replay()); // 关页签即落盘(重开凭 prev 回种,屏幕连续)
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
  // root 由 allocPty 单次读取的解析体直供(2026-11-14 双读根修,见 allocPty 注)
  return allocPty(io, req, res, (body) => {
    // root 字面 'default'(2026-11-14 欢迎页终端:GUI 上提的欢迎页选中工作区可能是缺省锚字面)——
    // 解析为 <tmp>/sunshinex-default(defaultScratchRoot 单点,与 createSession 同规则),不再 cwd='default' 相对目录
    const raw = typeof body?.root === 'string' && body.root !== '' ? body.root : undefined;
    const root = raw === undefined ? os.tmpdir() : raw === 'default' ? defaultScratchRoot() : raw;
    return { cwd: root, owner: '@app' };
  });
}

/** App 级 pty 回收:不校验 owner（'@app' 域无会话寻址）——ptyId 直杀,幂等 */
export function handleAppPtyKill(io: PtyHandlerIo, res: http.ServerResponse, ptyId: string): void {
  const alive = io.ptyManager.get(ptyId);
  if (alive !== undefined) saveReplay(ptyId, alive.replay());
  io.ptyManager.kill(ptyId);
  io.send(res, 200, { ok: true });
}

/** 终端 shell(win32 PowerShell,其余 $SHELL ?? bash)。-NoLogo:不打印启动版权横幅——续屏把历史
 *  接在新壳上方,每次重启的横幅会在滚动区层层堆积(2026-11-07 用户实测) */
function shellFile(): string {
  return process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
}
function shellArgs(): string[] {
  return process.platform === 'win32' ? ['-NoLogo'] : [];
}
