import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { applyDeveloperMode } from '../developer-mode';
import { Chat } from './Chat';
import type { ChatSink } from './Chat';
import type { Connection } from '../connection';

/**
 * 2026-11-18 用户实测回归「输入框怎么跑下面了,终端打开输入框跟随上移动」:keep-alive 座位壳
 * (.sx-chat-seat display:contents)让终端下栏不再是 .sx-main 直子,旧 CSS
 * `.sx-main:has(> .terminal-dock) .chat-dock` 抬升规则恒失配 → composer 压回下栏之上。
 * 修复后抬升走 Chat 的 dockShown → ChatComposerDock.dockLift 内联 bottom(=下栏高+10 呼吸缝),
 * 与 DOM 层级解耦。本测钉住两条:下栏在座=抬升;下栏关=回落 10px 缺省。
 * TerminalDock 以桩替身(xterm/pty 装配属 terminal-dock.test.tsx 测面)。
 */

const dockState = vi.hoisted(() => ({ open: false }));

vi.mock('../tabs/terminal-dock', () => ({
  TerminalDock: () => <div className="terminal-dock" />,
  loadDockSession: () => ({ open: dockState.open, tabs: [], active: '' }),
}));

const sinkRef = { current: null as ChatSink | null };

beforeEach(() => {
  applyDeveloperMode(true); // 终端下栏显能门(2026-11-17 缺省关)需开发者模式
  dockState.open = false;
});
afterEach(() => {
  applyDeveloperMode(false);
});

/** 最小 conn 面:播种快照/模型/上下文/设置(terminalDock=on)/技能与命令清单 */
function connOf(): Connection {
  return {
    sessionSnapshot: () =>
      Promise.resolve({ messages: [], status: 'idle', openRun: -1, openSeg: -1, board: { tasks: [] }, delegations: [], team: [], pending: [], lastSeq: 0 }),
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
    settings: () => Promise.resolve({ keys: [{ key: 'terminalDock', value: 'on' }], providers: { choices: [] } }),
    agentsView: () => Promise.resolve({ builtins: [], view: { entries: [], warnings: [] } }),
    teamsView: () => Promise.resolve({ view: { entries: [], warnings: [] } }),
  } as unknown as Connection;
}

function mountChat(): void {
  render(
    <Chat
      conn={connOf()}
      sessionId="s1"
      connState="open"
      onBack={() => {}}
      sinkRef={sinkRef}
      ptyIdFor={() => undefined}
      onPtyAllocated={() => {}}
      onCloseDockTab={() => {}}
    />,
  );
}

describe('终端下栏在座 → composer 抬升(keep-alive 座位壳回归)', () => {
  it('下栏开:composer 底边抬到下栏高+10 呼吸缝(不再压在下栏上)', async () => {
    dockState.open = true;
    mountChat();
    const dock = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.chat-dock');
      if (el === null) throw new Error('chat-dock not mounted');
      return el;
    });
    // settings 拉取(terminalDock=on)+ 高度上报(缺省 260)落定后抬升 270
    await waitFor(() => expect(dock.style.bottom).toBe('270px'));
    expect(document.querySelector('.terminal-dock')).not.toBeNull(); // 下栏桩真在座
  });

  it('下栏关:composer 无内联 bottom(CSS 缺省 10px 贴底)', async () => {
    dockState.open = false;
    mountChat();
    const dock = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.chat-dock');
      if (el === null) throw new Error('chat-dock not mounted');
      return el;
    });
    // 显能落定后再断言(关闭档不抬升,内联 bottom 恒空)
    await act(async () => {});
    expect(dock.style.bottom).toBe('');
    expect(document.querySelector('.terminal-dock')).toBeNull();
  });
});
