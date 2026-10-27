import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { SessionHandlerIo } from './session-handlers';

/**
 * 外部打开应用族(2026-10-27 用户需求:顶栏[|] 旁「打开」分体钮——工作区路径一键进资源
 * 管理器/编辑器):GET /app/editors 探测预设应用安装态(只列实际存在的),POST /app/open
 * 以指定应用打开路径。spawn detached+unref 脱离 daemon 生命周期(应用自身另起进程,daemon
 * 不等不收养);windowsHide 不闪控制台窗。
 */

export interface EditorApp {
  id: string;
  name: string;
  exe: string;
}

/** 预设候选(静态安装位):explorer 恒在;VS Code/Cursor 各取用户级+系统级两档常见安装位,
 *  同 id 多命中取首个(用户级优先于系统级)。便携版不在标准位——由 PATH shim 探测兜底 */
export function editorCandidates(env: NodeJS.ProcessEnv = process.env): EditorApp[] {
  const user = env.USERPROFILE ?? '';
  const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
  return [
    { id: 'explorer', name: '资源管理器', exe: path.join(env.windir ?? 'C:\\Windows', 'explorer.exe') },
    { id: 'vscode', name: 'VS Code', exe: path.join(user, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe') },
    { id: 'vscode', name: 'VS Code', exe: path.join(pf, 'Microsoft VS Code', 'Code.exe') },
    { id: 'cursor', name: 'Cursor', exe: path.join(user, 'AppData', 'Local', 'Programs', 'Cursor', 'Cursor.exe') },
  ];
}

/** PATH shim 探测(便携装兜底):where <shim> 首行→自 shim 目录向上逐层(≤6)找 <exeName>。
 *  同名 shim 可能是别家(如 Cursor 内嵌的 code.cmd)——逐层找不到真 exe 即整条放弃,
 *  宁缺勿错(错配会把「VS Code 打开」实际开成 Cursor)。 */
export const SHIM_PROBES: Array<{ id: string; name: string; shim: string; exeName: string }> = [
  { id: 'vscode', name: 'VS Code', shim: 'code', exeName: 'Code.exe' },
  { id: 'cursor', name: 'Cursor', shim: 'cursor', exeName: 'Cursor.exe' },
];

export type WhereFn = (shim: string) => string | null;

/** 真实 where 探针:首行(最高 PATH 优先级)或 null */
export function whereFirst(shim: string): string | null {
  const r = spawnSync('where', [shim], { windowsHide: true });
  if (r.status !== 0 || r.error !== undefined) return null;
  const first = r.stdout
    .toString()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  return first ?? null;
}

/** 安装态探测合成:静态位在前,PATH shim 解析兜底,同 id 静态命中优先 */
export function detectEditors(exists: (p: string) => boolean, env: NodeJS.ProcessEnv = process.env, where: WhereFn = whereFirst): EditorApp[] {
  const seen = new Set<string>();
  const out: EditorApp[] = [];
  const push = (c: EditorApp): void => {
    if (seen.has(c.id) || !exists(c.exe)) return;
    seen.add(c.id);
    out.push(c);
  };
  for (const c of editorCandidates(env)) push(c);
  if (out.some((e) => e.id !== 'explorer')) return out; // 静态位已有编辑器,PATH 兜底不再叠
  for (const probe of SHIM_PROBES) {
    if (seen.has(probe.id)) continue;
    const shimPath = where(probe.shim);
    if (shimPath === null) continue;
    let cur = path.dirname(shimPath);
    for (let depth = 0; depth < 6; depth++) {
      const exe = path.join(cur, probe.exeName);
      if (exists(exe)) {
        push({ id: probe.id, name: probe.name, exe });
        break;
      }
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  return out;
}

export async function handleEditorsGet(io: SessionHandlerIo, res: http.ServerResponse): Promise<void> {
  io.send(res, 200, { editors: detectEditors((p) => fs.existsSync(p)) });
}

/** 打开:body {path,id};id 须在已装名单内(防任意 exe 拼装),spawn detached 立即返回 */
export async function handleEditorsOpen(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = (parsed.body ?? {}) as { path?: unknown; id?: unknown };
  if (typeof body.path !== 'string' || body.path === '' || typeof body.id !== 'string') {
    io.send(res, 400, { error: 'path and id required' });
    return;
  }
  const editor = detectEditors((p) => fs.existsSync(p)).find((e) => e.id === body.id);
  if (editor === undefined) {
    io.send(res, 404, { error: 'editor not installed' });
    return;
  }
  try {
    const child = spawn(editor.exe, [body.path], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    io.send(res, 200, { ok: true });
  } catch {
    io.send(res, 500, { error: 'spawn failed' });
  }
}
