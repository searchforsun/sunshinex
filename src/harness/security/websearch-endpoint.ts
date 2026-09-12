/** 搜索引擎端点解析（零依赖模块）：guard 域名闸门与搜索 Provider 同源取值，避免双轨口径漂移 */

export const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
export const BING_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search';

/** WEBSEARCH_PROVIDER=bing 切 Bing API，缺省 DuckDuckGo HTML 端点 */
export function isBingMode(): boolean {
  return (process.env.WEBSEARCH_PROVIDER ?? '').toLowerCase() === 'bing';
}

/** 引擎端点（单一权威）：WEBSEARCH_ENDPOINT 覆盖优先（自托管/测试注入本地 mock）；否则按 WEBSEARCH_PROVIDER 选型 */
export function resolveWebSearchEndpoint(): string {
  const override = process.env.WEBSEARCH_ENDPOINT;
  if (override) return override;
  return isBingMode() ? BING_ENDPOINT : DDG_ENDPOINT;
}
