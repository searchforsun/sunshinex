import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
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

/** 预设候选(安装态探测名单):explorer 恒在;VS Code/Cursor 各取用户级+系统级两档常见安装位,
 *  同 id 多命中取首个(用户级优先于系统级)。新增预设应用在此追加行 */
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

/** 安装态探测:同 id 多档取首个命中,缺席的整个不列(用户裁定「只有实际安装的才显示」) */
export function detectEditors(exists: (p: string) => boolean, env: NodeJS.ProcessEnv = process.env): EditorApp[] {
  const seen = new Set<string>();
  const out: EditorApp[] = [];
  for (const c of editorCandidates(env)) {
    if (seen.has(c.id) || !exists(c.exe)) continue;
    seen.add(c.id);
    out.push(c);
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
