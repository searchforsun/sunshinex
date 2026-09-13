/** token 数紧凑显示：≥1000 记 k（1200 → 1.2k；12345 → 12k），负值/非有限值按 0 收束 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}
