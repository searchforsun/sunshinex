/**
 * Web 标签页名/站标元数据单点(2026-10-25 用户报障「页签只显 host+地球图标,应显网页标题+站标」):
 * WebTab 的 iframe 跨域帧 contentDocument 拒访,页名/图标只能服务端代取——GET 页面 HTML,
 * 解析 <title> 与 <link rel~=icon>,返回绝对站标 URL。有界防御:仅 http(s)、超时、字节数上限、
 * 解析失败全空回落(GUI 侧退 host/地球图标,与本模块缺席同形)。
 */

export interface WebMeta {
  title: string;
  /** 绝对 URL(favicon);解析不出为空串(GUI 回落地球图标) */
  icon: string;
}

const FETCH_TIMEOUT_MS = 6_000;
/** HTML 读取上限(title/图标声明都在文档头部,1MB 已远超需要;整页不落盘) */
const MAX_HTML_BYTES = 1_000_000;

/** HTML 实体最小解码(title 展示面;&x 十进制/十六进制数值实体一并收——中文站标题常含 &#x4e2d; 形) */
function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 32 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/** html 字节 → 文本:charset 探测(meta/content-type;gbk/gb2312 站点中文标题不乱码;解码器缺席退 utf-8) */
function decodeHtml(buf: Buffer, contentType: string): string {
  const head = buf.subarray(0, 2048).toString('latin1');
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(head) ?? /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
  const cs = m?.[1]?.toLowerCase() ?? 'utf-8';
  if (cs === 'utf-8' || cs === 'utf8') return buf.toString('utf-8');
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

/** 站标声明收集:link[rel~=icon] 的 href(声明序=优先序,href 为空/非法跳过) */
function iconHrefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/(?:^|\s)rel\s*=\s*["'][^"']*icon[^"']*["']/i.test(tag)) continue;
    const href = /(?:^|\s)href\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(tag);
    const v = href?.[2] ?? href?.[3] ?? href?.[4] ?? '';
    if (v !== '') out.push(v);
  }
  return out;
}

/** 页面 HTML → { title, icon }(绝对站标 URL;解析不出即空串——调用面回落) */
export function parseWebMeta(html: string, baseUrl: string): WebMeta {
  const base = (() => {
    try {
      return new URL(baseUrl);
    } catch {
      return undefined;
    }
  })();
  const title = decodeEntities(
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  let icon = '';
  for (const raw of iconHrefs(html)) {
    try {
      icon = new URL(decodeEntities(raw), base).toString();
      break;
    } catch {
      // 相对/畸形 href:试下一声明
    }
  }
  if (icon === '' && base !== undefined) {
    icon = `${base.origin}/favicon.ico`; // 无声明=约定路径(浏览器同款兜底)
  }
  return { title, icon };
}

/** url 取元数据:仅 http(s);任何失败回 null(GUI 按缺席回落,不报错——meta 是尽力而为的展示增强) */
export async function fetchWebMeta(rawUrl: string): Promise<WebMeta | null> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; SunshinexShell) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });
    const finalUrl = res.url !== '' ? res.url : target.toString();
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok) return parseWebMeta('', finalUrl); // 非 200:标题放弃,站标仍按 origin 兜底
    const reader = res.body?.getReader();
    if (reader === undefined) return parseWebMeta('', finalUrl);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return parseWebMeta(decodeHtml(buf, contentType), finalUrl);
  } catch {
    return null;
  }
}
