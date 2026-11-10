import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WelcomeBranchMenu } from './welcome-branch-menu';

/** 分支弹层改版钉(2026-11-09 用户裁定;2026-11-11 当前分支改「当前」文字标记):筛选行过滤、「+」仅在输入为合法新名时可用并
 *  派发新建、Enter=精确命中切换/否则新建 */
describe('WelcomeBranchMenu', () => {
  const gitBr = { current: 'dev1', branches: ['archive/parallel-1027-wip', 'dev1', 'main'] };

  it('当前分支标「当前」;筛选即过滤;无匹配给空态', () => {
    const { container } = render(<WelcomeBranchMenu gitBr={gitBr} onPick={vi.fn()} onCreate={vi.fn()} />);
    const items = screen.getAllByRole('menuitem');
    // 当前分支行 textContent 含「当前」标签——分支名断言用 .branch-pop-name
    expect(items.map((b) => b.querySelector('.branch-pop-name')?.textContent)).toEqual(gitBr.branches);
    // 当前分支=「当前」文字标签;选中态(≠当前)=对号(2026-11-11 用户裁定「双对号语义不清」)
    expect(items[1]!.querySelector('.branch-pop-current')).not.toBeNull();
    expect(items[1]!.textContent).toContain('Current'); // 测试基线语言 en
    expect(items[0]!.querySelector('.branch-pop-check')).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter or create branch'), { target: { value: 'ma' } });
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['main']);
    fireEvent.change(screen.getByLabelText('Filter or create branch'), { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(container.querySelector('.branch-pop-empty')).not.toBeNull();
  });

  it('「+」:空/同名/非法名禁用,合法新名可点并派发 onCreate;Enter 精确命中切换、否则新建', () => {
    const onPick = vi.fn();
    const onCreate = vi.fn();
    render(<WelcomeBranchMenu gitBr={gitBr} onPick={onPick} onCreate={onCreate} />);
    const input = screen.getByLabelText('Filter or create branch');
    const add = screen.getByRole('button', { name: 'Create branch' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'main' } });
    expect(add.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'bad name' } });
    expect(add.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'feat/x' } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(onCreate).toHaveBeenLastCalledWith('feat/x');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledTimes(2);
    fireEvent.change(input, { target: { value: 'main' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('main');
  });
});
