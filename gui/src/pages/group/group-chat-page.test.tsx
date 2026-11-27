// 群聊页（2026-11-26 群组规格 §7）：右侧群主气泡 + 环形饼图/两栏回执、左侧成员气泡
// （上方发送行/单卡片首行引用）、composer 发送走 sunxGroupSend。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setLanguage } from '../../i18n';
import type { Connection } from '../../connection';
import type { SunxRoomMessage } from '../../connection-types';
import { GroupChatPage } from './GroupChatPage';

setLanguage('zh');

const HUMAN: SunxRoomMessage = {
  id: 'm1', seq: 1, ts: 1_728_000_000_000, kind: 'human',
  from: { id: 'grp_x', name: '群主', kind: 'group' },
  text: '@A 你好', mentions: [{ id: 'jid_a', name: 'A' }],
  targets: [{ id: 'jid_a', name: 'A' }],
  deliveries: [{ to: 'jid_a', name: 'A', ok: true }],
};
const PEER: SunxRoomMessage = {
  id: 'm2', seq: 2, ts: 1_728_000_000_100, kind: 'peer',
  from: { id: 'jid_a', name: 'A', runSeq: 2, kind: 'sunx' },
  to: { id: 'grp_x', name: '群主', kind: 'group' },
  text: '回复正文', replyTo: 'm1',
  replyPreview: { from: { id: 'grp_x', name: '群主', kind: 'group' }, text: '@A 你好' },
};

function makeConn(): Connection {
  const messages = [HUMAN, PEER];
  return {
    commands: vi.fn(async () => ({ commands: [], descriptions: {}, supported: ['/status', '/delete'] })),
    models: vi.fn(async () => ({ choices: [{ id: 'm1', model: 'm1' }] })),
    sunxGroupDetail: vi.fn(async () => ({
      group: { id: 'grp_x', name: '研发群' },
      members: [{
        id: 'jid_a', name: 'A', live: true, running: false, updatedAt: 2, root: 'D:/w',
        asks: [{ pid: 'p1', req: { question: '要发布吗?', options: [{ label: '是' }, { label: '否' }] } }],
      }],
      owner: { id: 'grp_x', name: '群主', kind: 'group' as const },
    })),
    replyAsk: vi.fn(async () => undefined),
    sunxGroupMessages: vi.fn(async () => ({ group: { id: 'grp_x', name: '研发群' }, messages, cursor: 2, hasMore: false })),
    sunxGroupSend: vi.fn(async () => ({ ok: true as const, messageId: 'm3', seq: 3, targets: [] })),
    sunxGroupSearch: vi.fn(async () => ({ results: [] })),
    renameSunxGroup: vi.fn(async () => ({ ok: true as const, group: { id: 'grp_x', name: '研发群' } })),
    createSunxGroup: vi.fn(async () => ({ ok: true as const, group: { id: 'grp_y', name: '新群' } })),
    setSessionGroup: vi.fn(async () => ({ ok: true as const, groupId: 'grp_x' })),
  } as unknown as Connection;
}

describe('GroupChatPage', () => {
  it('渲染群名/右侧群主气泡+饼图回执/左侧成员气泡（发送行+首行引用）；回执两栏点名跳转', async () => {
    const conn = makeConn();
    const onOpenMember = vi.fn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={onOpenMember} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    expect(await screen.findByText('研发群')).toBeDefined();
    expect(screen.getAllByText('@A 你好').length).toBeGreaterThan(0);
    // 左侧气泡：上方发送行 A 发送给 群主；首行引用 @A 你好；正文 md
    expect(screen.getByText('发送给')).toBeDefined();
    expect(screen.getAllByText('A').length).toBeGreaterThan(0);
    expect(screen.getByText('回复正文')).toBeDefined();
    // 饼图回执 1/1 → 点击两栏
    fireEvent.click(screen.getByRole('button', { name: 'delivery receipt' }));
    expect(await screen.findByText(/已接收/)).toBeDefined();
    expect(screen.getByText(/未接收/)).toBeDefined();
    const dialog = screen.getByRole('dialog', { name: 'delivery receipt' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'A' }));
    expect(onOpenMember).toHaveBeenCalledWith('jid_a');
  });

  it('composer 发送：正文+显式 @ 成员 → sunxGroupSend（无文件/上下文/终端入口）', async () => {
    const conn = makeConn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    await screen.findByText('研发群');
    const input = screen.getByPlaceholderText('发消息到群聊…') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '给 A 的消息' } });
    fireEvent.click(screen.getByRole('button', { name: 'mention member' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(conn.sunxGroupSend).toHaveBeenCalled());
    const [gid, body] = (conn.sunxGroupSend as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { text: string; mentions?: string[] }];
    expect(gid).toBe('grp_x');
    expect(body.text).toContain('给 A 的消息');
    expect(body.mentions).toEqual(['jid_a']);
    expect(screen.getByRole('button', { name: 'add attachment' })).toBeDefined(); // + 保留（图片/命令等；文件区不渲染）
    expect(screen.queryByRole('button', { name: 'toggle terminal dock' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'toggle side panel' })).toBeNull();
  });

  it('成员 ask 卡在群页弹出：来自 A；选项提交走 replyAsk（同一 pid），提交后撤卡', async () => {
    const conn = makeConn();
    render(<GroupChatPage conn={conn} groupId="grp_x" onClose={vi.fn()} onOpenMember={vi.fn()} onOpenSession={vi.fn()} onError={vi.fn()} searchOpen={false} onSearchClose={vi.fn()} />);
    expect(await screen.findByText('要发布吗?')).toBeDefined();
    expect(screen.getByText('来自')).toBeDefined();
    expect(screen.getAllByText('A').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('是'));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(conn.replyAsk).toHaveBeenCalledWith('p1', { type: 'selected', labels: ['是'] }));
    await waitFor(() => expect(screen.queryByText('要发布吗?')).toBeNull());
  });
});
