import { beforeEach, describe, expect, it } from 'vitest';
import { expandRefContents, mintSnippetToken, rebuildPickTokens, refContentRegistry, splitBrowserFences } from './mention';

/** 正文/终端片段芯片全链(2026-11-05 用户裁定「正文圈选也要 chip」):铸造(同类 ·N 防注册表
 *  同键互覆)→ 发送期围栏化(body-snippet/text-selection 分型)→ 显示侧折回芯片段 →
 *  编辑回填重 token 化;展开∘回填 逐字节回原。 */
describe('mintSnippetToken 铸造', () => {
  it('同类二铸即 ·N,正文/终端独立计数', () => {
    expect(mintSnippetToken('body')).toBe('⟦正文片段⟧');
    expect(mintSnippetToken('body')).toBe('⟦正文片段·2⟧');
    expect(mintSnippetToken('term')).toBe('⟦终端片段⟧');
    expect(mintSnippetToken('term')).toBe('⟦终端片段·2⟧');
  });
});

describe('expandRefContents 围栏化落档', () => {
  beforeEach(() => refContentRegistry.clear());

  it('正文 token 展开 body-snippet 围栏(注册表兜底,账本缺省)', () => {
    refContentRegistry.set('⟦正文片段⟧', 'L5 声明 6 用例全部通过');
    expect(expandRefContents('前 ⟦正文片段⟧ 后', new Map())).toBe('前 ```body-snippet\nL5 声明 6 用例全部通过\n``` 后');
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
    expect(expandRefContents('⟦正文片段⟧', new Map())).toBe('⟦正文片段⟧');
  });
});

describe('splitBrowserFences 显示侧折叠', () => {
  it('body-snippet 围栏折回正文片段芯片段(原文段保留)', () => {
    expect(splitBrowserFences('甲```body-snippet\n引文\n```乙')).toEqual([
      { text: '甲' },
      { fence: '引文\n', kind: 'body-snippet', label: '正文片段', token: '⟦正文片段⟧' },
      { text: '乙' },
    ]);
  });

  it('终端/正文两类并存:各类独立顺序编号', () => {
    const md = '```text-selection\nA\n``````body-snippet\nB\n``````text-selection\nC\n``````body-snippet\nD\n```';
    const tokens = splitBrowserFences(md).map((s) => ('token' in s ? s.token : ''));
    expect(tokens).toEqual(['⟦终端片段⟧', '⟦正文片段⟧', '⟦终端片段·2⟧', '⟦正文片段·2⟧']);
  });

  it('browser-element 分支不受扩类影响(页签/定位 label 提取)', () => {
    const segs = splitBrowserFences('```browser-element\n页签 #t-abcd12\n定位: button#go\n```');
    expect(segs[0]).toMatchObject({ kind: 'browser-element', label: '网页#t-abcd12 · button#go' });
  });
});

describe('rebuildPickTokens 编辑回填回环', () => {
  beforeEach(() => refContentRegistry.clear());

  it('body-snippet 档文折回 token;展开∘回填逐字节回原', () => {
    const md = '说明 ```body-snippet\n第一行\n第二行\n``` 结尾';
    const back = rebuildPickTokens(md);
    expect(back).toBe('说明 ⟦正文片段⟧ 结尾');
    expect(expandRefContents(back, new Map())).toBe(md);
  });

  it('browser 档文折回 token 重展开回原(围栏体原样含标记)', () => {
    const md = '```browser-element\n页签 #t-1\n```';
    const back = rebuildPickTokens(md);
    expect(expandRefContents(back, new Map())).toBe(md);
  });
});
