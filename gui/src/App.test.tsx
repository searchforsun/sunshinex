import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { SessionEvent } from '../../src/types';
import { App } from './App';
import { emptyBoard } from './projection';
import type { SnapshotTranscriptEntry } from './chat-reducer';
import type { ConnectionOpts, ConnectionState, Connection, DirPickerResp, SessionRow, SnapshotResponse, WorkspaceRow } from './connection';

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
    submitReject: Error | null = null;
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

describe('卸载收口(单连接生命周期)', () => {
  it('unmount 关闭连接', async () => {
    const { conn, unmount } = await enterChat();
    unmount();
    expect(conn.closed).toBe(true);
  });
});
