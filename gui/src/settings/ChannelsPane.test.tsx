import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChannelsPane } from './ChannelsPane';
import type { ChannelsPaneConn } from './ChannelsPane';
import type { ChannelConfigMsg, ChannelHealthRowMsg } from '../connection-api';

/**
 * ChannelsPane 桩测(channels Task 12,task brief 用例 ①~⑥;conn 桩照 SchedulePage.test.tsx
 * makeConn 模式):conn 六面全桩不出网。测试基准语言钉 en(test-setup G14.104),断言走
 * bi() 双语容忍正则(D37 家族——产品面 t() 化,单语钉必脆)。
 */

/** 双语容忍正则(D37 家族):产品面 t() 化,测试环境钉 en,单语钉必脆 */
const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

/** GET /channels 健康行构造器(合法缺省,逐例覆写差面) */
const healthRow = (over: Partial<ChannelHealthRowMsg> = {}): ChannelHealthRowMsg => ({
  id: 'telegram-1',
  platform: 'telegram',
  enabled: true,
  connected: false,
  ...over,
});

/** pane conn 桩:六面调用记录(写面返回具名 mock,断言 putChannels 载荷/testChannel 自动试连) */
function makeConn(chans: ChannelHealthRowMsg[] = []) {
  const channelsView = vi.fn(async () => ({ channels: chans }));
  const putChannels = vi.fn(async (_channels: ChannelConfigMsg[]) => ({ ok: true as const, warnings: [] }));
  const testChannel = vi.fn(async () => ({ ok: true as const, botId: 'bot-1' }));
  const channelBindings = vi.fn(async () => ({ bindings: [] }));
  const deleteChannelBinding = vi.fn(async () => ({ ok: true as const }));
  const workspaces = vi.fn(async () => [{ slug: 'proj-a', root: 'D:/proj/a', mtime: 1, sessionCount: 0 }]);
  const conn = { channelsView, putChannels, testChannel, channelBindings, deleteChannelBinding, workspaces } as unknown as ChannelsPaneConn;
  return { conn, channelsView, putChannels, testChannel, channelBindings, deleteChannelBinding, workspaces };
}

describe('ChannelsPane', () => {
  /** ① 空态渲染:EmptyState + 「添加通道」钮;读面拉过一次 */
  it('renders empty state with add button', async () => {
    const { conn, channelsView } = makeConn([]);
    render(<ChannelsPane conn={conn} />);
    expect(await screen.findByText(bi('No channels yet.', '暂无通道。'))).toBeDefined();
    expect(screen.getByRole('button', { name: bi('+ Add channel', '+ 添加通道') })).toBeDefined();
    expect(channelsView).toHaveBeenCalled();
  });

  /** ② 添加通道:平台下拉选 telegram → 卡片出现,id 自动生成(platform-<序>)且无手填 id 输入 */
  it('adds a telegram card with auto-generated id', async () => {
    const { conn } = makeConn([]);
    const { container } = render(<ChannelsPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: bi('+ Add channel', '+ 添加通道') }));
    const picker = await screen.findByRole('combobox', { name: bi('Platform', '平台') });
    fireEvent.change(picker, { target: { value: 'telegram' } });
    // 卡片出现:id 自动为 telegram-1(平台前缀+序号)——行锚 data-setting-key 可证
    await waitFor(() => expect(container.querySelector('[data-setting-key="channels.telegram-1.root"]')).not.toBeNull());
    // id 不暴露手填面:无「通道标识」输入
    expect(screen.queryByLabelText(bi('Channel id', '通道标识'))).toBeNull();
  });

  /** ③ 通用组字段全下拉/开关:combobox ≥3(工作区/权限模式/模型/准入),开关在场;
   *  缺省值正确(root='auto' 聊天专属工作区、mode='read-only') */
  it('renders common-group dropdowns and switch with defaults', async () => {
    const { conn } = makeConn([]);
    const { container } = render(<ChannelsPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: bi('+ Add channel', '+ 添加通道') }));
    fireEvent.change(await screen.findByRole('combobox', { name: bi('Platform', '平台') }), { target: { value: 'telegram' } });
    await waitFor(() => expect(container.querySelectorAll('.sx-rc')).toHaveLength(1));
    expect(screen.getAllByRole('combobox')).toHaveLength(4); // 工作区/权限模式/模型/准入
    expect(screen.getAllByRole('switch')).toHaveLength(1); // 卡头启停
    expect((screen.getByRole('combobox', { name: bi('Workspace', '工作区') }) as HTMLSelectElement).value).toBe('auto');
    expect((screen.getByRole('combobox', { name: bi('Access mode', '权限模式') }) as HTMLSelectElement).value).toBe('read-only');
    expect((screen.getByRole('combobox', { name: bi('Model', '模型') }) as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('combobox', { name: bi('Admission', '准入') }) as HTMLSelectElement).value).toBe('first-user');
  });

  /** ④ 保存:putChannels 以合法 ChannelConfigMsg 全表载荷调用(root 缺省 'auto'、mode 缺省
   *  'read-only'、allow 缺省 first-user;model 空省键) */
  it('saves via putChannels with default payload', async () => {
    const { conn, putChannels } = makeConn([healthRow()]);
    const { container } = render(<ChannelsPane conn={conn} />);
    await waitFor(() => expect(container.querySelector('[data-setting-key="channels.telegram-1.root"]')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(putChannels).toHaveBeenCalledTimes(1));
    expect(putChannels.mock.calls[0]![0]).toEqual([
      { id: 'telegram-1', platform: 'telegram', enabled: true, root: 'auto', mode: 'read-only', allow: { kind: 'first-user' } },
    ]);
  });

  /** ⑤ 保存成功后 testChannel 自动调用一次(spec §8.3 保存即试连) */
  it('auto-tests the channel after a successful save', async () => {
    const { conn, putChannels, testChannel } = makeConn([healthRow()]);
    const { container } = render(<ChannelsPane conn={conn} />);
    await waitFor(() => expect(container.querySelector('[data-setting-key="channels.telegram-1.root"]')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(putChannels).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(testChannel).toHaveBeenCalledTimes(1));
    expect(testChannel).toHaveBeenCalledWith('telegram-1');
    // 试连结果横幅(成功 · botId)
    expect(await screen.findByText(/bot-1/)).toBeDefined();
  });

  /** ⑥ 删除卡:两段确认 → putChannels 全表少一条(余 mock-2) */
  it('deletes a card and writes the table without it', async () => {
    const { conn, putChannels } = makeConn([healthRow(), healthRow({ id: 'mock-2', platform: 'mock' })]);
    const { container } = render(<ChannelsPane conn={conn} />);
    await waitFor(() => expect(container.querySelectorAll('.sx-rc')).toHaveLength(2));
    const del = screen.getByRole('button', { name: bi('Delete telegram-1', '删除 telegram-1') });
    fireEvent.click(del); // 武装
    fireEvent.click(del); // 确认
    await waitFor(() => expect(putChannels).toHaveBeenCalledTimes(1));
    expect(putChannels.mock.calls[0]![0]).toEqual([
      { id: 'mock-2', platform: 'mock', enabled: true, root: 'auto', mode: 'read-only', allow: { kind: 'first-user' } },
    ]);
    await waitFor(() => expect(container.querySelectorAll('.sx-rc')).toHaveLength(1));
  });
});
