/**
 * 权限模式：
 * - manual：询问用户（阶段一 CLI 未实现交互，降级为只读白名单放行、写操作拒绝）
 * - plan：仅只读操作放行
 * - dontAsk：不询问，自动批准未 deny 的操作（deny 规则仍拦截）——「最大权限」，供稳定测试/受信场景
 */
export type PermissionMode = 'manual' | 'plan' | 'dontAsk';

/** 安全链规范名族（tools.ts CANONICAL_TOOL_NAMES 映射后的形态，guard/chain 共用单一权威）：
 *  PATH=需路径边界判界的文件工具；WRITE=写族——settings/.git/记忆窄口/worktree 主根四道硬底线、
 *  链侧写审批 kind 与 guard 路径形直放按族判定（edit 与 write 同族同保护，防「换名绕过硬底线」） */
export const PATH_TOOL_NAMES = new Set(['Read', 'Write', 'Edit', 'Grep']);
export const WRITE_TOOL_NAMES = new Set(['Write', 'Edit']);

/** 只读命令内置集（默认 allow） */
export const READONLY_WHITELIST = [
  'ls', 'cat', 'pwd', 'grep', 'find', 'head', 'tail', 'wc', 'which', 'diff', 'stat', 'du', 'cd', 'echo',
];

/** 破坏性命令清单：首 token basename 精确匹配（安全底线，任何权限模式生效，allow 规则不豁免） */
export const DESTRUCTIVE_COMMANDS = ['dd', 'fdisk', 'shutdown', 'reboot', 'poweroff', 'halt'];

/** 下载执行管道模式：curl/wget 输出直接交 shell 执行 */
export const DESTRUCTIVE_PIPE = /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/;
