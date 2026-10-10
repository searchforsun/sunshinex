import { describe, it, expect, vi, beforeEach } from 'vitest';
// mermaid 加载失败回落(懒加载降级纪律):工厂抛错即模拟拉包失败
vi.mock('mermaid', () => {
  throw new Error('mock: mermaid load failure');
});
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Chat } from './Chat';
import type { ChatSink } from './Chat';
import type { Connection } from '../connection';
import type { SessionEvent } from '../../../src/types';

/** G9-B3b 会话流 Codex 形:用户右胶囊(+hover 复制)/跨日居中日期分隔(DOM 契约:
 *  .entry-user>.user-bubble+.user-actions>.user-action[aria-label=Copy];.chat-day-sep[role=separator]) */

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
    sessionModel: () => Promise.resolve({ current: undefined, explicitDefault: false, choices: [] }),
    setSessionModel: vi.fn(() => Promise.resolve()),
    setSessionMode: vi.fn(() => Promise.resolve()),
    cancelSteer: vi.fn(() => Promise.resolve()),
    runCommand: vi.fn(() => Promise.resolve()),
    commands: () => Promise.resolve({ commands: ['/status', '/compact', '/plan'], descriptions: { status: 's', compact: 'c', plan: 'p' }, supported: ['/status', '/compact'] }),
  } as unknown as Connection;
}

function mountChat(messages: Seed[]): void {
  render(<Chat conn={connOf(messages)} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
}

/** 播种落定:冲微任务使 sessionSnapshot 应答处理完毕(seeding 门开,后继 fire 直投 reducer) */
async function flushed(): Promise<void> {
  await act(async () => {});
}
/** 投递本会话帧(seq 恒 1——页面不过滤 seq,连接层职责) */
function fire(e: SessionEvent): void {
  act(() => sinkRef.current!.on(e, 1));
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
    expect(entry.querySelector('button[aria-label="Copy"]')).toBeTruthy();
  });

  it('复制钮写入剪贴板(剥 > 前缀),成功示「已复制」', async () => {
    mountChat([{ seq: 1, ts: DAY1, kind: 'user', md: '> 你好' }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('你好');
    await waitFor(() => expect(document.querySelector('.entry-user .user-actions .sx-tip')?.getAttribute('data-tip')).toBe('Copied'));
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

describe('MermaidBlock(G11 §5.4)', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
  });

  it('容器带放大/复制钮;放大开 lightbox,Esc 关闭', async () => {
    mountChat([{ seq: 2, ts: DAY1, kind: 'assistant', md: ['图:', '', '```mermaid', 'graph TD; A-->B', '```'].join('\n') }]);
    await screen.findByText(/graph TD; A-->/, {}, { timeout: 5_000 });
    fireEvent.click(screen.getByRole('button', { name: 'zoom mermaid' }));
    expect(document.querySelector('.mermaid-lightbox')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.mermaid-lightbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'copy mermaid' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('graph TD; A-->B');
  });
});

describe('composer pills 与排队 chips(G10-C4)', () => {
  it('权限 pill 三态菜单:切换 manual 调 setSessionMode(manual)', async () => {
    const setSessionMode = vi.fn(() => Promise.resolve());
    const conn = connOf([{ seq: 1, ts: DAY1, kind: 'user', md: '> a' }]);
    (conn as unknown as Record<string, unknown>).setSessionMode = setSessionMode;
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    fireEvent.click(await screen.findByRole('button', { name: 'session mode' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Confirm changes' }));
    expect(setSessionMode).toHaveBeenCalledWith('s1', 'manual');
  });

  it('排队 chips:snapshot.queued 回显渲染,撤回钮调 cancelSteer(seq)', async () => {
    const cancelSteer = vi.fn(() => Promise.resolve());
    const conn = connOf([]);
    (conn as unknown as Record<string, unknown>).cancelSteer = cancelSteer;
    (conn as unknown as Record<string, unknown>).sessionSnapshot = () =>
      Promise.resolve({
        messages: [],
        status: 'running',
        board: { tasks: [] },
        delegations: [],
        team: [],
        pending: [],
        lastSeq: 0,
        queued: [
          { seq: 0, text: '排队一' },
          { seq: 1, text: '排队二' },
        ],
      });
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    expect(await screen.findByText('排队一')).toBeTruthy();
    expect(screen.getByText('排队二')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'cancel queued 0' }));
    expect(cancelSteer).toHaveBeenCalledWith('s1', 0);
  });
});

describe('run 状态行(G11 §1)', () => {
  it('model-start 后 .entry-run.live 显示 Working;done 封段后 .entry-run.sealed 显示 Worked for', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    expect(document.querySelector('.entry-run.live')?.textContent).toContain('Working');
    fire({ type: 'token', text: '答', ts: Date.now() });
    fire({ type: 'done', text: '答', ts: Date.now() + 34_000 });
    expect(document.querySelector('.entry-run.sealed')?.textContent).toContain('Worked for 34s');
  });

  it('live 行显示会话 tokens(usage 载荷续推,k 格式)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'usage', payload: { turnTotal: 8400 }, ts: Date.now() });
    expect(document.querySelector('.entry-run.live')?.textContent).toContain('8.4k tokens');
  });
});

describe('工具行展开 Input/Output(G11 §2)', () => {
  it('展开显示 input JSON 与 result 全文(md 只含首行)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'c1', input: { command: 'ls -la' } } });
    fire({ type: 'tool-result', text: 'file1\nfile2', ts: Date.now(), payload: { callId: 'c1' } });
    fireEvent.click(document.querySelector('.tool-summary')!);
    const io = document.querySelector('.tool-io');
    expect(io?.textContent).toContain('"command"');
    expect(io?.textContent).toContain('file2');
  });

  it('result 先到 call 后到(乱序)同样配对全文', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-result', text: 'out1\nout2', ts: Date.now(), payload: { callId: 'c9' } });
    fire({ type: 'tool-call', text: 'read', ts: Date.now(), payload: { callId: 'c9', input: { path: 'a.ts' } } });
    fireEvent.click(document.querySelector('.tool-summary')!);
    expect(document.querySelector('.tool-io')?.textContent).toContain('out2');
  });
});

describe('思考行(G11 §3)', () => {
  it('折叠预览示末个非空行;展开有 open 类与内滚容器', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'reasoning', text: '第一行\n第二行', ts: Date.now() });
    expect(document.querySelector('.thinking-preview')?.textContent).toBe('第二行');
    expect(document.querySelector('.think-body')).not.toBeNull();
    fireEvent.click(document.querySelector('.thinking-summary')!);
    expect(document.querySelector('.entry-thinking.open')).not.toBeNull();
    expect(document.querySelector('.thinking-scroll')).not.toBeNull();
    expect(document.querySelector('.thinking-detail')?.textContent).toContain('第一行');
  });

  it('Brain 图标在场', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'reasoning', text: '想', ts: Date.now() });
    expect(document.querySelector('.entry-thinking .thinking-summary svg')).not.toBeNull();
  });
});

describe('系统行图标(G11 §4)', () => {
  it('notice 通用=Info/委派 ✻=Bot/agent 消息=MessageSquare,error=AlertCircle——均 .entry-icon 前置', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'notice', text: 'hello', ts: Date.now() });
    expect(document.querySelector('.entry-notice .entry-icon svg')).not.toBeNull();
    expect(document.querySelector('.entry-notice')?.textContent).toContain('hello');
    fire({ type: 'delegation-started', payload: { label: 'dev', delegationId: 'd1' }, ts: Date.now() });
    expect(document.querySelectorAll('.entry-notice .entry-icon').length).toBe(2);
    fire({ type: 'agent-message', payload: { from: 'boss', to: 'dev', text: 'hi' }, ts: Date.now() });
    expect(document.querySelectorAll('.entry-notice .entry-icon').length).toBe(3);
    fire({ type: 'error', text: 'boom', ts: Date.now() });
    expect(document.querySelector('.entry-error .entry-icon svg')).not.toBeNull();
  });
});

describe('代码块 CodeBlock(G11 §5.2)', () => {
  it('围栏代码卡:语言标+hljs 高亮+复制写剪贴板', async () => {
    mountChat([{ seq: 1, ts: DAY1, kind: 'assistant', md: ['```ts', 'const a = 1;', '```'].join('\n') }]);
    await waitFor(() => expect(document.querySelector('.code-block')).not.toBeNull());
    expect(document.querySelector('.code-lang')?.textContent).toBe('ts');
    expect(document.querySelector('.code-block code .hljs-keyword')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'copy code' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const a = 1;');
  });
});

describe('表格容器(G11 §5.3)', () => {
  it('md 表格包进 .table-wrap 横滚容器', async () => {
    const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    mountChat([{ seq: 1, ts: DAY1, kind: 'assistant', md }]);
    await waitFor(() => expect(document.querySelector('.table-wrap table')).not.toBeNull());
  });
});
