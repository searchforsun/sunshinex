/**
 * G8e-T2 共享 UI 小工具:relTime/errText 原三处本地复制(SettingsForm/SettingsShell/
 * ProjectMenu)抽一单源——行为逐字保持,既有测试面零破。
 */

/** 相对时间(简易,纯刻度不带后缀):<60s 刚刚;<60m Nm;<24h Nh;否则 Nd */
export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/** 错误文案归一:Error.message 优先,否则 String(err)(Promise 拒因透出行内错误条) */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
