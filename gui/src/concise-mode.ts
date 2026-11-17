/**
 * 简洁模式(2026-11-14 用户裁定「设置页提供简洁模式」):两阶段正文之间的工具/思考行段外面
 * 再加一层段级折叠——折叠头=交织双方形图标+各类调用总结(查阅了文件 · 运行了命令 · 修改了
 * 文件…),展开后露出既有段内聚合(查阅 ×N 组)为第二层;运行中只显正在运行的一行(流光),
 * 跑完向上并入折叠行(纯渲染层识别)。逃逸面(不进折叠层,恒独立行)=子智能体 spawn、智能体
 * 团队/成员/板面工具、交互问询 ask_question、计划提交 exit_plan、工作树 worktree、任务停止——
 * 影响大/有交互/用户核心关注点的行不折叠;其余(查阅/命令/网页/编辑/技能/记忆/待办/等待/思考)
 * 全部并入。结构同 usage-stats.ts:LS+根 data 属性+ui-pref-sync 双写,默认开(2026-11-17 裁定:与普通态强制值一致)。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from './ui-pref-sync';
import { onDeveloperModeChange, readDeveloperMode } from './developer-mode';

const LS_KEY = 'sunshinex.concise-mode';
const DATA_ATTR = 'conciseMode';
const PREF_KEY = 'conciseMode';

const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    // 2026-11-17 用户裁定「开关开=左侧内容开启」:缺省=开(与普通态强制值一致,开发者模式开关不再反向)
    return localStorage.getItem(LS_KEY) !== '0';
  } catch {
    return true;
  }
}

function readAttr(): boolean {
  return document.documentElement.dataset[DATA_ATTR] === '1';
}

/** 有效值(2026-11-17 用户裁定「非开发者模式下肯定是简洁模式」):普通态恒开,
 *  存储值仅在开发者模式开启时生效 */
export function readConciseMode(): boolean {
  return readDeveloperMode() ? readStored() : true;
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

export function applyConciseMode(on: boolean): void {
  apply(on);
}

/** 有效值落根属性(存储值不动):普通态恒开 */
function applyAttr(): void {
  const root = document.documentElement;
  if (readConciseMode()) root.dataset[DATA_ATTR] = '1';
  else delete root.dataset[DATA_ATTR];
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

export function useConciseMode(): boolean {
  return useSyncExternalStore(subscribe, readAttr, readStored);
}
