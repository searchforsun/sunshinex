import type { CliArgs } from './index';
import { createWorktree, randomWorktreeName } from '../harness/worktree';
import { resolveDataDir } from '../config/data-dir';

/**
 * 入口一接缝（计划 T3，规格 §7/D5）：--worktree 启动旗标的装配前解析单点。
 * 调用时序 = path.resolve(dir) 之后、buildDeps/SessionController 装配之前；返回值替换 root，
 * 既有装配链零改动全量继承。非旗标调用恒等返回（root 原样、零副作用）。
 * 红/绿实现仅此一处：run 与 tui 两入口各自一行接线，禁在入口内散写创建逻辑（防两处漂移）。
 */
export function resolveWorktreeLaunchRoot(args: CliArgs, root: string): string {
  if (args.flags.worktree === undefined) return root;
  // 互斥（规格 §7）：恢复会话的活动 root 属会话自身事实，跨旗标拼接产生歧义——fail-fast 双旗标提示
  if (args.flags['continue'] === true) {
    throw new Error('--continue and --worktree are mutually exclusive: resume keeps the session root, --worktree starts a fresh isolated tree');
  }
  const raw = args.flags.worktree;
  const name = raw === true ? randomWorktreeName() : String(raw);
  const r = createWorktree(root, resolveDataDir(root), name);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.path;
}
