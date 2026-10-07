import { describe, it, expect } from 'vitest';
import {
  emptyTabSession, ensureSession, openTab, closeTab, setActive, cycleTab,
  setCollapsed, setWidth, DEFAULT_TAB_WIDTH, type TabStates, type SingletonProbe,
} from './tab-state';

/** 判重/单例探针(T3 registry 提供真实现;此处 stub 同口径:file 按 path,tasks 单例) */
const probe: SingletonProbe = {
  isSingleton: (t) => t === 'tasks',
  resolveKey: (t, p) => (t === 'file' ? p.path ?? '' : t === 'web' ? p.url ?? '' : ''),
};

describe('tab-state 纯逻辑(spec §1 标签模型)', () => {
  it('ensureSession:新会话缺省开 tasks 单例;已有会话原样', () => {
    const s = ensureSession({}, 's1', probe);
    expect(s.s1.tabs.map((t) => t.type)).toEqual(['tasks']);
    expect(s.s1.activeUid).toBe('tasks:');
    const again = ensureSession(s, 's1', probe);
    expect(again).toBe(s); // 引用相等=未动
  });

  it('openTab:file 按 path 判重——重开同 path 聚焦不重复', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    s = openTab(s, 's1', 'file', { path: 'b.ts' }, probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    expect(s.s1.tabs).toHaveLength(3); // tasks + a + b
    expect(s.s1.activeUid).toBe('file:a.ts');
  });

  it('openTab:单例类型(tasks)重开=聚焦既有', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    s = openTab(s, 's1', 'tasks', {}, probe);
    expect(s.s1.tabs).toHaveLength(2);
    expect(s.s1.activeUid).toBe('tasks:');
  });

  it('openTab:无参非单例(terminal)每次新开一页', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'terminal', {}, { ...probe, isSingleton: () => false, resolveKey: (t, p) => (t === 'file' ? p.path ?? '' : t === 'terminal' ? `n${s.s1.tabs.length}` : '') });
    expect(s.s1.tabs.filter((t) => t.type === 'terminal')).toHaveLength(1); // 探针给序号判重,此处验证追加行为
  });

  it('closeTab:关活动标签→右侧邻标承继;清空→null', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    s = openTab(s, 's1', 'file', { path: 'b.ts' }, probe);
    s = closeTab(s, 's1', 'file:b.ts');       // 关活动(b)→右无→左承继(a)
    expect(s.s1.activeUid).toBe('file:a.ts');
    s = closeTab(s, 's1', 'file:a.ts');
    s = closeTab(s, 's1', 'tasks:');
    expect(s.s1.tabs).toHaveLength(0);
    expect(s.s1.activeUid).toBeNull();
  });

  it('cycleTab:±1 环回;单标签不动', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    expect(cycleTab(s, 's1', 1).s1.activeUid).toBe('tasks:');            // file(末位)→tasks 环回
    expect(cycleTab(cycleTab(s, 's1', 1), 's1', -1).s1.activeUid).toBe('file:a.ts'); // 链式:去而复返
  });

  it('标签态每会话独立', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    const s2 = ensureSession(s, 's2', probe);
    expect(s2.s2.tabs.map((t) => t.type)).toEqual(['tasks']);
    expect(s2.s1.tabs).toHaveLength(2); // s1 未被 s2 操作扰动
  });

  it('setWidth clamp 200..720;setCollapsed 切换', () => {
    const s = ensureSession({}, 's1', probe);
    expect(setWidth(s, 's1', 99).s1.width).toBe(200);
    expect(setWidth(s, 's1', 999).s1.width).toBe(720);
    expect(setWidth(s, 's1', 500).s1.width).toBe(500);
    expect(setCollapsed(s, 's1', true).s1.collapsed).toBe(true);
  });

  it('emptyTabSession 缺省面', () => {
    const e = emptyTabSession();
    expect(e.tabs).toHaveLength(0);
    expect(e.activeUid).toBeNull();
    expect(e.collapsed).toBe(false);
    expect(e.width).toBe(DEFAULT_TAB_WIDTH);
  });
});
