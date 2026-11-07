import { describe, it, expect } from 'vitest';
import { hasUnclosedFence, PENDING_IMAGE_SRC, sealPartialImage, streamMdCut } from './stream-md';

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

describe('sealPartialImage(流式尾块半截图片语法不外露原文)', () => {
  const P = `](${PENDING_IMAGE_SRC})`;
  it('各书写阶段 → 占位图;alt 写完才保留', () => {
    expect(sealPartialImage('截图如下:![')).toBe(`截图如下:![${P}`);
    expect(sealPartialImage('截图如下:![桌面截')).toBe(`截图如下:![${P}`);
    expect(sealPartialImage('截图如下:![桌面截图]')).toBe(`截图如下:![桌面截图${P}`);
    expect(sealPartialImage('截图如下:![桌面截图](C:\\Users\\a\\shot')).toBe(`截图如下:![桌面截图${P}`);
  });
  it('末字符单个 ! 先藏一帧(可能是图片起笔)', () => {
    expect(sealPartialImage('完成!')).toBe('完成');
  });
  it('已闭合图片/非图片文本/代码内原样', () => {
    expect(sealPartialImage('![a](b.png) 之后的字')).toBe('![a](b.png) 之后的字');
    expect(sealPartialImage('![a](b.png)')).toBe('![a](b.png)');
    expect(sealPartialImage('用 `![alt](')).toBe('用 `![alt](');
    expect(sealPartialImage('```md\n![alt](')).toBe('```md\n![alt](');
    expect(sealPartialImage('![a\n下一行')).toBe('![a\n下一行');
  });
});
