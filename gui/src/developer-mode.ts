/**
 * 开发者模式(2026-11-17 用户裁定「使用一个开关就可以控制,可以说是开发者模式」):
 * 关=C 端简洁界面(隐藏终端/高级设置/工程详情类入口);开=完整工程能力。
 * 单一布尔贯穿全产品,不设子开关。持久与其余外观偏好同通路(ui-pref-sync 双写:
 * localStorage 即时层 + /app/gui-state 公共档);html[data-developer-mode] 同步落值供样式面。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from './ui-pref-sync';

const LS_KEY = 'sunshinex.developer-mode';
const DATA_ATTR = 'developerMode';
const PREF_KEY = 'developerMode';

const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

export function readDeveloperMode(): boolean {
  return readStored();
}

function apply(on: boolean): void {
  const root = document.documentElement;
  if (on) root.dataset[DATA_ATTR] = '1';
  else delete root.dataset[DATA_ATTR];
  try {
    localStorage.setItem(LS_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
  notifyUiPref(PREF_KEY, on ? '1' : '0');
  for (const fn of listeners) fn();
}

export function applyDeveloperMode(on: boolean): void {
  apply(on);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useDeveloperMode(): boolean {
  return useSyncExternalStore(subscribe, readStored, readStored);
}
