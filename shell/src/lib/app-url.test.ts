import { describe, expect, it } from 'vitest';
import { appUrl } from './app-url';

describe('appUrl', () => {
  it('端口与 token 直出：逐字断言完整 URL', () => {
    expect(appUrl(8765, 'tok-123')).toBe(
      'http://127.0.0.1:8765/?token=tok-123',
    );
    expect(appUrl(80, 'abc')).toBe('http://127.0.0.1:80/?token=abc');
  });

  it('特殊字符 token 经 encodeURIComponent 编码：空格→%20、&→%26', () => {
    expect(appUrl(9100, 'a b&c')).toBe(
      'http://127.0.0.1:9100/?token=a%20b%26c',
    );
  });

  it('更多编码样例：+/=? 等保留字符全部转义', () => {
    expect(appUrl(1, 'x+y=z?')).toBe('http://127.0.0.1:1/?token=x%2By%3Dz%3F');
  });
});
