import { CodedToolError } from '../tools';
import { BING_ENDPOINT, BING_HTML_ENDPOINT, DDG_ENDPOINT, isBingHtmlMode, isBingMode, resolveFallbackEndpoint, resolveWebSearchEndpoint } from '../security/websearch-endpoint';

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
class DuckDuckGoProvider implements WebSearchProvider {
  constructor(private endpoint = DDG_ENDPOINT) {}

  async search(query: string, count: number): Promise<WebSearchHit[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set('q', query);
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SunshineX-Agent)' },
    });
    if (!res.ok) throw new CodedToolError('websearch_upstream', `Search upstream HTTP ${res.status}`);
    return parseDuckDuckGoHtml(await res.text(), count);
  }
}

/** 可选 Provider：Bing Web Search API v7（SUNSHINEX_WEBSEARCH_PROVIDER=bing 时启用，需 SUNSHINEX_BING_API_KEY） */
class BingProvider implements WebSearchProvider {
  constructor(
    private endpoint = BING_ENDPOINT,
    private apiKey = process.env.SUNSHINEX_BING_API_KEY ?? '',
  ) {}

  async search(query: string, count: number): Promise<WebSearchHit[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': this.apiKey },
    });
    if (!res.ok) throw new CodedToolError('websearch_upstream', `Search upstream HTTP ${res.status}`);
    const doc = (await res.json()) as { webPages?: { value?: { name?: unknown; url?: unknown; snippet?: unknown }[] } };
    return (doc.webPages?.value ?? [])
      .slice(0, count)
      .map((v) => ({ title: String(v.name ?? ''), url: String(v.url ?? ''), snippet: String(v.snippet ?? '') }));
  }
}

/** Bing 网页版 Provider（cn.bing.com HTML 刮取,无 key;2026-11-01 用户环境 DDG 被网关拦实测超时,
 *  cn.bing.com 实测 200 可达）。解析 li.b_algo → h2>a(href,title) + 首个 <p> 摘要;结构漂移返回空列表
 *  （表达「无结果」,不误报失败——与 DDG 解析器同纪律） */
class BingHtmlProvider implements WebSearchProvider {
  constructor(private endpoint = BING_HTML_ENDPOINT) {}

  async search(query: string, count: number): Promise<WebSearchHit[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
    });
    if (!res.ok) throw new CodedToolError('websearch_upstream', `Search upstream HTTP ${res.status}`);
    return parseBingHtml(await res.text(), count);
  }
}

/** Bing 网页版 HTML → 归一化结果:逐 li.b_algo 段取 h2>a 链接与首个 <p> 段 */
export function parseBingHtml(html: string, count: number): WebSearchHit[] {
  const blocks = html.split('<li class="b_algo"').slice(1);
  const hits: WebSearchHit[] = [];
  for (const block of blocks) {
    if (hits.length >= count) break;
    const link = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (link === null) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    hits.push({ title: stripTags(link[2]), url: stripTags(link[1]), snippet: snippet !== null ? stripTags(snippet[1]) : '' });
  }
  return hits;
}

/** 主引擎失败自动回落（2026-11-01 用户网关拦境外站,DDG fetch failed→cn.bing 可达）:
 *  网络类失败（fetch failed/超时/上游非 2xx）即换备引擎;两台都失败抛原始错误 */
class FallbackProvider implements WebSearchProvider {
  constructor(private primary: WebSearchProvider, private fallback: WebSearchProvider | undefined) {}

  async search(query: string, count: number): Promise<WebSearchHit[]> {
    try {
      return await this.primary.search(query, count);
    } catch (e) {
      if (this.fallback === undefined) throw e;
      try {
        return await this.fallback.search(query, count);
      } catch {
        throw e; // 备引擎也失败:抛主引擎原始错误（诊断面指向用户配置的主引擎）
      }
    }
  }
}

/** 按环境装配：SUNSHINEX_WEBSEARCH_PROVIDER=bing 切 Bing API/=bing-html 切 Bing 网页版,缺省 DuckDuckGo;
 *  显式端点(SUNSHINEX_WEBSEARCH_ENDPOINT)不回落(自托管权威);bing-api 主引擎不回落(凭据问题换引擎无益) */
export function resolveWebSearchProvider(): WebSearchProvider {
  // Provider 与 guard 同源消费 SUNSHINEX_WEBSEARCH_ENDPOINT 覆盖：判界主机与实际抓取主机必须一致
  const endpoint = resolveWebSearchEndpoint();
  const primary: WebSearchProvider = isBingMode()
    ? new BingProvider(endpoint)
    : isBingHtmlMode()
      ? new BingHtmlProvider(endpoint)
      : new DuckDuckGoProvider(endpoint);
  const fb = resolveFallbackEndpoint();
  const alternate: WebSearchProvider | undefined = fb === undefined ? undefined : fb === BING_HTML_ENDPOINT ? new BingHtmlProvider(fb) : new DuckDuckGoProvider(fb);
  return new FallbackProvider(primary, alternate);
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
    // 结果集里混入非法 URL（new URL 抛出）时按「跳过该条」降级（调用方对空串 continue），不使整页解析失败
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
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}
