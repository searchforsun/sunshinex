import type { TabTypeId } from './tab-state';

/** 正文/顶栏打开即刷：这些页签类型支持刷新 */
export const REFRESHABLE_TAB_TYPES: ReadonlySet<TabTypeId> = new Set([
  'agents',
  'bgtasks',
  'tasks',
  'memory',
  'learned',
  'artifacts',
  'sunxboard', // SUNX 总览页(2026-11-15 sunx P2 Task 8):懒快照视图,打开即拉一次
]);
