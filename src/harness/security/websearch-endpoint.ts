/** 搜索引擎端点解析（零依赖模块）：guard 域名闸门与搜索 Provider 同源取值，避免双轨口径漂移 */

export const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
export const BING_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search';
export const BING_HTML_ENDPOINT = 'https://cn.bing.com/search'; // Bing 网页版(国内可达,无 key;HTML 刮取)

/** SUNSHINEX_WEBSEARCH_PROVIDER=bing 切 Bing API，=duckduckgo 切 DDG HTML；**缺省 bing-html**
 *  (2026-11-01 用户裁定:缺省=国内可达路径——DDG 境外端点被网关拦实测超时,cn.bing.com 实测 200) */
export function isBingMode(): boolean {
  return (process.env.SUNSHINEX_WEBSEARCH_PROVIDER ?? '').toLowerCase() === 'bing';
}

export function isDdgMode(): boolean {
  return (process.env.SUNSHINEX_WEBSEARCH_PROVIDER ?? '').toLowerCase() === 'duckduckgo';
}

export function isBingHtmlMode(): boolean {
  return !isBingMode() && !isDdgMode(); // 缺省(未配/他值)=bing-html
}

/** 引擎端点（单一权威）：SUNSHINEX_WEBSEARCH_ENDPOINT 覆盖优先（自托管/测试注入本地 mock）；否则按 SUNSHINEX_WEBSEARCH_PROVIDER 选型 */
export function resolveWebSearchEndpoint(): string {
  const override = process.env.SUNSHINEX_WEBSEARCH_ENDPOINT;
  if (override) return override;
  return isBingMode() ? BING_ENDPOINT : isDdgMode() ? DDG_ENDPOINT : BING_HTML_ENDPOINT;
}
