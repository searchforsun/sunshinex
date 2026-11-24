/**
 * 中性入口共享叶（D80④）：cli/tui 两入口共用的最小面，住在两域之下——tui 引此不触 cli/，
 * cli 引此不触 tui/，入口层互指边在此收口为零。现载三件：CliArgs 形、可重复 flag 归一
 * （flagList）、--worktree 启动旗标装配前解析（resolveWorktreeLaunchRoot）。
 */
import { createWorktree, randomWorktreeName } from './harness/worktree';
import { resolveDataDir } from './config/data-dir';

/** CLI 参数解析：仅内置约定，零依赖。--flag=v 或 --flag v → 字符串；--flag（末尾无值）→ true；其余为 positional。
 *  可重复 flag（REPEATABLE_FLAGS，spec 5.3 --add-dir）：多次出现收集为 string[]，其余同前 */
export interface CliArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** 可重复 flag 取值归一（spec 5.3 --add-dir）：单值/数组/缺省统一 string[] */
export function flagList(flags: CliArgs['flags'], name: string): string[] {
  const v = flags[name];
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (Array.isArray(v)) return v;
  return [];
}

/**
 * 入口一接缝（计划 T3，规格 §7/D5）：--worktree 启动旗标的装配前解析单点。
 * 调用时序 = path.resolve(dir) 之后、buildDeps/SessionController 装配之前；返回值替换 root，
 * 既有装配链零改动全量继承。非旗标调用恒等返回（root 原样、零副作用）。
 * 红/绿实现仅此一处：run 与 tui 两入口各自一行接线，禁在入口内散写创建逻辑（防两处漂移）。
 */
export function resolveWorktreeLaunchRoot(args: CliArgs, root: string): string {
  if (args.flags.worktree === undefined) return root;
  // 互斥（规格 §7）：恢复会话的活动 root 属会话自身事实，跨旗标拼接产生歧义——fail-fast 双旗标提示
  if (args.flags['continue'] === true || args.flags.resume !== undefined) {
    const other = args.flags['continue'] === true ? '--continue' : '--resume';
    throw new Error(`${other} and --worktree are mutually exclusive: resume keeps the session root, --worktree starts a fresh isolated tree`);
  }
  const raw = args.flags.worktree;
  const name = raw === true ? randomWorktreeName() : String(raw);
  const r = createWorktree(root, resolveDataDir(root), name);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.path;
}
