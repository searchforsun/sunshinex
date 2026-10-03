import * as fs from 'fs';
import * as os from 'path';

/**
 * /terminal-setup 终端键位自动配置（2026-10-02 用户裁决「看一下 claude code 怎么实现换行」对齐项）：
 * 终端缺省 Shift+Enter 与 Enter 同发 \r 不可区分，运行时只能认 \x1b\r（Alt+Enter / 绑定发送序列）。
 * CC 同款方案：本命令把 Windows Terminal 键位写好——Shift+Enter 绑定 sendInput "\u001b\r" +
 * 解绑 Alt+Enter（WT 缺省绑全屏切换），一次性消除「需要用户手动改 JSON」的设置成本。
 * 纯函数 + 注入路径（os.homedir/env 在会话分支解析），settings.json 读写全在备份之后。
 */

/** Shift+Enter 换行键位项（WT settings 的 actions/keybindings 数组条目；input 为真实 ESC+CR 字节，JSON 序列化自带 \u001b\r 转义） */
export function shiftEnterBinding(): Record<string, unknown> {
  return { command: { action: 'sendInput', input: '\u001b\r' }, keys: 'shift+enter' };
}

/** Alt+Enter 解绑项：WT 缺省把 Alt+Enter 绑全屏切换，不 解绑 则 Alt+Enter 换行到不了应用 */
export function altEnterUnbind(): Record<string, unknown> {
  return { command: 'unbound', keys: 'alt+enter' };
}

/** Windows Terminal settings.json 候选（存在性由调用侧过滤）：商店版 / Preview / 非打包安装 */
export function wtSettingsCandidates(localAppData?: string): string[] {
  const lad = localAppData ?? process.env.LOCALAPPDATA;
  if (!lad) return [];
  return [
    os.join(lad, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    os.join(lad, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    os.join(lad, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
}

/** 宽松 JSON 解析：settings.json 允许 // 注释（WT 手写场景）——剥行注释后 JSON.parse，仍失败返回 undefined */
function parseLoose(raw: string): Record<string, unknown> | undefined {
  const noBom = raw.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(noBom) as Record<string, unknown>;
  } catch {
    /* 尝试剥行注释再试 */
  }
  try {
    return JSON.parse(noBom.replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function bindingsArray(cfg: Record<string, unknown>): { key: 'actions' | 'keybindings'; list: unknown[] } {
  if (Array.isArray(cfg.actions)) return { key: 'actions', list: cfg.actions };
  if (Array.isArray(cfg.keybindings)) return { key: 'keybindings', list: cfg.keybindings };
  return { key: 'actions', list: [] };
}

function hasBinding(list: unknown[], pred: (e: Record<string, unknown>) => boolean): boolean {
  return list.some((e) => typeof e === 'object' && e !== null && pred(e as Record<string, unknown>));
}

function entryKeys(e: Record<string, unknown>): string {
  return typeof e.keys === 'string' ? e.keys : '';
}

function entryInput(e: Record<string, unknown>): string {
  const c = e.command;
  if (typeof c === 'object' && c !== null) {
    const input = (c as Record<string, unknown>).input;
    if (typeof input === 'string') return input;
  }
  return '';
}

interface TerminalSetupResult {
  ok: boolean;
  /** 本次是否写盘（false=已配置幂等跳过 / 解析失败未动盘） */
  changed: boolean;
  backup?: string;
  settingsPath: string;
  message: string;
}

/** 单个 settings.json 的幂等配置：Shift+Enter→sendInput \x1b\r + Alt+Enter 解绑；写盘前备份原文件。
 *  解析失败（重度 JSONC/损坏）不动盘，message 带手动指引 */
export function configureWindowsTerminal(settingsPath: string): TerminalSetupResult {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8');
  } catch (e) {
    return { ok: false, changed: false, settingsPath, message: `read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const cfg = parseLoose(raw);
  if (cfg === undefined) {
    return {
      ok: false,
      changed: false,
      settingsPath,
      message: 'settings.json 解析失败（注释/格式超出口径）——请手动在 actions 数组加 {"command":{"action":"sendInput","input":"\\u001b\\r"},"keys":"shift+enter"}',
    };
  }
  const { key: arrayKey, list } = bindingsArray(cfg);
  let changed = false;
  if (!hasBinding(list, (e) => entryKeys(e) === 'shift+enter' && entryInput(e).includes('\u001b'))) {
    list.push(shiftEnterBinding());
    changed = true;
  }
  if (!hasBinding(list, (e) => entryKeys(e) === 'alt+enter' && (e.command === 'unbound' || (typeof e.command === 'object' && e.command !== null && (e.command as Record<string, unknown>).action === 'unbound')))) {
    list.push(altEnterUnbind());
    changed = true;
  }
  if (!changed) {
    return { ok: true, changed: false, settingsPath, message: 'already configured' };
  }
  const backup = `${settingsPath}.sunshinex.bak`;
  fs.writeFileSync(backup, raw);
  cfg[arrayKey] = list;
  fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2));
  return { ok: true, changed: true, backup, settingsPath, message: 'configured' };
}
