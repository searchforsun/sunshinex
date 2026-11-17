/**
 * 会话信息卡显隐开关(2026-11-17 用户裁定「会话信息卡,也在普通模式下不显示,开发者默认开,同样放到 diff 下」):
 * 关=侧栏会话行悬浮信息卡(会话名/路径/分支/轮次步数/建档时刻)不渲染。
 * 有效值:开发者模式开=存储值(缺省开);普通态=恒关(设置行亦不渲染)。
 * 结构同 change-cards.ts:LS+ui-pref-sync 双写+useSyncExternalStore。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from './ui-pref-sync';
import { onDeveloperModeChange, readDeveloperMode } from './developer-mode';

const LS_KEY = 'sunshinex.session-info-cards';
const PREF_KEY = 'sessionInfoCards';

const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return localStorage.getItem(LS_KEY) !== '0';
  } catch {
    return true;
  }
}

/** 有效值:普通态恒关,开发者模式开时按存储值(缺省开) */
export function readSessionInfoCards(): boolean {
  return readDeveloperMode() ? readStored() : false;
}

function apply(on: boolean): void {
  try {
    localStorage.setItem(LS_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
  notifyUiPref(PREF_KEY, on ? '1' : '0');
  for (const fn of listeners) fn();
}

export function applySessionInfoCards(on: boolean): void {
  apply(on);
}

/** 开发者模式翻转:有效值随之变化,重渲消费面(存储值不动) */
onDeveloperModeChange(() => {
  for (const fn of listeners) fn();
});

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSessionInfoCards(): boolean {
  return useSyncExternalStore(subscribe, readSessionInfoCards, readSessionInfoCards);
}
