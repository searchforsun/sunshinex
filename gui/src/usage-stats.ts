/**
 * 用量统计显隐开关(2026-11-14 用户裁定「设置页加开关,gui 控制显示步数轮次和 tokens」):
 * 控制面=①上下文圆环弹层具体数字(关=只留百分比,首行总量恒显;轮次/步数行关=整行隐)
 * ②轮尾操作条步数+tokens ③运行状态行(主对话/子智能体转录页同件)步数+tokens
 * ④会话悬停卡/行 tooltip 轮次步数段。开=缺省(现行为)。
 * 结构同 dark-surfaces.ts:落根 html[data-usage-stats],持久与其余外观偏好同通路
 * (ui-pref-sync 双写);开关默认「开」——存储缺键/非法值一律按显。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from './ui-pref-sync';

const LS_KEY = 'sunshinex.usage-stats';
const DATA_ATTR = 'usageStats';
const PREF_KEY = 'usageStats';

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

export function readUsageStats(): boolean {
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

export function applyUsageStats(on: boolean): void {
  apply(on);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useUsageStats(): boolean {
  return useSyncExternalStore(subscribe, readAttr, readStored);
}
