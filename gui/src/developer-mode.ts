/**
 * 开发者模式(2026-11-17 用户裁定「使用一个开关就可以控制,可以说是开发者模式」):
 * 关=C 端简洁界面(隐藏终端/高级设置/工程详情类入口);开=完整工程能力。
 * 单一布尔贯穿全产品,不设子开关。持久与其余外观偏好同通路(ui-pref-sync 双写:
 * localStorage 即时层 + /app/gui-state 公共档);html[data-developer-mode] 同步落值供样式面。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from './ui-pref-sync';
import { bindBooleanPrefDevSource } from './ui-pref-boolean';

const LS_KEY = 'sunshinex.developer-mode';
const DATA_ATTR = 'developerMode';
const PREF_KEY = 'developerMode';

const listeners = new Set<() => void>();
/** 模式派生偏好的依赖回调(办公/简洁/用量统计等):开发者模式翻转时重算有效值并重渲。
 *  各模块自行注册并落根属性,避免跨模块 import 环。 */
const depListeners = new Set<() => void>();

/** 注册模式派生依赖(返回退订) */
export function onDeveloperModeChange(fn: () => void): () => void {
  depListeners.add(fn);
  return () => depListeners.delete(fn);
}

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
  for (const fn of depListeners) fn();
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

// 布尔偏好工厂（ui-pref-boolean，D84）的模式派生源回填：本模块装载即接线（工厂体先于本模块
// 求值，devGated 闭包在列待接——依赖方向 dev→sync→factory 为 DAG，见工厂头注）
bindBooleanPrefDevSource({ read: readDeveloperMode, onChange: onDeveloperModeChange });
