import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EditorDrawer, EmptyState, ErrorBanner, ResourceCard, ScopeSwitcher, SearchBar } from '../components';
import { useConfigChanged } from '../use-config-changed';
import type { ConfigChangedInfo, ConfigChangedSource } from '../use-config-changed';
import type { SourceBadgeProps } from '../SourceBadge';

/**
 * Task 21 设置共享组件 kit 桩测:ScopeSwitcher 切换回调/项目不可用禁用态、SearchBar 200ms 防抖、
 * ResourceCard 开关与 actions/折叠详情渲染、EditorDrawer 开合与提交、EmptyState/ErrorBanner、
 * useConfigChanged 帧后按 resource 合并 200ms 递增(connection 桩注入帧)。测试基准语言钉 en
 * (test-setup G14.104),断言单语 en。
 */

/** 计时器面:防抖/合并窗全走 fake timers(逐例推进,零真实等待) */
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** conn 桩:onConfigChanged 注册点(记录回调+退订计数)——emit 直注入帧 */
class ConnStub implements ConfigChangedSource {
  readonly registered: Array<(f: ConfigChangedInfo) => void> = [];
  offCalls = 0;
  onConfigChanged(cb: (f: ConfigChangedInfo) => void): () => void {
    this.registered.push(cb);
    return () => {
      this.offCalls += 1;
    };
  }
  emit(f: ConfigChangedInfo): void {
    for (const cb of this.registered) cb(f);
  }
}

/** useConfigChanged 观察件:逐 resource tick 平铺(testid 定位断言) */
function TickProbe({ conn }: { readonly conn: ConfigChangedSource }): JSX.Element {
  const ticks = useConfigChanged(conn);
  return (
    <ul>
      {Object.entries(ticks).map(([k, v]) => (
        <li key={k} data-testid={`tick-${k}`}>
          {v}
        </li>
      ))}
    </ul>
  );
}

describe('ScopeSwitcher', () => {
  it('分段控件:两枚按钮,当值 aria-pressed;点击上抛 onScopeChange', () => {
    const calls: string[] = [];
    render(<ScopeSwitcher scope="project" projectAvailable={true} onScopeChange={(s) => calls.push(s)} />);
    const g = screen.getByRole('button', { name: 'Global' }) as HTMLButtonElement;
    const p = screen.getByRole('button', { name: 'Project' }) as HTMLButtonElement;
    expect(p.getAttribute('aria-pressed')).toBe('true');
    expect(g.getAttribute('aria-pressed')).toBe('false');
    expect(p.disabled).toBe(false);
    fireEvent.click(g);
    expect(calls).toEqual(['global']);
  });

  it('项目不可用:项目侧禁用+title 提示,点击不上抛', () => {
    const calls: string[] = [];
    render(<ScopeSwitcher scope="global" projectAvailable={false} onScopeChange={(s) => calls.push(s)} />);
    const p = screen.getByRole('button', { name: 'Project' }) as HTMLButtonElement;
    expect(p.disabled).toBe(true);
    expect(p.getAttribute('title')).not.toBe(null);
    fireEvent.click(p); // disabled:handler 不触发
    expect(calls).toEqual([]);
  });
});

describe('SearchBar', () => {
  it('防抖 200ms:键入即显不即抛,窗满单次上抛终值', () => {
    const calls: string[] = [];
    render(<SearchBar value="" onChange={(v) => calls.push(v)} />);
    const input = screen.getByLabelText('Search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'm' } });
    expect(input.value).toBe('m'); // 输入框即时回显
    expect(calls).toEqual([]); // 未满窗不上抛
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(calls).toEqual(['m']);
  });

  it('窗内连击合并:多次键入只上抛一次终值;外部置值镜像回输入框', () => {
    const calls: string[] = [];
    const { rerender } = render(<SearchBar value="" onChange={(v) => calls.push(v)} />);
    const input = screen.getByLabelText('Search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'mc' } });
    act(() => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.change(input, { target: { value: 'mcp' } });
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(calls).toEqual([]); // 240ms 分两段但单窗未满(尾键重起表)
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(calls).toEqual(['mcp']); // 距尾键 200ms 恰满,单次终值
    // 父面回写防抖值(''→'mcp'):镜像无感;外部清空('mcp'→'')即时镜像回输入框
    const noop = (): void => {};
    rerender(<SearchBar value="mcp" onChange={noop} />);
    expect(input.value).toBe('mcp');
    rerender(<SearchBar value="" onChange={noop} />);
    expect(input.value).toBe('');
  });
});

describe('ResourceCard', () => {
  const badge: SourceBadgeProps = { source: 'project' };

  it('标题/副题/徽标/chips/actions 渲染;开关 aria-checked 并上抛 onToggle;children 折叠详情', () => {
    const toggles: number[] = [];
    render(
      <ul>
        <ResourceCard
          title="Demo"
          subtitle="sub line"
          badge={badge}
          chips={<span className="sx-chip">chip-a</span>}
          enabled={true}
          onToggle={() => toggles.push(1)}
          actions={<button type="button">Act</button>}
        >
          <p>detail-body</p>
        </ResourceCard>
      </ul>,
    );
    expect(screen.getByText('Demo')).toBeDefined();
    expect(screen.getByText('sub line')).toBeDefined();
    expect(screen.getByText('Project')).toBeDefined(); // SourceBadge en 钉
    expect(screen.getByText('chip-a')).toBeDefined();
    expect(screen.getByText('Act')).toBeDefined();
    const sw = screen.getByRole('switch', { name: 'Enable Demo' }) as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(toggles).toEqual([1]);
    // children=折叠详情:<details> 缺省收起(内容在场,summary 开合)
    const details = screen.getByText('detail-body').closest('details');
    expect(details).not.toBe(null);
    expect(details!.open).toBe(false);
  });

  it('无 onToggle 不渲染开关;enabled=false aria-checked=false', () => {
    render(
      <ul>
        <ResourceCard title="ReadOnly" enabled={false} />
      </ul>,
    );
    expect(screen.queryByRole('switch')).toBe(null);
    expect(screen.getByText('ReadOnly')).toBeDefined();
  });
});

describe('EditorDrawer', () => {
  it('open=false 不渲染;open=true 右侧滑出:标题/Save/Cancel/背板开合', () => {
    const { container, rerender } = render(
      <EditorDrawer open={false} title="Edit thing" onClose={() => {}} onSubmit={() => {}}>
        <input aria-label="field" />
      </EditorDrawer>,
    );
    expect(container.textContent).toBe('');

    const closes: number[] = [];
    const submits: number[] = [];
    rerender(
      <EditorDrawer open={true} title="Edit thing" onClose={() => closes.push(1)} onSubmit={() => submits.push(1)}>
        <input aria-label="field" />
      </EditorDrawer>,
    );
    expect(screen.getByRole('dialog', { name: 'Edit thing' })).toBeDefined();
    expect(screen.getByLabelText('field')).toBeDefined();
    fireEvent.click(screen.getByText('Save'));
    expect(submits).toEqual([1]);
    expect(closes).toEqual([]);
    fireEvent.click(screen.getByText('Cancel'));
    expect(closes).toEqual([1]);
    // 背板点击=关;抽屉体内点击不关(stopPropagation)
    const backdrop = container.querySelector('.sx-drawer-backdrop')!;
    fireEvent.click(backdrop);
    expect(closes).toEqual([1, 1]);
    fireEvent.click(screen.getByRole('dialog', { name: 'Edit thing' }));
    expect(closes).toEqual([1, 1]);
  });
});

describe('EmptyState / ErrorBanner', () => {
  it('EmptyState 文本;ErrorBanner role=alert', () => {
    render(
      <>
        <EmptyState text="Nothing here" />
        <ErrorBanner text="boom" />
      </>,
    );
    expect(screen.getByText('Nothing here')).toBeDefined();
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('boom')).toBeDefined();
  });
});

describe('useConfigChanged', () => {
  it('帧到 → 对应 resource 的 tick 200ms 后递增;他 resource 不动', () => {
    const conn = new ConnStub();
    render(<TickProbe conn={conn} />);
    expect(screen.getByTestId('tick-mcp').textContent).toBe('0');
    act(() => {
      conn.emit({ resource: 'mcp', scope: 'project', root: '/w/proj' });
    });
    expect(screen.getByTestId('tick-mcp').textContent).toBe('0'); // 窗未满不递增
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId('tick-mcp').textContent).toBe('1');
    expect(screen.getByTestId('tick-plugins').textContent).toBe('0');
  });

  it('200ms 窗内同 resource 多帧合并一次;异 resource 各自递增;未知 resource 忽略', () => {
    const conn = new ConnStub();
    render(<TickProbe conn={conn} />);
    act(() => {
      conn.emit({ resource: 'mcp', scope: 'project', root: '/w/proj' });
      conn.emit({ resource: 'mcp', scope: 'project', root: '/w/proj' });
      conn.emit({ resource: 'mcp', scope: 'global', root: null });
      conn.emit({ resource: 'plugins', scope: 'global', root: null });
      conn.emit({ resource: 'bogus', scope: 'global', root: null });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId('tick-mcp').textContent).toBe('1'); // 三帧合一
    expect(screen.getByTestId('tick-plugins').textContent).toBe('1');
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId('tick-mcp').textContent).toBe('1'); // 不再跳
  });

  it('全局帧(root=null)同径递增;卸载退订(注册点退订函数被调)', () => {
    const conn = new ConnStub();
    const { unmount } = render(<TickProbe conn={conn} />);
    act(() => {
      conn.emit({ resource: 'settings', scope: 'global', root: null });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId('tick-settings').textContent).toBe('1');
    expect(conn.offCalls).toBe(0);
    unmount();
    expect(conn.offCalls).toBe(1);
    // 卸载后在途窗不递增(off 后 stub 回调仍在——真实现 off 摘除;此处直证不炸)
  });
});
