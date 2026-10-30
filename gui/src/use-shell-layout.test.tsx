import { describe, it, expect, afterEach } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { useShellLayout } from './use-shell-layout';
import type { ShellLayoutDeps } from './use-shell-layout';
import type { TabStates } from './tabs/tab-state';

/**
 * use-shell-layout 窄宽钉(2026-10-30 用户裁定「设置页缩宽不产生抽屉浮窗」):settingsOpen
 * 期间 menuFloating 恒 false——菜单保持停靠(渲染期钳制 240 下限压缩,menuRenderW),设置内容
 * 由 ≤720px 响应式纵向布局兜底;settingsOpen=false 同宽照旧转浮窗(对照)。
 * 形态:仓库无 renderHook,用最小探针组件消费 useShellLayout,menuFloating 映射 sx-menu-float
 * 类(App.tsx :565 消费形态)。视口经 useState 初始化器取 window.innerWidth——render 前
 * defineProperty 钉 <856(856=240+320+296 浮窗沿);jsdom 无根 zoom,zoomScale()=1。
 */

/** 遮蔽 jsdom innerWidth(render 前——viewportW 走 useState 初始化器只取首渲染值) */
function setViewport(px: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
}

afterEach(() => {
  cleanup();
  // 删自有遮蔽属性,还原 jsdom 原型 getter(防跨用例泄漏)
  delete (window as { innerWidth?: unknown }).innerWidth;
});

/** 探针:deps 按 App.tsx useShellLayout 装配形态(page=settings/settingsOpen 注入) */
function Probe(props: { settingsOpen: boolean }): React.ReactElement {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [, setTabStates] = useState<TabStates>({});
  const deps: ShellLayoutDeps = {
    shellRef,
    sidebarRef,
    resizeCleanupRef,
    page: 'settings',
    settingsOpen: props.settingsOpen,
    openSessionId: '',
    tabCollapsed: false,
    tabWidth: 296,
    setTabStates,
  };
  const layout = useShellLayout(deps);
  return (
    <div ref={shellRef} data-testid="menu" className={layout.menuFloating ? 'sx-menu-float' : ''}>
      menu
    </div>
  );
}

describe('use-shell-layout 设置页停靠例外(2026-10-30 用户裁定)', () => {
  it('settingsOpen=true 且视口 <856:菜单容器不带 sx-menu-float(停靠,240 钳制压缩兜底)', () => {
    setViewport(800);
    render(<Probe settingsOpen={true} />);
    const menu = screen.getByTestId('menu');
    expect(menu.className).not.toContain('sx-menu-float');
  });

  it('settingsOpen=false 同宽(<856):菜单容器带 sx-menu-float(原规则浮窗,对照)', () => {
    setViewport(800);
    render(<Probe settingsOpen={false} />);
    const menu = screen.getByTestId('menu');
    expect(menu.className).toContain('sx-menu-float');
  });
});
