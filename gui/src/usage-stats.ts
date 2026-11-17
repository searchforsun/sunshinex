/**
 * 用量统计显隐开关(2026-11-14 用户裁定「设置页加开关,gui 控制显示步数轮次和 tokens」):
 * 控制面=①上下文圆环弹层具体数字(关=只留百分比,首行总量恒显;轮次/步数行关=整行隐)
 * ②轮尾操作条步数+tokens ③运行状态行(主对话/子智能体转录页同件)步数+tokens
 * ④会话悬停卡/行 tooltip 轮次步数段。开=缺省(现行为)。
 * 结构同 dark-surfaces.ts:落根 html[data-usage-stats],持久与其余外观偏好同通路
 * (ui-pref-sync 双写);2026-11-17 起默认「关」——与普通态强制值一致(开发者模式开关不反向)。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from './ui-pref-sync';
import { onDeveloperModeChange, readDeveloperMode } from './developer-mode';

const LS_KEY = 'sunshinex.usage-stats';
const DATA_ATTR = 'usageStats';
const PREF_KEY = 'usageStats';

const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    // 2026-11-17 用户裁定「开关开=左侧内容开启」:缺省=关(与普通态强制值一致,开发者模式开关不再反向)
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

function readAttr(): boolean {
  return document.documentElement.dataset[DATA_ATTR] !== '0';
}

/** 有效值(2026-11-17 用户裁定「非开发者模式用量统计是关的」):普通态恒关,
 *  存储值仅在开发者模式开启时生效 */
export function readUsageStats(): boolean {
  return readDeveloperMode() ? readStored() : false;
}

function apply(on: boolean): void {
  applyAttr();
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

/** 有效值落根属性(存储值不动):普通态恒关 */
function applyAttr(): void {
  const root = document.documentElement;
  if (readUsageStats()) delete root.dataset[DATA_ATTR];
  else root.dataset[DATA_ATTR] = '0';
}

/** 开发者模式翻转:重落属性并重渲(存储值不动) */
onDeveloperModeChange(() => {
  applyAttr();
  for (const fn of listeners) fn();
});

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useUsageStats(): boolean {
  return useSyncExternalStore(subscribe, readAttr, readStored);
}
