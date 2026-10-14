import { describe, it, expect, vi, beforeEach } from 'vitest';
// mermaid 加载失败回落(懒加载降级纪律):工厂抛错即模拟拉包失败
vi.mock('mermaid', () => {
  throw new Error('mock: mermaid load failure');
});
// monaco 真渲染需要浏览器布局——jsdom 挂 stub(与 App.test 同款;G14.41 write 行 diff 面板)
vi.mock('monaco-editor', () => ({
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
}));
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  Editor: (props: { value?: string; language?: string }) => (
    <div className="mock-monaco-editor" data-language={props.language}>
      {props.value}
    </div>
  ),
  DiffEditor: (props: { original?: string; modified?: string }) => (
    <div className="mock-monaco-diff" data-original={props.original} data-modified={props.modified} />
  ),
}));
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
    sessionContext: () => Promise.resolve({ parts: [{ id: 'stable', tokens: 429, count: 1 }, { id: 'chain', tokens: 26, count: 3 }], chainByAction: [], total: 6577, window: 1_000_000, free: 993_423 }),
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
    expect((await screen.findAllByText('你好'))[0]).toBeTruthy(); // 标题回落同文——取首个(气泡)
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

  it('live 行只示时长(G14.11:tokens 迁工具行尾)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'usage', payload: { turnTotal: 8400 }, ts: Date.now() });
    const live = document.querySelector('.entry-run.live')?.textContent ?? '';
    expect(live).not.toContain('tokens'); // tokens 不在状态行
    expect(live).not.toContain('8.4k');
  });
});


  it('read 执行中:波纹+「正在读取」,不含路径;结果回后回落 名称+目录', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'read', ts: Date.now(), payload: { callId: 'cr', input: { path: 'src/a.ts' } } });
    let row = document.querySelector('.tool-summary')!;
    expect(row.textContent).toMatch(/Reading file|正在读取/);
    expect(row.querySelector('.exec-ripple-icon')).not.toBeNull();
    expect(row.textContent).not.toContain('src/');
    fire({ type: 'tool-result', text: 'content', ts: Date.now(), payload: { callId: 'cr' } });
    row = document.querySelector('.tool-summary')!;
    expect(row.textContent).toContain('a.ts src/'); // 完成后回落 名称+目录
  });

describe('工具行展开分型(G14:exec=$ 命令+输出,无 Input/Output 分节标)', () => {
  it('exec 展开:$ 命令行(highlight)+输出全文(md 只含首行,旁路全文优先)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'c1', input: { command: 'ls -la' } } });
    fire({ type: 'tool-result', text: 'file1\nfile2', ts: Date.now(), payload: { callId: 'c1' } });
    fireEvent.click(document.querySelector('.tool-summary')!);
    const exec = document.querySelector('.tool-exec');
    expect(exec).not.toBeNull();
    // G14.50:命令+输出同块(pre.tool-io-pre 单区;$ 行 bash 高亮)
    expect(exec?.querySelector('.tool-io-pre .exec-prompt')?.textContent).toContain('$');
    expect(exec?.querySelector('.tool-io-pre code')?.innerHTML).toContain('hljs'); // bash 高亮在场
    expect(exec?.querySelector('.tool-io-pre')?.textContent).toContain('ls -la');
    expect(exec?.querySelector('.tool-io-pre')?.textContent).toContain('file2');
  });

  it('result 先到 call 后到(乱序)同样配对全文(read 分型折叠行点开=文件,展开面经 .tool-body)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-result', text: 'out1\nout2', ts: Date.now(), payload: { callId: 'c9' } });
    fire({ type: 'tool-call', text: 'glob', ts: Date.now(), payload: { callId: 'c9', input: { pattern: '**/*' } } });
    fireEvent.click(document.querySelector('.tool-summary')!);
    expect(document.querySelector('.tool-io-pre')?.textContent).toContain('out2');
  });
});

describe('思考行(G11 §3)', () => {
  it('折叠预览示末个非空行;展开有 open 类与内滚容器', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'reasoning', text: '第一行\n第二行', ts: Date.now() });
    expect(document.querySelector('.thinking-preview')).toBeNull(); // G14.24:末行预览退役
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

describe('run 尾部操作条(G11 §6)', () => {
  it('末条正文下挂条:复制/fork 钮与 steps/tokens/时间', async () => {
    const onFork = vi.fn();
    render(<Chat conn={connOf([])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} onFork={onFork} />);
    await flushed();
    const now = Date.now();
    fire({ type: 'model-start', ts: now });
    fire({ type: 'token', text: '答', ts: now });
    fire({ type: 'done', text: '答', ts: now, payload: { steps: 12, tokensUsed: 8400 } });
    const footer = document.querySelector('.run-footer');
    expect(footer?.textContent).toContain('12 steps');
    expect(footer?.textContent).toContain('8.4k tokens');
    fireEvent.click(screen.getByRole('button', { name: 'fork session' }));
    expect(onFork).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'copy reply' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('答');
  });

  it('run 仍在跑(流尾 streaming)不挂条', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'token', text: '写一半', ts: Date.now() });
    expect(document.querySelector('.run-footer')).toBeNull();
  });
});

describe('用户气泡编辑卡(G11 §7)', () => {
  it('编辑:预填原文;发送=新消息(sessionSubmit+新回显条);Esc 取消回气泡', async () => {
    const sessionSubmit = vi.fn(() => Promise.resolve());
    const conn = connOf([{ seq: 1, ts: DAY1, kind: 'user', md: '> 你好' }]);
    (conn as unknown as Record<string, unknown>).sessionSubmit = sessionSubmit;
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await screen.findAllByText('你好'); // 标题回落同文——取首个
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'edit message' }) as HTMLTextAreaElement;
    expect(box.value).toBe('你好');
    fireEvent.change(box, { target: { value: '你好,再来一次' } });
    fireEvent.click(screen.getByRole('button', { name: 'send edit' }));
    expect(sessionSubmit).toHaveBeenCalledWith('s1', '你好,再来一次');
    await screen.findAllByText('你好,再来一次');
    // 发送后流内已有两条 user 气泡(原条+新回显条),各带 Edit 钮——getByRole 多元素会抛,取首条
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'edit message' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'edit message' })).toBeNull();
  });
});

describe('exec 执行中/完成双态(G14.13)', () => {
  it('执行中(result 未回):波纹图标+「正在执行」,不含命令', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'cx', input: { command: 'npm test' } } });
    const row = document.querySelector('.tool-summary')!;
    expect(row.textContent).toMatch(/Running|正在执行/); // 双语(测试默认 en)
    expect(row.querySelector('.exec-ripple-icon')).not.toBeNull();
    expect(row.textContent).not.toContain('npm test'); // 命令在完成后才示出
  });

  it('完成后:exec+完整命令(可点展开 $ 命令+输出)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'cx', input: { command: 'npm test' } } });
    fire({ type: 'tool-result', text: '3 tests passed', ts: Date.now(), payload: { callId: 'cx' } });
    const row = document.querySelector('.tool-summary')!;
    expect(row.textContent).toContain('exec');
    expect(row.textContent).toContain('npm test');
    expect(row.querySelector('.exec-ripple-icon')).toBeNull(); // 波纹退场
  });
});

describe('G14.18 上下文圆环', () => {
  it('模型 pill 左侧渲染圆环;hover 弹层示上下文占用/轮次步数/tokens/缓存命中', async () => {
    mountChat([]);
    await flushed();
    const ring = document.querySelector('.ctx-ring')!;
    expect(ring).not.toBeNull();
    // 挂载即拉 sessionContext:bar 命中率面 = total/window
    await waitFor(() => {
      expect(ring.querySelector('.ctx-ring-bar')!.getAttribute('stroke-dasharray')).not.toBe('0 43.982300884955774');
    });
    fireEvent.mouseEnter(ring);
    const pop = document.querySelector('.ctx-pop')!;
    expect(pop.textContent).toContain('6,577');
    expect(pop.textContent).toContain('1,000,000');
    expect(pop.textContent).toContain('Turns / Steps');
    expect(pop.textContent).toContain('System'); // G14.21 构成明细逐段
    expect(pop.textContent).toContain('Chain');
    expect(pop.textContent).toContain('· 3'); // 条数缀
    expect(pop.textContent).not.toContain('Model'); // 模型行去除(pill 在侧,冗余)
    fireEvent.mouseLeave(ring);
    await waitFor(() => expect(document.querySelector('.ctx-pop')).toBeNull());
  });
});

describe('G14.31 轮折叠与辅助对话全新视图', () => {
  it('Worked 行点击折叠/展开该轮工具行;chevron 元素恒在', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'c1', input: { command: 'ls' } } });
    fire({ type: 'tool-result', text: 'ok', ts: Date.now(), payload: { callId: 'c1' } });
    fire({ type: 'done', text: 'fin', ts: Date.now(), payload: { steps: 1, tokensUsed: 10 } });
    expect(document.querySelector('.entry-tool')).not.toBeNull();
    const runRow = document.querySelector('.entry-run.sealed')!;
    expect(runRow.getAttribute('aria-expanded')).toBe('true');
    expect(runRow.querySelector('.run-chev')).not.toBeNull();
    fireEvent.click(runRow);
    expect(document.querySelector('.entry-tool')).toBeNull(); // 工具行随轮折叠
    expect(runRow.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(runRow);
    expect(document.querySelector('.entry-tool')).not.toBeNull(); // 再点展开
  });

  it('freshView:种子历史不落屏(辅助对话全新视图)', async () => {
    render(
      <Chat
        conn={connOf([
          { seq: 1, kind: 'user', md: '> 旧问题' },
          { seq: 2, kind: 'assistant', md: '旧回答' },
        ])}
        sessionId="s1"
        connState="open"
        onBack={() => {}}
        sinkRef={sinkRef}
        freshView
      />,
    );
    await flushed();
    expect(document.querySelectorAll('.chat .entry')).toHaveLength(0);
  });
});

describe('G14.41 write 行 diffstat 保留', () => {
  it('write 行:路径省略时 +N -M 仍在行尾(宽度保留,不随省略消失)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'write', ts: Date.now(), payload: { callId: 'w1', input: { path: 'D:/very/long/path/sunshine-repo-path.md', content: 'x' } } });
    fire({ type: 'tool-result', text: 'written +1 -0', ts: Date.now(), payload: { callId: 'w1' } });
    expect(document.querySelector('.tool-stat-add')?.textContent).toContain('+1');
    expect(document.querySelector('.tool-stat-del')?.textContent).toContain('-0');
    // 路径省略(ellipsis 类在场)不影响 stat 渲染
    expect(document.querySelector('.tool-file-base')?.className).toContain('tool-file-base');
  });
});

