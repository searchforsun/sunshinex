import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChannelsPane } from './ChannelsPane';
import type { ChannelsPaneConn } from './ChannelsPane';
import type { ChannelConfigMsg, ChannelHealthRowMsg } from '../connection-api';

/**
 * ChannelsPane 桩测（channels Task 15 终形态重做 + 同日修复波：密钥写面接线，spec §8 2026-11-22
 * 用户裁定；conn 桩照 SchedulePage.test.tsx makeConn 模式）：conn 八面全桩不出网。测试基准语言钉
 * en（test-setup G14.104），断言走 bi() 双语容忍正则（D37 家族——产品面 t() 化，单语钉必脆）。
 *
 * 八用例：①空态+「+ 新增通道」；②新增弹窗（平台/应用名称/token → putChannels 载含 name，保存后
 * 自动试连）；③编辑弹窗回填（settingsChannels 真值；token 零回显，留空=不动 env 键）；④卡头
 * Switch → putChannels enabled 翻转；⑤删除（两段确认）→ 全表少一条；⑥full-access 红字警示；
 * ⑦卡头「测试连接」→ testChannel + 行内结果；⑧保存含 token → setChannelSecret 以 (id, token)
 * 调用（密钥写面接线，紧随 putChannels）。
 */

/** 双语容忍正则（D37 家族）：产品面 t() 化，测试环境钉 en，单语钉必脆 */
const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

/** GET /channels 健康行构造器（合法缺省，逐例覆写差面） */
const healthRow = (over: Partial<ChannelHealthRowMsg> = {}): ChannelHealthRowMsg => ({
  id: 'telegram-1',
  platform: 'telegram',
  enabled: true,
  connected: false,
  ...over,
});

/** pane conn 桩：七面调用记录（写面返回具名 mock，断言 putChannels 载荷/testChannel 自动试连；
 *  opts.cfg = GET /settings/channels 配置读面初始应答——已有通道弹窗回填真值的数据源。
 *  写面回显语义：putChannels 成功后配置读面返回刚写的全表（daemon 写盘后 handleChannelsGet
 *  同语义）——保存后的卡片与行内试连结果经重拉存活，真实链路同径） */
function makeConn(chans: ChannelHealthRowMsg[] = [], opts: { cfg?: ChannelConfigMsg[] } = {}) {
  let current: ChannelConfigMsg[] = opts.cfg ?? [];
  const channelsView = vi.fn(async () => ({ channels: chans }));
  const settingsChannels = vi.fn(async () => ({ channels: current, warnings: [] }));
  const putChannels = vi.fn(async (channels: ChannelConfigMsg[]) => {
    current = channels;
    return { ok: true as const, warnings: [] };
  });
  const testChannel = vi.fn(async () => ({ ok: true as const, botId: 'bot-1' }));
  const setChannelSecret = vi.fn(async (_id: string, _secret: string) => ({ ok: true as const }));
  const channelBindings = vi.fn(async () => ({ bindings: [] }));
  const deleteChannelBinding = vi.fn(async () => ({ ok: true as const }));
  const workspaces = vi.fn(async () => [{ slug: 'proj-a', root: 'D:/proj/a', mtime: 1, sessionCount: 0 }]);
  const conn = { channelsView, settingsChannels, putChannels, testChannel, setChannelSecret, channelBindings, deleteChannelBinding, workspaces } as unknown as ChannelsPaneConn;
  return { conn, channelsView, settingsChannels, putChannels, testChannel, setChannelSecret, channelBindings, deleteChannelBinding, workspaces };
}

describe('ChannelsPane（Task 15 终形态：ProvidersPane 克隆）', () => {
  /** ① 空态：简介一句 + EmptyState + 「+ 新增通道」钮；读面拉过一次 */
  it('renders intro, empty state and the + New channel button', async () => {
    const { conn, channelsView } = makeConn([]);
    render(<ChannelsPane conn={conn} />);
    expect(screen.getByText(bi('Connect Feishu / DingTalk / WeCom / Telegram chats to sunshine sessions.', '把飞书/钉钉/企业微信/Telegram 的聊天接入 sunshine 会话。'))).toBeDefined();
    expect(await screen.findByText(bi('No channels yet.', '暂无通道。'))).toBeDefined();
    expect(screen.getByRole('button', { name: bi('+ New channel', '+ 新增通道') })).toBeDefined();
    expect(channelsView).toHaveBeenCalled();
  });

  /** ② 新增弹窗：平台选 Telegram + 填应用名称 + token → 保存 putChannels 载含
   *  {id:'telegram-1', platform:'telegram', name:'我的TG', enabled:true}（token 零入载荷——D6），
   *  成功后 testChannel 自动试连一次 */
  it('adds a telegram channel via the modal and writes putChannels with the app name', async () => {
    const { conn, putChannels, testChannel } = makeConn([]);
    render(<ChannelsPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: bi('+ New channel', '+ 新增通道') }));
    const picker = await screen.findByRole('combobox', { name: bi('Platform', '平台') });
    fireEvent.change(picker, { target: { value: 'telegram' } });
    fireEvent.change(screen.getByLabelText(bi('App name', '应用名称')), { target: { value: '我的TG' } });
    fireEvent.change(screen.getByLabelText(bi('Bot Token', 'Bot Token')), { target: { value: 'tok-secret' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(putChannels).toHaveBeenCalledTimes(1));
    expect(putChannels.mock.calls[0]![0]).toEqual([
      { id: 'telegram-1', platform: 'telegram', name: '我的TG', enabled: true, root: 'auto', mode: 'read-only', allow: { kind: 'first-user' } },
    ]);
    await waitFor(() => expect(testChannel).toHaveBeenCalledWith('telegram-1'));
    // 试连结果行内回显机器人身份
    expect(await screen.findByText(/bot-1/)).toBeDefined();
  });

  /** ③ 编辑：卡片铅笔 → 弹窗回填 settingsChannels 真值（name/工作区/权限模式）+ 平台锁定只读 +
   *  token 零回显（播种恒空串）；留空保存 → setChannelSecret 不调（不动 env 键），putChannels
   *  保留原值 */
  it('edits a channel: modal backfills from settingsChannels and preserves values on save', async () => {
    const cfg: ChannelConfigMsg = {
      id: 'telegram-9',
      platform: 'telegram',
      name: '我的TG',
      enabled: true,
      root: 'D:/proj/a',
      mode: 'acceptEdits',
      allow: { kind: 'first-user' },
    };
    const { conn, putChannels, testChannel, setChannelSecret } = makeConn([healthRow({ id: 'telegram-9' })], { cfg: [cfg] });
    const { container } = render(<ChannelsPane conn={conn} />);
    // 卡片标题=应用名称，副标=平台名
    await waitFor(() => expect(container.textContent).toContain('我的TG'));
    fireEvent.click(screen.getByRole('button', { name: bi('Edit telegram-9', '编辑 telegram-9') }));
    expect(((await screen.findByLabelText(bi('App name', '应用名称'))) as HTMLInputElement).value).toBe('我的TG');
    expect((screen.getByRole('combobox', { name: bi('Platform', '平台') }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: bi('Workspace', '工作区') }) as HTMLSelectElement).value).toBe('D:/proj/a');
    expect((screen.getByRole('combobox', { name: bi('Access mode', '权限模式') }) as HTMLSelectElement).value).toBe('acceptEdits');
    // token 零回显（凭证区一句「此处输入不会明文回显」同源纪律）
    expect((screen.getByLabelText(bi('Bot Token', 'Bot Token')) as HTMLInputElement).value).toBe('');
    // 留空保存 = 不动 env 键：setChannelSecret 零调用
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(putChannels).toHaveBeenCalledTimes(1));
    expect(putChannels.mock.calls[0]![0]).toEqual([cfg]);
    // 等保存链收束（末腿 testChannel 已发）再断言密钥腿零调用
    await waitFor(() => expect(testChannel).toHaveBeenCalledTimes(1));
    expect(setChannelSecret).not.toHaveBeenCalled();
  });

  /** ④ 卡头 Switch → putChannels 全表写 enabled 翻转（false） */
  it('toggles the card switch and writes enabled:false via putChannels', async () => {
    const { conn, putChannels } = makeConn([healthRow()]);
    const { container } = render(<ChannelsPane conn={conn} />);
    await waitFor(() => expect(container.querySelectorAll('.sx-rc')).toHaveLength(1));
    fireEvent.click(screen.getByRole('switch', { name: bi('Enable telegram-1', '启用 telegram-1') }));
    await waitFor(() => expect(putChannels).toHaveBeenCalledTimes(1));
    const row = (putChannels.mock.calls[0]![0] as ChannelConfigMsg[])[0]!;
    expect(row.enabled).toBe(false);
    expect(row.id).toBe('telegram-1');
  });

  /** ⑤ 删除：两段确认 → putChannels 全表少一条（余 mock-2），卡片摘除不复活 */
  it('deletes a channel after confirm and writes the table without it', async () => {
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

  /** ⑥ full-access 红字警示（弹窗内 role=alert） */
  it('warns in red when full-access mode is selected', async () => {
    const { conn } = makeConn([]);
    render(<ChannelsPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: bi('+ New channel', '+ 新增通道') }));
    fireEvent.change(await screen.findByRole('combobox', { name: bi('Platform', '平台') }), { target: { value: 'telegram' } });
    fireEvent.change(screen.getByRole('combobox', { name: bi('Access mode', '权限模式') }), { target: { value: 'full-access' } });
    expect(
      await screen.findByText(
        bi(
          'Full access lets chat run commands and write files in this workspace — only for channels you personally use.',
          '完全访问允许聊天在该工作区执行命令与写盘——仅建议用于本人使用的通道。',
        ),
      ),
    ).toBeDefined();
  });

  /** ⑦ 卡头「测试连接」→ testChannel 单发 + 行内结果（成功回显机器人身份） */
  it('runs testChannel from the card button and shows the result inline', async () => {
    const { conn, testChannel } = makeConn([healthRow()]);
    const { container } = render(<ChannelsPane conn={conn} />);
    await waitFor(() => expect(container.querySelectorAll('.sx-rc')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: bi('Test connection telegram-1', '测试连接 telegram-1') }));
    await waitFor(() => expect(testChannel).toHaveBeenCalledWith('telegram-1'));
    expect(await screen.findByText(/bot-1/)).toBeDefined();
  });

  /** ⑧ 保存含 token（修复波密钥腿）：弹窗输入 Bot Token 保存 → setChannelSecret 以 (id, token)
   *  调用（紧随 putChannels，先于 testChannel——daemon 写 env 块槽 + 链重载后 dry-run 取新值）；
   *  重开弹窗零回显 */
  it('saves the token via setChannelSecret(id, token) after putChannels', async () => {
    const cfg: ChannelConfigMsg = { id: 'telegram-9', platform: 'telegram', name: '我的TG', enabled: true, root: 'auto', mode: 'read-only', allow: { kind: 'first-user' } };
    const { conn, putChannels, testChannel, setChannelSecret } = makeConn([healthRow({ id: 'telegram-9' })], { cfg: [cfg] });
    const { container } = render(<ChannelsPane conn={conn} />);
    await waitFor(() => expect(container.querySelectorAll('.sx-rc')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: bi('Edit telegram-9', '编辑 telegram-9') }));
    fireEvent.change(await screen.findByLabelText(bi('Bot Token', 'Bot Token')), { target: { value: 'tok-9' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(setChannelSecret).toHaveBeenCalledTimes(1));
    expect(setChannelSecret).toHaveBeenCalledWith('telegram-9', 'tok-9');
    // 次序:putChannels 先行(密钥腿在配置表之后)、testChannel 收尾
    expect(putChannels).toHaveBeenCalled();
    await waitFor(() => expect(testChannel).toHaveBeenCalledTimes(1));
    expect(testChannel).toHaveBeenCalledWith('telegram-9');
    // 重开弹窗:token 零回显(播种恒空串)
    fireEvent.click(await screen.findByRole('button', { name: bi('Edit telegram-9', '编辑 telegram-9') }));
    expect(((await screen.findByLabelText(bi('Bot Token', 'Bot Token'))) as HTMLInputElement).value).toBe('');
  });
});
