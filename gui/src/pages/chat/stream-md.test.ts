import { describe, it, expect } from 'vitest';
import { hasUnclosedFence, streamMdCut } from './stream-md';

describe('hasUnclosedFence', () => {
  it('无围栏 / 已闭合 → false', () => {
    expect(hasUnclosedFence('hello\n\nworld')).toBe(false);
    expect(hasUnclosedFence('```ts\nconst a = 1;\n```\n\nok')).toBe(false);
    expect(hasUnclosedFence('```mermaid\ngraph TD; A-->B\n```')).toBe(false);
  });

  it('未闭合 → true', () => {
    expect(hasUnclosedFence('```mermaid\nstateDiagram-v2\n')).toBe(true);
    expect(hasUnclosedFence('前置\n\n```ts\nconst a = ')).toBe(true);
  });

  it('围栏内空行仍算未闭合', () => {
    expect(hasUnclosedFence('```mermaid\nstateDiagram-v2\n\n[*] --> pending\n')).toBe(true);
  });
});

describe('streamMdCut', () => {
  it('普通空行切分', () => {
    expect(streamMdCut('一段。\n\n二段')).toEqual({ head: '一段。', tail: '二段' });
  });

  it('mermaid 围栏内空行不切断——整段留尾,防半截源码外泄', () => {
    const md = [
      '说明\n\n```mermaid',
      'stateDiagram-v2',
      '',
      '[*] --> pending',
      '',
      'state "terminal 终态" as terminal',
    ].join('\n');
    const { head, tail } = streamMdCut(md);
    expect(head).toBe('说明');
    expect(tail.startsWith('```mermaid')).toBe(true);
    expect(tail).toContain('state "terminal 终态"');
    expect(hasUnclosedFence(tail)).toBe(true);
  });

  it('围栏闭合后可在后续空行晋升', () => {
    const md = '前置\n\n```mermaid\ngraph TD; A-->B\n```\n\n后文';
    expect(streamMdCut(md)).toEqual({
      head: '前置\n\n```mermaid\ngraph TD; A-->B\n```',
      tail: '后文',
    });
  });

  it('全文在未闭合围栏内 → 头空尾满', () => {
    const md = '```mermaid\nstateDiagram-v2\n\n[*] --> a\n';
    expect(streamMdCut(md)).toEqual({ head: '', tail: md });
  });
});
