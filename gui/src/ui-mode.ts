/**
 * 界面模式(2026-11-07 用户裁定,外观设置项):编程模式(缺省=现状)显示命令、输出与代码变更详情;
 * 办公模式面向无编程基础用户,侧重操作摘要与结果——工具行数量与编程模式一致(多行聚合组照常可
 * 展开),单个工具行不可展开细节、只显动词头(可跳转行保留链接,文件行去 +/- 统计;等待后台任务行
 * 不显跳转,等待团队任务保留),记忆/技能更新旁白与轮尾代码变动条隐藏。侧栏跳转入口保留。
 *
 * 外部 store(useSyncExternalStore):转录行多为 memo 组件,模式切换须穿透 memo 即时重渲;
 * html[data-ui-mode] 同步落值供样式面使用。持久与其余外观偏好同通路(ui-pref-sync)。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from './ui-pref-sync';

export type UiMode = 'code' | 'office';

const KEY = 'sunshinex.ui-mode';
const listeners = new Set<() => void>();
let current: UiMode = readStored();

function readStored(): UiMode {
  try {
    return localStorage.getItem(KEY) === 'office' ? 'office' : 'code';
  } catch {
    return 'code';
  }
}

export function readUiMode(): UiMode {
  return current;
}

export function applyUiMode(mode: UiMode): void {
  current = mode;
  document.documentElement.dataset.uiMode = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
  notifyUiPref('uiMode', mode);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useUiMode(): UiMode {
  return useSyncExternalStore(subscribe, readUiMode, readUiMode);
}

/** 办公模式下保留完整折叠行的工具(行内有跳转链接:文件/子智能体/团队/任务/计划/待办)或用户交互行(问询);
 *  其余工具行只显动词头。task_wait(后台任务)不在列——办公模式不显后台任务跳转(2026-11-07 用户裁定) */
const OFFICE_STANDALONE = new Set([
  'write', 'edit',
  'spawn', 'create_agent_teammate', 'create_agent_team', 'create_agent_team_task',
  'get_agent_team_board', 'agent_team_task_wait',
  'task_stop', 'agent_team_task_stop', 'update_agent_team_task', 'assign', 'set_dependency', 'get_task',
  'exit_plan', 'todo_write', 'ask_question',
]);

export function isOfficeStandaloneTool(name: string | undefined): boolean {
  return name !== undefined && OFFICE_STANDALONE.has(name);
}

/** 办公模式隐藏的旁白:记忆/技能更新(daemon notice 前缀) */
export function isOfficeHiddenNotice(kind: string, md: string): boolean {
  return kind === 'notice' && (md.startsWith('[memory]') || md.startsWith('[skills]'));
}
