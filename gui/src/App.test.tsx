import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { SessionEvent } from '../../src/types';
import { App } from './App';
import { emptyBoard } from './projection';
import type { SnapshotTranscriptEntry } from './chat-reducer';
import type { ConnectionOpts, SnapshotResponse } from './connection';

/**
 * G3 对话页装配测（G-D10 单栏 + 底部输入 + 状态条）：vi.mock 连接工厂注入事件——
 * App() 无 props 自装配（token 经 localStorage 注入），mock conn 捕获 onEvent/onResync/
 * onStateChange 回调面驱动三投影；断言 md 渲染、Enter 分流（idle submit / running steer）、
 * Stop 中断、状态条连接点与 tokens/steps。
 */

const h = vi.hoisted(() => {
  class FakeConn {
    readonly opts: ConnectionOpts;
    submitCalls: string[] = [];
    steerCalls: string[] = [];
    interruptCalls = 0;
    closed = false;
    submitReject: Error | null = null;
    constructor(opts: ConnectionOpts) {
      this.opts = opts;
      created.push(this);
      opts.onStateChange?.('connecting'); // 真实现初始态即报
    }
    submit(goal: string): Promise<void> {
      if (this.submitReject !== null) return Promise.reject(this.submitReject);
      this.submitCalls.push(goal);
      return Promise.resolve();
    }
    steer(text: string): Promise<void> {
      this.steerCalls.push(text);
      return Promise.resolve();
    }
    interrupt(): Promise<void> {
      this.interruptCalls += 1;
      return Promise.resolve();
    }
    snapshot(): Promise<SnapshotResponse> {
      return Promise.resolve({ messages: [], board: emptyBoard(), delegations: [], status: 'idle' });
    }
    close(): void {
      this.closed = true;
    }
    state(): 'connecting' {
      return 'connecting';
    }
  }
  const created: FakeConn[] = [];
  return { FakeConn, created };
});

vi.mock('./connection', () => ({ createConnection: (opts: ConnectionOpts) => new h.FakeConn(opts) }));

/** react-markdown 透明计数桩：包装真实现并计渲染次数——条目 React.memo 的流式收敛回归依据
 *  （流式 token 帧只有流式条重渲染，稳定条目 md 解析零重跑） */
const md = vi.hoisted(() => ({ renders: 0 }));
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  const Real = actual.default;
  const Counting = (props: React.ComponentProps<typeof Real>): JSX.Element => {
    md.renders += 1;
    return <Real {...props} />;
  };
  return { default: Counting };
});

let ts = 0;
const ev = (type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent => ({ type, text, payload, ts: ++ts });

/** fixture 形态：messages 以五 kind 全集（daemon 实发 TranscriptEntry 面；connection.ts 声明的三 kind 子集经下行收窄断言） */
function snapshotOf(over: Partial<Omit<SnapshotResponse, 'messages'>> & { messages?: SnapshotTranscriptEntry[] }): SnapshotResponse {
  return { messages: [], board: emptyBoard(), delegations: [], status: 'idle', ...over } as SnapshotResponse;
}

/** 挂载（token 经 localStorage 注入，同 main 装配的开发持久形态）→ 捕获的 mock conn + 卸载句柄 */
function mount(): { conn: InstanceType<typeof h.FakeConn>; unmount: () => void } {
  localStorage.setItem('sunshinex.token', 'test-token');
  const { unmount } = render(<App />);
  return { conn: h.created.at(-1)!, unmount };
}

/** 快照落定 + open（连接层序：onResync → onStateChange('open')） */
function openWith(conn: InstanceType<typeof h.FakeConn>, snap: SnapshotResponse = snapshotOf({})): void {
  act(() => {
    conn.opts.onResync(snap);
    conn.opts.onStateChange?.('open');
  });
}

const fire = (conn: InstanceType<typeof h.FakeConn>, e: SessionEvent): void => {
  act(() => conn.opts.onEvent(e, 0));
};

const type = (text: string): void => {
  fireEvent.change(screen.getByLabelText('message input'), { target: { value: text } });
};

const pressEnter = (): void => {
  fireEvent.keyDown(screen.getByLabelText('message input'), { key: 'Enter' });
};

beforeEach(() => {
  localStorage.clear();
  h.created.length = 0;
});

describe('状态条：连接点四态 + 会话指标', () => {
  it('初始 connecting 态（工厂初始即报）；open 后迁移', () => {
    const { conn } = mount();
    expect(screen.getByLabelText('connection: connecting')).toBeDefined();
    expect(screen.getByText('connecting')).toBeDefined();
    openWith(conn);
    expect(screen.getByLabelText('connection: open')).toBeDefined();
  });

  it('reconnecting/closed 两态色 hook 亦可表达（onStateChange 透传）', () => {
    const { conn } = mount();
    act(() => conn.opts.onStateChange?.('reconnecting'));
    expect(screen.getByLabelText('connection: reconnecting')).toBeDefined();
    act(() => conn.opts.onStateChange?.('closed'));
    expect(screen.getByLabelText('connection: closed')).toBeDefined();
  });

  it('tokens/steps 随 usage/step 事件聚合显示', () => {
    const { conn } = mount();
    openWith(conn);
    fire(conn, ev('model-start'));
    fire(conn, ev('usage', undefined, { turnTotal: 120 }));
    fire(conn, ev('usage', undefined, { turnTotal: 340 }));
    fire(conn, ev('step', 'a'));
    fire(conn, ev('step', 'b'));
    expect(screen.getByText('340 tokens')).toBeDefined();
    expect(screen.getByText('2 steps')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
  });
});

describe('对话流渲染：onResync 基线 + 事件续推（md/gfm）', () => {
  it('onResync：snapshot.messages 五 kind 直映射渲染（md 原文，user 引用块等 gfm 形）', () => {
    const { conn } = mount();
    openWith(
      conn,
      snapshotOf({
        status: 'running',
        messages: [
          { seq: 1, ts: 1, kind: 'user', md: '> build the widget' },
          { seq: 2, ts: 2, kind: 'tool', md: '● read\n⎿ ok' },
          { seq: 3, ts: 3, kind: 'notice', md: '✻ dev started' },
          { seq: 4, ts: 4, kind: 'error', md: 'boom' },
        ],
      }),
    );
    expect(screen.getByText('build the widget')).toBeDefined(); // `> …` → blockquote
    expect(screen.getByText('● read ⎿ ok')).toBeDefined(); // 两行同段（normalizer 折叠）
    expect(screen.getByText('✻ dev started')).toBeDefined();
    expect(screen.getByText('boom')).toBeDefined();
    expect(document.querySelector('.entry-user blockquote')).not.toBeNull();
    expect(screen.getByText('running')).toBeDefined();
  });

  it('token 流式 → streaming 光标钩子；done 收段去光标', () => {
    const { conn } = mount();
    openWith(conn);
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 'widget '));
    fire(conn, ev('token', '**done**'));
    const entry = document.querySelector('.entry-assistant');
    expect(entry?.textContent).toBe('widget done'); // `**done**` → <strong>（gfm 生效）
    expect(entry?.querySelector('strong')?.textContent).toBe('done');
    expect(document.querySelector('.entry-assistant.streaming')).not.toBeNull();
    fire(conn, ev('done', 'widget **done**')); // 终稿=已累积（流即原文 md）
    expect(document.querySelector('.entry-assistant.streaming')).toBeNull();
    expect(document.querySelector('.entry-assistant')?.textContent).toBe('widget done');
  });

  it('条目 React.memo：流式 token 帧只重渲染流式条（稳定条 md 渲染计数不涨）', () => {
    const { conn } = mount();
    openWith(conn);
    type('stable');
    pressEnter(); // user 条 → 1 次 md 渲染
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 'a')); // 流式条开条 → +1
    const before = md.renders;
    fire(conn, ev('token', 'b')); // 流式增量：仅流式条重渲染（memo 跳过 user 条）
    fire(conn, ev('token', 'c'));
    expect(md.renders).toBe(before + 2);
    expect(document.querySelector('.entry-assistant')?.textContent).toBe('abc');
    expect(document.querySelector('.entry-user')?.textContent).toContain('stable');
  });

  it('delegation/agent-message → notice 行（同时喂 delegations 投影不倒面）', () => {
    const { conn } = mount();
    openWith(conn);
    fire(conn, ev('delegation-started', undefined, { label: 'dev', delegationId: 'd1' }));
    fire(conn, ev('agent-message', undefined, { from: 'a', to: 'b', text: 'ping' }));
    expect(screen.getByText('✻ dev started')).toBeDefined();
    expect(screen.getByText('[a → b] ping')).toBeDefined();
  });
});

describe('底部输入区：Enter 分流与 Stop', () => {
  it('idle：Enter 提交 submit + 本地 user 回显条，输入清空', () => {
    const { conn } = mount();
    openWith(conn);
    type('do the thing');
    pressEnter();
    expect(conn.submitCalls).toEqual(['do the thing']);
    expect(conn.steerCalls).toEqual([]);
    expect(screen.getByText('do the thing')).toBeDefined(); // `> do the thing` → blockquote 正文
    expect((screen.getByLabelText('message input') as HTMLInputElement).value).toBe('');
  });

  it('running：Enter 发 steer（不 submit）+ user 回显', () => {
    const { conn } = mount();
    openWith(conn);
    fire(conn, ev('model-start'));
    type('mid-run nudge');
    pressEnter();
    expect(conn.steerCalls).toEqual(['mid-run nudge']);
    expect(conn.submitCalls).toEqual([]);
    expect(screen.getByText('mid-run nudge')).toBeDefined();
  });

  it('Stop 按钮：running 在场且点击中断；idle 态退场（提交语义不占位）', () => {
    const { conn } = mount();
    openWith(conn);
    fire(conn, ev('model-start'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(conn.interruptCalls).toBe(1);
    fire(conn, ev('done', 'fin'));
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('submit 失败：error 条入列（HTTP 面错误不静默）', async () => {
    const { conn } = mount();
    openWith(conn);
    conn.submitReject = new Error('/submit -> 409');
    type('will fail');
    pressEnter();
    await waitFor(() => expect(screen.getByText('/submit -> 409')).toBeDefined());
    expect(document.querySelector('.entry-error')).not.toBeNull();
  });

  it('空输入 Enter 不动作', () => {
    const { conn } = mount();
    openWith(conn);
    type('   ');
    pressEnter();
    expect(conn.submitCalls).toEqual([]);
  });
});

describe('顶部 tab：Chat | Board（Board G5 禁用占位）', () => {
  it('Board 禁用、Chat 在场', () => {
    mount();
    expect((screen.getByRole('button', { name: 'Board' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Chat' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('token 门面（无 token 不建连接）', () => {
  it('无 token：显示输入页，不创建连接；提交后持久并装配', () => {
    const { unmount } = render(<App />);
    expect(h.created).toHaveLength(0);
    expect(screen.getByLabelText('token input')).toBeDefined();
    fireEvent.change(screen.getByLabelText('token input'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(localStorage.getItem('sunshinex.token')).toBe('abc123');
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.opts.token).toBe('abc123');
    unmount();
  });

  it('URL ?token= 直连：以其装配且回写 localStorage 持久（刷新/重连免带参）', () => {
    window.history.pushState({}, '', '/?token=from-url');
    try {
      const { unmount } = render(<App />);
      expect(h.created).toHaveLength(1);
      expect(h.created[0]!.opts.token).toBe('from-url');
      expect(localStorage.getItem('sunshinex.token')).toBe('from-url');
      unmount();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('卸载收口（单连接生命周期）', () => {
  it('unmount 关闭连接', () => {
    const { conn, unmount } = mount();
    openWith(conn);
    unmount();
    expect(conn.closed).toBe(true);
  });
});
