import { describe, it, expect } from 'vitest';
import { highlightByLang, highlightCommand, stripAnsi } from './highlight';

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

describe('highlightCommand(2026-10-25 shell 命令行着色)', () => {
  it('命令词/旗标/操作符/字符串分令牌着色', () => {
    const html = highlightCommand('git commit -m "msg" && ls | head -8');
    expect(html).toContain('tok-cmd">git<');
    expect(html).toContain('tok-flag">-m<');
    expect(html).toContain('tok-str">&quot;msg&quot;<'); // 引号经转义
    expect(html).toContain('tok-op">&amp;&amp;<');
    expect(html).toContain('tok-op">|<');
    expect(html).toContain('tok-cmd">ls<'); // 管道右侧新命令位
    expect(html).toContain('tok-cmd">head<');
    expect(html).toContain('tok-flag">-8<');
  });

  it('重定向与数字:2>&1 着操作符族', () => {
    const html = highlightCommand('pnpm build 2>&1 | tail -8');
    expect(html).toContain('tok-cmd">pnpm<');
    expect(html).toContain('tok-op');
    expect(html).toContain('tok-cmd">tail<');
  });

  it('未闭合字符串(流式半截)不裸文,吃到行尾', () => {
    const html = highlightCommand('git commit -m "docs: 流');
    expect(html).toContain('tok-str');
    expect(html).toContain('&quot;docs: 流');
  });

  it('变量与 ENV 赋值(赋值前缀不消耗命令位)', () => {
    const html = highlightCommand('FOO=bar echo $HOME');
    expect(html).toContain('tok-var">FOO=<');
    expect(html).toContain('tok-cmd">echo<'); // 真命令仍在命令位
    expect(html).toContain('tok-var">$HOME<');
  });

  it('HTML 注入面:原文经转义(重定向符分词后仍无注入)', () => {
    const html = highlightCommand('echo <script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;');
    expect(html).toContain('tok-cmd">echo<');
  });
});

describe('stripAnsi(工具输出 ANSI 剥离)', () => {
  it('SGR 颜色码剥离,正文保留', () => {
    expect(stripAnsi('\u001b[2m../dist/\u001b[22m\u001b[36mfile.js\u001b[39m')).toBe('../dist/file.js');
  });

  it('无 ANSI 原样;光标控制与 OSC 剥离', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
    expect(stripAnsi('a\u001b[2Kb')).toBe('ab');
    expect(stripAnsi('x\u001b]0;title\u0007y')).toBe('xy');
  });
});
