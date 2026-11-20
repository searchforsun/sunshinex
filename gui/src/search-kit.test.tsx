import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SearchCatBar, SearchSectionHead, useSearchListNav } from './search-kit';

/** 共享搜索套件单测:分类条/吸顶分组头/键盘跳转(侧栏聚合、标签页、目录树三面共用) */

describe('SearchCatBar', () => {
  it('分类按钮选中态走 aria-selected;点击上抛分类 id(不显示数量)', () => {
    const onPick = vi.fn();
    render(
      <SearchCatBar
        cats={[
          { id: 'all', en: 'All', zh: '全部' },
          { id: 'project', en: 'Projects', zh: '项目' },
          { id: 'action', en: 'Actions', zh: '操作' },
        ]}
        active="project"
        onPick={onPick}
      />,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
    expect(tabs[0]!.textContent).toBe('All'); // 2026-11-21 用户裁定:分类条不显示数量
    fireEvent.click(tabs[0]!);
    expect(onPick).toHaveBeenCalledWith('all');
  });

  it('SearchSectionHead:分类名(分组头吸顶类由样式承载)', () => {
    render(<SearchSectionHead label="Sessions" />);
    const head = document.querySelector('.sx-search-sec')!;
    expect(head.textContent).toBe('Sessions');
  });
});

/** 键盘跳转钩子夹具:输入框挂 onKeyDown,列表行数 = items.length */
function NavHarness(props: { readonly count: number; readonly resetKey: string; readonly onPick: (i: number) => void }): JSX.Element {
  const nav = useSearchListNav({ count: props.count, onPick: props.onPick, resetKey: props.resetKey });
  return <input aria-label="query" onKeyDown={nav.onKeyDown} />;
}

describe('useSearchListNav', () => {
  it('↑↓ 移动并在边界收敛,Home/End 直达,Enter 选中当前行', () => {
    const onPick = vi.fn();
    render(<NavHarness count={3} resetKey="a" onPick={onPick} />);
    const input = screen.getByLabelText('query');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // 0→1
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // 1→2
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // 2→2(末行收敛)
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // 2→1
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(input, { key: 'Home' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(input, { key: 'End' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith(2);
  });

  it('空列表 Enter 不触发;resetKey(查询/分类)变化回第一行', () => {
    const onPick = vi.fn();
    const { rerender } = render(<NavHarness count={0} resetKey="a" onPick={onPick} />);
    const input = screen.getByLabelText('query');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    rerender(<NavHarness count={3} resetKey="a" onPick={onPick} />);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith(1);
    rerender(<NavHarness count={3} resetKey="b" onPick={onPick} />); // 换分类/查询
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith(0);
  });
});
