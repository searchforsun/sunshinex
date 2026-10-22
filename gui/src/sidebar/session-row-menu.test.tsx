import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionRowMenu, type SessionRowMenuItem } from './session-row-menu';

/** SessionRowMenu 组件直测(D49 L 项清偿:此前零直测,仅经 Chat.test/project-menu.test 间接覆盖):
 *  items 渲染三形(menuitem/divider/disabled)、选择即回调+关、四路关闭(外点 mousedown/Esc/
 *  scroll/resize)与「菜单内 mousedown 不关」。onClose 以 vi.fn 断言调用次数——外点收语义
 *  (锚钮 mousedown stopPropagation 不击穿 toggle)归调用方,组件面只验自身契约 */

const ITEMS: SessionRowMenuItem[] = [
  { id: 'pin', label: '置顶', onSelect: vi.fn() },
  { id: 'sep', label: '', onSelect: () => {}, divider: true },
  { id: 'remove', label: '移除工作区', disabled: true, onSelect: vi.fn() },
];

function mount(onClose = vi.fn()): void {
  render(<SessionRowMenu x={100} y={80} items={ITEMS.map((it) => ({ ...it, onSelect: vi.fn() }))} onClose={onClose} />);
}

describe('SessionRowMenu(会话行快捷菜单)', () => {
  it('渲染:menuitem 全量在场(含 disabled 灰显),divider 渲染为分隔线', () => {
    mount();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2); // divider 不占 menuitem 位
    expect(screen.getByText('置顶')).toBeDefined();
    expect(screen.getByText('移除工作区')).toBeDefined();
    expect(items[1]!.hasAttribute('disabled')).toBe(true); // disabled 灰显
    expect(document.querySelector('.sx-menu-divider')).not.toBeNull();
  });

  it('选择:menuitem 点击即 onSelect+onClose;disabled 项点击不触发不关', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<SessionRowMenu x={0} y={0} items={[{ id: 'pin', label: '置顶', onSelect }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('外点 mousedown 关;菜单内 mousedown 不关', () => {
    const onClose = vi.fn();
    render(<SessionRowMenu x={0} y={0} items={[{ id: 'a', label: 'A', onSelect: vi.fn() }]} onClose={onClose} />);
    const menu = screen.getByRole('menu');
    fireEvent.mouseDown(menu); // 菜单内:不关
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body); // 菜单外:关
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc 关;滚动/resize 关(捕获段监听,任意容器滚动即收)', () => {
    const onClose = vi.fn();
    render(<SessionRowMenu x={0} y={0} items={[{ id: 'a', label: 'A', onSelect: vi.fn() }]} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.resize(window);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
