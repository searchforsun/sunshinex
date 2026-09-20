/** token 数紧凑显示：≥1000 记 k（1200 → 1.2k；12345 → 12k），负值/非有限值按 0 收束 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}

/** 可读时长：秒 → 分段 h/m/s（<1m 只显秒 59s；跨分含分 10m 2s；跨时 1h 21m 30s），负值/非有限值按 0 收束 */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0s';
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
