import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setLanguage } from '../i18n';
import { ChannelsSection } from './project-menu-channels';
import type { ChannelSessionRow } from './use-menu-channels';

// i18n 语言钉:断言走中文文案(project-menu-sunx.test 同款先例)
setLanguage('zh');

/**
 * 侧栏「通道」分组(channels Task 13,spec §9.1):GET /channels/sessions 域容器全域枚举行
 * 平铺单列——行=平台图标(平台名 data-tip)+聊天标识(通道 id)+会话标题;点击=attach(root,
 * journalId) 直寻址(sunxAttach 同语义);空容器/装载中整块不渲染组(与 SUNX 常驻组刻意分叉——
 * 通道域按需出现,零通道零噪音)。
 */

const FIXED_TS = 1_728_000_000_000;
const DOMAIN_ROOT = 'C:/Users/x/AppData/Roaming/sunshinex/channels/im-tg1-c1';

function channelRow(id: string, over: Partial<ChannelSessionRow> = {}): ChannelSessionRow {
  return {
    id,
    file: `${id}.jsonl`,
    updatedAt: FIXED_TS,
    firstUser: `通道会话 ${id}`,
    kind: 'channel',
    root: DOMAIN_ROOT,
    channel: 'tg1',
    platform: 'telegram',
    channelLabel: 'tg1',
    ...over,
  } as ChannelSessionRow;
}

function renderSection(
  rows: ChannelSessionRow[] | null,
  over: Partial<Parameters<typeof ChannelsSection>[0]> = {},
) {
  return render(
    <ChannelsSection
      rows={rows}
      activeSessionId=""
      runningIds={new Set()}
      journalOfSession={new Map()}
      isUnseen={() => false}
      busy={false}
      onAttach={() => undefined}
      {...over}
    />,
  );
}

describe('ChannelsSection(侧栏「通道」分组,spec §9.1)', () => {
  it('①通道组渲染行:组头「通道」+平台图标(data-tip=平台名)+聊天标识(通道 id)+会话标题', () => {
    const { container } = renderSection([channelRow('j1'), channelRow('j2')]);
    expect(screen.getByText('通道')).toBeDefined(); // 组头标题
    // 平台图标位:icon span 携平台名 data-tip(行面保持「图标+标识+标题」紧凑形态)
    expect(container.querySelectorAll('[data-tip="Telegram"]').length).toBe(2);
    // 聊天标识=通道配置 id(行 meta channel 反查)
    expect(screen.getAllByText('tg1').length).toBe(2);
    // 会话标题
    expect(screen.getByText('通道会话 j1')).toBeDefined();
    expect(screen.getByText('通道会话 j2')).toBeDefined();
    expect(container.querySelectorAll('.recent-list .session-row').length).toBe(2);
  });

  it('②行点击 → onAttach(root, journalId, updatedAt) 直寻址参数对(sunxAttach 同语义)', () => {
    const onAttach = vi.fn();
    renderSection([channelRow('j9')], { onAttach });
    fireEvent.click(screen.getByText('通道会话 j9'));
    expect(onAttach).toHaveBeenCalledWith(DOMAIN_ROOT, 'j9', FIXED_TS);
  });

  it('③空容器不渲染组:rows 空列/装载中(null)整块不渲染(与 SUNX 常驻组分叉)', () => {
    const empty = renderSection([]);
    expect(empty.container.querySelector('.sx-side-head')).toBeNull();
    expect(empty.container.textContent).toBe('');
    empty.unmount();
    const loading = renderSection(null);
    expect(loading.container.querySelector('.sx-side-head')).toBeNull();
    expect(loading.container.textContent).toBe('');
  });
});
