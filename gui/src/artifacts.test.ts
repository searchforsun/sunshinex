import { describe, it, expect } from 'vitest';
import { extOf, isDeliverablePath, artifactKindLabel } from './artifacts';

/** 产物共享面(2026-11-12 spec §3.2;内核同形副本,惯例同 ChangeFile 不引) */

describe('产物分类器与标签', () => {
  it('extOf:反斜杠/嵌套/点开头顶格', () => {
    expect(extOf('docs\\a\\b.md')).toBe('md');
    expect(extOf('报告.MD')).toBe('md');
    expect(extOf('dir/.hidden')).toBeUndefined();
    expect(extOf('README')).toBeUndefined();
  });
  it('isDeliverablePath 与内核白名单同形', () => {
    expect(isDeliverablePath('docs/a.md')).toBe(true);
    expect(isDeliverablePath('src/index.ts')).toBe(false);
  });
  it('artifactKindLabel:「类目 · 大写扩展名」,非产物 undefined', () => {
    expect(artifactKindLabel('docs/TECH-DEBT-LOG.md')).toBe('文档 · MD');
    expect(artifactKindLabel('shot.png')).toBe('图片 · PNG');
    expect(artifactKindLabel('数据.xlsx')).toBe('表格 · XLSX');
    expect(artifactKindLabel('deck.pptx')).toBe('演示 · PPTX');
    expect(artifactKindLabel('out.json')).toBe('数据 · JSON');
    expect(artifactKindLabel('docx 盘.docx')).toBe('文档 · DOCX');
    expect(artifactKindLabel('src/index.ts')).toBeUndefined();
  });
});
