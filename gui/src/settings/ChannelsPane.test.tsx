import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChannelsPane } from './ChannelsPane';
import type { ChannelsPaneConn } from './ChannelsPane';
import type { ChannelConfigMsg, ChannelHealthRowMsg } from '../connection-api';

/**
 * ChannelsPane 桩测（channels Task 15 终形态重做 + 2026-11-22 密钥内联改版：推翻 D6 env 分组口径
 * ——密钥存通道条目 secret 字段、可回显；conn 桩照 SchedulePage.test.tsx makeConn 模式）：conn
 * 八面全桩不出网。测试基准语言钉 en（test-setup G14.104），断言走 bi() 双语容忍正则（D37 家族）。
 *
 * 用例：①空态+「+ 新增通道」；②新增弹窗（平台/应用名称/token → putChannels 载含 name 与
 * secret，保存后自动试连）；③编辑弹窗回填（settingsChannels 真值；token 回显已存 secret+
 * 眼睛显隐切换；未改动保存 → putChannels 原值随表）；④卡头 Switch → putChannels enabled 翻转；
 * ⑤删除（两段确认）→ 全表少一条；⑥full-access 红字警示；⑦卡头「测试连接」→ testChannel +
 * 行内结果；⑧改动 token 保存 → putChannels 载新 secret（密钥随条目落盘，2026-11-22 裁定）；
 * ⑨清空 token 保存 → putChannels 行无 secret 键（清除）。
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
  const channelBindings = vi.fn(async () => ({ bindings: [] }));
  const deleteChannelBinding = vi.fn(async () => ({ ok: true as const }));
  const workspaces = vi.fn(async () => [{ slug: 'proj-a', root: 'D:/proj/a', mtime: 1, sessionCount: 0 }]);
  const conn = { channelsView, settingsChannels, putChannels, testChannel, channelBindings, deleteChannelBinding, workspaces } as unknown as ChannelsPaneConn;
  return { conn, channelsView, settingsChannels, putChannels, testChannel, channelBindings, deleteChannelBinding, workspaces };
}

describe('ChannelsPane（Task 15 终形态：ProvidersPane 克隆 + 密钥内联回显）', () => {
  /** ① 空态：简介一句 + EmptyState + 「+ 新增通道」钮；读面拉过一次 */
  it('renders intro, empty state and the + New channel button', async () => {
    const { conn, channelsView } = makeConn([]);
    render(<ChannelsPane conn={conn} />);
    expect(screen.getByText(bi('Connect third-party apps (e.g. Feishu, WeCom) to Sunshinex.', '把三方应用（如飞书，企业微信）接入 Sunshinex。'))).toBeDefined();
    expect(await screen.findByText(bi('No channels yet.', '暂无通道。'))).toBeDefined();
    expect(screen.getByRole('button', { name: bi('+ New channel', '+ 新增通道') })).toBeDefined();
    expect(channelsView).toHaveBeenCalled();
  });

  /** ② 新增弹窗：平台选 Telegram + 填应用名称 + token → 保存 putChannels 载含
   *  {id:'telegram-1', platform:'telegram', name:'我的TG', enabled:true, secret:'tok-secret'}
   *  （密钥随条目落盘——2026-11-22 用户裁定推翻 D6），成功后 testChannel 自动试连一次 */
  it('adds a telegram channel via the modal and writes putChannels with the app name', async () => {
    const { conn, putChannels, testChannel } = makeConn([]);
    render(<ChannelsPane conn={conn} />);
    fireEvent.click(await screen.findByRole('button', { name: bi('+ New channel', '+ 新增通道') }));
    // 平台缺省飞书(2026-11-22 裁定):触发钮初始即显飞书,无需手选
    expect(screen.getByRole('button', { name: bi('Platform', '平台') }).textContent).toMatch(/Feishu|飞书/);
    fireEvent.click(screen.getByRole('button', { name: bi('Platform', '平台') }));
    fireEvent.click(await screen.findByRole('option', { name: /Telegram/ }));
    fireEvent.change(screen.getByLabelText(bi('App name', '应用名称')), { target: { value: '我的TG' } });
    fireEvent.change(screen.getByLabelText(bi('Bot Token', 'Bot Token')), { target: { value: 'tok-secret' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(putChannels).toHaveBeenCalledTimes(1));
    expect(putChannels.mock.calls[0]![0]).toEqual([
      { id: 'telegram-1', platform: 'telegram', name: '我的TG', enabled: true, root: 'auto', mode: 'read-only', secret: 'tok-secret', allow: { kind: 'first-user' } },
    ]);
    await waitFor(() => expect(testChannel).toHaveBeenCalledWith('telegram-1'));
    // 试连结果行内回显机器人身份
    expect(await screen.findByText(/bot-1/)).toBeDefined();
  });

  /** ③ 编辑：卡片铅笔 → 弹窗回填 settingsChannels 真值（name/工作区/权限模式）+ 平台锁定只读 +
   *  token 回显已存 secret（2026-11-22 裁定：密钥可回显）+ 眼睛显隐切换；未改动保存 → putChannels
   *  原值随表（secret 原样保留） */
  it('edits a channel: modal backfills from settingsChannels and echoes the stored secret', async () => {
    const cfg: ChannelConfigMsg = {
      id: 'telegram-9',
      platform: 'telegram',
      name: '我的TG',
      enabled: true,
      root: 'D:/proj/a',
      mode: 'acceptEdits',
      secret: 'tok-old',
      allow: { kind: 'first-user' },
    };
    const { conn, putChannels, testChannel } = makeConn([healthRow({ id: 'telegram-9' })], { cfg: [cfg] });
    const { container } = render(<ChannelsPane conn={conn} />);
    // 卡片标题=应用名称，副标=平台名
    await waitFor(() => expect(container.textContent).toContain('我的TG'));
    fireEvent.click(screen.getByRole('button', { name: bi('Edit telegram-9', '编辑 telegram-9') }));
    expect(((await screen.findByLabelText(bi('App name', '应用名称'))) as HTMLInputElement).value).toBe('我的TG');
    expect((screen.getByRole('button', { name: bi('Platform', '平台') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(bi('Workspace', '工作区')) as HTMLInputElement).value).toBe('D:/proj/a');
    expect(screen.getByRole('button', { name: bi('Access mode', '权限模式') }).textContent).toContain('Accept edits');
    // 回显已存 secret（缺省密文形态）
    const tokenInput = () => screen.getByLabelText(bi('Bot Token', 'Bot Token')) as HTMLInputElement;
    expect(tokenInput().value).toBe('tok-old');
    expect(tokenInput().type).toBe('password');
    // 眼睛显隐切换：显示 → text，再切回 password
    fireEvent.click(screen.getByRole('button', { name: bi('Show Bot Token', '显示 Bot Token') }));
    expect(tokenInput().type).toBe('text');
    expect(screen.getByRole('button', { name: bi('Hide Bot Token', '隐藏 Bot Token') })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: bi('Hide Bot Token', '隐藏 Bot Token') }));
    expect(tokenInput().type).toBe('password');
    // 未改动保存：putChannels 原值随表（secret 原样保留）
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(putChannels).toHaveBeenCalledTimes(1));
    expect(putChannels.mock.calls[0]![0]).toEqual([cfg]);
    // 等保存链收束（末腿 testChannel 已发）
    await waitFor(() => expect(testChannel).toHaveBeenCalledTimes(1));
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
    // 平台缺省飞书(2026-11-22 裁定):触发钮初始即显飞书,无需手选
    expect(screen.getByRole('button', { name: bi('Platform', '平台') }).textContent).toMatch(/Feishu|飞书/);
    fireEvent.click(screen.getByRole('button', { name: bi('Platform', '平台') }));
    fireEvent.click(await screen.findByRole('option', { name: /Telegram/ }));
    fireEvent.click(screen.getByRole('button', { name: bi('Access mode', '权限模式') }));
    fireEvent.click(await screen.findByRole('option', { name: bi('Full access', '完全访问') }));
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

  /** ⑧ 改动 token 保存（2026-11-22 密钥内联）：putChannels 载新 secret（密钥随条目落盘）；
   *  重开弹窗回显新值 */
  it('saves the changed token inline via putChannels secret and echoes it on reopen', async () => {
    const cfg: ChannelConfigMsg = { id: 'telegram-9', platform: 'telegram', name: '我的TG', enabled: true, root: 'auto', mode: 'read-only', secret: 'tok-old', allow: { kind: 'first-user' } };
    const { conn, putChannels, testChannel } = makeConn([healthRow({ id: 'telegram-9' })], { cfg: [cfg] });
    const { container } = render(<ChannelsPane conn={conn} />);
    await waitFor(() => expect(container.querySelectorAll('.sx-rc')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: bi('Edit telegram-9', '编辑 telegram-9') }));
    fireEvent.change(await screen.findByLabelText(bi('Bot Token', 'Bot Token')), { target: { value: 'tok-9' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(putChannels).toHaveBeenCalledTimes(1));
    const row = (putChannels.mock.calls[0]![0] as ChannelConfigMsg[])[0]!;
    expect(row.id).toBe('telegram-9');
    expect(row.secret).toBe('tok-9');
    await waitFor(() => expect(testChannel).toHaveBeenCalledWith('telegram-9'));
    // 重开弹窗：新值回显（保存后配置读面返回刚写全表——真实链路同径）
    fireEvent.click(await screen.findByRole('button', { name: bi('Edit telegram-9', '编辑 telegram-9') }));
    expect(((await screen.findByLabelText(bi('Bot Token', 'Bot Token'))) as HTMLInputElement).value).toBe('tok-9');
  });

  /** ⑨ 清空 token 保存 → putChannels 行无 secret 键（清除字段） */
  it('clears the secret when the token is emptied and saved', async () => {
    const cfg: ChannelConfigMsg = { id: 'telegram-9', platform: 'telegram', name: '我的TG', enabled: true, root: 'auto', mode: 'read-only', secret: 'tok-old', allow: { kind: 'first-user' } };
    const { conn, putChannels } = makeConn([healthRow({ id: 'telegram-9' })], { cfg: [cfg] });
    const { container } = render(<ChannelsPane conn={conn} />);
    await waitFor(() => expect(container.querySelectorAll('.sx-rc')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: bi('Edit telegram-9', '编辑 telegram-9') }));
    fireEvent.change(await screen.findByLabelText(bi('Bot Token', 'Bot Token')), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: bi('Save', '保存') }));
    await waitFor(() => expect(putChannels).toHaveBeenCalledTimes(1));
    const row = (putChannels.mock.calls[0]![0] as ChannelConfigMsg[])[0]!;
    expect('secret' in row).toBe(false);
  });
});
