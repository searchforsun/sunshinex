import { describe, expect, it } from 'vitest';
import { filterRefEntries, flatRefItems, refTokenAt, unknownRefTokens } from './ref-palette';
import type { RefEntries } from './ref-palette';

/** agents-teams P1 Task 4(spec 2026-11-04 §3.1/§3.2 GUI):$ / # 软引用 palette 纯函数面——
 *  触发令牌解析(词法与 mention.splitMentionTokens 的 $/# 支同款:词边界起手+小写首字符)、
 *  前缀过滤、扁平双组(键盘单游标)、未知引用聚合(R5:只读对照缓存 entries)。 */

const ENTRIES: RefEntries = {
  agents: [
    { id: 'devx', name: 'Dev X' },
    { id: 'devops', name: 'Dev Ops' },
    { id: 'planner', name: 'Planner' },
  ],
  teams: [
    { id: 'core-team', name: 'Core' },
    { id: 'fullstack-delivery', name: 'Fullstack' },
  ],
};

describe('refTokenAt($/# 触发令牌)', () => {
  it('刚敲 $ 即触发(空 query 合法)', () => {
    expect(refTokenAt('$', 1)).toEqual({ query: '', from: 0, sym: '$' });
  });
  it('刚敲 # 同款(空 query)', () => {
    expect(refTokenAt('#', 1)).toEqual({ query: '', from: 0, sym: '#' });
  });
  it('空白后 $devx 命中(query=devx,from=符号下标)', () => {
    expect(refTokenAt('让 $devx', 7)).toEqual({ query: 'devx', from: 2, sym: '$' });
  });
  it('行首 #fullstack-delivery 命中', () => {
    expect(refTokenAt('#fullstack-delivery', 19)).toEqual({ query: 'fullstack-delivery', from: 0, sym: '#' });
  });
  it('词中 $ 不触发(a$b 粘贴文本,需词边界起手)', () => {
    expect(refTokenAt('a$b', 3)).toBeNull();
  });
  it('PATH=$PATH shell 粘贴文本不触发', () => {
    expect(refTokenAt('export PATH=$PATH', 17)).toBeNull();
  });
  it('#L30 行锚不误伤(# 后首字符须小写)', () => {
    expect(refTokenAt('见 ./a.ts#L30', 13)).toBeNull();
  });
  it('#Title 大写首字符不触发', () => {
    expect(refTokenAt('#Title', 6)).toBeNull();
  });
  it('caret 已续写空格(离开令牌)不再触发', () => {
    expect(refTokenAt('$dev ', 5)).toBeNull();
  });
  it('caret 落在令牌敲入中段照常触发(query=已敲部分)', () => {
    expect(refTokenAt('#team', 2)).toEqual({ query: 't', from: 0, sym: '#' });
    expect(refTokenAt(' $dev', 4)).toEqual({ query: 'de', from: 1, sym: '$' });
  });
  it('caret 前文窗口外的早前令牌不误触发(已空格收口)', () => {
    expect(refTokenAt('$devx 和 #team', 14)).toEqual({ query: 'team', from: 8, sym: '#' });
    expect(refTokenAt('$devx 和 ', 9)).toBeNull();
  });
});

describe('filterRefEntries(id 前缀过滤)', () => {
  it('空 query 全量保留', () => {
    expect(filterRefEntries(ENTRIES, '')).toEqual(ENTRIES);
  });
  it('按 id 前缀过滤(两组各自过滤,保原序)', () => {
    expect(filterRefEntries(ENTRIES, 'dev')).toEqual({
      agents: [ENTRIES.agents[0], ENTRIES.agents[1]],
      teams: [],
    });
    expect(filterRefEntries(ENTRIES, 'core')).toEqual({
      agents: [],
      teams: [ENTRIES.teams[0]],
    });
  });
  it('大小写不敏感:catalog 大写 id(DevX 词法允许)被小写 query(dev)前缀命中', () => {
    expect(filterRefEntries({ agents: [{ id: 'DevX', name: 'Dev X' }], teams: [] }, 'dev')).toEqual({
      agents: [{ id: 'DevX', name: 'Dev X' }],
      teams: [],
    });
  });
  it('无命中=空组(面板不开)', () => {
    expect(filterRefEntries(ENTRIES, 'zzz')).toEqual({ agents: [], teams: [] });
  });
});

describe('flatRefItems(单域扁平——2026-11-05 用户裁定:$ / # 拆开各弹各的)', () => {
  it("sym='$' 只出 agents 行", () => {
    expect(flatRefItems(ENTRIES, '', '$').map((i) => `${i.sym}${i.id}`)).toEqual(['$devx', '$devops', '$planner']);
  });
  it("sym='#' 只出 teams 行", () => {
    expect(flatRefItems(ENTRIES, '', '#').map((i) => `${i.sym}${i.id}`)).toEqual(['#core-team', '#fullstack-delivery']);
  });
  it('过滤+扁平一体(sym=#,query=full 只剩一行)', () => {
    expect(flatRefItems(ENTRIES, 'full', '#')).toEqual([{ id: 'fullstack-delivery', name: 'Fullstack', sym: '#' }]);
  });
});

describe('unknownRefTokens(R5 未知引用聚合,只读对照缓存)', () => {
  it('未命中缓存 id 集的原样收集(含符号)', () => {
    expect(unknownRefTokens('叫 $ghost 上场,拉 #phantom 一起', ENTRIES)).toEqual(['$ghost', '#phantom']);
  });
  it('在册 id 不入列', () => {
    expect(unknownRefTokens('叫 $devx 和 #core-team 上场', ENTRIES)).toEqual([]);
  });
  it('同 token 重复只报一次(聚合一处)', () => {
    expect(unknownRefTokens('$ghost 干完 $ghost 再说', ENTRIES)).toEqual(['$ghost']);
  });
  it('shell 粘贴文本/行锚不是 token,零误报', () => {
    expect(unknownRefTokens('export PATH=$PATH 见 ./a.ts#L30 与 #Title', ENTRIES)).toEqual([]);
  });
  it('entries 空(从未拉到)=全部视为未知', () => {
    expect(unknownRefTokens('$devx', { agents: [], teams: [] })).toEqual(['$devx']);
  });
});
