import { describe, expect, it } from 'vitest';
import { artifactKey, artifactKindLabel, artifactTitleOf, extOf, isDeliverablePath, type Artifact } from './artifacts';

/** 产物共享面(2026-11-12 spec §3.2;2026-11-14 kind 化):三类判别 + 类目标签 + 身份键 */

describe('产物分类器与标签', () => {
  it('extOf:反斜杠/嵌套/点开头顶格', () => {
    expect(extOf('docs\\a\\b.md')).toBe('md'); // 反斜杠归一
    expect(extOf('报告.MD')).toBe('md');
    expect(extOf('dir/.hidden')).toBeUndefined();
    expect(extOf('README')).toBeUndefined();
  });
  it('isDeliverablePath 与内核白名单同形', () => {
    expect(isDeliverablePath('docs/a.md')).toBe(true);
    expect(isDeliverablePath('src/index.ts')).toBe(false);
  });
  it('artifactKindLabel:file=类目·大写扩展名,url=网站,command=命令', () => {
    expect(artifactKindLabel({ kind: 'file', path: 'docs/TECH-DEBT-LOG.md', source: 'write' })).toBe('文档 · MD');
    expect(artifactKindLabel({ kind: 'file', path: 'shot.png', source: 'bash' })).toBe('图片 · PNG');
    expect(artifactKindLabel({ kind: 'file', path: '数据.xlsx', source: 'bash' })).toBe('表格 · XLSX');
    expect(artifactKindLabel({ kind: 'file', path: 'deck.pptx', source: 'write' })).toBe('演示 · PPTX');
    expect(artifactKindLabel({ kind: 'url', url: 'http://localhost:7788', source: 'tool' })).toBe('网站');
    expect(artifactKindLabel({ kind: 'command', command: 'python main.py', source: 'tool' })).toBe('命令');
  });
  it('artifactTitleOf:title 优先,缺省 file=基名/url=主机+路径/command=首段', () => {
    expect(artifactTitleOf({ kind: 'file', path: 'docs/a.md', source: 'write' })).toBe('a.md');
    expect(artifactTitleOf({ kind: 'file', path: 'docs/a.md', source: 'write', title: '主文档' })).toBe('主文档');
    expect(artifactTitleOf({ kind: 'url', url: 'http://localhost:7788/play', source: 'tool' })).toBe('localhost:7788/play');
    expect(artifactTitleOf({ kind: 'command', command: 'python main.py --dev', source: 'tool' })).toBe('python');
  });
  it('artifactKey:file=path 归一/url=原串/command=trim', () => {
    const a: Artifact = { kind: 'file', path: 'docs\\a.md', source: 'write' };
    const b: Artifact = { kind: 'file', path: 'docs/a.md', source: 'edit' };
    expect(artifactKey(a)).toBe(artifactKey(b));
    expect(artifactKey({ kind: 'url', url: 'http://x', source: 'tool' })).toBe('u:http://x');
    expect(artifactKey({ kind: 'command', command: '  run  ', source: 'tool' })).toBe('c:run');
  });
});
