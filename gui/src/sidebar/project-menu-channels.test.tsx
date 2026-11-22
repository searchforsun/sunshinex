import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setLanguage } from '../i18n';
import { ChannelsSection } from './project-menu-channels';
import type { ChannelSessionRow } from './use-menu-channels';

// i18n 语言钉:断言走中文文案(project-menu-sunx.test 同款先例)
setLanguage('zh');

/**
 * 侧栏「通道」分组(2026-11-22 项目式布局重做,用户裁定「一个应用通道相当于一个项目,下面
 * 展开才显示某个会话,同样支持归档等能力,复用已有的布局」):ProjectsSection 同构克隆。
 * 用例:①组头「通道」+通道组行(平台图标 data-tip=飞书/应用名称+计数 chip)+组内会话行=标准
 * SessionRowView(标题+右对齐相对时间);②会话行点击 → onAttach(root, journalId, updatedAt)
 * 直寻址;③空容器/装载中整块不渲染;④行内归档两段确认 → onArchiveRow(id, true);⑤归档行
 * 滤除主列表;⑥组头归档箱钮 → onOpenArchive(归档通道专域入口)。
 */

const FIXED_TS = 1_728_000_000_000;
const DOMAIN_ROOT = 'C:/Users/x/AppData/Roaming/sunshinex/channels/im-feishu-1-c1';

function channelRow(id: string, over: Partial<ChannelSessionRow> = {}): ChannelSessionRow {
  return {
    id,
    file: `${id}.jsonl`,
    updatedAt: FIXED_TS,
    firstUser: `通道会话 ${id}`,
    kind: 'channel',
    root: DOMAIN_ROOT,
    channel: 'feishu-1',
    platform: 'feishu',
    channelLabel: 'feishu-1',
    ...over,
  } as ChannelSessionRow;
}

function renderSection(rows: ChannelSessionRow[] | null, over: Partial<Parameters<typeof ChannelsSection>[0]> = {}) {
  return render(
    <ChannelsSection
      rows={rows}
      activeSessionId=""
      runningIds={new Set()}
      journalOfSession={new Map()}
      isUnseen={() => false}
      busy={false}
      onAttach={() => undefined}
      onArchiveRow={() => undefined}
      {...over}
    />,
  );
}

describe('ChannelsSection(侧栏「通道」分组,项目式布局)', () => {
  it('①组头「通道」+通道组行(平台图标/应用名称+计数)+组内标准会话行(标题+右对齐时间)', () => {
    const { container } = renderSection([
      channelRow('j1', { channelName: '我的飞书' }),
      channelRow('j2', { updatedAt: FIXED_TS + 1 }),
    ]);
    expect(screen.getByText('通道')).toBeDefined(); // 分区头
    // 通道组行=应用名称优先(回退通道 id),平台图标 data-tip=飞书(目录位同款)
    expect(screen.getByText('我的飞书')).toBeDefined();
    expect(container.querySelector('[data-tip="飞书"]')).not.toBeNull();
    // 计数 chip=组内会话数
    expect(screen.getByLabelText('会话数 2')).toBeDefined();
    // 组内会话行=标准 SessionRowView(标题+右对齐相对时间,session-meta 同款)
    expect(screen.getByText('通道会话 j1')).toBeDefined();
    expect(container.querySelectorAll('.session-list .sx-session-row, .session-list li')).toHaveLength(2);
  });

  it('②会话行点击 → onAttach(root, journalId, updatedAt) 直寻址参数对', () => {
    const onAttach = vi.fn();
    renderSection([channelRow('j9')], { onAttach });
    fireEvent.click(screen.getByText('通道会话 j9'));
    expect(onAttach).toHaveBeenCalledWith(DOMAIN_ROOT, 'j9', FIXED_TS);
  });

  it('③空容器/装载中不渲染组(与 SUNX 常驻组分叉)', () => {
    const empty = renderSection([]);
    expect(empty.container.querySelector('.sx-side-head')).toBeNull();
    empty.unmount();
    const loading = renderSection(null);
    expect(loading.container.querySelector('.sx-side-head')).toBeNull();
  });

  it('④行内归档两段确认 → onArchiveRow(id, true)(T6 同款链)', () => {
    const onArchiveRow = vi.fn();
    const { container } = renderSection([channelRow('j-arch')], { onArchiveRow });
    const arm = screen.getByRole('button', { name: `归档 j-arch` });
    fireEvent.click(arm); // 武装
    const confirm = screen.getByRole('button', { name: `确认归档 j-arch` });
    fireEvent.click(confirm); // 确认
    expect(onArchiveRow).toHaveBeenCalledWith('j-arch', true);
    void container;
  });

  it('⑤归档行滤除主列表(归档行进「归档通道」专域)', () => {
    renderSection([channelRow('j-live'), channelRow('j-gone', { archived: true })]);
    expect(screen.getByText('通道会话 j-live')).toBeDefined();
    expect(screen.queryByText('通道会话 j-gone')).toBeNull();
    expect(screen.getByLabelText('会话数 1')).toBeDefined();
  });

  it('⑥组头归档箱钮 → onOpenArchive(归档通道专域入口;未配=钮不渲染)', () => {
    const onOpenArchive = vi.fn();
    const withBtn = renderSection([channelRow('j1')], { onOpenArchive });
    fireEvent.click(withBtn.container.querySelector('[aria-label="archived channels"]')!);
    expect(onOpenArchive).toHaveBeenCalledTimes(1);
    withBtn.unmount();
    const withoutBtn = renderSection([channelRow('j1')]);
    expect(withoutBtn.container.querySelector('[aria-label="archived channels"]')).toBeNull();
  });

  it('⑦计数钮点击收起/展开通道组(组开合态翻转;缺省全展开)', () => {
    const { container } = renderSection([channelRow('j1')]);
    expect(screen.getByText('通道会话 j1')).toBeDefined();
    const toggle = container.querySelector('.workspace-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByLabelText('会话数 1')); // 收起
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByLabelText('会话数 1')); // 展开
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});
