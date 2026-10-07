import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabStrip } from './TabStrip';
import { TAB_REGISTRY, registryProbe } from './registry';
import { ensureSession, openTab } from './tab-state';

const base = {
  onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn(), onOpenType: vi.fn(),
  onToggleCollapse: vi.fn(), onCycle: vi.fn(), onCloseActive: vi.fn(),
};

describe('TAB_REGISTRY(G8a 两类 + G8b terminal)', () => {
  it('注册 file/tasks/terminal;file 按 path 判重多实例,tasks 单例,terminal 按 nonce 多实例', () => {
    expect(TAB_REGISTRY.map((e) => e.id)).toEqual(['file', 'tasks', 'terminal']);
    const file = TAB_REGISTRY[0]!;
    expect(file.singleton).toBe(false);
    expect(file.resolveKey({ path: 'a.ts' })).toBe('a.ts');
    expect(file.title({ path: 'a.ts' })).toBe('a.ts');
    const tasks = TAB_REGISTRY[1]!;
    expect(tasks.singleton).toBe(true);
    expect(tasks.title({})).toBe('任务');
    const terminal = TAB_REGISTRY[2]!;
    expect(terminal.singleton).toBe(false);
    expect(terminal.resolveKey({ nonce: 't1' })).toBe('t1');
    expect(terminal.resolveKey({})).toBe('');
    expect(terminal.title({})).toBe('终端');
  });
  it('registryProbe 与注册表同口径', () => {
    const p = registryProbe();
    expect(p.isSingleton('tasks')).toBe(true);
    expect(p.isSingleton('file')).toBe(false);
    expect(p.resolveKey('file', { path: 'x' })).toBe('x');
  });
});

describe('TabStrip(spec §1 标签条)', () => {
  it('渲染标签 pill(图标+标题+×),活动高亮;点选/点×回调', () => {
    let s = ensureSession({}, 's1', registryProbe());
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, registryProbe());
    const handlers = { ...base, onSelect: vi.fn(), onClose: vi.fn() };
    render(<TabStrip {...handlers} tabs={s.s1.tabs} activeUid={s.s1.activeUid} collapsed={false} />);
    expect(screen.getByTitle('a.ts').className).toContain('sx-tab');
    fireEvent.click(screen.getByTitle('a.ts'));
    expect(handlers.onSelect).toHaveBeenCalledWith('file:a.ts');
    fireEvent.click(screen.getByRole('button', { name: 'close tab a.ts' }));
    expect(handlers.onClose).toHaveBeenCalledWith('file:a.ts');
  });

  it('「+」弹类型菜单,选中回调 onOpenType;「≫」折叠回调', () => {
    const handlers = { ...base };
    render(<TabStrip {...handlers} tabs={[]} activeUid={null} collapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /文件/ }));
    expect(handlers.onOpenType).toHaveBeenCalledWith('file');
    fireEvent.click(screen.getByRole('button', { name: 'collapse sidebar' }));
    expect(handlers.onToggleCollapse).toHaveBeenCalled();
  });

  it('快捷键:Alt+W 关活动,Ctrl+Alt+→/← 切换', () => {
    const handlers = { ...base };
    render(<TabStrip {...handlers} tabs={[]} activeUid={null} collapsed={false} />);
    fireEvent.keyDown(window, { key: 'w', altKey: true });
    expect(handlers.onCloseActive).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true, altKey: true });
    expect(handlers.onCycle).toHaveBeenCalledWith(1);
    fireEvent.keyDown(window, { key: 'ArrowLeft', ctrlKey: true, altKey: true });
    expect(handlers.onCycle).toHaveBeenCalledWith(-1);
  });

  it('disabled 态:+ 与标签不可点', () => {
    const handlers = { ...base };
    render(<TabStrip {...handlers} tabs={[]} activeUid={null} collapsed={false} disabled />);
    expect((screen.getByRole('button', { name: 'new tab' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
