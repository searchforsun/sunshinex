import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EditorModal, EmptyState, ErrorBanner, ModalField, ModalTabs, ResourceCard, ScopeSelect, SearchBar, defaultScopeOptions, scopeTargetLabel } from '../components';
import type { ScopeOption } from '../components';
import { Select } from '../controls';
import { useConfigChanged } from '../use-config-changed';
import type { ConfigChangedInfo, ConfigChangedSource } from '../use-config-changed';
import type { SourceBadgeProps } from '../SourceBadge';

/**
 * Task 21 设置共享组件 kit 桩测:ScopeSelect 目标选择器(2026-10-29 用户裁定:两选项形态
 * 退役——选项列表形态,选项渲染/当值回显/上抛 value=root 字符串,''=全局;defaultScopeOptions
 * 缺省面+scopeTargetLabel basename 双分隔容错)、SearchBar 200ms 防抖、ResourceCard 开关与
 * actions/折叠详情渲染、EditorModal 开合与提交(2026-10-29 弹窗替换抽屉:Cancel/×/遮罩/Esc=关,
 * Save=提交,焦点落对话框)、EmptyState/ErrorBanner、useConfigChanged 帧后按 resource 合并
 * 200ms 递增(connection 桩注入帧)。测试基准语言钉 en(test-setup G14.104),断言单语 en。
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

describe('ScopeSelect(目标选择器形态)', () => {
  const options: ScopeOption[] = [
    { value: '', label: 'Global' },
    { value: '/w/sunshinex', label: 'sunshinex' },
    { value: '/w/project1', label: 'project1' },
  ];

  it('选项列表渲染:弹层按 options 展开,当值(项目 root 字符串)回显,选中上抛 value', () => {
    const calls: string[] = [];
    render(<ScopeSelect value="/w/sunshinex" options={options} onChange={(v) => calls.push(v)} />);
    const trigger = screen.getByRole('button', { name: 'Settings scope' }) as HTMLButtonElement;
    expect(trigger.textContent).toContain('sunshinex'); // 当值=项目 root 对应项回显
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'Global' })).toBeDefined(); // 全局恒在
    expect(screen.getByRole('option', { name: 'project1' })).toBeDefined(); // 注册项目逐项
    fireEvent.click(screen.getByRole('option', { name: 'Global' }));
    expect(calls).toEqual(['']); // '' = 全局
    fireEvent.click(trigger); // 重开弹层
    fireEvent.click(screen.getByRole('option', { name: 'project1' }));
    expect(calls).toEqual(['', '/w/project1']); // 项目=root 字符串上抛(壳 setState 换发)
  });

  it("value='' 全局回显;defaultScopeOptions(root)=全局+当前 root basename;scopeTargetLabel 双分隔容错", () => {
    render(<ScopeSelect value="" options={defaultScopeOptions('/w/sunshinex')} onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Settings scope' });
    expect(trigger.textContent).toContain('Global'); // 全局当值照显
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'Global' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'sunshinex' })).toBeDefined(); // basename 标签
    expect(scopeTargetLabel('D:\\repos\\demo')).toBe('demo'); // win32 反斜杠容错
    expect(scopeTargetLabel('/w/root-a/')).toBe('root-a'); // unix 斜杠+尾分隔符
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

describe('EditorModal', () => {
  it('open=false 不渲染;open=true 居中对话框:标题/字段/焦点落框;Save/Cancel/×/遮罩/Esc 关闭路径', () => {
    const { container, rerender } = render(
      <EditorModal open={false} title="Edit thing" onClose={() => {}} onSubmit={() => {}}>
        <input aria-label="field" />
      </EditorModal>,
    );
    expect(container.textContent).toBe('');

    const closes: number[] = [];
    const submits: number[] = [];
    rerender(
      <EditorModal open={true} title="Edit thing" onClose={() => closes.push(1)} onSubmit={() => submits.push(1)}>
        <input aria-label="field" />
      </EditorModal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit thing' });
    expect(dialog).toBeDefined();
    expect(screen.getByLabelText('field')).toBeDefined();
    expect(document.activeElement).toBe(dialog); // 焦点落对话框(autoFocus+tabIndex=-1,简单落焦)
    fireEvent.click(screen.getByText('Save'));
    expect(submits).toEqual([1]);
    expect(closes).toEqual([]);
    fireEvent.click(screen.getByText('Cancel'));
    expect(closes).toEqual([1]);
    // 右上 ×=关
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(closes).toEqual([1, 1]);
    // 遮罩点击=关;对话框体内点击不关(stopPropagation)
    const backdrop = container.querySelector('.sx-editor-modal-backdrop')!;
    fireEvent.click(backdrop);
    expect(closes).toEqual([1, 1, 1]);
    fireEvent.click(screen.getByRole('dialog', { name: 'Edit thing' }));
    expect(closes).toEqual([1, 1, 1]);
    // Esc=document 捕获段关闭(stopPropagation 截断壳层 document 冒泡段「Esc 回会话态」监听)
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closes).toEqual([1, 1, 1, 1]);
  });

  it('Modal 内共享 Select(2026-10-30 z 修正回归保护):弹窗开共享 Select 弹层容器出现在 document 且在弹窗遮罩内,选项可点选上抛;ModalField=标签行(label+hint)+控件行', () => {
    const picks: string[] = [];
    render(
      <EditorModal open title="Edit thing" onClose={() => {}} onSubmit={() => {}}>
        <ModalField label="Transport" hint="pick one">
          <Select
            ariaLabel="Transport"
            value="stdio"
            options={[
              { v: 'stdio', l: 'stdio' },
              { v: 'http', l: 'http' },
            ]}
            onChange={(v) => picks.push(v)}
          />
        </ModalField>
      </EditorModal>,
    );
    // ModalField 表单行:标签行(名+hint)在,控件(trigger)在
    expect(screen.getByText('pick one')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Transport' })).toBeDefined();
    // 开弹层:弹层容器(.sx-dd-pop)出现在 document 且位于弹窗遮罩内(z 层修正的 DOM 面锚点——
    // 遮罩 z120 stacking context 圈住弹层,弹窗作用域 CSS 抬层保证浮于表单之上,此处钉 DOM 在场)
    fireEvent.click(screen.getByRole('button', { name: 'Transport' }));
    expect(document.querySelector('.sx-editor-modal-backdrop .sx-dd-pop')).not.toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'http' }));
    expect(picks).toEqual(['http']); // 弹层选项点选上抛(弹窗内交互通路)
  });
});

describe('ModalTabs', () => {
  const tabs = [
    { id: 'config', label: 'Config' },
    { id: 'source', label: 'Source' },
  ];

  it('tablist/tab 渲染:active 当值 aria-selected+active 类;点击上抛 id(2026-10-29 用户裁定:MCP/Plugins 配置弹窗 配置|源码 两 Tab 共享件)', () => {
    const picks: string[] = [];
    const { rerender } = render(<ModalTabs tabs={tabs} active="config" onChange={(id) => picks.push(id)} ariaLabel="editor" />);
    const list = screen.getByRole('tablist', { name: 'editor' });
    expect(list).toBeDefined();
    const configTab = screen.getByRole('tab', { name: 'Config' });
    const sourceTab = screen.getByRole('tab', { name: 'Source' });
    expect(configTab.getAttribute('aria-selected')).toBe('true'); // 当值高亮
    expect(sourceTab.getAttribute('aria-selected')).toBe('false');
    expect(configTab.className).toContain('active');
    expect(sourceTab.className).not.toContain('active');
    fireEvent.click(sourceTab);
    expect(picks).toEqual(['source']); // 上抛 id,受控切换由宿主任
    // 受控换面:active=source → aria/类随动
    rerender(<ModalTabs tabs={tabs} active="source" onChange={(id) => picks.push(id)} ariaLabel="editor" />);
    expect(sourceTab.getAttribute('aria-selected')).toBe('true');
    expect(sourceTab.className).toContain('active');
    expect(configTab.className).not.toContain('active');
  });

  it('ScopeSelect 定宽(2026-10-29 用户裁定):包裹层挂 sx-dd-fixed(150px 定宽,超长项目名 ellipsis 由 .sx-dd-value 既有规则承接)', () => {
    render(<ScopeSelect value="" options={[{ value: '', label: 'Global' }]} onChange={() => {}} />);
    const wrap = screen.getByRole('button', { name: 'Settings scope' }).closest('.sx-dd');
    expect(wrap!.className).toContain('sx-dd-fixed');
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

  it('真尾随防抖(尾帧起算):首帧+150ms 又来帧 → 计时重起,尾帧后 200ms 才单次递增(leading 语义在 t+200 已=1,本例分辨两语义)', () => {
    const conn = new ConnStub();
    render(<TickProbe conn={conn} />);
    act(() => {
      conn.emit({ resource: 'mcp', scope: 'project', root: '/w/proj' }); // t=0 首帧
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByTestId('tick-mcp').textContent).toBe('0');
    act(() => {
      conn.emit({ resource: 'mcp', scope: 'project', root: '/w/proj' }); // t=150 尾帧(窗内重起表)
    });
    act(() => {
      vi.advanceTimersByTime(150); // t=300:leading 语义此刻已触发(=1),尾随仍未到(350)
    });
    expect(screen.getByTestId('tick-mcp').textContent).toBe('0');
    act(() => {
      vi.advanceTimersByTime(50); // t=350=尾帧+200ms
    });
    expect(screen.getByTestId('tick-mcp').textContent).toBe('1'); // 只此一次
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
