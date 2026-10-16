import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { urlOf } from './daemon-wire';
import { projectsRoot, projectSlug } from '../config/data-dir';
import { listSessions } from '../tui/session-journal';
import type { WorkspaceRow } from './daemon';

/** 工作区面 HTTP 处理器（D31 批3 拆分自 daemon.ts 类）：locate（标记文件全盘定位）/create（注册+建
 *  目录+落 SUNSHINE.md）/workspaces 清单/dirpicker 目录浏览——io 两面（send/readJson）；盘符扫描与
 *  标记追踪为模块纯助手。行为零变化（daemon.test 为锚）。
 */

export interface WorkspaceHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
}

export async function handleWorkspaceLocate(io: WorkspaceHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const body = parsed.body as { token?: unknown; roots?: unknown };
  const token = typeof body.token === 'string' ? body.token : '';
  if (token.length < 8) return io.send(res, 400, { error: 'invalid token' });
  const roots = Array.isArray(body.roots) && body.roots.every((r) => typeof r === 'string') && body.roots.length > 0
    ? (body.roots as string[]).map((r) => path.resolve(r))
    : systemScanRoots();
  const found = await walkForMarker(roots, token, 20_000);
  io.send(res, 200, { path: found });
}

/** 系统扫描根(Windows=各盘根;其余平台家目录);盘符探测 C..Z 存在即入列 */
export function systemScanRoots(): string[] {
  if (process.platform !== 'win32') return [os.homedir()];
  const roots: string[] = [];
  for (let i = 67; i <= 90; i += 1) {
    const drive = `${String.fromCharCode(i)}:\\`;
    if (fs.existsSync(drive)) roots.push(drive);
  }
  return roots.length > 0 ? roots : [os.homedir()];
}

/** 多根 BFS 找标记文件(标记文件名=token):单次 readdir 即判本目录是否命中;噪声目录
 *  (系统/程序目录/node_modules/$ 开头)剪枝,深度 ≤10,整体限时;命中即返绝对路径 */
export async function walkForMarker(roots: string[], token: string, capMs: number): Promise<string | null> {
  const deadline = Date.now() + capMs;
  const skip = new Set([
    'windows', 'program files', 'program files (x86)', 'programdata', 'appdata',
    '$recycle.bin', 'system volume information', '$windows.~bt', 'recovery', 'perflogs',
    'node_modules', '.git',
  ]);
  const queue: Array<{ dir: string; depth: number }> = roots.map((r) => ({ dir: r, depth: 0 }));
  while (queue.length > 0) {
    if (Date.now() > deadline) return null;
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限/系统占用——跳过
    }
    for (const ent of entries) {
      if (ent.isFile() && ent.name === token) return dir;
    }
    if (depth >= 10) continue;
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name.toLowerCase();
      if (name.startsWith('$') || skip.has(name)) continue;
      queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
    }
  }
  return null;
}

export async function handleWorkspaceCreate(io: WorkspaceHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const body = parsed.body as { name?: unknown; path?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const extPath = typeof body.path === 'string' ? path.resolve(body.path) : '';
  let root: string;
  if (extPath !== '') {
    let st: fs.Stats;
    try {
      st = fs.statSync(extPath);
    } catch {
      return io.send(res, 400, { error: 'path does not exist' });
    }
    if (!st.isDirectory()) return io.send(res, 400, { error: 'path is not a directory' });
    root = extPath;
  } else {
    if (name === '' || /[\\/:*?"<>|]/.test(name)) return io.send(res, 400, { error: 'invalid project name' });
    root = path.join(projectsRoot(), name);
    fs.mkdirSync(root, { recursive: true });
  }
  const dataDir = path.join(projectsRoot(), projectSlug(root), 'data');
  const wsFile = path.join(dataDir, 'workspace.json');
  if (fs.existsSync(wsFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(wsFile, 'utf8')) as { root?: unknown };
      if (raw?.root === root) return io.send(res, 200, { ok: true, root, slug: projectSlug(root) });
    } catch {
      // 坏档:按新初始化覆写
    }
  }
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  fs.writeFileSync(wsFile, JSON.stringify({ root }, null, 2));
  io.send(res, 200, { ok: true, root, slug: projectSlug(root) });
}

export function handleWorkspaces(io: WorkspaceHandlerIo, res: http.ServerResponse): void {
  const rows: WorkspaceRow[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
  } catch {
    // projects 根不存在/不可读：空注册表（合法态——从未建过会话）
    io.send(res, 200, rows);
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(projectsRoot(), ent.name, 'data');
    let st: fs.Stats;
    try {
      st = fs.statSync(dataDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let root: string | undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')) as { root?: unknown };
      if (typeof raw?.root === 'string' && raw.root.length > 0) root = raw.root;
    } catch {
      // 历史工作区无档/坏档 → slug-only（root undefined，前端不可 attach）
    }
    if (root === undefined && ent.name.includes('sunshinex-default')) {
      // G14.96 默认锚点历史档降级:slug 自证身份,root 回锚定路径(可 attach/可开回)
      root = path.join(os.tmpdir(), 'sunshinex-default');
    }
    // G14.32:计数与列表同源(listSessions——side 辅助会话滤除),徽标不再虚高
    // G14.165 回退:注册表恒全量(欢迎页项目下拉要能选到刚建 0 会话的工作区);
    // 0 会话残渣的隐藏归 GUI 侧栏渲染层(sessionCount>0 门)
    const sessionCount = listSessions(dataDir).length;
    rows.push({ ...(root !== undefined ? { root } : {}), slug: ent.name, mtime: st.mtimeMs, sessionCount });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  io.send(res, 200, rows);
}

export function handleDirpicker(io: WorkspaceHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const abs = path.resolve(url.searchParams.get('path') ?? os.homedir());
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    io.send(res, 400, { error: `path does not exist: ${abs}` });
    return;
  }
  if (!st.isDirectory()) {
    io.send(res, 400, { error: `path is not a directory: ${abs}` });
    return;
  }
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    io.send(res, 400, { error: `path is not readable: ${abs}` });
    return;
  }
  io.send(res, 200, { path: abs, parent: path.resolve(abs, '..'), dirs });
}
