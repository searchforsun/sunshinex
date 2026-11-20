import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TabSearchPop } from './TabSearchPop';
import type { ClosedTab, TabInstance } from './tab-state';

/** 标签页搜索:分类条(全部/打开的标签页/最近关闭)+ 键盘 ↑↓/Enter 直达 + 分组头计数 */

const tab = (uid: string, path: string, createdAt = 1_000): TabInstance => ({ uid, type: 'file', params: { path }, createdAt });
const closed = (path: string, closedAt = 2_000): ClosedTab => ({ type: 'file', params: { path }, closedAt, createdAt: 500 });

function mount(over?: { tabs?: TabInstance[]; recentClosed?: ClosedTab[] }) {
  const onSelect = vi.fn();
  const onCloseTab = vi.fn();
  const onReopen = vi.fn();
  const onDone = vi.fn();
  render(
    <TabSearchPop
      tabs={over?.tabs ?? [tab('u1', 'alpha.ts'), tab('u2', 'beta.ts')]}
      activeUid="u1"
      recentClosed={over?.recentClosed ?? [closed('gone-one.ts'), closed('gone-two.ts')]}
      onSelect={onSelect}
      onCloseTab={onCloseTab}
      onReopen={onReopen}
      onDone={onDone}
    />,
  );
  return { onSelect, onCloseTab, onReopen, onDone, input: screen.getByRole('textbox') as HTMLInputElement };
}

describe('TabSearchPop(标签页搜索)', () => {
  it('搜索框下分类条(不显示数量);切分类只留对应组(分组头随之只剩一节)', () => {
    mount();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['All', 'Open tabs', 'Recently closed']);
    fireEvent.click(screen.getByRole('tab', { name: /Recently closed/ }));
    expect(document.querySelectorAll('.sx-tabsearch-row')).toHaveLength(2);
    expect(document.querySelector('.sx-tabsearch-body')!.textContent).not.toContain('alpha.ts');
    expect(document.querySelector('.sx-tabsearch-body')!.textContent).toContain('gone-one.ts');
    fireEvent.click(screen.getByRole('tab', { name: /Open tabs/ }));
    expect(document.querySelectorAll('.sx-tabsearch-row')).toHaveLength(2);
    expect(document.querySelector('.sx-tabsearch-body')!.textContent).not.toContain('gone-one.ts');
  });

  it('↑↓+Enter 直达:打开项切页签,最近关闭项重开;均收口弹层', () => {
    const { onSelect, onReopen, onDone, input } = mount();
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // 0→1(第二个打开的标签页)
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('u2');
    expect(onDone).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: /Recently closed/ }));
    expect(document.activeElement).toBe(input); // 分类点击后焦点回搜索框
    fireEvent.keyDown(input, { key: 'Enter' }); // 最近关闭第一条
    expect(onReopen).toHaveBeenCalledWith(0);
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it('过滤无命中显示空态;Esc 收口', () => {
    const { onDone, input } = mount();
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('No matching tabs')).toBeDefined();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
