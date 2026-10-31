import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage } from '../types';

/**
 * 图片引用回水(2026-10-31 images-cache 裁定的 wire 边界配对件):档/上下文里的用户图片附件是
 * 文件地址(<dataDir>/images-cache/<...>.png,见 serve/images-cache.ts),上游 vision 协议只收
 * dataURL/http URL——发请求前按地址读回 dataURL。只在 wire 边界回水,上下文/journal/快照仍是
 * 路径串(base64 不进上下文的裁定不破)。缺档/读失败保留原串(上游报格式错比静默丢图可诊)。
 * 进程级 memo(键=地址,内容寻址文件名永不变更):同图多轮重发零重复读盘。
 */
const MIME_OF_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};
const memo = new Map<string, string>();

/** 单图引用 → wire 可用 URL:dataURL/http(s) 原样;本地图片地址读回 dataURL;其余原样 */
export function imageRefToUrl(src: string): string {
  if (src.startsWith('data:') || /^https?:\/\//i.test(src)) return src;
  const hit = memo.get(src);
  if (hit !== undefined) return hit;
  const mime = MIME_OF_EXT[path.extname(src).toLowerCase()];
  if (mime === undefined) return src;
  try {
    const url = `data:${mime};base64,${fs.readFileSync(src).toString('base64')}`;
    memo.set(src, url);
    return url;
  } catch {
    return src;
  }
}

/** 消息列 user.images 回水(纯映射;无图消息引用原样) */
export function resolveImageRefs(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.role === 'user' && m.images !== undefined && m.images.length > 0 ? { ...m, images: m.images.map(imageRefToUrl) } : m));
}
