import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserEntryView } from './EntryViews';
import { seedChatFromSnapshot } from '../../chat-reducer';
import type { ChatEntry, SnapshotTranscriptEntry } from '../../chat-reducer';
import { setLanguage } from '../../i18n';

// 语言钉:data-tip 断言走中文(本仓 i18n 测试先例)
setLanguage('zh');

const PEER = { id: 'sunx-jid-aaa', name: 'Planner' };

function peerEntry(over: Partial<ChatEntry> = {}): ChatEntry {
  return {
    key: 'k2',
    kind: 'user',
    md: '[fromSunx: Planner (sunx-jid-aaa)] 看板第三列卡住了\n\n(From another Sunx, not from the user. Reply to that Sunx with send_sunx_messages, to="sunx-jid-aaa".)',
    ts: Date.now(),
    fromSunx: PEER,
    ...over,
  };
}

/** 2026-11-26 用户裁定「gui 显示 sunx 的用户气泡,上面 sunx 图标加名称显示,可点击跳转指定 sunx」：
 *  对方视角=用户气泡形态，来源行(SunxIcon+实例名)在气泡上方;前缀与回答提示行只属模型面/链面，
 *  显示侧同剥——用户只看到正文 */
describe('跨 Sunx 消息气泡(来源行)', () => {
  it('来源行=实例名 + 点击跳转发送方 journalId 与发送轮次锚;正文剥掉前缀与回答提示行', () => {
    const onOpenSunx = vi.fn();
    const { container } = render(<UserEntryView entry={peerEntry({ fromSunx: { ...PEER, runSeq: 12 } })} onOpenSunx={onOpenSunx} />);
    const btn = screen.getByRole('button', { name: /Planner/ });
    // 无 hover 提示(2026-11-26 用户裁定「不要显示 hover 信息」);图标黑白色类随行
    expect(btn.getAttribute('data-tip')).toBeNull();
    expect(btn.querySelector('.user-from-sunx-icon')).not.toBeNull();
    fireEvent.click(btn);
    expect(onOpenSunx).toHaveBeenCalledWith('sunx-jid-aaa', 12); // runSeq=定位到发送方该轮
    // 前缀 + 提示行剥显：气泡正文只有原文
    expect(container.textContent).toContain('看板第三列卡住了');
    expect(container.textContent).not.toContain('[fromSunx');
    expect(container.textContent).not.toContain('send_sunx_messages');
  });

  it('未配跳转通道(测试桩/旁路面):来源行只读不产出可点钮', () => {
    render(<UserEntryView entry={peerEntry()} />);
    expect(screen.queryByRole('button', { name: /Planner/ })).toBeNull();
    expect(screen.getByText('Planner')).toBeDefined(); // 名称仍显示
  });

  it('普通用户条零来源行(旧行为逐字节不变)', () => {
    const { container } = render(<UserEntryView entry={{ key: 'k1', kind: 'user', md: '你好', ts: Date.now() }} onOpenSunx={() => undefined} />);
    expect(container.querySelector('.user-from-sunx')).toBeNull();
    expect(container.textContent).toContain('你好');
  });
});

describe('快照回种携带 fromSunx(重开/切会话归因不丢)', () => {
  it('seedChatFromSnapshot:user 条直映 fromSunx → 视图条目同字段', () => {
    const messages: SnapshotTranscriptEntry[] = [
      { seq: 1, ts: 1, kind: 'user', md: '[fromSunx: Planner (sunx-jid-aaa)] 在吗', fromSunx: PEER },
    ];
    const st = seedChatFromSnapshot(messages, { openRun: -1, openSeg: -1 });
    const u = st.entries.find((e) => e.kind === 'user');
    expect(u?.fromSunx).toEqual(PEER);
  });
});
