/**
 * 产物卡显隐开关(2026-11-16 用户裁定「设置页可以控制产物显隐开关」):关=正文轮末产物卡区
 * 整块不渲染(产物仍登记在 runmeta,产物库页签/回放/端点面不受影响——只收渲染层)。
 * 结构同 usage-stats.ts / dark-surfaces.ts:落根 html[data-artifact-cards],持久与其余外观偏好
 * 同通路(ui-pref-sync 双写);缺省「开」(现行为)。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from './ui-pref-sync';

const LS_KEY = 'sunshinex.artifact-cards';
const DATA_ATTR = 'artifactCards';
const PREF_KEY = 'artifactCards';

const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return localStorage.getItem(LS_KEY) !== '0';
  } catch {
    return true;
  }
}

function readAttr(): boolean {
  return document.documentElement.dataset[DATA_ATTR] !== '0';
}

export function readArtifactCards(): boolean {
  return readStored();
}

function apply(on: boolean): void {
  const root = document.documentElement;
  if (on) delete root.dataset[DATA_ATTR];
  else root.dataset[DATA_ATTR] = '0';
  try {
    localStorage.setItem(LS_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
  notifyUiPref(PREF_KEY, on ? '1' : '0');
  for (const fn of listeners) fn();
}

export function applyArtifactCards(on: boolean): void {
  apply(on);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useArtifactCards(): boolean {
  return useSyncExternalStore(subscribe, readAttr, readStored);
}
