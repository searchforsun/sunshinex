import { CodedToolError } from '../tools';
import { BING_ENDPOINT, DDG_ENDPOINT, isBingMode, resolveWebSearchEndpoint } from '../security/websearch-endpoint';

/** 搜索结果归一化条目（provider 无关）：websearch 工具 stdout 渲染的最小单元 */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** 搜索 Provider 接缝：引擎可替换（自托管 SearXNG / 商用 API），工具层只消费归一化结果 */
export interface WebSearchProvider {
  search(query: string, count: number): Promise<WebSearchHit[]>;
}

/** 缺省 Provider：DuckDuckGo HTML 端点（无 key、纯 GET）；端点与选型口径统一由 security/websearch-endpoint 提供（guard 域名闸门同源） */
export class DuckDuckGoProvider implements WebSearchProvider {
  constructor(private endpoint = DDG_ENDPOINT) {}

  async search(query: string, count: number): Promise<WebSearchHit[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set('q', query);
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SunshineX-Agent)' },
    });
    if (!res.ok) throw new CodedToolError('websearch_upstream', `搜索上游 HTTP ${res.status}`);
    return parseDuckDuckGoHtml(await res.text(), count);
  }
}

/** 可选 Provider：Bing Web Search API v7（WEBSEARCH_PROVIDER=bing 时启用，需 BING_API_KEY） */
export class BingProvider implements WebSearchProvider {
  constructor(
    private endpoint = BING_ENDPOINT,
    private apiKey = process.env.BING_API_KEY ?? '',
  ) {}

  async search(query: string, count: number): Promise<WebSearchHit[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': this.apiKey },
    });
    if (!res.ok) throw new CodedToolError('websearch_upstream', `搜索上游 HTTP ${res.status}`);
    const doc = (await res.json()) as { webPages?: { value?: { name?: unknown; url?: unknown; snippet?: unknown }[] } };
    return (doc.webPages?.value ?? [])
      .slice(0, count)
      .map((v) => ({ title: String(v.name ?? ''), url: String(v.url ?? ''), snippet: String(v.snippet ?? '') }));
  }
}

/** 按环境装配：WEBSEARCH_PROVIDER=bing 切 Bing，缺省 DuckDuckGo */
export function resolveWebSearchProvider(): WebSearchProvider {
  // Provider 与 guard 同源消费 WEBSEARCH_ENDPOINT 覆盖：判界主机与实际抓取主机必须一致
  const endpoint = resolveWebSearchEndpoint();
  return isBingMode() ? new BingProvider(endpoint) : new DuckDuckGoProvider(endpoint);
}

/** DDG HTML → 归一化结果：只依赖 result__a / result__snippet 两个 class；结构漂移返回空列表（表达「无结果」，不误报失败） */
export function parseDuckDuckGoHtml(html: string, count: number): WebSearchHit[] {
  const links = matchAll(html, /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g);
  const snippets = matchAll(html, /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g).map((m) => stripTags(m[1]));
  const hits: WebSearchHit[] = [];
  for (const link of links) {
    if (hits.length >= count) break;
    const url = unwrapRedirect(link[1]);
    if (!url) continue;
    hits.push({ title: stripTags(link[2]), url, snippet: snippets[hits.length] ?? '' });
  }
  return hits;
}

function matchAll(src: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m);
  return out;
}

/** DDG 结果链接是站内跳转（…/l/?uddg=<encoded>），还原真实 URL；直链原样返回；不可解析返回空串（调用方跳过该条） */
function unwrapRedirect(href: string): string {
  const base = href.startsWith('//') ? `https:${href}` : href;
  try {
    const u = new URL(base);
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : base;
  } catch {
    return '';
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
