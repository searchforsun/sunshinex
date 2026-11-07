/**
 * 主会话收件身份(团队消息 to/from、teammate 保留名、主会话气泡过滤共用)。零依赖叶模块:session/entry
 * 经 GUI chat-reducer 进浏览器包,teammate.ts 带 fs/path/worktree 等 Node 依赖——常量放这里才不把
 * Node 模块拖进 vite 构建(2026-11-08 构建失败根因)。
 */
export const LEADER_RECIPIENT = 'leader';
