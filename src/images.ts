/**
 * 图片附件共享面（2026-10-26 图片功能；serve HTTP 面与 TUI 剪贴板面共用单源）：
 * dataURL 形态（`data:image/<fmt>;base64,<b64>`，≤8 张）自交互面起原样贯穿转录条目/链行/wire
 * image_url 块，任何一层不再二次转码。常量与校验此前散在 serve/session-handlers，TUI 需要同值
 * 钳制后上收本件（serve 面原路径再导出，消费方零改动）。
 */

/** 单条消息图片上限（GUI/TUI/daemon HTTP 面同值；超出拒收并提示） */
export const MAX_IMAGES = 8;
/** 单张图片 dataURL 字符上限（≈6MB 二进制）：交互面压缩后正常远低于此；防单张巨型载荷 */
export const MAX_IMAGE_CHARS = 8 * 1024 * 1024;
/** dataURL 形态校验（png/jpeg/webp/gif；交互端产物恒此四类） */
export const IMAGE_DURL_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
/** 降采样长边（vision 端点惯例 ≤1568px）：GUI 装载面与插件 server 生产者同规范——视觉端点友好口径 */
export const IMAGE_MAX_EDGE = 1568;
/** 降采样 JPEG 质量：GUI 装载面与插件 server 生产者同规范——视觉端点友好口径 */
export const IMAGE_JPEG_QUALITY = 0.85;

/** 提交载荷 images 字段净化：合法回 dataURL 串数组（原样贯穿）；非法回错误文案（调用方按 400/提示面承接） */
export function parseImagesParam(raw: unknown): { ok: true; images?: string[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: 'images must be an array of data URLs' };
  if (raw.length > MAX_IMAGES) return { ok: false, error: `too many images (max ${MAX_IMAGES})` };
  for (const img of raw) {
    if (typeof img !== 'string' || !IMAGE_DURL_RE.test(img)) return { ok: false, error: 'images must be data:image/{png|jpeg|webp|gif};base64,... URLs' };
    if (img.length > MAX_IMAGE_CHARS) return { ok: false, error: 'image too large (max 6MB each)' };
  }
  return { ok: true, images: raw.length > 0 ? (raw as string[]) : undefined };
}

/** [Image N] 占位标记串（TUI 转录行与输入 chips 共用；Claude Code 对标形态）：`[Image 1] [Image 2] …` */
export function imageMarkers(count: number): string {
  return Array.from({ length: Math.max(0, count) }, (_, i) => `[Image ${i + 1}]`).join(' ');
}

/** 追加钳制：合并后超出 MAX_IMAGES 即截断，返回溢出张数（调用方出「最多 8 张」提示） */
export function appendImages(current: readonly string[], incoming: readonly string[]): { images: string[]; overflow: number } {
  const merged = [...current, ...incoming].slice(0, MAX_IMAGES);
  return { images: merged, overflow: current.length + incoming.length - merged.length };
}
