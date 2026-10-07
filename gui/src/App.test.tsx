import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { SessionEvent } from '../../src/types';
import { App } from './App';
import { emptyBoard, applyBoardEvent } from './projection';
import { highlightCode } from './highlight';
import type { SnapshotTranscriptEntry } from './chat-reducer';
import type { ConnectionOpts, ConnectionState, Connection, DiffResp, DirPickerResp, SessionRow, SnapshotResponse, WorkspaceRow, FileResp, TreeResp } from './connection';
import type { GuiApprovalReq, GuiAskAnswer, GuiAskReq } from './connection';

/**
 * G3.5 App 装配测(T4δ Chat 页会话化;G8a 三栏壳适配):vi.mock 连接工厂注入事件——
 * App() 无 props 自装配(token 经 localStorage 注入),mock conn 捕获 onEvent(sessionId,…)/
 * onReset/onStateChange 回调面;chat 分支经左栏 ProjectMenu 真流程进入(组头展开→Attach
 * 两步链→Chat 装配播种快照——G8a:Home 全页退役,工作区分组/attach 内化左栏,无会话=
 * 中栏欢迎空态)。
 * 断言:路由骨架(welcome|chat:Chat 页挂载/占位条退役/返回=欢迎空态)、帧按会话分发(他
 * 会话帧丢弃)、onReset 重置+重播种、md 渲染、Enter 分流(idle sessionSubmit / running
 * sessionSteer)、Stop 中断、状态条、种子竞态缓冲(seed 在途帧缓冲→种子落定 seq 过滤补投)、
 * 两会话先后打开投影独立;右栏标签面(G8a:默认「任务」页 Board 恒挂,file 标签经 write
 * path 钮/「+」菜单开)。
 */

type FakeSnapshot = SnapshotResponse & { lastSeq: number };

const h = vi.hoisted(() => {
  class FakeConn {
    readonly opts: ConnectionOpts;
    workspaceRows: WorkspaceRow[] = [{ root: '/w/root-a', slug: 'ws-root-a', mtime: 1, sessionCount: 1 }];
    sessionRows: SessionRow[] = [{ id: 'j1', file: '/d/j1.jsonl', updatedAt: 1, firstUser: '老会话摘要' }];
    dirpickerResp: DirPickerResp = { path: '/home', parent: '/', dirs: [] };
    nextSessionId = 's1';
    snapshotResp: FakeSnapshot = { messages: [], board: emptyBoard(), delegations: [], status: 'idle', lastSeq: 0 };
    sessionSubmitCalls: Array<[string, string]> = [];
    sessionSteerCalls: Array<[string, string]> = [];
    sessionInterruptCalls: string[] = [];
    newSessionCalls: string[] = [];
    attachCalls: Array<[string, string]> = [];
    snapshotCalls: string[] = [];
    replyApprovalCalls: Array<[string, string]> = [];
    replyAskCalls: Array<[string, GuiAskAnswer]> = [];
    deleteSessionCalls: string[] = [];
    boardReviewCalls: Array<[string, string, boolean]> = [];
    readFileCalls: Array<[string, string]> = [];
    /** G6 Files 预览面应答(readFile 可编程) */
    fileResp: FileResp = { path: '/w/root-a/src/a.ts', content: 'const x = 1;\n' };
    fileReject: Error | null = null;
    /** G7 diff 面应答(fetchDiff 可编程;缺省拒——write 展开退单列现内容) */
    diffCalls: Array<[string, string]> = [];
    diffResp: DiffResp | null = null;
    diffReject: Error | null = null;
    /** G8b pty 面:openPty 恒应答 ptyId 'p1'(分配调用记录 sessionId/cols/rows);killPty 记录寻址对 */
    openPtyCalls: Array<[string, number, number]> = [];
    killPtyCalls: Array<[string, string]> = [];
    /** G8b T7 目录树面:tree 按路径可编程(键 ''=root;缺省空);调用记录 [sessionId, path 归一 ''] */
    treeCalls: Array<[string, string]> = [];
    treeByPath: Record<string, TreeResp> = {};
    treeReject: Error | null = null;
    submitReject: Error | null = null;
    /** G4 回执失败注入(404 已决面):approval/ask 回执共享 */
    replyReject: Error | null = null;
    deleteReject: Error | null = null;
    stateVal: ConnectionState = 'connecting';
    closed = false;
    /** 播种门(种子竞态测):hold 后 sessionSnapshot 应答悬挂,release 落定——控 seed 在途窗时序 */
    private snapshotGate: Promise<void> = Promise.resolve();
    private snapshotGateRelease: () => void = () => {};
    holdSnapshot(): void {
      this.snapshotGate = new Promise<void>((resolve) => {
        this.snapshotGateRelease = resolve;
      });
    }
    releaseSnapshot(): void {
      this.snapshotGateRelease();
    }
    constructor(opts: ConnectionOpts) {
      this.opts = opts;
      created.push(this);
      opts.onStateChange?.('connecting'); // 真实现初始态即报
    }
    workspaces(): Promise<WorkspaceRow[]> {
      return Promise.resolve(this.workspaceRows);
    }
    sessionsOf(_root: string): Promise<SessionRow[]> {
      return Promise.resolve(this.sessionRows);
    }
    dirpicker(_path?: string): Promise<DirPickerResp> {
      return Promise.resolve(this.dirpickerResp);
    }
    newSession(root: string): Promise<{ sessionId: string }> {
      this.newSessionCalls.push(root);
      return Promise.resolve({ sessionId: this.nextSessionId });
    }
    attach(sessionId: string, journalId: string): Promise<void> {
      this.attachCalls.push([sessionId, journalId]);
      return Promise.resolve();
    }
    sessionSubmit(id: string, goal: string): Promise<void> {
      if (this.submitReject !== null) return Promise.reject(this.submitReject);
      this.sessionSubmitCalls.push([id, goal]);
      return Promise.resolve();
    }
    sessionSteer(id: string, text: string): Promise<void> {
      this.sessionSteerCalls.push([id, text]);
      return Promise.resolve();
    }
    sessionInterrupt(id: string): Promise<void> {
      this.sessionInterruptCalls.push(id);
      return Promise.resolve();
    }
    sessionSnapshot(id: string): Promise<FakeSnapshot> {
      this.snapshotCalls.push(id);
      return this.snapshotGate.then(() => this.snapshotResp);
    }
    replyApproval(pid: string, decision: string): Promise<void> {
      if (this.replyReject !== null) return Promise.reject(this.replyReject);
      this.replyApprovalCalls.push([pid, decision]);
      return Promise.resolve();
    }
    replyAsk(pid: string, answer: GuiAskAnswer): Promise<void> {
      if (this.replyReject !== null) return Promise.reject(this.replyReject);
      this.replyAskCalls.push([pid, answer]);
      return Promise.resolve();
    }
    deleteSession(id: string): Promise<void> {
      if (this.deleteReject !== null) return Promise.reject(this.deleteReject);
      this.deleteSessionCalls.push(id);
      return Promise.resolve();
    }
    boardReview(sessionId: string, taskId: string, approved: boolean): Promise<void> {
      this.boardReviewCalls.push([sessionId, taskId, approved]);
      return Promise.resolve();
    }
    readFile(sessionId: string, path: string): Promise<FileResp> {
      if (this.fileReject !== null) return Promise.reject(this.fileReject);
      this.readFileCalls.push([sessionId, path]);
      return Promise.resolve(this.fileResp);
    }
    fetchDiff(sessionId: string, callId: string): Promise<DiffResp> {
      if (this.diffReject !== null) return Promise.reject(this.diffReject);
      this.diffCalls.push([sessionId, callId]);
      if (this.diffResp !== null) return Promise.resolve(this.diffResp);
      return Promise.reject(new Error(`/session/${sessionId}/diff?callId=${callId} -> 404`));
    }
    openPty(sessionId: string, cols?: number, rows?: number): Promise<{ ptyId: string }> {
      this.openPtyCalls.push([sessionId, cols ?? 0, rows ?? 0]);
      return Promise.resolve({ ptyId: 'p1' });
    }
    killPty(sessionId: string, ptyId: string): Promise<void> {
      this.killPtyCalls.push([sessionId, ptyId]);
      return Promise.resolve();
    }
    tree(sessionId: string, path?: string): Promise<TreeResp> {
      this.treeCalls.push([sessionId, path ?? '']);
      if (this.treeReject !== null) return Promise.reject(this.treeReject);
      const p = path ?? '';
      return Promise.resolve(this.treeByPath[p] ?? { entries: [] });
    }
    close(): void {
      this.closed = true;
    }
    state(): ConnectionState {
      return this.stateVal;
    }
    debug = { socket: (): WebSocket | undefined => undefined };
  }
  const created: FakeConn[] = [];
  return { FakeConn, created };
});

vi.mock('./connection', () => ({ createConnection: (opts: ConnectionOpts) => new h.FakeConn(opts) }));

/** highlight.js 抛错注入桩(T1 评审回落收口测):仅含 marker 的输入抛错,其余透传真实现——
 *  既有 Files 页断言(.hljs-keyword 真高亮)不受染 */
const hljsStub = vi.hoisted(() => ({ marker: 'HLJS-THROW-MARKER' }));
vi.mock('highlight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('highlight.js')>();
  const real = actual.default;
  const throwing = (code: string, opts: { language: string }): { value: string } => {
    if (code.includes(hljsStub.marker)) throw new Error('hljs exploded (injected)');
    return real.highlight(code, opts);
  };
  // Proxy 透传全部真面(方法多在原型上,展开拷贝会漏),仅 highlight 拦截
  const fake = new Proxy(real, { get: (target, prop, receiver) => (prop === 'highlight' ? throwing : Reflect.get(target, prop, receiver)) });
  return { ...actual, default: fake };
});

/** react-markdown 透明计数桩:包装真实现并计渲染次数——条目 React.memo 的流式收敛回归依据
 *  (流式 token 帧只有流式条重渲染,稳定条目 md 解析零重跑) */
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

/** fixture 形态:messages 以五 kind 全集(daemon 实发 TranscriptEntry 面;connection.ts 声明的三 kind 子集经下行收窄断言) */
function snapshotOf(over: Partial<Omit<FakeSnapshot, 'messages'>> & { messages?: SnapshotTranscriptEntry[] }): FakeSnapshot {
  return { messages: [], board: emptyBoard(), delegations: [], status: 'idle', lastSeq: 0, ...over } as FakeSnapshot;
}

type Conn = InstanceType<typeof h.FakeConn>;

/** 挂载(token 经 localStorage 注入,同 main 装配的开发持久形态)→ 捕获的 mock conn + 卸载句柄;初始 welcome */
function mount(): { conn: Conn; unmount: () => void } {
  localStorage.setItem('sunshinex.token', 'test-token');
  const { unmount } = render(<App />);
  return { conn: h.created.at(-1)!, unmount };
}

/** 左栏项目组头定位(ProjectMenu 组头钮可及名 = slug + 会话数;G8a:Home 行退役,组头即展开钮) */
const GROUP_HEAD = { name: /^ws-root-a 1 sessions$/ };

/** 左栏真流程进 chat(G8a:ProjectMenu 组头展开 → Attach 两步链(newSession+attach)→ Chat
 *  会话 chip 在场)→ 连接 open + 播种落定(输入启用——seeding 门:基线快照在途时输入禁用) */
async function enterChat(): Promise<{ conn: Conn; unmount: () => void }> {
  const { conn, unmount } = mount();
  fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
  fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
  await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
  openConn(conn);
  await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
  return { conn, unmount };
}

const fire = (conn: Conn, e: SessionEvent, seq = 0): void => {
  act(() => conn.opts.onEvent('s1', e, seq));
};

const fireOther = (conn: Conn, e: SessionEvent): void => {
  act(() => conn.opts.onEvent('s9', e, 0)); // 非当前会话帧
};

const openConn = (conn: Conn): void => {
  act(() => conn.opts.onStateChange?.('open'));
};

/** G4 挂起帧模拟(经 App 装配面:opts 回调——App 过滤会话后转投 Chat sink) */
const fireApproval = (conn: Conn, sessionId: string, pid: string, req: GuiApprovalReq): void => {
  act(() => conn.opts.onApproval?.(sessionId, pid, req));
};

const fireAsk = (conn: Conn, sessionId: string, pid: string, req: GuiAskReq): void => {
  act(() => conn.opts.onAsk?.(sessionId, pid, req));
};

const fireResetSession = (conn: Conn, sessionId: string): void => {
  act(() => conn.opts.onResetSession?.(sessionId));
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

describe('路由骨架:welcome | chat(Chat 页挂载)', () => {
  it('初始 welcome:左栏项目菜单在场、无对话输入区(中栏欢迎空态);无会话 chip', async () => {
    mount();
    // G8a:Home 退役——左栏 ProjectMenu 组头(workspaces 装配面)+ 中栏欢迎空态
    expect(await screen.findByRole('button', GROUP_HEAD)).toBeDefined();
    expect(screen.getByLabelText('welcome')).toBeDefined();
    expect(screen.queryByLabelText('message input')).toBeNull();
    expect(screen.queryByText('session s1')).toBeNull();
  });

  it('左栏 Attach 链 → chat:Chat 页挂载渲染 sessionId(newSession→attach 两步)+ 返回 welcome', async () => {
    const { conn, unmount } = await enterChat();
    // 两步链:Attach = newSession(root) + attach(sessionId, journalId)
    expect(conn.newSessionCalls).toEqual(['/w/root-a']);
    expect(conn.attachCalls).toEqual([['s1', 'j1']]);
    // Chat 页面:会话 chip 在场、占位条退役(T4δ 真组件装配)
    expect(screen.getByText('session s1')).toBeDefined();
    expect(document.querySelector('.session-placeholder')).toBeNull();
    expect(screen.getByLabelText('message input')).toBeDefined();
    // 返回:对话面退场 → 欢迎空态(左栏常驻)
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
    await screen.findByLabelText('welcome');
    expect(screen.queryByLabelText('message input')).toBeNull();
    expect(screen.getByRole('button', GROUP_HEAD)).toBeDefined();
    unmount();
  });

  it('两会话先后打开投影独立:key 隔离——s1 交互→back→s2 打开无 s1 条目,再交互各自 :id', async () => {
    const { conn, unmount } = mount();
    openConn(conn);
    // —— s1:进 chat + 交互(user 回显 + 流式帧)——
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    type('s1 目标');
    pressEnter();
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 's1 流内容'));
    expect(conn.sessionSubmitCalls).toEqual([['s1', 's1 目标']]);
    expect(screen.getByText('s1 目标')).toBeDefined();
    // —— back → welcome(Chat 卸毁:s1 本地态随组件销毁;左栏组仍展开——壳常驻)——
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
    await screen.findByLabelText('welcome');
    // —— s2:FakeConn 下一会话号;组已展开(常驻),Attach 直点 ——
    conn.nextSessionId = 's2';
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s2')).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    // s2 投影独立:无 s1 条目串扰(组件级隔离——非空起步)
    expect(screen.queryByText('s1 目标')).toBeNull();
    expect(screen.queryByText('s1 流内容')).toBeNull();
    type('s2 目标');
    pressEnter();
    expect(conn.sessionSubmitCalls).toEqual([
      ['s1', 's1 目标'],
      ['s2', 's2 目标'],
    ]);
    expect(screen.getByText('s2 目标')).toBeDefined();
    unmount();
  });
});

describe('状态条:连接点四态 + 会话指标', () => {
  it('初始 connecting 态(工厂初始即报);open 后迁移(home 面同样在场)', async () => {
    const { conn } = mount();
    expect(await screen.getByLabelText('connection: connecting')).toBeDefined();
    expect(screen.getByText('connecting')).toBeDefined();
    openConn(conn);
    expect(screen.getByLabelText('connection: open')).toBeDefined();
  });

  it('reconnecting/closed 两态色 hook 亦可表达(onStateChange 透传)', () => {
    const { conn } = mount();
    act(() => conn.opts.onStateChange?.('reconnecting'));
    expect(screen.getByLabelText('connection: reconnecting')).toBeDefined();
    act(() => conn.opts.onStateChange?.('closed'));
    expect(screen.getByLabelText('connection: closed')).toBeDefined();
  });

  it('tokens/steps 随 usage/step 事件聚合显示(chat 面)', async () => {
    const { conn } = await enterChat();
    openConn(conn);
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

describe('对话流渲染:会话播种基线 + 事件续推(md/gfm)', () => {
  it('打开会话即播种:snapshotResp.messages 五 kind 直映射渲染(md 原文,user 引用块等 gfm 形)', async () => {
    const { conn, unmount } = mount();
    conn.snapshotResp = snapshotOf({
      status: 'running',
      messages: [
        { seq: 1, ts: 1, kind: 'user', md: '> build the widget' },
        { seq: 2, ts: 2, kind: 'tool', md: '● read\n⎿ ok' },
        { seq: 3, ts: 3, kind: 'notice', md: '✻ dev started' },
        { seq: 4, ts: 4, kind: 'error', md: 'boom' },
      ],
    });
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    openConn(conn);
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText('build the widget')).toBeDefined(); // `> …` → blockquote
    expect(screen.getByText('● read ⎿ ok')).toBeDefined(); // 两行同段(normalizer 折叠)
    expect(screen.getByText('✻ dev started')).toBeDefined();
    expect(screen.getByText('boom')).toBeDefined();
    expect(document.querySelector('.entry-user blockquote')).not.toBeNull();
    expect(screen.getByText('running')).toBeDefined();
    unmount();
  });

  it('token 流式 → streaming 光标钩子;done 收段去光标', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 'widget '));
    fire(conn, ev('token', '**done**'));
    const entry = document.querySelector('.entry-assistant');
    expect(entry?.textContent).toBe('widget done'); // `**done**` → <strong>(gfm 生效)
    expect(entry?.querySelector('strong')?.textContent).toBe('done');
    expect(document.querySelector('.entry-assistant.streaming')).not.toBeNull();
    fire(conn, ev('done', 'widget **done**')); // 终稿=已累积(流即原文 md)
    expect(document.querySelector('.entry-assistant.streaming')).toBeNull();
    expect(document.querySelector('.entry-assistant')?.textContent).toBe('widget done');
  });

  it('帧按会话分发:他会话帧(sessionId 不符)丢弃,当前会话帧照投', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    fireOther(conn, ev('token', '他会话内容'));
    expect(document.querySelector('.entry-assistant')).toBeNull();
    fire(conn, ev('model-start'));
    fire(conn, ev('token', '本会话内容'));
    expect(document.querySelector('.entry-assistant')?.textContent).toBe('本会话内容');
  });

  it('onReset(重连):投影清零 + 当前会话重拉 sessionSnapshot 重播种', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start'));
    fire(conn, ev('token', '旧流内容'));
    expect(document.querySelector('.entry-assistant')?.textContent).toBe('旧流内容');
    const seedCallsBefore = conn.snapshotCalls.length;
    conn.snapshotResp = snapshotOf({
      messages: [
        { seq: 1, ts: 1, kind: 'user', md: '> goal one' },
        { seq: 2, ts: 2, kind: 'assistant', md: '首轮答复' },
      ],
    });
    act(() => conn.opts.onReset());
    await waitFor(() => expect(conn.snapshotCalls.length).toBe(seedCallsBefore + 1));
    await waitFor(() => expect(screen.getByText('首轮答复')).toBeDefined());
    expect(document.querySelector('.entry-assistant')?.textContent).toBe('首轮答复'); // 旧流内容已清(重置投影)
    expect(screen.queryByText('旧流内容')).toBeNull();
  });

  it('onReset 时未开会话(welcome):仅清投影不拉快照', async () => {
    const { conn } = mount();
    await screen.findByRole('button', GROUP_HEAD); // 左栏装配面在场(等价旧 home 面断言)
    const before = conn.snapshotCalls.length;
    act(() => conn.opts.onReset());
    expect(conn.snapshotCalls.length).toBe(before);
    expect(screen.getByLabelText('welcome')).toBeDefined();
  });

  it('条目 React.memo:流式 token 帧只重渲染流式条(稳定条 md 渲染计数不涨)', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    type('stable');
    pressEnter(); // user 条 → 1 次 md 渲染
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 'a')); // 流式条开条 → +1
    const before = md.renders;
    fire(conn, ev('token', 'b')); // 流式增量:仅流式条重渲染(memo 跳过 user 条)
    fire(conn, ev('token', 'c'));
    expect(md.renders).toBe(before + 2);
    expect(document.querySelector('.entry-assistant')?.textContent).toBe('abc');
    expect(document.querySelector('.entry-user')?.textContent).toContain('stable');
  });

  it('delegation/agent-message → notice 行(同时喂 delegations 投影不倒面)', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    fire(conn, ev('delegation-started', undefined, { label: 'dev', delegationId: 'd1' }));
    fire(conn, ev('agent-message', undefined, { from: 'a', to: 'b', text: 'ping' }));
    expect(screen.getByText('✻ dev started')).toBeDefined();
    expect(screen.getByText('[a → b] ping')).toBeDefined();
  });
});

describe('种子竞态缓冲(T3 收口):seed 在途帧缓冲→种子落定过滤补投', () => {
  /** 进 chat 且 seed 应答悬挂(在途窗):返回后可先投帧再落定种子 */
  async function enterChatHeld(): Promise<{ conn: Conn; unmount: () => void }> {
    const { conn, unmount } = mount();
    conn.holdSnapshot();
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    openConn(conn);
    return { conn, unmount };
  }

  it('在途窗内本会话帧缓冲不投;种子落定后 seq≤lastSeq 丢、>lastSeq 依序补投(无丢帧/无双应用)', async () => {
    const { conn, unmount } = await enterChatHeld();
    conn.snapshotResp = snapshotOf({
      lastSeq: 5,
      messages: [{ seq: 1, ts: 1, kind: 'user', md: '> 基线目标' }],
    });
    // —— seed 在途窗:本会话帧到达(补发/直播混合)——缓冲不投 ——
    fire(conn, ev('token', '旧帧'), 3); // ≤ lastSeq:种子已含(直播帧先于应答落定)
    fire(conn, ev('model-start'), 7);
    fire(conn, ev('token', '新帧'), 8); // > lastSeq:种子切割序之后,须补投
    expect(document.querySelector('.entry-assistant')).toBeNull(); // 未投(缓冲中)
    // —— 种子落定:基线直映射 + 缓冲过滤补投 ——
    conn.releaseSnapshot();
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText('基线目标')).toBeDefined(); // 种子条(md `> …` → blockquote)
    const assistant = document.querySelector('.entry-assistant');
    expect(assistant?.textContent).toBe('新帧'); // seq 7/8 补投(流式条已含增量)
    expect(assistant?.className).toContain('streaming'); // 补投后流式态保持(未 done 收段)
    expect(screen.queryByText('旧帧')).toBeNull(); // seq 3 ≤ lastSeq:丢(双应用防线)
    unmount();
  });

  it('种子落定后的后续帧直投(不再缓冲):流式续推不受竞态窗影响', async () => {
    const { conn, unmount } = await enterChatHeld();
    conn.releaseSnapshot();
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    fire(conn, ev('model-start'));
    fire(conn, ev('token', '直投'));
    expect(document.querySelector('.entry-assistant')?.textContent).toBe('直投');
    unmount();
  });

  it('unmount 清缓冲:在途窗卸载,迟到的种子应答不炸不残留', async () => {
    const { conn, unmount } = await enterChatHeld();
    fire(conn, ev('token', '窗内帧'), 3);
    unmount();
    conn.releaseSnapshot(); // 迟到应答落定(组件已毁,状态更新无的放矢)
    await new Promise((r) => setTimeout(r, 0)); // 微任务链冲净
    expect(document.querySelector('.entry-assistant')).toBeNull();
  });
});

describe('底部输入区:Enter 分流与 Stop(会话维 :id)', () => {
  it('idle:Enter 提交 sessionSubmit(id, goal) + 本地 user 回显条,输入清空', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    type('do the thing');
    pressEnter();
    expect(conn.sessionSubmitCalls).toEqual([['s1', 'do the thing']]);
    expect(conn.sessionSteerCalls).toEqual([]);
    expect(screen.getByText('do the thing')).toBeDefined(); // `> do the thing` → blockquote 正文
    expect((screen.getByLabelText('message input') as HTMLInputElement).value).toBe('');
  });

  it('running:Enter 发 sessionSteer(不 submit)+ user 回显', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start'));
    type('mid-run nudge');
    pressEnter();
    expect(conn.sessionSteerCalls).toEqual([['s1', 'mid-run nudge']]);
    expect(conn.sessionSubmitCalls).toEqual([]);
    expect(screen.getByText('mid-run nudge')).toBeDefined();
  });

  it('Stop 按钮:running 在场且点击 sessionInterrupt(id);idle 态退场', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(conn.sessionInterruptCalls).toEqual(['s1']);
    fire(conn, ev('done', 'fin'));
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('submit 失败:error 条入列(HTTP 面错误不静默)', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    conn.submitReject = new Error('/session/s1/submit -> 409');
    type('will fail');
    pressEnter();
    await waitFor(() => expect(screen.getByText('/session/s1/submit -> 409')).toBeDefined());
    expect(document.querySelector('.entry-error')).not.toBeNull();
  });

  it('空输入 Enter 不动作', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    type('   ');
    pressEnter();
    expect(conn.sessionSubmitCalls).toEqual([]);
  });
});

describe('G4 挂起卡片区:审批/问询回执(pid 契约)与 reset 帧', () => {
  const apReq: GuiApprovalReq = { id: 'ap-3', kind: 'write', subject: 'rm -rf /tmp/x', reason: 'destructive command' };
  const apTitle = '[approval write] rm -rf /tmp/x';

  it('approval 卡渲染(kind/subject/reason)+ 三按钮回执用帧顶层 pid(非 req.id)+ 回执成功移卡', async () => {
    const { conn, unmount } = await enterChat();
    fireApproval(conn, 's1', 'p-ap-9', apReq);
    expect(screen.getByText(apTitle)).toBeDefined();
    expect(screen.getByText('destructive command')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(conn.replyApprovalCalls).toEqual([['p-ap-9', 'allow']]));
    await waitFor(() => expect(screen.queryByText(apTitle)).toBeNull());
    // Deny / Always 字面(T1 ApprovalDecision 三态)
    fireApproval(conn, 's1', 'p-a2', apReq);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(conn.replyApprovalCalls[1]).toEqual(['p-a2', 'deny']));
    fireApproval(conn, 's1', 'p-a3', apReq);
    fireEvent.click(screen.getByRole('button', { name: 'Always' }));
    await waitFor(() => expect(conn.replyApprovalCalls[2]).toEqual(['p-a3', 'always']));
    unmount();
  });

  it('回执失败(404 已决)也移卡——不静默悬挂', async () => {
    const { conn, unmount } = await enterChat();
    conn.replyReject = new Error('/approval/p-x -> 404');
    fireApproval(conn, 's1', 'p-x', apReq);
    expect(screen.getByText(apTitle)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(screen.queryByText(apTitle)).toBeNull());
    unmount();
  });

  it('ask 卡:多选勾选 / custom 文本(customIndex 输入面)/ Dismiss 三态回执', async () => {
    const { conn, unmount } = await enterChat();
    fireAsk(conn, 's1', 'p-ask-1', {
      question: '选哪条路?',
      options: [{ label: '左' }, { label: '右' }, { label: 'Other…' }],
      multiple: true,
      customIndex: 2,
    });
    expect(screen.getByText('选哪条路?')).toBeDefined();
    // 多选:勾两项 → Submit → selected labels
    fireEvent.click(screen.getByLabelText('左'));
    fireEvent.click(screen.getByLabelText('右'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(conn.replyAskCalls).toEqual([['p-ask-1', { type: 'selected', labels: ['左', '右'] }]]));
    await waitFor(() => expect(screen.queryByText('选哪条路?')).toBeNull());
    // custom 文本:非空 → custom 态(优先于勾选)
    fireAsk(conn, 's1', 'p-ask-2', { question: 'q2', options: [{ label: 'x' }], customIndex: 1 });
    fireEvent.click(screen.getByLabelText('x'));
    fireEvent.change(screen.getByLabelText('custom answer'), { target: { value: '自己写' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(conn.replyAskCalls[1]).toEqual(['p-ask-2', { type: 'custom', text: '自己写' }]));
    // Dismiss → dismissed(正常放弃,非错误)
    fireAsk(conn, 's1', 'p-ask-3', { question: 'q3', options: [{ label: 'y' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(conn.replyAskCalls[2]).toEqual(['p-ask-3', { type: 'dismissed' }]));
    await waitFor(() => expect(screen.queryByText('q3')).toBeNull());
    unmount();
  });

  it('ask 单选(无 multiple):后点替换先点', async () => {
    const { conn, unmount } = await enterChat();
    fireAsk(conn, 's1', 'p-ask-4', { question: '单选?', options: [{ label: '甲' }, { label: '乙' }] });
    fireEvent.click(screen.getByLabelText('甲'));
    fireEvent.click(screen.getByLabelText('乙'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(conn.replyAskCalls).toEqual([['p-ask-4', { type: 'selected', labels: ['乙'] }]]));
    unmount();
  });

  it('卡按会话过滤:他会话(s9)approval/ask 帧不显卡', async () => {
    const { conn, unmount } = await enterChat();
    fireApproval(conn, 's9', 'p-other', apReq);
    fireAsk(conn, 's9', 'p-other-2', { question: '他会话问询', options: [{ label: 'a' }] });
    expect(screen.queryByText(apTitle)).toBeNull();
    expect(screen.queryByText('他会话问询')).toBeNull();
    unmount();
  });

  it('reset 帧(本会话):清投影 + 清卡 + 重播种(snapshot 重拉);他会话 reset 忽略', async () => {
    const { conn, unmount } = await enterChat();
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 'reset 前内容'));
    fireApproval(conn, 's1', 'p-ap-r', apReq);
    expect(screen.getByText('reset 前内容')).toBeDefined();
    conn.snapshotResp = snapshotOf({ messages: [{ seq: 1, ts: 1, kind: 'user', md: '> 重播种基线' }] });
    const seedsBefore = conn.snapshotCalls.length;
    fireResetSession(conn, 's9'); // 他会话 reset:忽略(不重播种)
    expect(conn.snapshotCalls.length).toBe(seedsBefore);
    fireResetSession(conn, 's1'); // 本会话:清投影 + 清卡(daemon 已 deny 回填) + reseed
    await waitFor(() => expect(conn.snapshotCalls.length).toBe(seedsBefore + 1));
    await waitFor(() => expect(screen.getByText('重播种基线')).toBeDefined());
    expect(screen.queryByText('reset 前内容')).toBeNull();
    expect(screen.queryByText(apTitle)).toBeNull();
    unmount();
  });

  it('连接级 onReset(重连):卡保留——daemon 未决重发被连接层 pid 去重,不重挂不丢卡', async () => {
    const { conn, unmount } = await enterChat();
    fireApproval(conn, 's1', 'p-keep', apReq);
    act(() => conn.opts.onReset());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText(apTitle)).toBeDefined();
    unmount();
  });

  it('G7 reseed 重建挂起卡:snapshot.pending 带 req → 卡渲染在场(subject 来自透传 req)且回执可用;pid 与实时帧防重', async () => {
    // 刷新/重开面:无实时帧,卡的唯一来源是快照 pending 段(daemon G7 起 req 直序列化)
    const { conn, unmount } = await mount();
    conn.snapshotResp = snapshotOf({
      status: 'running',
      pending: [{ pid: 'p-snap-1', kind: 'approval', req: apReq }],
    });
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    openConn(conn);
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    // 卡内容来自快照 req(kind/subject/reason 直序列化)——刷新后回执闭环照常可用
    expect(screen.getByText(apTitle)).toBeDefined();
    expect(screen.getByText('destructive command')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(conn.replyApprovalCalls).toEqual([['p-snap-1', 'allow']]));
    await waitFor(() => expect(screen.queryByText(apTitle)).toBeNull());
    unmount();
  });
});

describe('token 门面(无 token 不建连接)', () => {
  it('无 token:显示输入页,不创建连接;提交后持久并装配', () => {
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

  it('URL ?token= 直连:以其装配且回写 localStorage 持久(刷新/重连免带参)', () => {
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

describe('G6/G8a 文件标签:右栏标签面 + write 工具 path 按钮跳转', () => {
  it('右栏标签切换:默认「任务」页(Board);「+」菜单开文件标签 → Files 预览面,Chat 恒挂零重播种', async () => {
    const { conn, unmount } = await enterChat();
    // G8a:会话缺省开「任务」单例页且活动——Board 看板面即右栏标签体;Chat 恒中栏(输入面常驻)
    expect(document.querySelector('.sx-tab[title="任务"]')?.classList.contains('active')).toBe(true);
    expect(screen.getByLabelText('board')).toBeDefined();
    expect(screen.getByLabelText('message input')).toBeDefined();
    expect(conn.snapshotCalls).toHaveLength(1); // Chat 常驻:开标签不重播种
    // 「+」菜单开文件标签(无参 file → 标签条第二页且活动):Files 预览面
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '文件' }));
    expect(screen.getByLabelText('files')).toBeDefined();
    expect(document.querySelector('.sx-tab[title="文件"]')?.classList.contains('active')).toBe(true);
    expect(screen.queryByLabelText('board')).toBeNull(); // 标签体随活动切换
    expect(conn.snapshotCalls).toHaveLength(1); // 无第二次播种
    // 切回「任务」标签:Board 回归(仍零重播种)
    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    expect(screen.getByLabelText('board')).toBeDefined();
    expect(conn.snapshotCalls).toHaveLength(1);
    unmount();
  });

  it('write 条目 path 按钮 → onOpenFile 跳转:file 标签激活(title=path)+ initialPath 自动加载 + 高亮渲染', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    // write tool-call 帧(batch-runner 实发形态:text=工具名,payload.input={path,content})
    fire(conn, ev('tool-call', 'write', { input: { path: 'src/a.ts', content: 'const y = 2;\n' }, callId: 'c1', status: 'pending' }));
    fire(conn, ev('tool-result', 'written', { tool: 'write', callId: 'c1', status: 'completed' }));
    // 展开 write 条目 → path 按钮 → 文件标签(G8a:openTabInSession('file',{path}))
    fireEvent.click(screen.getByRole('button', { name: '● write src/a.ts ⎿ written' }));
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tool-path')!);
    expect(document.querySelector('.sx-tab[title="src/a.ts"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'src/a.ts']])); // initialPath 自动加载
    await waitFor(() => expect(screen.getByLabelText('file content')).toBeDefined());
    expect(document.querySelector('.files-view .hljs-keyword')).not.toBeNull(); // 高亮 class(const → keyword)
    // 手动输入换路径:回车加载第二文件
    conn.fileResp = { path: '/w/root-a/src/b.md', content: '# 标题\n' };
    fireEvent.change(screen.getByLabelText('file path input'), { target: { value: 'src/b.md' } });
    fireEvent.keyDown(screen.getByLabelText('file path input'), { key: 'Enter' });
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'src/a.ts'], ['s1', 'src/b.md']]));
    unmount();
  });

  it('两个文件标签互切:key={activeTab.uid} 重挂——切回 A 后 initialPath 重新生效(加载请求 path=A,路径输入=A)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    // —— 开 file 标签 A:write 条目 path 钮跳转(initialPath=src/a.ts,自动加载)——
    fire(conn, ev('tool-call', 'write', { input: { path: 'src/a.ts', content: 'const y = 2;\n' }, callId: 'c1', status: 'pending' }));
    fire(conn, ev('tool-result', 'written', { tool: 'write', callId: 'c1', status: 'completed' }));
    fireEvent.click(screen.getByRole('button', { name: '● write src/a.ts ⎿ written' }));
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' })); // tool-path 钮(可及名=路径)
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'src/a.ts']]));
    fireEvent.click(screen.getByRole('button', { name: '● write src/a.ts ⎿ written' })); // 收起条目(消除同名的 path 钮)
    // —— 开 file 标签 B:第二条 write,同法 ——
    fire(conn, ev('tool-call', 'write', { input: { path: 'src/b.ts', content: 'const z = 3;\n' }, callId: 'c2', status: 'pending' }));
    fire(conn, ev('tool-result', 'written', { tool: 'write', callId: 'c2', status: 'completed' }));
    fireEvent.click(screen.getByRole('button', { name: '● write src/b.ts ⎿ written' }));
    fireEvent.click(screen.getByRole('button', { name: 'src/b.ts' }));
    // 两文件标签在场且 B 活动(判重经 path:两 uid 两页)
    expect(document.querySelector('.sx-tab[title="src/a.ts"]')).not.toBeNull();
    expect(document.querySelector('.sx-tab[title="src/b.ts"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'src/a.ts'], ['s1', 'src/b.ts']]));
    fireEvent.click(screen.getByRole('button', { name: '● write src/b.ts ⎿ written' })); // 收起条目
    // —— 切回 A:tabbody key=uid 强制重挂——initialPath 重新生效(第三笔加载请求 path=A)+ 路径输入回 A
    // (无 key 时 React 复用 B 的 Files 实例:effect no-op,无第三笔请求且路径输入残留 src/b.ts)
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }));
    expect(document.querySelector('.sx-tab[title="src/a.ts"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'src/a.ts'], ['s1', 'src/b.ts'], ['s1', 'src/a.ts']]));
    expect((screen.getByLabelText('file path input') as HTMLInputElement).value).toBe('src/a.ts');
    unmount();
  });

  it('Files 403 错误态:越界路径错误消息示出', async () => {
    const { conn, unmount } = await enterChat();
    conn.fileReject = new Error('/session/s1/file?path=../x -> 403');
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '文件' }));
    fireEvent.change(screen.getByLabelText('file path input'), { target: { value: '../x' } });
    fireEvent.click(screen.getByRole('button', { name: '加载' }));
    await waitFor(() => expect(screen.getByText('/session/s1/file?path=../x -> 403')).toBeDefined());
    expect(document.querySelector('.files-view')).toBeNull();
    unmount();
  });

  it('highlightCode 回落转义(T1 评审必落):hljs.highlight 抛错 → HTML 转义原文返回,无活 <script>', () => {
    const evil = `<script>${hljsStub.marker}alert(1)</script>`;
    const out = highlightCode(evil, 'a.ts'); // 'ts' 在映射表内:抛错来自注入桩(非 plaintext 回落旁路)
    expect(out).not.toContain('<'); // 转义后无任何裸标签开角
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;/script&gt;');
  });
});

describe('G8b 终端标签:+菜单 nonce 多实例 + jsdom 降级面 + 关标签 kill 链', () => {
  /** +菜单开终端(菜单 → tools 节「终端」直调 onOpenType) */
  const openTerminal = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '终端' }));
  };

  it('+菜单开终端:openPty(s1,80,24) 分配 + 降级面在场(jsdom 无布局)+ nonce 两开两标签', async () => {
    const { conn, unmount } = await enterChat();
    openTerminal();
    // 分配链:TerminalTab mount → conn.openPty(sessionId, 80, 24) → onPtyAllocated(App ptyIdsRef 记账)
    // ——降级面在场即分配续体已跑(同微任务:记账先于守卫渲染)
    await waitFor(() => expect(conn.openPtyCalls).toEqual([['s1', 80, 24]]));
    await waitFor(() => expect(screen.getByText('终端渲染需要真浏览器窗口')).toBeDefined());
    // nonce 多实例:mintParams 铸唯一 resolveKey → 再开 = 第二个终端标签(非判重聚焦既有)
    openTerminal();
    expect(document.querySelectorAll('.sx-tab[title="终端"]')).toHaveLength(2);
    await waitFor(() => expect(conn.openPtyCalls).toHaveLength(2)); // 活动切换重挂:新实例再分配
    unmount();
  });

  it('关终端标签 → conn.killPty(s1, p1);backHome 切走不 kill(标签还原重挂后才可关链)', async () => {
    const { conn, unmount } = await enterChat();
    openTerminal();
    await waitFor(() => expect(screen.getByText('终端渲染需要真浏览器窗口')).toBeDefined()); // 记账落定(uid→p1)
    // backHome:会话切走不 kill——pty 生命周期归标签关闭链,tabStates 每会话保留(spec §1)
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
    await screen.findByLabelText('welcome');
    expect(conn.killPtyCalls).toEqual([]);
    // 重进同会话(journal 重挂 s1):终端标签还原 → 重挂走重连径(记账命中,不重开 pty)
    conn.nextSessionId = 's1';
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    await waitFor(() => expect(screen.getByText('终端渲染需要真浏览器窗口')).toBeDefined()); // 重挂完成(重连既有 p1)
    expect(conn.openPtyCalls).toHaveLength(1); // 重连径:还原面不再分配
    fireEvent.click(screen.getByRole('button', { name: 'close tab 终端' }));
    await waitFor(() => expect(conn.killPtyCalls).toEqual([['s1', 'p1']]));
    expect(document.querySelector('.sx-tab[title="终端"]')).toBeNull(); // 标签已移除(承继「任务」)
    unmount();
  });

  it('裁定修复:切标签往返重连既有 pty——终端→任务→终端 不再 openPty(记账复用+replay 恢复)', async () => {
    const { conn, unmount } = await enterChat();
    openTerminal();
    await waitFor(() => expect(screen.getByText('终端渲染需要真浏览器窗口')).toBeDefined()); // 首挂分配+记账(uid→p1)
    expect(conn.openPtyCalls).toHaveLength(1);
    // 切到「任务」:TerminalTab 卸载——socket dispose 但不 kill(pty 服务侧存活)
    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    expect(screen.queryByText('终端渲染需要真浏览器窗口')).toBeNull(); // 终端面退场(卸载)
    expect(screen.getByLabelText('board')).toBeDefined();
    expect(conn.killPtyCalls).toEqual([]); // 卸载≠kill
    // 切回「终端」:重挂走重连径(ptyIdFor 命中既有记账)——openPty 计数不变,降级面照常
    fireEvent.click(screen.getByRole('button', { name: '终端' }));
    await waitFor(() => expect(screen.getByText('终端渲染需要真浏览器窗口')).toBeDefined());
    expect(conn.openPtyCalls).toHaveLength(1); // 重连既有 pty,不再分配(spec U-D5 等同本地底线)
    unmount();
  });
});

describe('G8b 目录标签:树惰拉/单例注册 + 文件行开标签 + truncated 标记', () => {
  /** +菜单开目录(菜单 → content 节「目录」直调 onOpenType) */
  const openDirectory = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '目录' }));
  };

  it('+菜单开目录:mount 拉 root → 展开 dirA 惰拉单层 → 点 fileA.ts 开文件标签且活动(title=路径);单例两开一标签;收起保留缓存', async () => {
    const { conn, unmount } = await enterChat();
    // 桩两级:root(dirA 目录 + fileB.ts 文件)/ dirA(fileA.ts 文件)
    conn.treeByPath = {
      '': { entries: [{ name: 'dirA', kind: 'dir' }, { name: 'fileB.ts', kind: 'file' }] },
      dirA: { entries: [{ name: 'fileA.ts', kind: 'file' }] },
    };
    openDirectory();
    // mount 拉 root:tree(s1, '') 一笔;根级行列表在场(目录行+文件行)
    await waitFor(() => expect(conn.treeCalls).toEqual([['s1', '']]));
    expect(screen.getByRole('button', { name: 'dirA' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'fileB.ts' })).toBeDefined();
    // 单例:再开 = 聚焦既有(仍一个目录标签且活动)
    openDirectory();
    expect(document.querySelectorAll('.sx-tab[title="目录"]')).toHaveLength(1);
    expect(document.querySelector('.sx-tab[title="目录"]')?.classList.contains('active')).toBe(true);
    // 展开 dirA:惰拉单层(path 拼合 = name)→ 子文件行在场
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    await waitFor(() => expect(conn.treeCalls).toEqual([['s1', ''], ['s1', 'dirA']]));
    expect(screen.getByRole('button', { name: 'fileA.ts' })).toBeDefined();
    // 收起:子层退场但缓存保留——再展开不再拉(treeCalls 仍两笔)
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    expect(screen.queryByRole('button', { name: 'fileA.ts' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    expect(screen.getByRole('button', { name: 'fileA.ts' })).toBeDefined();
    expect(conn.treeCalls).toHaveLength(2);
    // 点 fileA.ts:openTab('file', { path: 'dirA/fileA.ts' }) → 文件标签开且活动(title=相对路径)
    fireEvent.click(screen.getByRole('button', { name: 'fileA.ts' }));
    expect(document.querySelector('.sx-tab[title="dirA/fileA.ts"]')?.classList.contains('active')).toBe(true);
    expect(screen.getByLabelText('files')).toBeDefined();
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'dirA/fileA.ts']])); // initialPath 自动加载
    unmount();
  });

  it('truncated 标记:桩返 truncated:true → 行尾「…已截断」;子层拉失败 → 行内错误消息', async () => {
    const { conn, unmount } = await enterChat();
    conn.treeByPath = { '': { entries: [{ name: 'dirA', kind: 'dir' }], truncated: true } };
    openDirectory();
    await waitFor(() => expect(screen.getByText('…已截断')).toBeDefined()); // root 级截断标记
    conn.treeReject = new Error('/session/s1/tree?path=dirA -> 404');
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    await waitFor(() => expect(screen.getByText('/session/s1/tree?path=dirA -> 404')).toBeDefined()); // 行内错误态
    unmount();
  });
});

describe('卸载收口(单连接生命周期)', () => {
  it('unmount 关闭连接', async () => {
    const { conn, unmount } = await enterChat();
    unmount();
    expect(conn.closed).toBe(true);
  });
});


describe('G5 Board(右栏默认任务页):板/委派投影 + team(快照) + 会话维 reset', () => {
  const taskCreated = (id: string, title: string, dependsOn: string[] = []): SessionEvent =>
    ev('task-created', undefined, { taskId: id, title, spec: 's', dependsOn });

  it('任务页默认在场(空板占位);开文件标签再切回,Board 回归(Chat 恒挂不重播种)', async () => {
    const { conn, unmount } = await enterChat();
    // G8a:右栏缺省「任务」页——Board 空板占位直接在场;Chat 恒中栏(输入面常驻)
    expect(screen.getByLabelText('board')).toBeDefined();
    expect(screen.getByText(/任务板为空/)).toBeDefined();
    expect(screen.getByLabelText('message input')).toBeDefined();
    expect(conn.snapshotCalls).toHaveLength(1); // 播种恰一次
    // 开文件标签(任务失活)→ 切回「任务」标签:标签体随活动切换,零重播种
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '文件' }));
    expect(screen.queryByLabelText('board')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    expect(screen.getByLabelText('board')).toBeDefined();
    expect(conn.snapshotCalls).toHaveLength(1); // 无第二次播种
    unmount();
  });

  it('板投影随事件:task-created/assigned/gate 帧 → Board List 行(t1 ⚠ @w1);Approve → conn.boardReview(s1, t1, true)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, taskCreated('t1', 'Demo'));
    fire(conn, taskCreated('t2', 'Next', ['t1']));
    fire(conn, ev('task-assigned', undefined, { taskId: 't1', assignee: 'w1' }));
    fire(conn, ev('gate-waiting', undefined, { taskId: 't1' }));
    expect(screen.getByText('t1 [pending] Demo ⚠ @w1')).toBeDefined(); // 任务页默认在场:板随事件直显
    expect(screen.getByText('t2 [pending] Next (needs t1)')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Approve t1' }));
    await waitFor(() => expect(conn.boardReviewCalls).toEqual([['s1', 't1', true]]));
    unmount();
  });

  it('他会话帧不进板投影(sessionRef 过滤在板面前)', async () => {
    const { conn, unmount } = await enterChat();
    fireOther(conn, taskCreated('t9', '他会话任务'));
    expect(screen.getByText(/任务板为空/)).toBeDefined();
    unmount();
  });

  it('team 侧栏:snapshot.team 经 Chat 播种回填 App 态;onReset 重播种更新', async () => {
    const { conn, unmount } = mount();
    conn.snapshotResp = snapshotOf({ team: [{ name: 'w1', busy: true }] });
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    openConn(conn);
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByLabelText('team').textContent).toContain('w1');
    expect(document.querySelector('.team-dot.busy')).not.toBeNull();
    // 重播种(连接级 onReset)→ 新 team 回填
    conn.snapshotResp = snapshotOf({ team: [{ name: 'w2', busy: false }] });
    act(() => conn.opts.onReset());
    await waitFor(() => expect(screen.getByLabelText('team').textContent).toContain('w2'));
    expect(screen.queryByText('w1')).toBeNull();
    unmount();
  });

  it('onResetSession(本会话)清 board/delegations 投影;他会话 reset 不清', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, taskCreated('t1', 'Demo'));
    fire(conn, ev('delegation-started', undefined, { delegationId: 'd1', kind: 'subagent', label: 'dev' }));
    expect(screen.getByText('t1 [pending] Demo')).toBeDefined();
    expect(screen.getByLabelText('delegations').textContent).toContain('dev');
    fireResetSession(conn, 's9'); // 他会话:板投影不动
    expect(screen.getByText('t1 [pending] Demo')).toBeDefined();
    fireResetSession(conn, 's1'); // 本会话:board/delegations 清(reset 语义 = swap 新 Harness,旧板作废;
    // 重播种快照板再经 onSeeded 回填——默认空快照,空态维持)
    await waitFor(() => expect(screen.getByText(/任务板为空/)).toBeDefined());
    expect(screen.getByLabelText('delegations').textContent).not.toContain('dev');
    unmount();
  });

  it('会话切换板投影随快照(串态根除):s1 积任务 → back → s2 板为空;重开 s1 板回快照权威态', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, taskCreated('t1', 'Demo'));
    expect(screen.getByText('t1 [pending] Demo')).toBeDefined();
    // —— back → 开 s2:openSession 清板投影 + s2 快照(空)回填——无 s1 残留(左栏组仍展开,Attach 直点)——
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
    await screen.findByLabelText('welcome');
    conn.nextSessionId = 's2';
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s2')).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText(/任务板为空/)).toBeDefined(); // s2 快照空板(而非 s1 残留)
    // —— 重开 s1:快照带板 → onSeeded 回填,任务页即快照权威态(无需事件帧)——
    conn.snapshotResp = snapshotOf({
      board: applyBoardEvent(emptyBoard(), { t: 'task-created', taskId: 't1', title: 'Demo', spec: '', dependsOn: [], ts: 1 }),
    });
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
    await screen.findByLabelText('welcome');
    conn.nextSessionId = 's1';
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText('t1 [pending] Demo')).toBeDefined(); // 快照回填的权威板
    unmount();
  });
});

describe('G6 板投影 seq 门:seeding 期帧缓冲 → onSeeded 后过滤重放(G5 交接 b——丢一帧增量根修)', () => {
  const taskEv = (id: string, title: string): SessionEvent =>
    ev('task-created', undefined, { taskId: id, title, spec: 's', dependsOn: [] });

  /** 进 chat 且种子应答悬挂(播种窗开——板帧窗同步开):返回后可先投板帧再落定种子 */
  async function enterChatHeldBoard(): Promise<{ conn: Conn; unmount: () => void }> {
    const { conn, unmount } = mount();
    conn.holdSnapshot();
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    openConn(conn);
    return { conn, unmount };
  }

  it('播种窗内 task/gate/delegation 帧缓冲不投;整替后 ≤lastSeq 丢、>lastSeq 依序重放(增量不被整替吞)', async () => {
    const { conn, unmount } = await enterChatHeldBoard();
    // 窗内三帧:seq 3 gate-waiting(≤ lastSeq——快照已含其效果:门已 resolved)、seq 8 assigned(>——须重放)、
    // seq 9 委派(>——须重放)
    fire(conn, ev('gate-waiting', undefined, { taskId: 't1' }), 3);
    fire(conn, ev('task-assigned', undefined, { taskId: 't1', assignee: 'w1' }), 8);
    fire(conn, ev('delegation-started', undefined, { delegationId: 'd1', kind: 'subagent', label: 'dev' }), 9);
    // 窗内不投:任务页默认在场,空板 + 委派空(帧在 boardPendingRef 缓冲)
    expect(screen.getByText(/任务板为空/)).toBeDefined();
    expect(screen.getByLabelText('delegations').textContent).not.toContain('dev');
    // 种子:lastSeq 5;快照板 t1(Base,门已 resolved——seq 3 的效果已在快照内)
    conn.snapshotResp = snapshotOf({
      lastSeq: 5,
      board: applyBoardEvent(
        applyBoardEvent(
          applyBoardEvent(emptyBoard(), { t: 'task-created', taskId: 't1', title: 'Base', spec: '', dependsOn: [], ts: 1 }),
          { t: 'gate-set', taskId: 't1', ts: 2 },
        ),
        { t: 'gate-resolved', taskId: 't1', approved: true, ts: 3 },
      ),
    });
    conn.releaseSnapshot();
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    // 整替+过滤重放:t1 带 @w1 且无 ⚠(seq 8 重放——丢帧根修判据;seq 3 丢——若重放则门被重新挂上 ⚠,
    // reducer 对 created 幂等故以 gate-set 重挂为 ≤ 过滤的可观测判据);seq 9 委派重放(行在场)
    expect(screen.getByText('t1 [pending] Base @w1')).toBeDefined();
    expect(screen.getByLabelText('delegations').textContent).toContain('dev');
    // 窗后帧直投(不再缓冲)
    fire(conn, taskEv('t2', 'Live'), 10);
    expect(screen.getByText('t2 [pending] Live')).toBeDefined();
    unmount();
  });

  it('onResetSession 清缓冲:窗内帧随 reset 弃(旧板作废),新种子不重放', async () => {
    const { conn, unmount } = await enterChatHeldBoard();
    fire(conn, taskEv('t1', 'Ghost'), 10); // 窗内缓冲(种子 lastSeq 0,若不清必重放)
    fireResetSession(conn, 's1'); // 本会话 reset:板投影+缓冲清 → Chat reseed(种子仍 held)
    conn.releaseSnapshot();
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText(/任务板为空/)).toBeDefined(); // Ghost 未重放
    unmount();
  });
});

describe('G5 Chat 顶栏 Delete(daemon 会话 id 寻址)与 idle 清卡', () => {
  const apReq: GuiApprovalReq = { id: 'ap-1', kind: 'write', subject: 'rm -rf /tmp/x' };
  const apTitle = '[approval write] rm -rf /tmp/x';

  afterEach(() => {
    vi.restoreAllMocks(); // window.confirm spy 复原
  });

  it('Delete:confirm 真 → conn.deleteSession(sessionId) → 回 welcome;confirm 假不动', async () => {
    const { conn, unmount } = await enterChat();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(conn.deleteSessionCalls).toEqual([]); // 假:不发
    expect(screen.getByText('session s1')).toBeDefined(); // 留在会话
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(conn.deleteSessionCalls).toEqual(['s1'])); // daemon 会话 id(非 journal id)
    await waitFor(() => expect(screen.getByLabelText('welcome')).toBeDefined()); // onBack → 欢迎空态(会话关窗)
    unmount();
  });

  it('Delete 失败(running 409):error 条示出不静默,留在会话', async () => {
    const { conn, unmount } = await enterChat();
    conn.deleteReject = new Error('/session/s1/delete -> 409');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByText('/session/s1/delete -> 409')).toBeDefined());
    expect(screen.getByText('session s1')).toBeDefined();
    unmount();
  });

  it('status 转 idle 清卡:卡在场 → run(running)→ done(idle)→ 卡区退场', async () => {
    const { conn, unmount } = await enterChat();
    fireApproval(conn, 's1', 'p-idle-1', apReq);
    expect(screen.getByText(apTitle)).toBeDefined();
    fire(conn, ev('model-start')); // idle → running
    expect(screen.getByText(apTitle)).toBeDefined(); // run 中不清
    fire(conn, ev('done', 'fin')); // running → idle(daemon 已 deny 回填)→ 清卡
    await waitFor(() => expect(screen.queryByText(apTitle)).toBeNull());
    unmount();
  });

  it('重连(reseed 瞬态)不清卡:running 中挂起卡在场 → onReset → 播种落定卡仍保留;真 idle 转换仍清(G4 不变式)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start')); // running:挂起卡的常态现场(run 中审批)
    fireApproval(conn, 's1', 'p-keep2', apReq);
    expect(screen.getByText(apTitle)).toBeDefined();
    act(() => conn.opts.onReset()); // 连接级 reset:reseed 置 initialChatState(idle)瞬态
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText(apTitle)).toBeDefined(); // 瞬态不清——daemon 重发被 pid 去重拦,卡是唯一在场面
    // reseed 后真转换照常清:快照 idle → model-start(running)→ done(idle)
    fire(conn, ev('model-start'));
    fire(conn, ev('done', 'fin'));
    await waitFor(() => expect(screen.queryByText(apTitle)).toBeNull());
    unmount();
  });
});
