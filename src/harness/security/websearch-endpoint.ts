/** 搜索引擎端点解析（零依赖模块）：guard 域名闸门与搜索 Provider 同源取值，避免双轨口径漂移 */

export const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
export const BING_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search';
export const BING_HTML_ENDPOINT = 'https://cn.bing.com/search'; // Bing 网页版(国内可达,无 key;HTML 刮取)

/** SUNSHINEX_WEBSEARCH_PROVIDER=bing 切 Bing API，=bing-html 切 Bing 网页版(2026-11-01 用户环境
 *  DDG 境外端点被网关拦实测超时,cn.bing.com 实测 200 可达)，缺省 DuckDuckGo HTML 端点 */
export function isBingMode(): boolean {
  return (process.env.SUNSHINEX_WEBSEARCH_PROVIDER ?? '').toLowerCase() === 'bing';
}

export function isBingHtmlMode(): boolean {
  return (process.env.SUNSHINEX_WEBSEARCH_PROVIDER ?? '').toLowerCase() === 'bing-html';
}

/** 引擎端点（单一权威）：SUNSHINEX_WEBSEARCH_ENDPOINT 覆盖优先（自托管/测试注入本地 mock）；否则按 SUNSHINEX_WEBSEARCH_PROVIDER 选型 */
export function resolveWebSearchEndpoint(): string {
  const override = process.env.SUNSHINEX_WEBSEARCH_ENDPOINT;
  if (override) return override;
  return isBingMode() ? BING_ENDPOINT : isBingHtmlMode() ? BING_HTML_ENDPOINT : DDG_ENDPOINT;
}

/** 回落引擎端点（2026-11-01 主引擎网络不可达时 Provider 层自动回落,用户网关拦境外站实测 DDG 超时）：
 *  主引擎 ↔ 备引擎互换（ddg↔bing-html;bing API 为主时不回落——key 引擎失败是凭据/配额问题,换引擎无益） */
export function resolveFallbackEndpoint(): string | undefined {
  if (process.env.SUNSHINEX_WEBSEARCH_ENDPOINT !== undefined) return undefined; // 显式端点=自托管权威,不回落
  if (isBingMode()) return undefined;
  return isBingHtmlMode() ? DDG_ENDPOINT : BING_HTML_ENDPOINT;
}
