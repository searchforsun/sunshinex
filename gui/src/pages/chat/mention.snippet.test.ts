import { beforeEach, describe, expect, it } from 'vitest';
import { expandRefContents, mintSnippetToken, rebuildPickTokens, refContentRegistry, splitBrowserFences, splitMentionTokens } from './mention';

/** 正文/终端片段芯片全链(2026-11-05 用户裁定「正文圈选也要 chip」;同日定界符迁移 ⟦⟧→【】
 *  ——全宽括弧每侧 ~1em 字形预算,前缀图标+边距放得下;旧形 ⟦⟧ 兼容:重启表单恢复的旧草稿
 *  与旧注册表键仍解析/展开):铸造(同类 ·N 防注册表同键互覆)→ 发送期围栏化(body-snippet/
 *  text-selection 分型)→ 显示侧折回芯片段 → 编辑回填重 token 化;展开∘回填 逐字节回原。 */
describe('mintSnippetToken 铸造', () => {
  it('同类二铸即 ·N,正文/终端独立计数;新形 【】 定界符', () => {
    expect(mintSnippetToken('body')).toBe('【正文片段】');
    expect(mintSnippetToken('body')).toBe('【正文片段·2】');
    expect(mintSnippetToken('term')).toBe('【终端片段】');
    expect(mintSnippetToken('term')).toBe('【终端片段·2】');
  });
});

describe('expandRefContents 围栏化落档(双形)', () => {
  beforeEach(() => refContentRegistry.clear());

  it('新形正文 token 展开 body-snippet 围栏', () => {
    refContentRegistry.set('【正文片段】', 'L5 声明 6 用例全部通过');
    expect(expandRefContents('前 【正文片段】 后', new Map())).toBe('前 ```body-snippet\nL5 声明 6 用例全部通过\n``` 后');
  });

  it('旧形 ⟦⟧ 草稿(重启表单恢复)仍展开', () => {
    refContentRegistry.set('⟦正文片段⟧', '旧草稿内容');
    expect(expandRefContents('⟦正文片段⟧', new Map())).toBe('```body-snippet\n旧草稿内容\n```');
  });

  it('终端 token 展开 text-selection 围栏(口径不变)', () => {
    refContentRegistry.set('【终端片段】', 'npm test\n');
    expect(expandRefContents('【终端片段】', new Map())).toBe('```text-selection\nnpm test\n```');
  });

  it('内容自带围栏(browser 回填形态)不重复套', () => {
    refContentRegistry.set('【网页#t-1】', '```browser-element\n页签 #t-1\n```');
    expect(expandRefContents('【网页#t-1】', new Map())).toBe('```browser-element\n页签 #t-1\n```');
  });

  it('注册表无记录原样保留(非芯片 ⟦…⟧/【…】 文本不受扰)', () => {
    expect(expandRefContents('【正文片段】⟦正文片段⟧', new Map())).toBe('【正文片段】⟦正文片段⟧');
  });
});

describe('splitMentionTokens 解析(受限前缀防散文误判)', () => {
  beforeEach(() => refContentRegistry.clear());

  it('新形【正文片段/终端片段/网页#…】解析为 ref token', () => {
    for (const t of ['【正文片段】', '【正文片段·2】', '【终端片段】', '【网页#t-abcd12 · button.go】']) {
      expect(splitMentionTokens(`x ${t} y`).find((k) => k.text === t)?.kind).toBe('ref');
    }
  });

  it('散文 【标题】 不误判(受限前缀外)', () => {
    expect(splitMentionTokens('【重要】说明').every((k) => k.kind !== 'ref')).toBe(true);
  });

  it('旧形 ⟦…⟧ 仍解析(兼容)', () => {
    expect(splitMentionTokens('x ⟦正文片段·4⟧ y').find((k) => k.text === '⟦正文片段·4⟧')?.kind).toBe('ref');
  });
});

describe('splitBrowserFences 显示侧折叠', () => {
  it('body-snippet 围栏折回正文片段芯片段(原文段保留,token 新形)', () => {
    expect(splitBrowserFences('甲```body-snippet\n引文\n```乙')).toEqual([
      { text: '甲' },
      { fence: '引文\n', kind: 'body-snippet', label: '正文片段', token: '【正文片段】' },
      { text: '乙' },
    ]);
  });

  it('终端/正文两类并存:各类独立顺序编号', () => {
    const md = '```text-selection\nA\n``````body-snippet\nB\n``````text-selection\nC\n``````body-snippet\nD\n```';
    const tokens = splitBrowserFences(md).map((s) => ('token' in s ? s.token : ''));
    expect(tokens).toEqual(['【终端片段】', '【正文片段】', '【终端片段·2】', '【正文片段·2】']);
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
    expect(back).toBe('说明 【正文片段】 结尾');
    expect(expandRefContents(back, new Map())).toBe(md);
  });

  it('browser 档文折回 token 重展开回原(围栏体原样含标记)', () => {
    const md = '```browser-element\n页签 #t-1\n```';
    const back = rebuildPickTokens(md);
    expect(expandRefContents(back, new Map())).toBe(md);
  });
});
