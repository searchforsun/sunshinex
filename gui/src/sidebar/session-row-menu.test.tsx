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

describe('SessionRowMenu 纵向几何(2026-11-14 用户裁定「默认下边,下边不能展示,翻到上边」)', () => {
  const ITEM = [{ id: 'a', label: 'A', onSelect: vi.fn() }];

  it('默认 below:锚点下缘+2px 开(transform 纯右对齐)', () => {
    render(<SessionRowMenu x={100} y={80} items={ITEM} onClose={vi.fn()} />);
    const menu = screen.getByRole('menu');
    expect(menu.style.top).toBe('82px'); // (y+2)/zoomScale(),测试域 zoom=1
    expect(menu.style.transform).toBe('translateX(-100%)');
  });

  it("placement='above':恒上开=top Y−2+translateY(-100%)(自身高百分比定位,免 offsetHeight 首渲染读 0 的竞态——2026-11-15 产物卡实测「还是没有向上翻」根修)", () => {
    render(<SessionRowMenu x={100} y={80} placement="above" items={ITEM} onClose={vi.fn()} />);
    const menu = screen.getByRole('menu');
    expect(menu.style.top).toBe('78px'); // (y-2)/zoomScale()
    expect(menu.style.transform).toBe('translate(-100%, -100%)');
  });

  it("above+anchorTop:菜单底缘贴锚顶上方 2px——不覆盖打开钮(2026-11-15 用户裁定「翻到打开上面,不是覆盖打开」)", () => {
    // y=锚底 180,anchorTop=锚顶 140 → top=(140-2)=138px,菜单底=138+translateY(-100%) 回贴 138
    render(<SessionRowMenu x={100} y={180} anchorTop={140} placement="above" items={ITEM} onClose={vi.fn()} />);
    const menu = screen.getByRole('menu');
    expect(menu.style.top).toBe('138px');
    expect(menu.style.transform).toBe('translate(-100%, -100%)');
  });

  it('below+视口下方放不下:量高后自动翻上(h=0 早退防误翻;rerender 换 y 重触发量高)', () => {
    const orig = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true });
    try {
      const view = render(<SessionRowMenu x={100} y={180} items={ITEM} onClose={vi.fn()} />);
      const menu = screen.getByRole('menu');
      expect(menu.style.transform).toBe('translateX(-100%)'); // 挂载时 jsdom 无布局,h=0 早退不误翻
      Object.defineProperty(menu, 'offsetHeight', { value: 120, configurable: true });
      view.rerender(<SessionRowMenu x={100} y={181} items={ITEM} onClose={vi.fn()} />);
      // y181+2+120 > 200 且 y181 > h120 → 翻上
      expect(menu.style.transform).toBe('translate(-100%, -100%)');
    } finally {
      Object.defineProperty(window, 'innerHeight', orig ?? { value: 768, configurable: true, writable: true });
    }
  });
});
