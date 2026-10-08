/**
 * 进程级警告过滤（用户 2026-10-08 裁定：SQLite 实验横幅污染 TUI 启动渲染面）。
 * 仅滤 Node 内建 node:sqlite 的 ExperimentalWarning 这一条；其余警告（废弃/安全/自定义）
 * 原样透出——不做全局静音（--no-warnings 会掩盖真问题）。
 * 用法：作为入口模块的**首个 import**（ESM 按序执行，本模块体先于后续 import 链运行——
 * node:sqlite 的警告在首次 require 时发射，过滤必须在此之前就位）。
 */
type EmitWarningArgs = [warning: string | Error, type?: string, ctor?: unknown, arg?: unknown];

const rawEmitWarning: (typeof process)['emitWarning'] = process.emitWarning.bind(process);

function isSqliteExperimental(warning: string | Error, type: unknown): boolean {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  return (type === 'ExperimentalWarning' || text.includes('experimental feature')) && /sqlite/i.test(text);
}

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  // process.emitWarning 重载：(warning, type, ctor?, arg?) 或 (warning, options?)——type 位取第二参
  try {
    if (isSqliteExperimental(warning, rest[0])) return;
  } catch {
    /* 判定失败即透出，不做静默吞 */
  }
  return (rawEmitWarning as (...a: EmitWarningArgs) => void)(warning, rest[0] as string | undefined, rest[1], rest[2]);
}) as typeof process.emitWarning;
