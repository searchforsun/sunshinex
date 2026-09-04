/**
 * 权限模式：
 * - manual：询问用户（阶段一 CLI 未实现交互，降级为只读白名单放行、写操作拒绝）
 * - plan：仅只读操作放行
 * - dontAsk：不询问，自动批准未 deny 的操作（deny 规则仍拦截）——「最大权限」，供稳定测试/受信场景
 */
export type PermissionMode = 'manual' | 'plan' | 'dontAsk';

/** 只读命令内置集（默认 allow） */
export const READONLY_WHITELIST = [
  'ls', 'cat', 'pwd', 'grep', 'find', 'head', 'tail', 'wc', 'which', 'diff', 'stat', 'du', 'cd', 'echo',
];
