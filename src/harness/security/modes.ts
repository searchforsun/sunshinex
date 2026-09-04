export type PermissionMode = 'manual' | 'plan' | 'dontAsk';

/** 只读命令内置集（默认 allow） */
export const READONLY_WHITELIST = [
  'ls', 'cat', 'pwd', 'grep', 'find', 'head', 'tail', 'wc', 'which', 'diff', 'stat', 'du', 'cd',
];
