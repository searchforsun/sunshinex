import { describe, it, expect } from 'vitest';
import { emptyNavHistory, navKeyOf, pushNav, NAV_CAP } from './nav-history';
import type { NavLoc } from './nav-history';

const chat = (id: string): NavLoc => ({ k: 'chat', sessionId: id, root: '/w/a', journalId: `j-${id}` });
const welcome: NavLoc = { k: 'welcome' };

describe('nav-history 纯状态', () => {
  it('尾追推进位次:空史起步 push 即 idx=0', () => {
    let h = emptyNavHistory();
    h = pushNav(h, chat('s1'));
    expect(h).toEqual({ stack: [chat('s1')], idx: 0 });
    h = pushNav(h, welcome);
    expect(h).toEqual({ stack: [chat('s1'), welcome], idx: 1 });
  });

  it('记录截断前进尾支:回退后再导航,原前进支废弃', () => {
    let h = emptyNavHistory();
    h = pushNav(h, chat('s1'));
    h = pushNav(h, welcome); // [s1, w] idx=1
    h = { ...h, idx: 0 }; // 后退到 s1
    h = pushNav(h, welcome); // 再 New chat:原前进支(w)废弃
    expect(h).toEqual({ stack: [chat('s1'), welcome], idx: 1 });
  });

  it('相邻去重:同会话连续记录折叠(rewind 重开同会话不涨栈);隔位重复保留(浏览器形)', () => {
    let h = emptyNavHistory();
    h = pushNav(h, chat('s1'));
    h = pushNav(h, chat('s1')); // 去重:原样返回
    expect(h.stack).toHaveLength(1);
    h = pushNav(h, welcome);
    h = pushNav(h, chat('s1')); // 隔 welcome 的重复:照常尾追
    expect(h).toEqual({ stack: [chat('s1'), welcome, chat('s1')], idx: 2 });
  });

  it('cap 裁最旧:超容丢栈底,位次恒指栈顶', () => {
    let h = emptyNavHistory();
    for (let i = 0; i < NAV_CAP + 5; i++) h = pushNav(h, chat(`s${i}`));
    expect(h.stack).toHaveLength(NAV_CAP);
    expect(navKeyOf(h.stack[0] as NavLoc)).toBe(`s5`); // 最旧 5 条已裁
    expect(navKeyOf(h.stack[h.stack.length - 1] as NavLoc)).toBe(`s${NAV_CAP + 4}`);
    expect(h.idx).toBe(NAV_CAP - 1);
  });
});
