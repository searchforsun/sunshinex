/** Web 标签纯元数据(2026-10-26 二期分包拆层):registry 同步层(title/resolveKey)消费——
 *  WebTab 体整体 lazy 化后,纯函数不随 chunk 走(同步可用,零依赖倒挂) */

/** url 规范化:去首尾空白;无 :// 前缀(无 scheme)补 https:// */
export function normalizeWebUrl(raw: string): string {
  const t = raw.trim();
  return t.includes('://') ? t : `https://${t}`;
}

/** 页名推导:url → host(剥 www.;解析失败退原文)——标签条标题兜底/导航回写共用 */
export function webPageName(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}
