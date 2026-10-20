import { describe, it, expect } from 'vitest';
import {
  emptyTabSession, ensureSession, openTab, closeTab, cycleTab,
  setCollapsed, setWidth, DEFAULT_TAB_WIDTH, disambiguateTabTitles, reopenClosed, type SingletonProbe,
} from './tab-state';

/** 判重/单例探针(T3 registry 提供真实现;此处 stub 同口径:file 按 path,tasks 单例) */
const probe: SingletonProbe = {
  isSingleton: (t) => t === 'tasks',
  resolveKey: (t, p) => (t === 'file' ? p.path ?? '' : t === 'web' ? p.url ?? '' : ''),
};

describe('tab-state 纯逻辑(spec §1 标签模型)', () => {
  it('ensureSession:新会话零标签空态且默认折叠(G14.27/38);已有会话原样', () => {
    const s = ensureSession({}, 's1', probe);
    expect(s.s1.tabs).toEqual([]);
    expect(s.s1.activeUid).toBeNull();
    expect(s.s1.collapsed).toBe(true);
    const again = ensureSession(s, 's1', probe);
    expect(again).toBe(s); // 引用相等=未动
  });

  it('openTab:file 按 path 判重——重开同 path 聚焦不重复', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    s = openTab(s, 's1', 'file', { path: 'b.ts' }, probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    expect(s.s1.tabs).toHaveLength(2); // a + b
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
    expect(cycleTab(s, 's1', 1).s1.activeUid).toBe('file:a.ts');         // 仅一页:环回自身
    expect(cycleTab(cycleTab(s, 's1', 1), 's1', -1).s1.activeUid).toBe('file:a.ts'); // 链式:去而复返
  });

  it('标签态每会话独立', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    const s2 = ensureSession(s, 's2', probe);
    expect(s2.s2.tabs).toEqual([]);
    expect(s2.s1.tabs).toHaveLength(1); // s1 未被 s2 操作扰动
  });

  it('setWidth 只钳最小 440,无最大宽(G14.196;G14.2xx 用户裁定最大宽退役);setCollapsed 切换', () => {
    const s = ensureSession({}, 's1', probe);
    expect(setWidth(s, 's1', 99).s1.width).toBe(440);
    expect(setWidth(s, 's1', 999).s1.width).toBe(999);
    expect(setWidth(s, 's1', 500).s1.width).toBe(500);
    expect(setCollapsed(s, 's1', true).s1.collapsed).toBe(true);
  });

  it('emptyTabSession 缺省面', () => {
    const e = emptyTabSession();
    expect(e.tabs).toHaveLength(0);
    expect(e.activeUid).toBeNull();
    expect(e.collapsed).toBe(true); // G14.38:零标签新会话缺省折叠(右栏不自动打开)
    expect(e.width).toBe(DEFAULT_TAB_WIDTH);
  });

  it('disambiguateTabTitles:同名 file 标签显最小区分相对路径,无撞名保原题,非 file 不入表', () => {
    // 用户回归锚:两个 util.ts → a/util.ts、b/util.ts(chrome 同位逐级上溯)
    const s1 = openTab(openTab(ensureSession({}, 's1', probe), 's1', 'file', { path: 'src/a/util.ts' }, probe), 's1', 'file', { path: 'src/b/util.ts' }, probe);
    expect(disambiguateTabTitles(s1.s1.tabs).get(s1.s1.tabs[0]!.uid)).toBe('a/util.ts');
    expect(disambiguateTabTitles(s1.s1.tabs).get(s1.s1.tabs[1]!.uid)).toBe('b/util.ts');
    // 中间层也撞名:再上溯一层才区分(p/g.ts 撞 → x/p/g.ts、y/p/g.ts;q/g.ts 第二层即唯一)
    const paths = ['x/p/g.ts', 'y/p/g.ts', 'x/q/g.ts'];
    let s2 = ensureSession({}, 's2', probe);
    for (const p of paths) s2 = openTab(s2, 's2', 'file', { path: p }, probe);
    const labels = disambiguateTabTitles(s2.s2.tabs);
    expect(labels.get(s2.s2.tabs[0]!.uid)).toBe('x/p/g.ts');
    expect(labels.get(s2.s2.tabs[1]!.uid)).toBe('y/p/g.ts');
    expect(labels.get(s2.s2.tabs[2]!.uid)).toBe('q/g.ts');
    // 无撞名保原题;非 file 标签(tasks 单例)不进表
    let s3 = ensureSession({}, 's3', probe);
    s3 = openTab(openTab(s3, 's3', 'file', { path: 'README.md' }, probe), 's3', 'tasks', {}, probe);
    const labels3 = disambiguateTabTitles(s3.s3.tabs);
    expect(labels3.get(s3.s3.tabs[0]!.uid)).toBe('README.md');
    expect(labels3.has(s3.s3.tabs[1]!.uid)).toBe(false);
  });

  it('G14.2xx 标签搜索数据面:openTab 落 createdAt;closeTab 压 recentClosed 头部(cap 10);reopenClosed 按索引重开随弹随消', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    expect(typeof s.s1.tabs[0]!.createdAt).toBe('number'); // 弹窗相对时间面
    s = openTab(s, 's1', 'file', { path: 'b.ts' }, probe);
    const uidB = s.s1.tabs[1]!.uid;
    s = closeTab(s, 's1', uidB);
    expect(s.s1.tabs).toHaveLength(1);
    expect(s.s1.recentClosed).toHaveLength(1); // 关闭即入历史(新者在前)
    expect(s.s1.recentClosed[0]!.params.path).toBe('b.ts');
    expect(typeof s.s1.recentClosed[0]!.closedAt).toBe('number');
    // 重开同文件 = 判重聚焦既有 a.ts?否——path 不同新开;记录随弹随消
    s = reopenClosed(s, 's1', 0, probe);
    expect(s.s1.recentClosed).toHaveLength(0);
    expect(s.s1.tabs.map((t) => t.params.path)).toContain('b.ts');
    // 索引越界 → 原引用返回
    expect(reopenClosed(s, 's1', 5, probe)).toBe(s);
    // cap 10:关 12 个只留最近 10 条
    let c = ensureSession({}, 'c', probe);
    for (let i = 0; i < 12; i += 1) {
      c = openTab(c, 'c', 'file', { path: `f${i}.ts` }, probe);
      c = closeTab(c, 'c', c.c.tabs[c.c.tabs.length - 1]!.uid);
    }
    expect(c.c.recentClosed).toHaveLength(10);
    expect(c.c.recentClosed[0]!.params.path).toBe('f11.ts'); // 新者在前
  });
});
