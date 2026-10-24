/**
 * 权限档（2026-10-24 重构，spec docs/superpowers/specs/2026-10-24-plan-mode-redesign-design.md §3.1）：
 * - read-only：仅非变异操作放行（Read/Grep/Glob + ask_question/todo_write/worktree list），拒绝消息带出路提示；
 * - acceptEdits：信任域内 Write/Edit 直放、域外写与命令类 ask（沿原 manual 语义，正名）；
 * - full-access：未 deny 一律自动放行（deny 规则与破坏性底线保留；沿原 dontAsk 语义，正名——
 *   CC 的 dontAsk=「该问不问直接拒」，勿再混用该词）。
 * plan 不是档：它是流程标记（planFlow），权限面由流程临时覆盖 read-only 承载。
 */
export type PermissionMode = 'read-only' | 'acceptEdits' | 'full-access';

/** read-only 档拒绝文案单点（guard 只读闸门/worktree 分支与 chain 写分支共用，防漂移；括号内即出路提示） */
export const READONLY_DENY = 'COMMAND_DENIED: read-only mode allows read-only operations only (ask the user to switch permission modes to make changes)';

/** 安全链规范名族（tools.ts CANONICAL_TOOL_NAMES 映射后的形态，guard/chain 共用单一权威）：
 *  PATH=需路径边界判界的文件工具；WRITE=文件写入/编辑两件(write/edit)——settings/.git/记忆窄口/worktree 主根四道硬底线、
 *  链侧写审批 kind 与 guard 路径形直放按同套安全语义判定（防「换名绕过硬底线」；工具身份各自独立——
 *  write=写入整稿,edit=编辑定点替换,共享的只是文件改写的安全不变量） */
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

/** 旧档/别名兼容层已摘除（2026-10-24 用户裁定「不要有兼容逻辑,旧会话记录可以删」）：
 *  meta 旁车 mode 回放只认现值三档,旧值/未知回落缺省档+warn（daemon.ts 装载序）,沿 MANUAL-GUI
 *  「不保旧档」开发期先例;'plan' 是流程标记非档,照写不照回——arm 不跨重启（spec §5.2）。 */
