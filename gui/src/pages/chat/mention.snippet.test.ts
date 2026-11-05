import { beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../../i18n';
import { expandRefContents, mintSnippetToken, rebuildPickTokens, refContentRegistry, splitBrowserFences, splitMentionTokens } from './mention';

/** 正文/终端片段芯片全链(2026-11-05 用户裁定「正文圈选也要 chip」):铸造(同类 ·N 防注册表
 *  同键互覆)→ 发送期围栏化(body-snippet/text-selection 分型)→ 显示侧折回芯片段(标签 i18n
 *  随界面语言)→ 编辑回填重 token 化;展开∘回填 逐字节回原。定界符 ⟦⟧ 保持细字形:透明不可见,
 *  5.4px 预算=图标位(全角【】迁移实测否决——尾侧全角字形宽=光标飞,前侧宽随字体浮动=图标压字)。 */
describe('mintSnippetToken 铸造', () => {
  it('同类二铸即 ·N,正文/终端独立计数', () => {
    expect(mintSnippetToken('body')).toBe('📄文本片段');
    expect(mintSnippetToken('body')).toBe('📄文本片段·2');
    expect(mintSnippetToken('term')).toBe('💻终端片段');
    expect(mintSnippetToken('term')).toBe('💻终端片段·2');
  });
});

describe('expandRefContents 围栏化落档', () => {
  beforeEach(() => {
    setLanguage('zh');
    refContentRegistry.clear();
  });

  it('正文 token 展开 body-snippet 围栏', () => {
    refContentRegistry.set('⟦文本片段⟧', 'L5 声明 6 用例全部通过');
    expect(expandRefContents('前 ⟦文本片段⟧ 后', new Map())).toBe('前 ```body-snippet\nL5 声明 6 用例全部通过\n``` 后');
  });

  it('终端 token 展开 text-selection 围栏(口径不变)', () => {
    refContentRegistry.set('⟦终端片段⟧', 'npm test\n');
    expect(expandRefContents('⟦终端片段⟧', new Map())).toBe('```text-selection\nnpm test\n```');
  });

  it('内容自带围栏(browser 回填形态)不重复套', () => {
    refContentRegistry.set('⟦网页#t-1⟧', '```browser-element\n页签 #t-1\n```');
    expect(expandRefContents('⟦网页#t-1⟧', new Map())).toBe('```browser-element\n页签 #t-1\n```');
  });

  it('注册表无记录原样保留(非芯片 ⟦…⟧ 文本不受扰)', () => {
    expect(expandRefContents('⟦文本片段⟧', new Map())).toBe('⟦文本片段⟧');
  });
});

describe('splitMentionTokens 解析', () => {
  it('⟦…⟧ 解析为 ref token', () => {
    expect(splitMentionTokens('x ⟦文本片段·4⟧ y').find((k) => k.text === '⟦文本片段·4⟧')?.kind).toBe('ref');
  });
});

describe('splitBrowserFences 显示侧折叠(标签 i18n+顺序编号)', () => {
  beforeEach(() => setLanguage('zh'));

  it('body-snippet 围栏折回正文片段芯片段(原文段保留)', () => {
    expect(splitBrowserFences('甲```body-snippet\n引文\n```乙')).toEqual([
      { text: '甲' },
      { fence: '引文\n', kind: 'body-snippet', label: '文本片段', token: '📄文本片段' },
      { text: '乙' },
    ]);
  });

  it('终端/正文两类并存:各类独立顺序编号,标签带 ·N', () => {
    const md = '```text-selection\nA\n``````body-snippet\nB\n``````text-selection\nC\n``````body-snippet\nD\n```';
    const segs = splitBrowserFences(md);
    expect(segs.map((s) => ('label' in s ? s.label : ''))).toEqual(['终端片段', '文本片段', '终端片段·2', '文本片段·2']);
  });

  it('browser-element 分支不受扩类影响(页签/定位 label 提取)', () => {
    const segs = splitBrowserFences('```browser-element\n页签 #t-abcd12\n定位: button#go\n```');
    expect(segs[0]).toMatchObject({ kind: 'browser-element', label: '网页#t-abcd12 · button#go' });
  });

  it('en 语言显示英文标签', () => {
    setLanguage('en');
    const segs = splitBrowserFences('```body-snippet\n引文\n```');
    expect(segs[0]).toMatchObject({ label: 'Text snippet' });
    setLanguage('zh');
  });
});

describe('rebuildPickTokens 编辑回填回环', () => {
  beforeEach(() => {
    setLanguage('zh');
    refContentRegistry.clear();
  });

  it('body-snippet 档文折回 token;展开∘回填逐字节回原', () => {
    const md = '说明 ```body-snippet\n第一行\n第二行\n``` 结尾';
    const back = rebuildPickTokens(md);
    expect(back).toBe('说明 📄文本片段 结尾');
    expect(expandRefContents(back, new Map())).toBe(md);
  });

  it('browser 档文折回 token 重展开回原(围栏体原样含标记)', () => {
    const md = '```browser-element\n页签 #t-1\n```';
    const back = rebuildPickTokens(md);
    expect(expandRefContents(back, new Map())).toBe(md);
  });
});
