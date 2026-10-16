import { describe, it, expect, vi, beforeEach } from 'vitest';
// mermaid/monaco stub(与 Chat.test 同款——jsdom 无布局)
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => Promise.resolve({ svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' })),
  },
}));
vi.mock('monaco-editor', () => ({
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
}));
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  Editor: (props: { value?: string }) => <div className="mock-monaco-editor">{props.value}</div>,
  DiffEditor: () => <div className="mock-monaco-diff" />,
}));
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setLanguage } from '../../src/i18n';
import { Chat } from './Chat';
import type { ChatSink } from './Chat';
import type { Connection } from '../connection';

/** D30 判别用例：pauseAndSend 吞错收口（409/网络失败倒 error 条可见化）——
 *  换回 `.catch(() => {})` 旧实现时本用例红（错误条不出现）。 */

const sinkRef = { current: null as ChatSink | null };

function mountWithQueue(submitImpl: () => Promise<void>): { sessionSubmit: ReturnType<typeof vi.fn>; sessionInterrupt: ReturnType<typeof vi.fn>; cancelSteer: ReturnType<typeof vi.fn> } {
  let snapCount = 0;
  const sessionSubmit = vi.fn(submitImpl);
  const sessionInterrupt = vi.fn(() => Promise.resolve());
  const cancelSteer = vi.fn(() => Promise.resolve());
  const conn = {
    sessionSnapshot: () => {
      snapCount += 1;
      // 首拍=挂载播种（running+队列一行）;此后 idle(pauseAndSend 等 idle 窗即出)
      return Promise.resolve(
        snapCount <= 1
          ? { messages: [], status: 'running', board: { tasks: [] }, delegations: [], team: [], pending: [], lastSeq: 0, queued: [{ seq: 7, text: '排队的一条' }] }
          : { messages: [], status: 'idle', board: { tasks: [] }, delegations: [], team: [], pending: [], lastSeq: 0, queued: [] },
      );
    },
    sessionSubmit,
    sessionInterrupt,
    cancelSteer,
    sessionSteer: vi.fn(() => Promise.resolve()),
    deleteSession: vi.fn(() => Promise.resolve()),
    fetchDiff: vi.fn(() => Promise.resolve({ oldContent: '', newContent: '' })),
    replyApproval: vi.fn(() => Promise.resolve()),
    replyAsk: vi.fn(() => Promise.resolve()),
    sessionModel: vi.fn(() => Promise.resolve({ current: undefined, explicitDefault: false, choices: [] })),
    setSessionModel: vi.fn(() => Promise.resolve()),
    setSessionMode: vi.fn(() => Promise.resolve()),
    runCommand: vi.fn(() => Promise.resolve()),
    commands: vi.fn(() => Promise.resolve({ commands: [], descriptions: {}, supported: [] })),
    sessionContext: vi.fn(() => Promise.resolve({ parts: [], chainByAction: [], total: 0, window: 1, free: 1 })),
  } as unknown as Connection;
  render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
  return { sessionSubmit, sessionInterrupt, cancelSteer };
}

describe('D30 pauseAndSend 吞错收口（判别用例）', () => {
  beforeEach(() => {
    setLanguage('en');
  });

  it('「暂停并发送」submit 409 失败 → error 条可见（旧实现静默丢消息,本用例红）', async () => {
    const { sessionSubmit, sessionInterrupt } = mountWithQueue(() => Promise.reject(new Error('run in progress')));
    // 队列行渲染(running 态播种带 queued)
    await waitFor(() => expect(screen.getByText('排队的一条')).toBeTruthy());
    // 点击队列行的「Now」(pauseAndSend 入口)
    fireEvent.click(screen.getByText('Now'));
    // 中断已发起 + submit 已尝试;409 拒绝倒 error 条(可见化=收口判据)
    await waitFor(() => expect(sessionSubmit).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/run in progress/)).toBeTruthy());
    expect(sessionInterrupt).toHaveBeenCalled();
  });

  it('submit 成功路径:无 error 条,队列条目本地移除', async () => {
    const { cancelSteer } = mountWithQueue(() => Promise.resolve());
    await waitFor(() => expect(screen.getByText('排队的一条')).toBeTruthy());
    fireEvent.click(screen.getByText('Now'));
    await waitFor(() => expect(cancelSteer).toHaveBeenCalledWith('s1', 7));
    // 成功:错误条不出现(轮询数拍确认非时序假绿)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(screen.queryByText(/run in progress/)).toBeNull();
  });
});

describe('D30 欢迎页接力判别用例', () => {
  it('接力目标提交失败 → error 条可见（submitText 单点路径,用户气泡不缺席）', async () => {
    let snapCount = 0;
    const sessionSubmit = vi.fn(() => Promise.reject(new Error('run in progress')));
    const conn = {
      sessionSnapshot: () => {
        snapCount += 1;
        return Promise.resolve({ messages: [], status: 'idle', board: { tasks: [] }, delegations: [], team: [], pending: [], lastSeq: 0 });
      },
      sessionSubmit,
      sessionSteer: vi.fn(() => Promise.resolve()),
      sessionInterrupt: vi.fn(() => Promise.resolve()),
      cancelSteer: vi.fn(() => Promise.resolve()),
      commands: vi.fn(() => Promise.resolve({ commands: [], descriptions: {}, supported: [] })),
      sessionModel: vi.fn(() => Promise.resolve({ current: undefined, explicitDefault: false, choices: [] })),
      setSessionModel: vi.fn(() => Promise.resolve()),
      setSessionMode: vi.fn(() => Promise.resolve()),
      runCommand: vi.fn(() => Promise.resolve()),
      deleteSession: vi.fn(() => Promise.resolve()),
      fetchDiff: vi.fn(() => Promise.resolve({ oldContent: '', newContent: '' })),
      replyApproval: vi.fn(() => Promise.resolve()),
      replyAsk: vi.fn(() => Promise.resolve()),
      sessionContext: vi.fn(() => Promise.resolve({ parts: [], chainByAction: [], total: 0, window: 1, free: 1 })),
    } as unknown as Connection;
    render(
      <Chat
        conn={conn}
        sessionId="s1"
        connState="open"
        onBack={() => {}}
        sinkRef={sinkRef}
        pendingGoal={{ root: '/w', goal: '接力的一条' }}
        onPendingGoalDone={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getAllByText('接力的一条')[0]).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/run in progress/)).toBeTruthy());
    expect(sessionSubmit).toHaveBeenCalledWith('s1', '接力的一条');
  });
});
