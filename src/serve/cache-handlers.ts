import type * as http from 'node:http';

/**
 * /cache 端点族 handler(2026-11-21 spec §5):io 注入形(SessionHandlerIo 同款薄接缝)——
 * status/clear/retentionInfo 由 daemon 供真实现(cache-inventory + retention state),
 * 测试可换 tmp 桩;daemon 回执恒英文(§15),双语标签由 GUI 按 id 映射。
 */

export interface CacheRetentionInfo {
  days: number;
  lastRunAt: number | null;
  lastPurged: number;
  lastFailed: number;
}

export interface CacheHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  status(): { total: number; categories: Array<{ id: string; safe: boolean; size: number; files: number }> };
  retentionInfo(): CacheRetentionInfo;
  clear(ids?: string[]): { cleared: Array<{ id: string; freed: number }>; failed: Array<{ id: string; error: string }> };
}

export function handleCacheStatus(io: CacheHandlerIo, res: http.ServerResponse): void {
  io.send(res, 200, { ...io.status(), retention: io.retentionInfo() });
}

export async function handleCacheClear(io: CacheHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const raw = (parsed.body as { categories?: unknown }).categories;
  if (raw !== undefined && (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string'))) {
    return io.send(res, 400, { error: 'categories must be an array of strings' });
  }
  io.send(res, 200, io.clear(raw as string[] | undefined));
}
