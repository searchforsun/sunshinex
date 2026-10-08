import { describe, it, expect, vi, beforeEach } from 'vitest';
// mermaid 加载失败回落(懒加载降级纪律):工厂抛错即模拟拉包失败
vi.mock('mermaid', () => {
  throw new Error('mock: mermaid load failure');
});
import { render, screen, fireEvent } from '@testing-library/react';
import { Chat } from './Chat';
import type { ChatSink } from './Chat';
import type { Connection } from '../connection';

/** G9-B3b 会话流 Codex 形:用户右胶囊(+hover 复制)/跨日居中日期分隔(DOM 契约:
 *  .entry-user>.user-bubble+.user-actions>.user-action[title=复制];.chat-day-sep[role=separator]) */

const sinkRef = { current: null as ChatSink | null };
const DAY1 = new Date(2026, 0, 10, 10).getTime();
const DAY2 = new Date(2026, 0, 11, 10).getTime();

type Seed = { seq: number; ts?: number; kind: 'user' | 'assistant'; md: string };

function connOf(messages: Seed[]): Connection {
  return {
    sessionSnapshot: () =>
      Promise.resolve({ messages, status: 'idle', board: { tasks: [] }, delegations: [], team: [], pending: [], lastSeq: 0 }),
    sessionSubmit: () => Promise.resolve(),
    sessionSteer: () => Promise.resolve(),
    sessionInterrupt: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    fetchDiff: () => Promise.resolve({ oldContent: '', newContent: '' }),
    replyApproval: () => Promise.resolve(),
    replyAsk: () => Promise.resolve(),
  } as unknown as Connection;
}

function mountChat(messages: Seed[]): void {
  render(<Chat conn={connOf(messages)} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
}

describe('Chat 会话流 Codex 形(B3b)', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
  });

  it('用户条目渲染右胶囊:entry-user 容器 + user-bubble 气泡 + 复制钮', async () => {
    mountChat([{ seq: 1, ts: DAY1, kind: 'user', md: '> 你好' }]);
    expect(await screen.findByText('你好')).toBeTruthy();
    const entry = document.querySelector('.entry-user')!;
    expect(entry).toBeTruthy();
    expect(entry.querySelector('.user-bubble')).toBeTruthy();
    expect(entry.querySelector('button[title="Copy"]')).toBeTruthy();
  });

  it('复制钮写入剪贴板(剥 > 前缀),成功示「已复制」', async () => {
    mountChat([{ seq: 1, ts: DAY1, kind: 'user', md: '> 你好' }]);
    fireEvent.click(await screen.findByTitle('Copy'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('你好');
    await screen.findByTitle('Copied');
  });

  it('跨日条目间渲染一条居中日期分隔;同日不渲染', async () => {
    const { unmount } = render(
      <Chat
        conn={connOf([
          { seq: 1, ts: DAY1, kind: 'user', md: '> a' },
          { seq: 2, ts: DAY2, kind: 'assistant', md: 'b' },
        ])}
        sessionId="s1"
        connState="open"
        onBack={() => {}}
        sinkRef={sinkRef}
      />,
    );
    // Codex 形:每个日组顶部一条(首组亦有)——两日两条
    const seps = await screen.findAllByRole('separator');
    expect(seps).toHaveLength(2);
    expect(seps.every((el) => el.classList.contains('chat-day-sep'))).toBe(true);
    unmount();
    mountChat([
      { seq: 1, ts: DAY1, kind: 'user', md: '> a' },
      { seq: 2, ts: DAY1, kind: 'assistant', md: 'b' },
    ]);
    await screen.findByText('b');
    expect(document.querySelectorAll('.chat-day-sep')).toHaveLength(1);
  });
});

describe('mermaid 围栏(G10-C3c)', () => {
  it('加载失败回落原文代码块(降级纪律,会话流零阻塞)', async () => {
    mountChat([{ seq: 2, ts: DAY1, kind: 'assistant', md: '图:\n\n```mermaid\ngraph TD; A-->B\n```' }]);
    expect(await screen.findByText(/graph TD; A-->B/, {}, { timeout: 5_000 })).toBeTruthy();
  });
});
