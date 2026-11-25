/**
 * 快捷键覆盖档(2026-11-25 调研轮):动作 id → 用户自定义键串(''=已清除,显示「无」)。
 * 持久与字号/主题同通路(ui-pref-sync 三登记点):localStorage 即时层(sunshinex.shortcuts,
 * 值=JSON 串)+ /app/gui-state 公共档双写(浏览器/壳跨端共用);远端权威值经
 * use-appearance-sync 注入 applyShortcutOverridesRemote 回灌。
 * resolve = 覆盖 ?? 默认(registry 单一数据源);重置=删覆盖项回落默认表——与 Claude Code
 * keybindings.json 同口径(删条目即默认,不另存默认副本)。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from '../ui-pref-sync';
import { SHORTCUT_DEFS } from './registry';
import type { ShortcutId } from './registry';

const LS_KEY = 'sunshinex.shortcuts';
type Overrides = Readonly<Record<string, string>>;

/** 覆盖档白名单解析(键必须是注册表已知动作 id、值必须是字符串;坏档整表忽略) */
function parseOverrides(raw: unknown): Overrides {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && SHORTCUT_DEFS.some((d) => d.id === k)) out[k] = v;
  }
  return out;
}

function readLocal(): Overrides {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null || raw === '') return {};
    return parseOverrides(JSON.parse(raw));
  } catch {
    return {};
  }
}

let overrides: Overrides = readLocal();
const subs = new Set<() => void>();
/** 录制态旗(ShortcutsPane 改键中):集中分发器见旗让位,防录制按键误触全局动作 */
let capturing = false;

function commit(next: Overrides): void {
  overrides = next;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
  notifyUiPref('shortcuts', JSON.stringify(next));
  for (const fn of subs) fn();
}

/** 远端公共档回灌(use-appearance-sync 注入;本地落盘由 ui-pref-sync flush 统一做,此处仅内存态)。
 *  整表替换:公共档即权威,末写胜 */
export function applyShortcutOverridesRemote(value: string): void {
  let next: Overrides;
  try {
    next = parseOverrides(JSON.parse(value));
  } catch {
    return;
  }
  overrides = next;
  for (const fn of subs) fn();
}

/** 生效键串(覆盖 ?? 默认;''=用户已清除 → null) */
export function resolveShortcutKeys(id: ShortcutId): string | null {
  const o = overrides[id];
  if (o !== undefined) return o === '' ? null : o;
  const def = SHORTCUT_DEFS.find((d) => d.id === id);
  return def !== undefined && def.keys !== '' ? def.keys : null;
}

function defaultKeys(id: ShortcutId): string {
  return SHORTCUT_DEFS.find((d) => d.id === id)?.keys ?? '';
}

/** 冲突检测:该键串已绑在其他动作上 → 返回该动作 id(exceptId 自身豁免) */
export function shortcutConflict(combo: string, exceptId?: ShortcutId): ShortcutId | null {
  if (combo === '') return null;
  for (const d of SHORTCUT_DEFS) {
    if (d.id === exceptId) continue;
    if (resolveShortcutKeys(d.id) === combo) return d.id;
  }
  return null;
}

/** 写覆盖(与默认同值=删项回落;''=清除绑定) */
export function setShortcutOverride(id: ShortcutId, combo: string): void {
  const next: Record<string, string> = { ...overrides };
  if (combo === defaultKeys(id)) delete next[id];
  else next[id] = combo;
  commit(next);
}

/** 单条重置(删覆盖项回默认;无覆盖即空操作) */
export function resetShortcut(id: ShortcutId): void {
  if (overrides[id] === undefined) return;
  const next: Record<string, string> = { ...overrides };
  delete next[id];
  commit(next);
}

/** 全部重置(清空覆盖档;无覆盖即空操作) */
export function resetAllShortcuts(): void {
  if (Object.keys(overrides).length === 0) return;
  commit({});
}

export function isShortcutOverridden(id: ShortcutId): boolean {
  return overrides[id] !== undefined;
}

export function setShortcutCapturing(on: boolean): void {
  capturing = on;
}

export function isShortcutCapturing(): boolean {
  return capturing;
}

/** 订阅覆盖档变化(设置页/侧栏角标重渲) */
export function subscribeShortcuts(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** 生效键串响应式(侧栏角标等单键消费;基本不变更,零重渲常态) */
export function useShortcutKeys(id: ShortcutId): string | null {
  return useSyncExternalStore(subscribeShortcuts, () => resolveShortcutKeys(id));
}

/** 覆盖档快照(设置页:行级重置钮/全部重置显隐) */
export function useShortcutOverrides(): Overrides {
  return useSyncExternalStore(subscribeShortcuts, () => overrides);
}
