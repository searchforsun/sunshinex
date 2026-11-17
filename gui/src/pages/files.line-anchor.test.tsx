import { describe, expect, it } from 'vitest';
import { splitLineAnchor } from '../ui-util';

/** 文件行段锚解析(2026-11-14 用户裁定「文件预览支持 #L40-L57; #L123/#L123-L235 定位到开头一行」) */
describe('splitLineAnchor', () => {
  it('无锚原样返回', () => {
    expect(splitLineAnchor('docs/a.md')).toEqual({ path: 'docs/a.md' });
    expect(splitLineAnchor('./x/y.py')).toEqual({ path: './x/y.py' });
  });

  it('#L123 单行锚:拆出行号,末斜杠/目录形态不受影响', () => {
    expect(splitLineAnchor('aries-radar-logs.md#L123')).toEqual({ path: 'aries-radar-logs.md', line: 123 });
    expect(splitLineAnchor('./.agents/skills/bigdata-assistant/knowledge/aries/aries-radar-logs.md#L40-L57')).toEqual({
      path: './.agents/skills/bigdata-assistant/knowledge/aries/aries-radar-logs.md',
      line: 40,
      lineEnd: 57,
    });
  });

  it('#L123-L235 行段:lineEnd 取较大端,倒序输入归正/单点段省略', () => {
    expect(splitLineAnchor('a.ts#L10-L20')).toEqual({ path: 'a.ts', line: 10, lineEnd: 20 });
    expect(splitLineAnchor('a.ts#L20-L10')).toEqual({ path: 'a.ts', line: 20 });
    expect(splitLineAnchor('a.ts#L7-L7')).toEqual({ path: 'a.ts', line: 7 });
  });

  it('大小写不敏感;非行段锚(#section)不误拆', () => {
    expect(splitLineAnchor('a.md#l5')).toEqual({ path: 'a.md', line: 5 });
    expect(splitLineAnchor('a.md#section')).toEqual({ path: 'a.md#section' });
    expect(splitLineAnchor('a.md#L0')).toEqual({ path: 'a.md#L0' });
  });
});
