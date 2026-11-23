import { t } from './i18n';
import { fmtBytes } from './ui-util';
import type { CacheClearResp } from './connection-types';

/**
 * 缓存清理共享单点（2026-11-21 归档保留期/缓存清理线，技术债轮收敛）：daemon safe/显式档清理
 * + 壳浏览器 HTTP 缓存并行组合原在 StoragePane 与 App.clearCacheNow 两处手写（freed 求和与
 * toast 文案各自维护且已现分叉），两面收敛于此。壳侧 best-effort——浏览器 HTTP 缓存失败不挡
 * daemon 面（登录态不受影响，见 StoragePane http-cache 行说明）。
 */

/** daemon 档清理 + 壳 HTTP 缓存并行，返回 freed 字节与失败条数供展示层落文案。
 *  categories 缺省（全档清）才随行壳侧清理——行级单清不波及浏览器 HTTP 缓存（原 StoragePane 口径） */
export async function clearCacheAll(conn: { clearCache(categories?: string[]): Promise<CacheClearResp> }, categories?: string[]): Promise<{ freed: number; failed: number }> {
  const http = categories === undefined ? window.sunshinexWindow?.clearHttpCache?.().catch(() => undefined) : undefined; // 壳侧 best-effort
  const r = await conn.clearCache(categories);
  await http;
  return { freed: r.cleared.reduce((a, c) => a + c.freed, 0), failed: r.failed.length };
}

/** 清理结果展示文案单点（失败计数 > freed > 已净，三档；两面同词） */
export function cacheClearResultText(r: { freed: number; failed: number }): string {
  if (r.failed > 0) return t(`${r.failed} item(s) failed to clear`, `${r.failed} 项清理失败`);
  if (r.freed > 0) return t(`Cleared — freed ${fmtBytes(r.freed)}`, `已清理，释放 ${fmtBytes(r.freed)}`);
  return t('Cache is already clean', '缓存本来就很干净');
}
