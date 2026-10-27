import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionHandlerIo } from './session-handlers';
import { userConfigDir } from '../config/env';

/**
 * 外部打开应用族(2026-10-27 用户需求:顶栏「打开」分体钮——工作区路径一键进资源管理器/编辑器):
 * GET /app/editors 探测安装态(只列实际存在的),GET /app/editors/icon?id= 抽取**应用原生图标**
 * (PowerShell ExtractAssociatedIcon 从 exe 资源段提取,PNG 落盘缓存,机器级一次),POST /app/open
 * 以指定应用打开路径。spawn detached+unref 脱离 daemon 生命周期。
 *
 * 2026-10-27 三修(用户实测四连):①探测全异步(execFile 代替 spawnSync)——where.exe 单次数百
 * 毫秒且同步调用阻塞 daemon 事件循环,菜单打开即整应用卡顿;②注册表卸载键兜底——VS Code 装在
 * 非标盘位(D:\MyWorkSoftware 等自定义位)不在静态候选,PATH 上 `code` shim 又被 Cursor 内嵌
 * CLI 占用(「宁缺勿错」正确放弃),从 Inno Setup 定版 GUID 卸载键读 InstallLocation 兜回;
 * ③open spawn 去 windowsHide——CREATE_NO_WINDOW 吞被拉起 GUI 应用的首个窗口(explorer
 * 「点了没反应」实锤;GUI 子系统本不产控制台窗)。安装态缓存于 daemon 生命周期(低频事件,重启刷新)。
 */

export interface EditorApp {
  id: string;
  name: string;
  exe: string;
}

/** 预设候选(静态安装位):explorer 恒在;VS Code/Cursor 各取用户级+系统级两档常见安装位,
 *  同 id 多命中取首个(用户级优先于系统级)。便携版不在标准位——由注册表/PATH shim 兜底 */
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
 *  同名 shim 可能是别家(实测 Cursor 内嵌的 code.cmd)——逐层找不到真 exe 即整条放弃,
 *  宁缺勿错(错配会把「VS Code 打开」实际开成 Cursor)。 */
export const SHIM_PROBES: Array<{ id: string; name: string; shim: string; exeName: string }> = [
  { id: 'vscode', name: 'VS Code', shim: 'code', exeName: 'Code.exe' },
  { id: 'cursor', name: 'Cursor', shim: 'cursor', exeName: 'Cursor.exe' },
];

/** 注册表探测源(与具体安装路径解耦——盘位/安装方式千人千面,但都登记在这里):
 *  ① App Paths\Code.exe 缺省值=安装器登记的完整 exe 路径(HKCU 用户装/HKLM 系统装两键,
 *  任意盘位任意目录通用);② Inno Setup 定版 GUID 卸载键 InstallLocation(系统装常见登记)
 *  → 命中安装根,Code.exe 由调用方拼接 */
export const VSCODE_APP_PATHS_KEYS = [
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
];
export const VSCODE_UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1',
];

const execFile = promisify(execFileCb);

/** 真实 where 探针(async):首行(最高 PATH 优先级)或 null */
export async function whereFirst(shim: string): Promise<string | null> {
  try {
    const r = await execFile('where', [shim], { windowsHide: true });
    const first = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '');
    return first ?? null;
  } catch {
    return null;
  }
}

/** 注册表读探测值(async reg query;shell 转义与本进程无关):命中回 InstallLocation/缺省值 */
export async function vscodeInstallFromRegistry(): Promise<string | null> {
  // ① App Paths:缺省值即完整 exe 路径(任意安装位通用)
  for (const key of VSCODE_APP_PATHS_KEYS) {
    try {
      const r = await execFile('reg', ['query', key], { windowsHide: true });
      const m = /REG_SZ\s+(.+)/.exec(r.stdout);
      const exe = m !== null ? m[1]!.trim() : '';
      if (exe !== '' && /Code\.exe$/i.test(exe)) return path.dirname(exe);
    } catch {
      /* 键缺席:降级 */
    }
  }
  // ② Inno 卸载键 InstallLocation(系统装登记)→ 安装根
  for (const key of VSCODE_UNINSTALL_KEYS) {
    try {
      const r = await execFile('reg', ['query', key, '/v', 'InstallLocation'], { windowsHide: true });
      const m = /InstallLocation\s+REG_SZ\s+(.+)/.exec(r.stdout);
      const loc = m !== null ? m[1]!.trim() : '';
      if (loc !== '') return loc;
    } catch {
      /* 键缺席/被拒:逐键降级 */
    }
  }
  return null;
}

/** 探测合成(异步,事件循环零阻塞):静态位 → 注册表卸载键(vscode 专属兜底)→ PATH shim;
 *  同 id 先命中先得(静态 > 注册表 > shim) */
export async function detectEditorsAsync(
  exists: (p: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
  where: (shim: string) => Promise<string | null> = whereFirst,
  vscodeRegistry: () => Promise<string | null> = vscodeInstallFromRegistry,
): Promise<EditorApp[]> {
  const seen = new Set<string>();
  const out: EditorApp[] = [];
  const push = (c: EditorApp): void => {
    if (seen.has(c.id) || !exists(c.exe)) return;
    seen.add(c.id);
    out.push(c);
  };
  for (const c of editorCandidates(env)) push(c);
  if (!seen.has('vscode')) {
    const loc = await vscodeRegistry();
    if (loc !== null) push({ id: 'vscode', name: 'VS Code', exe: path.join(loc, 'Code.exe') });
  }
  for (const probe of SHIM_PROBES) {
    if (seen.has(probe.id)) continue;
    const shimPath = await where(probe.shim);
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

/** 旧同步签名保留(测试锚):语义=无注册表兜底、同步 where 的探测(逻辑与 async 同构) */
export function detectEditors(
  exists: (p: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
  where: (shim: string) => string | null = (): string | null => null,
): EditorApp[] {
  const seen = new Set<string>();
  const out: EditorApp[] = [];
  const push = (c: EditorApp): void => {
    if (seen.has(c.id) || !exists(c.exe)) return;
    seen.add(c.id);
    out.push(c);
  };
  for (const c of editorCandidates(env)) push(c);
  if (!seen.has('vscode')) {
    const shimPath = where('code');
    if (shimPath !== null) {
      let cur = path.dirname(shimPath);
      for (let depth = 0; depth < 6; depth++) {
        const exe = path.join(cur, 'Code.exe');
        if (exists(exe)) {
          push({ id: 'vscode', name: 'VS Code', exe });
          break;
        }
        const up = path.dirname(cur);
        if (up === cur) break;
        cur = up;
      }
    }
  }
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

/** 安装态缓存(daemon 生命周期):菜单每次打开都读,异步探测只跑首次 */
let editorsCache: EditorApp[] | null = null;
export function editorsCacheReset(): void {
  editorsCache = null;
}

export async function handleEditorsGet(io: SessionHandlerIo, res: http.ServerResponse): Promise<void> {
  if (editorsCache === null) {
    editorsCache = await detectEditorsAsync((p) => fs.existsSync(p));
  }
  io.send(res, 200, { editors: editorsCache });
}

/** 原生图标缓存路径(机器级一次抽取):<userConfigDir>/gui/editor-icons/<id>.v2.png(64px 带透明;v1 32px 黑角淘汰) */
function editorIconPath(id: string): string {
  return path.join(userConfigDir(), 'gui', 'editor-icons', `${id}.v2.png`);
}

/** 原生图标抽取(ExtractAssociatedIcon→透明画布重绘 64px→PNG):直接 ToBitmap 会丢透明度
 *  (透明区变黑、字形缩角=「只显示左上角」观感的根因);异步不阻塞;失败回 null(GUI 回落集内字形)。
 *  注:Icon(exe,64,64) 三参重载经 New-Object 绑定失败(实测「picture 必须是可用作 Icon」),不用 */
export async function extractEditorIcon(id: string, exe: string): Promise<string | null> {
  const out = editorIconPath(id);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!fs.existsSync(out)) {
    const exeQ = exe.replaceAll("'", "''");
    const outQ = out.replaceAll("'", "''");
    const ps =
      'Add-Type -AssemblyName System.Drawing; ' +
      `$i=[System.Drawing.Icon]::ExtractAssociatedIcon('${exeQ}'); ` +
      '$b=New-Object System.Drawing.Bitmap 64, 64; ' +
      '$g=[System.Drawing.Graphics]::FromImage($b); ' +
      '$g.Clear([System.Drawing.Color]::Transparent); ' +
      "$g.InterpolationMode='HighQualityBicubic'; " +
      '$g.DrawIcon($i, (New-Object System.Drawing.Rectangle 8, 8, 48, 48)); ' +
      `$b.Save('${outQ}', [System.Drawing.Imaging.ImageFormat]::Png)`;
    try {
      await execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 });
    } catch {
      return null;
    }
  }
  return fs.existsSync(out) ? fs.readFileSync(out).toString('base64') : null;
}

/** GET /app/editors/icon?id=:原生图标 PNG → {mime,data(base64)};失败 404(GUI 回落集内字形) */
export async function handleEditorsIcon(io: SessionHandlerIo, res: http.ServerResponse, id: string): Promise<void> {
  const list = editorsCache ?? (await detectEditorsAsync((p) => fs.existsSync(p)));
  const editor = list.find((e) => e.id === id);
  if (editor === undefined) {
    io.send(res, 404, { error: 'editor not installed' });
    return;
  }
  const data = await extractEditorIcon(id, editor.exe);
  if (data === null) {
    io.send(res, 404, { error: 'icon extract failed' });
    return;
  }
  io.send(res, 200, { mime: 'image/png', data });
}

/** 打开:body {path,id};id 须在已装名单内(防任意 exe 拼装),spawn detached 立即返回。
 *  windowsHide 不传:CREATE_NO_WINDOW 会吞被拉起 GUI 应用的首个窗口(explorer「点了没反应」
 *  实锤——Node 已知坑);explorer/Code/Cursor 均为 GUI 子系统,本就不产控制台窗,无需隐藏 */
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
  const list = editorsCache ?? (await detectEditorsAsync((p) => fs.existsSync(p)));
  const editor = list.find((e) => e.id === body.id);
  if (editor === undefined) {
    io.send(res, 404, { error: 'editor not installed' });
    return;
  }
  try {
    const child = spawn(editor.exe, [body.path], { detached: true, stdio: 'ignore' });
    child.unref();
    io.send(res, 200, { ok: true });
  } catch {
    io.send(res, 500, { error: 'spawn failed' });
  }
}
