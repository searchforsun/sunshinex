import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { SessionEvent } from '../../src/types';
import { App } from './App';
import { emptyBoard, applyBoardEvent } from './projection';
import type { SnapshotTranscriptEntry } from './chat-reducer';
import type { ConnectionOpts, ConnectionState, Connection, DirPickerResp, SessionRow, SnapshotResponse, WorkspaceRow, FileResp } from './connection';
import type { GuiApprovalReq, GuiAskAnswer, GuiAskReq } from './connection';

/**
 * G3.5 App 装配测(T4δ Chat 页会话化):vi.mock 连接工厂注入事件——App() 无 props 自装配
 * (token 经 localStorage 注入),mock conn 捕获 onEvent(sessionId,…)/onReset/onStateChange
 * 回调面;chat 分支经 Home 真流程进入(工作区展开→Attach 两步链→Chat 装配播种快照)。
 * 断言:路由骨架(Chat 页挂载/占位条退役/返回)、帧按会话分发(他会话帧丢弃)、onReset 重置+
 * 重播种、md 渲染、Enter 分流(idle sessionSubmit / running sessionSteer)、Stop 中断、状态条、
 * 种子竞态缓冲(seed 在途帧缓冲→种子落定 seq 过滤补投)、两会话先后打开投影独立。
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

/** 挂载(token 经 localStorage 注入,同 main 装配的开发持久形态)→ 捕获的 mock conn + 卸载句柄;初始路由 home */
function mount(): { conn: Conn; unmount: () => void } {
  localStorage.setItem('sunshinex.token', 'test-token');
  const { unmount } = render(<App />);
  return { conn: h.created.at(-1)!, unmount };
}

/** Home 真流程进 chat:工作区行展开 → Attach 两步链(newSession+attach)→ 会话占位在场 →
 *  连接 open + 播种落定(输入启用——seeding 门:基线快照在途时输入禁用) */
async function enterChat(): Promise<{ conn: Conn; unmount: () => void }> {
  const { conn, unmount } = mount();
  fireEvent.click(await screen.findByRole('button', { name: /ws-root-a/ }));
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

describe('路由骨架:home | chat(Chat 页挂载)', () => {
  it('初始 home:工作区列表在场、无对话输入区;顶栏无会话 chip', async () => {
    mount();
    expect(await screen.findByRole('region', { name: 'workspaces' })).toBeDefined();
    expect(screen.queryByLabelText('message input')).toBeNull();
    expect(screen.queryByText('session s1')).toBeNull();
  });

  it('Home 选中(Attach 链)→ chat:Chat 页挂载渲染 sessionId(newSession→attach 两步)+ 返回 home', async () => {
    const { conn, unmount } = await enterChat();
    // 两步链:Attach = newSession(root) + attach(sessionId, journalId)
    expect(conn.newSessionCalls).toEqual(['/w/root-a']);
    expect(conn.attachCalls).toEqual([['s1', 'j1']]);
    // Chat 页面:会话 chip 在场、占位条退役(T4δ 真组件装配)
    expect(screen.getByText('session s1')).toBeDefined();
    expect(document.querySelector('.session-placeholder')).toBeNull();
    expect(screen.getByLabelText('message input')).toBeDefined();
    // 返回 home:对话面退场、工作区列表回归
    fireEvent.click(screen.getByRole('button', { name: /返回首页/ }));
    expect(await screen.findByRole('region', { name: 'workspaces' })).toBeDefined();
    expect(screen.queryByLabelText('message input')).toBeNull();
    unmount();
  });

  it('两会话先后打开投影独立:key 隔离——s1 交互→back→s2 打开无 s1 条目,再交互各自 :id', async () => {
    const { conn, unmount } = mount();
    openConn(conn);
    // —— s1:进 chat + 交互(user 回显 + 流式帧)——
    fireEvent.click(await screen.findByRole('button', { name: /ws-root-a/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    type('s1 目标');
    pressEnter();
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 's1 流内容'));
    expect(conn.sessionSubmitCalls).toEqual([['s1', 's1 目标']]);
    expect(screen.getByText('s1 目标')).toBeDefined();
    // —— back → home(Chat 卸毁:s1 本地态随组件销毁)——
    fireEvent.click(screen.getByRole('button', { name: /返回首页/ }));
    expect(await screen.findByRole('region', { name: 'workspaces' })).toBeDefined();
    // —— s2:FakeConn 下一会话号;重走 Home 真流程 ——
    conn.nextSessionId = 's2';
    fireEvent.click(await screen.findByRole('button', { name: /ws-root-a/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
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
    fireEvent.click(await screen.findByRole('button', { name: /ws-root-a/ }));
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

  it('onReset 时未开会话(home):仅清投影不拉快照', async () => {
    const { conn } = mount();
    await screen.findByRole('region', { name: 'workspaces' });
    const before = conn.snapshotCalls.length;
    act(() => conn.opts.onReset());
    expect(conn.snapshotCalls.length).toBe(before);
    expect(screen.getByRole('region', { name: 'workspaces' })).toBeDefined();
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
    fireEvent.click(await screen.findByRole('button', { name: /ws-root-a/ }));
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

describe('G6 Files 页:第三 tab + write 工具 path 按钮跳转', () => {
  it('三 tab 切换:Chat|Board|Files;Files 进入预览面,Chat 常驻零重播种', async () => {
    const { conn, unmount } = await enterChat();
    expect(screen.getByRole('button', { name: 'Files' })).toBeDefined(); // 第三 tab 在场
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByLabelText('files')).toBeDefined(); // Files 预览面
    expect(screen.getByRole('button', { name: 'Files' }).getAttribute('aria-pressed')).toBe('true');
    expect(conn.snapshotCalls).toHaveLength(1); // Chat 常驻:切 tab 不重播种
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByLabelText('board')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByLabelText('message input')).toBeDefined(); // 回 Chat 对话面在场
    unmount();
  });

  it('write 条目 path 按钮 → onOpenFile 跳转:Files tab 激活 + initialPath 自动加载 + 高亮渲染', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    // write tool-call 帧(batch-runner 实发形态:text=工具名,payload.input={path,content})
    fire(conn, ev('tool-call', 'write', { input: { path: 'src/a.ts', content: 'const y = 2;\n' }, callId: 'c1', status: 'pending' }));
    fire(conn, ev('tool-result', 'written', { tool: 'write', callId: 'c1', status: 'completed' }));
    // 展开 write 条目 → path 按钮 → Files tab
    fireEvent.click(screen.getByRole('button', { name: '● write src/a.ts ⎿ written' }));
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }));
    expect(screen.getByRole('button', { name: 'Files' }).getAttribute('aria-pressed')).toBe('true');
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

  it('Files 403 错误态:越界路径错误消息示出', async () => {
    const { conn, unmount } = await enterChat();
    conn.fileReject = new Error('/session/s1/file?path=../x -> 403');
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.change(screen.getByLabelText('file path input'), { target: { value: '../x' } });
    fireEvent.click(screen.getByRole('button', { name: '加载' }));
    await waitFor(() => expect(screen.getByText('/session/s1/file?path=../x -> 403')).toBeDefined());
    expect(document.querySelector('.files-view')).toBeNull();
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


describe('G5 Board 页:tab 进入 + 板/委派投影 + team(快照) + 会话维 reset', () => {
  const taskCreated = (id: string, title: string, dependsOn: string[] = []): SessionEvent =>
    ev('task-created', undefined, { taskId: id, title, spec: 's', dependsOn });

  it('tab 切换:Board 进入(空板占位)→ 返回 Chat(tab 态切回,Chat 常驻不重播种)', async () => {
    const { conn, unmount } = await enterChat();
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByLabelText('board')).toBeDefined();
    expect(screen.getByText(/任务板为空/)).toBeDefined();
    // Chat 常驻(hidden 面):message input 仍在 DOM(tab 切回零重播种)
    fireEvent.click(screen.getByRole('button', { name: /返回 Chat/ }));
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed')).toBe('true');
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
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByText('t1 [pending] Demo ⚠ @w1')).toBeDefined();
    expect(screen.getByText('t2 [pending] Next (needs t1)')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Approve t1' }));
    await waitFor(() => expect(conn.boardReviewCalls).toEqual([['s1', 't1', true]]));
    unmount();
  });

  it('他会话帧不进板投影(sessionRef 过滤在板面前)', async () => {
    const { conn, unmount } = await enterChat();
    fireOther(conn, taskCreated('t9', '他会话任务'));
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByText(/任务板为空/)).toBeDefined();
    unmount();
  });

  it('team 侧栏:snapshot.team 经 Chat 播种回填 App 态;onReset 重播种更新', async () => {
    const { conn, unmount } = mount();
    conn.snapshotResp = snapshotOf({ team: [{ name: 'w1', busy: true }] });
    fireEvent.click(await screen.findByRole('button', { name: /ws-root-a/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    openConn(conn);
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByText('t1 [pending] Demo')).toBeDefined();
    // —— back → 开 s2:openSession 清板投影 + s2 快照(空)回填——无 s1 残留 ——
    fireEvent.click(screen.getByRole('button', { name: 'Chat' })); // tab 切回(Chat 面在场可达)
    fireEvent.click(screen.getByRole('button', { name: /返回首页/ }));
    await screen.findByRole('region', { name: 'workspaces' });
    conn.nextSessionId = 's2';
    fireEvent.click(await screen.findByRole('button', { name: /ws-root-a/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s2')).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByText(/任务板为空/)).toBeDefined(); // s2 快照空板(而非 s1 残留)
    // —— 重开 s1:快照带板 → onSeeded 回填,Board 即快照权威态(无需事件帧)——
    conn.snapshotResp = snapshotOf({
      board: applyBoardEvent(emptyBoard(), { t: 'task-created', taskId: 't1', title: 'Demo', spec: '', dependsOn: [], ts: 1 }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Chat' })); // tab 切回
    fireEvent.click(screen.getByRole('button', { name: /返回首页/ }));
    await screen.findByRole('region', { name: 'workspaces' });
    conn.nextSessionId = 's1';
    fireEvent.click(await screen.findByRole('button', { name: /ws-root-a/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByText('t1 [pending] Demo')).toBeDefined(); // 快照回填的权威板
    unmount();
  });
});

describe('G5 Chat 顶栏 Delete(daemon 会话 id 寻址)与 idle 清卡', () => {
  const apReq: GuiApprovalReq = { id: 'ap-1', kind: 'write', subject: 'rm -rf /tmp/x' };
  const apTitle = '[approval write] rm -rf /tmp/x';

  afterEach(() => {
    vi.restoreAllMocks(); // window.confirm spy 复原
  });

  it('Delete:confirm 真 → conn.deleteSession(sessionId) → 回 home;confirm 假不动', async () => {
    const { conn, unmount } = await enterChat();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(conn.deleteSessionCalls).toEqual([]); // 假:不发
    expect(screen.getByText('session s1')).toBeDefined(); // 留在会话
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(conn.deleteSessionCalls).toEqual(['s1'])); // daemon 会话 id(非 journal id)
    await waitFor(() => expect(screen.getByRole('region', { name: 'workspaces' })).toBeDefined()); // onBack 回 home
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
