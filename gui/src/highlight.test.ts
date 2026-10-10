import { describe, it, expect } from 'vitest';
import { highlightByLang } from './highlight';

/** G11 §5.2:围栏语言直给 hljs;未知语言/异常回落转义原文(注入面纪律) */

describe('highlightByLang', () => {
  it('已知语言产出 hljs 令牌 span', () => {
    const html = highlightByLang('const a = 1;', 'ts');
    expect(html).toContain('hljs-keyword');
  });

  it('未知语言回落 plaintext(无注入面:HTML 原文被转义)', () => {
    const html = highlightByLang('<script>alert(1)</script>', 'nope-lang');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('lang 缺省 plaintext;异常安全(不抛)', () => {
    expect(() => highlightByLang('x')).not.toThrow();
    expect(highlightByLang('x')).toBe('x');
  });
});
