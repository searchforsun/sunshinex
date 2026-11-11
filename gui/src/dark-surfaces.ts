/**
 * 暗色气泡/暗色代码(2026-11-12 用户裁定,外观设置两项):亮色模式下两组面改用暗色主题色——
 * 暗色气泡=用户气泡;暗色代码=代码块/文件源码视图/工具行 diff 预览。
 * 落根 html[data-bubble-dark]/[data-code-dark](CSS 覆写块的切换面,只在 [data-theme='light']
 * 下生效=暗色主题下开关无感);外部 store 同 ui-mode 先例(转录 memo 组件穿透重渲);
 * 持久与其余外观偏好同通路(ui-pref-sync 双写)。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from './ui-pref-sync';

export type DarkSurfaceKey = 'bubbles' | 'code';

const LS_KEYS: Record<DarkSurfaceKey, string> = {
  bubbles: 'sunshinex.dark-bubbles',
  code: 'sunshinex.dark-code',
};
const DATA_ATTRS: Record<DarkSurfaceKey, 'bubbleDark' | 'codeDark'> = {
  bubbles: 'bubbleDark',
  code: 'codeDark',
};
const PREF_KEYS: Record<DarkSurfaceKey, 'darkBubbles' | 'darkCode'> = {
  bubbles: 'darkBubbles',
  code: 'darkCode',
};

const listeners = new Set<() => void>();

function readStored(key: DarkSurfaceKey): boolean {
  try {
    return localStorage.getItem(LS_KEYS[key]) === '1';
  } catch {
    return false;
  }
}

function readAttr(key: DarkSurfaceKey): boolean {
  return document.documentElement.dataset[DATA_ATTRS[key]] === '1';
}

export function readDarkBubbles(): boolean {
  return readStored('bubbles');
}
export function readDarkCode(): boolean {
  return readStored('code');
}

function apply(key: DarkSurfaceKey, on: boolean): void {
  const root = document.documentElement;
  if (on) root.dataset[DATA_ATTRS[key]] = '1';
  else delete root.dataset[DATA_ATTRS[key]];
  try {
    localStorage.setItem(LS_KEYS[key], on ? '1' : '0');
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
  notifyUiPref(PREF_KEYS[key], on ? '1' : '0');
  for (const fn of listeners) fn();
}

export function applyDarkBubbles(on: boolean): void {
  apply('bubbles', on);
}
export function applyDarkCode(on: boolean): void {
  apply('code', on);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useDarkBubbles(): boolean {
  return useSyncExternalStore(subscribe, readAttr.bind(null, 'bubbles'), readDarkBubbles);
}
export function useDarkCode(): boolean {
  return useSyncExternalStore(subscribe, readAttr.bind(null, 'code'), readDarkCode);
}

/** 暗色代码强制面(Monaco/取值侧读不了 CSS 覆写块):亮色主题 + 开关在座 */
export function codeDarkForced(): boolean {
  const root = document.documentElement;
  return root.dataset.codeDark === '1' && root.dataset.theme === 'light';
}
