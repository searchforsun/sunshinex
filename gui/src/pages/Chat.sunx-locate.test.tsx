import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Chat } from './Chat';
import type { ChatSink } from './chat/chat-types';
import type { Connection } from '../connection';

/** 跨 Sunx 归因定位（2026-11-26 用户裁定「点击气泡上蓝色 sunx 名字定位到对应发送气泡的轮次中」
 *  「和左侧刻度一样,定位到轮次就可以」——不闪光）：信号命中本会话 → MessageList 走刻度跳转同
 *  路径落点（data-entry-key=k<runSeq>）并消费清信号；异会话信号不动。 */

const sinkRef = { current: null as ChatSink | null };
const DAY1 = new Date(2026, 0, 10, 10).getTime();

function connOf(): Connection {
  return {
    sessionSnapshot: () =>
      Promise.resolve({
        messages: [
          { seq: 1, ts: DAY1, kind: 'user', md: '甲->乙 测试' },
          { seq: 2, ts: DAY1 + 1, kind: 'run', md: '' },
          { seq: 3, ts: DAY1 + 2, kind: 'tool', md: '', name: 'send_sunx_messages', result: { text: 'ok', ok: true } },
        ],
        status: 'idle',
        openRun: -1,
        openSeg: -1,
        board: { tasks: [] },
        delegations: [],
        team: [],
        pending: [],
        lastSeq: 0,
      }),
    sessionSubmit: () => Promise.resolve(),
    sessionSteer: () => Promise.resolve(),
    sessionInterrupt: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    fetchDiff: () => Promise.resolve({ oldContent: '', newContent: '' }),
    replyApproval: () => Promise.resolve(),
    replyAsk: () => Promise.resolve(),
    sessionModel: () => Promise.resolve({ current: undefined, choices: [] }),
    setSessionModel: vi.fn(() => Promise.resolve()),
    setSessionMode: vi.fn(() => Promise.resolve()),
    cancelSteer: vi.fn(() => Promise.resolve()),
    runCommand: vi.fn(() => Promise.resolve()),
    commands: () => Promise.resolve({ commands: [], descriptions: {}, supported: [] }),
    skillsGroups: () => Promise.resolve({ groups: [] }),
    sessionContext: () => Promise.resolve({ parts: [], chainByAction: [], total: 0, window: 1_000_000, free: 1_000_000 }),
  } as unknown as Connection;
}

async function flushed(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('跨 Sunx 归因定位(与左侧刻度同路径,不闪光)', () => {
  it('命中本会话:下发 revealRequest → 定位到该 run 条并消费清信号', async () => {
    const done = vi.fn();
    render(
      <Chat
        conn={connOf()}
        sessionId="s1"
        journalId="j-sender"
        kindHint="sunx"
        connState="open"
        onBack={() => {}}
        sinkRef={sinkRef}
        sunxPeerFocus={{ journalId: 'j-sender', runSeq: 2, nonce: 1 }}
        onSunxPeerFocusDone={done}
      />,
    );
    await flushed();
    expect(done).toHaveBeenCalledTimes(1); // 信号被消费(清宿主信号,切回不重复跳)
    // 无闪光标记(用户裁定「不闪高亮」)
    expect(document.querySelector('.chat-locate-flash')).toBeNull();
    // 定位目标=发送轮 run 条在场(data-entry-key 锚,刻度跳转同寻址面)
    expect(document.querySelector('.entry[data-entry-key="k2"]')).not.toBeNull();
  });

  it('异会话信号不动(别的会话的定位请求不在本会话消费)', async () => {
    const done = vi.fn();
    render(
      <Chat
        conn={connOf()}
        sessionId="s1"
        journalId="j-other"
        kindHint="sunx"
        connState="open"
        onBack={() => {}}
        sinkRef={sinkRef}
        sunxPeerFocus={{ journalId: 'j-sender', runSeq: 2, nonce: 1 }}
        onSunxPeerFocusDone={done}
      />,
    );
    await flushed();
    expect(done).not.toHaveBeenCalled();
    expect(screen.getAllByText('甲->乙 测试').length).toBeGreaterThan(0); // 会话本体正常渲染(标题回落+气泡)
  });
});
