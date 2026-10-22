/**
 * UTC 紧凑时间戳单点（tasks 后台任务 id / session-journal 会话 id 两方言共用）：形如
 * `20261022T083045Z`——UTC 逐段两位补零、文件名安全、字典序即时间序。此前两处手写同构
 * 模板逐字漂移风险高（任务 id 与会话 id 的可排序契约同源，段宽改动必须两侧同频）。
 */
export function utcCompactStamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}
