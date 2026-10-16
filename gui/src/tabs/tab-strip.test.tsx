import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabStrip } from './TabStrip';
import { TAB_REGISTRY, registryProbe } from './registry';
import { ensureSession, openTab } from './tab-state';

const base = {
  onSelect: vi.fn(), onClose: vi.fn(), onOpenType: vi.fn(),
  onToggleCollapse: vi.fn(), onCycle: vi.fn(), onCloseActive: vi.fn(),
};

describe('TAB_REGISTRY(G8a 两类 + G8b terminal/directory + G8d diff/agents/web)', () => {
  it('注册 file/diff/directory/tasks/agents/terminal/web + G10 context/bgtasks/memory;file 按 path、diff 按 callId、terminal 按 nonce 判重多实例,directory/tasks/agents 单例,web 按 url 判重多实例', () => {
    expect(TAB_REGISTRY.map((e) => e.id)).toEqual([
      'file', 'diff', 'directory', 'tasks', 'agents', 'agent', 'bgtasks', 'memory', 'terminal', 'web', 'sidechat',
    ]); // G14.29:+ sidechat(尾插保位置型断言);G14.164:+ agent(子代理只读页,菜单不列)
    const file = TAB_REGISTRY[0]!;
    expect(file.singleton).toBe(false);
    expect(file.resolveKey({ path: 'a.ts' })).toBe('a.ts');
    expect(file.title({ path: 'a.ts' })).toBe('a.ts');
    expect(file.title({ path: 'D:\\w\\data\\memory\\MEMORY.md' })).toBe('MEMORY.md'); // G14.114 只显文件名
    const diff = TAB_REGISTRY[1]!;
    expect(diff.singleton).toBe(false);
    expect(diff.resolveKey({ callId: 'c1' })).toBe('c1');
    expect(diff.resolveKey({})).toBe('');
    expect(diff.title({ path: 'src/a.ts', callId: 'c1' })).toBe('a.ts'); // path 可读优先,只显文件名
    expect(diff.title({ callId: 'c1' })).toBe('c1');
    expect(diff.title({})).toBe('审查'); // G14.180 Diff 改审查(中文页签面)
    const directory = TAB_REGISTRY[2]!;
    expect(directory.singleton).toBe(true);
    expect(directory.title({})).toBe('目录');
    const tasks = TAB_REGISTRY[3]!;
    expect(tasks.singleton).toBe(true);
    expect(tasks.title({})).toBe('待办'); // G14.174 重定位:任务页签 → 待办
    const agents = TAB_REGISTRY[4]!;
    expect(agents.singleton).toBe(true);
    expect(agents.group).toBe('session');
    expect(agents.title({})).toBe('任务板'); // G14.174 重定位:Agents 页签 → 任务板
    expect(agents.resolveKey({})).toBe('');
    const agent = TAB_REGISTRY.find((e) => e.id === 'agent')!;
    expect(agent.singleton).toBe(false); // G14.164 by label 多实例:同 agent 重开=聚焦
    expect(agent.resolveKey({ label: 'task-t1' })).toBe('task-t1');
    expect(agent.title({ label: 'task-t1', agentTitle: '架构分析' })).toBe('架构分析'); // 开档定格名优先
    expect(agent.title({ label: 'task-t1' })).toBe('task-t1');
    const terminal = TAB_REGISTRY.find((e) => e.id === 'terminal')!;
    expect(terminal.singleton).toBe(false);
    expect(terminal.resolveKey({ nonce: 't1' })).toBe('t1');
    expect(terminal.resolveKey({})).toBe('');
    expect(terminal.title({})).toBe('终端');
    const web = TAB_REGISTRY.find((e) => e.id === 'web')!;
    expect(web.group).toBe('tools');
    expect(web.singleton).toBe(false);
    expect(web.resolveKey({ url: 'https://a.dev' })).toBe('https://a.dev');
    expect(web.resolveKey({})).toBe('');
    expect(web.title({ url: 'https://a.dev' })).toBe('https://a.dev');
    expect(web.title({})).toBe('Web');
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
    expect(screen.getByText('a.ts').closest('.sx-tab')?.className).toContain('sx-tab');
    fireEvent.click(screen.getByText('a.ts').closest('.sx-tab') as HTMLElement);
    expect(handlers.onSelect).toHaveBeenCalledWith('file:a.ts');
    fireEvent.click(screen.getByRole('button', { name: 'close tab a.ts' }));
    expect(handlers.onClose).toHaveBeenCalledWith('file:a.ts');
  });

  it('「+」弹类型菜单,选中回调 onOpenType;「≫」折叠回调', () => {
    const handlers = { ...base };
    render(<TabStrip {...handlers} tabs={[]} activeUid={null} collapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getAllByRole('menuitem', { name: /待办/ })[0]);
    expect(handlers.onOpenType).toHaveBeenCalledWith('tasks');
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
