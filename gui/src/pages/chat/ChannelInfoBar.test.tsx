import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setLanguage } from '../../i18n';
import { ChannelInfoBar } from './ChannelInfoBar';
import type { ChannelBindingMsg, ChannelConfigMsg } from '../../connection-api';
import type { WorkspaceRow } from '../../connection';

// i18n 语言钉:断言走中文文案(project-menu-sunx.test 同款先例)
setLanguage('zh');

/**
 * Chat 聊天信息条(channels Task 13,spec §9.3):激活会话 journalId 命中 channelBindings() 行
 * 才渲染——只读:平台/通道实例名/聊天 id(+单聊群聊)/锁定用户/绑定时间/工作区归属三态;
 * 可编辑:绑定工作区下拉(写 putChannelBinding(key,{rootOverride}),下次 /new 生效当前不动)+
 * 解绑按钮(确认后 deleteChannelBinding,下一条 IM 消息起全新会话)。非通道会话不渲染。
 */

const FIXED_TS = 1_728_000_000_000;

function mkBinding(over: Partial<ChannelBindingMsg> = {}): ChannelBindingMsg {
  return { key: 'm1:c1', sessionId: 's1', journalId: 'j1', updatedAt: FIXED_TS, ...over };
}

function mkCfg(over: Partial<ChannelConfigMsg> = {}): ChannelConfigMsg {
  return {
    id: 'm1',
    platform: 'telegram',
    enabled: true,
    root: 'auto', // 缺省形态=聊天专属域(沙箱)
    mode: 'read-only',
    allow: { kind: 'first-user' },
    ...over,
  };
}

const WORKSPACES: WorkspaceRow[] = [
  { slug: 'alpha', root: 'D:/w/alpha', mtime: 0, sessionCount: 1 },
  { slug: 'beta', root: 'D:/w/beta', mtime: 0, sessionCount: 2 },
];

function connStubs(
  bindings: ChannelBindingMsg[],
  channels: ChannelConfigMsg[] = [mkCfg()],
) {
  const put = vi.fn().mockResolvedValue({ ok: true });
  const del = vi.fn().mockResolvedValue({ ok: true });
  const conn = {
    channelBindings: vi.fn().mockResolvedValue({ bindings }),
    settingsChannels: vi.fn().mockResolvedValue({ channels, warnings: [] }),
    workspaces: vi.fn().mockResolvedValue(WORKSPACES),
    putChannelBinding: put,
    deleteChannelBinding: del,
  };
  return { conn, put, del };
}

describe('ChannelInfoBar(Chat 聊天信息条,spec §9.3)', () => {
  it('④只读字段齐全:平台(Telegram)/通道实例名(m1)/聊天 id(c1)/锁定用户/绑定于/单聊群聊', async () => {
    const { conn } = connStubs([mkBinding({ lockedUserId: 'u9', chatKind: 'group' })]);
    render(<ChannelInfoBar conn={conn} journalId="j1" />);
    await waitFor(() => expect(screen.getByText('Telegram')).toBeDefined());
    expect(screen.getByText('m1')).toBeDefined(); // 通道实例名
    expect(screen.getByText(/c1/)).toBeDefined(); // 聊天 id
    expect(screen.getByText('群聊')).toBeDefined(); // chatKind 随 binding 透出即显
    expect(screen.getByText(/u9/)).toBeDefined(); // 锁定用户
    expect(screen.getByText(/绑定于/)).toBeDefined(); // 绑定时间标
    expect(screen.getByText(/沙箱域/)).toBeDefined(); // 工作区归属三态之一(沙箱态,详见下三断言)
  });

  it('④工作区归属三态各断一:沙箱域 / 沙箱域 · 下次 /new 将切至 <目标> / 真实项目: <path>', async () => {
    // 态一:cfg.root==='auto' 且无 rootOverride → 「沙箱域」
    const a = connStubs([mkBinding({ rootOverride: undefined })]);
    const ra = render(<ChannelInfoBar conn={a.conn} journalId="j1" />);
    await waitFor(() => expect(ra.getByText(/沙箱域/).textContent).toBe('沙箱域'));
    ra.unmount();
    // 态二:rootOverride 在场未生效 → 「沙箱域 · 下次 /new 将切至 D:/w/target」
    const b = connStubs([mkBinding({ rootOverride: 'D:/w/target' })]);
    const rb = render(<ChannelInfoBar conn={b.conn} journalId="j1" />);
    await waitFor(() =>
      expect(rb.container.textContent).toContain('沙箱域 · 下次 /new 将切至 D:/w/target'),
    );
    rb.unmount();
    // 态三:cfg.root 为显式注册项目路径 → 「真实项目: D:/w/real」
    const c = connStubs([mkBinding()], [mkCfg({ root: 'D:/w/real' })]);
    const rc = render(<ChannelInfoBar conn={c.conn} journalId="j1" />);
    await waitFor(() => expect(rc.getByText(/真实项目: D:\/w\/real/)).toBeDefined());
    rc.unmount();
    // 附加:rootOverride 回显=下拉当前值(下次 /new 生效提示常驻;值取注册项目 root 供 option 命中)
    const d = connStubs([mkBinding({ rootOverride: 'D:/w/alpha' })]);
    const rd = render(<ChannelInfoBar conn={d.conn} journalId="j1" />);
    const sel = (await rd.findByLabelText('绑定工作区')) as HTMLSelectElement;
    expect(sel.value).toBe('D:/w/alpha');
    expect(rd.container.textContent).toContain('下次 /new 生效');
  });

  it('⑤rootOverride 下拉改值 → putChannelBinding(key, {rootOverride}) 以目标 root 调用', async () => {
    const { conn, put } = connStubs([mkBinding()]);
    render(<ChannelInfoBar conn={conn} journalId="j1" />);
    const sel = (await screen.findByLabelText('绑定工作区')) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'D:/w/alpha' } });
    await waitFor(() => expect(put).toHaveBeenCalledWith('m1:c1', { rootOverride: 'D:/w/alpha' }));
    // 切回「聊天专属域」=清除覆盖(写 null,服务端按全量定态语义清 rootOverride)
    fireEvent.change(sel, { target: { value: '' } });
    await waitFor(() => expect(put).toHaveBeenCalledWith('m1:c1', { rootOverride: null }));
  });

  it('⑥解绑:确认 morph 后 deleteChannelBinding(key),信息条随解除消失', async () => {
    const { conn, del } = connStubs([mkBinding()]);
    const { container } = render(<ChannelInfoBar conn={conn} journalId="j1" />);
    await screen.findByText('解绑');
    fireEvent.click(screen.getByRole('button', { name: '解绑' })); // 一击=确认 morph(不直执行)
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认解绑' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('m1:c1'));
    await waitFor(() => expect(container.textContent).toBe('')); // 解除即隐(下一条 IM 消息起全新会话)
  });

  it('⑦非通道会话(journalId 不命中绑定档)不渲染信息条', async () => {
    const { conn } = connStubs([mkBinding({ key: 'm1:other', journalId: 'j-other' })]);
    const { container } = render(<ChannelInfoBar conn={conn} journalId="j1" />);
    await waitFor(() => expect(conn.channelBindings).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    // journalId 缺席(测试桩/旁路面)同样不渲染
    const b = connStubs([mkBinding()]);
    const rb = render(<ChannelInfoBar conn={b.conn} journalId={undefined} />);
    expect(rb.container.textContent).toBe('');
  });
});
