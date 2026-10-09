import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { SessionEvent } from '../../src/types';
import { App } from './App';
import { emptyBoard, applyBoardEvent } from './projection';
import { highlightCode } from './highlight';
import type { SnapshotTranscriptEntry } from './chat-reducer';
import type { ConnectionOpts, ConnectionState, Connection, DiffResp, DirPickerResp, SessionRow, SnapshotResponse, WorkspaceRow, FileResp, TreeResp, SettingsView, SettingsKeyRow, ProviderChoice, McpRow, McpRowInput, McpProbeResult, BuiltinRole, AgentsView, SkillsGroup } from './connection';
import type { GuiApprovalReq, GuiAskAnswer, GuiAskReq } from './connection';

/** G10-C3 工具行图标化后的定位器:textContent 含给定文本的折叠行 */
function toolRow(text: string): HTMLButtonElement | null {
  const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.tool-summary'));
  return rows.find((r) => r.textContent?.replace(/\s+/g, ' ').includes(text)) ?? null;
}


/** putAgent 输入形(connection.ts 内联签名提取——FakeConn 桩记录类型用) */
type PutAgentInput = Parameters<Connection['putAgent']>[0];

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
    /** G8b-T7 修复测:会话维 tree 应答(sessionId→path→resp;命中优先于 treeByPath——跨会话
     *  同名路径分异桩,单例目录标签不重挂切换的陈旧层断言用) */
    treeBySession: Record<string, Record<string, TreeResp>> = {};
    treeReject: Error | null = null;
    /** G8c T8 设置面:settings 应答可编程(缺省空 keys);调用记录 [root 归一 '']——root 缺省
     *  (仅全局)记 ''(与有值 root 分异的断言面);putSettings 记 [root, updates] + 可编程拒;
     *  memoryStats 同 settings 形(记忆面板概览行数据源) */
    settingsView: SettingsView = settingsViewOf([]);
    settingsCalls: string[] = [];
    putSettingsCalls: Array<[string, Record<string, string | number | null>]> = [];
    putSettingsReject: Error | null = null;
    memoryStatsResp: { entries: number; lastWriteAt: number | null } = { entries: 0, lastWriteAt: null };
    memoryStatsCalls: string[] = [];
    /** G8c T9 MCP 面:mcpServers/probe/putMcpServers 三桩(应答可编程;调用记录 root 归一 '') */
    mcpServersResp: { servers: McpRow[] } = { servers: [] };
    mcpServersCalls: string[] = [];
    mcpProbeResp: McpProbeResult = { ok: true, tools: [] };
    mcpProbeCalls: Array<[string, string]> = [];
    putMcpServersCalls: Array<[string, McpRowInput[]]> = [];
    putMcpServersReject: Error | null = null;
    /** G8c T9 智能体面:agentsView/putAgent 两桩(putAgentReject 注入 400 面) */
    agentsViewResp: { builtins: BuiltinRole[]; view: AgentsView } = { builtins: [], view: { entries: [], warnings: [] } };
    agentsViewCalls: string[] = [];
    putAgentCalls: PutAgentInput[] = [];
    putAgentReject: Error | null = null;
    /** G8d T3 全文面:agentBody 应答/拒可编程(缺省拒 404——失败回退面);调用记录 [scope, id, root 归一 ''] */
    agentBodyResp: { body: string } | null = null;
    agentBodyReject: Error | null = null;
    agentBodyCalls: Array<['project' | 'global', string, string]> = [];
    /** G8c T9 技能面:skillsGroups 应答可编程(缺省空组) */
    skillsGroupsResp: { groups: SkillsGroup[] } = { groups: [] };
    skillsGroupsCalls: string[] = [];
    /** G8c T9 raw 面:读取应答/双拒可编程;调用记录 [scope, root 归一 '', file](+content) */
    rawResp: { content: string | null } = { content: null };
    rawReject: Error | null = null;
    settingsRawCalls: Array<['project' | 'global', string, 'settings' | 'mcp']> = [];
    putSettingsRawCalls: Array<['project' | 'global', string, 'settings' | 'mcp', string]> = [];
    putSettingsRawReject: Error | null = null;
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
    /** G8e-T2 设置面慢应答门(load 代守卫测):hold 后**下一笔** settings 应答悬挂(单发——
     *  只拦 hold 后首发一笔,后续直通;应答体在调用时定格——迟到仍回旧视图,竞态面可控) */
    private settingsGate: Promise<void> = Promise.resolve();
    private settingsGateRelease: () => void = () => {};
    holdSettings(): void {
      this.settingsGate = new Promise<void>((resolve) => {
        this.settingsGateRelease = resolve;
      });
    }
    releaseSettings(): void {
      this.settingsGateRelease();
    }
    /** G8e 终审 A raw 面慢读门(read 代守卫测):hold 后**下一笔** settingsRaw 应答悬挂(单发——
     *  只拦 hold 后首发一笔,后续直通;应答体在调用时定格——迟到仍回旧内容,竞态面可控) */
    private rawGate: Promise<void> = Promise.resolve();
    private rawGateRelease: () => void = () => {};
    holdRaw(): void {
      this.rawGate = new Promise<void>((resolve) => {
        this.rawGateRelease = resolve;
      });
    }
    releaseRaw(): void {
      this.rawGateRelease();
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
    recentSessions(): Promise<Array<SessionRow & { root: string; slug: string }>> {
      return Promise.resolve([]);
    }
    sessionModel(): Promise<{ current: undefined; explicitDefault: boolean; choices: never[] }> {
      return Promise.resolve({ current: undefined, explicitDefault: false, choices: [] });
    }
    setSessionModel(): Promise<void> { return Promise.resolve(); }
    setSessionTier(): Promise<void> { return Promise.resolve(); }
    setSessionEffort(): Promise<void> { return Promise.resolve(); }
    setSessionMode(): Promise<void> { return Promise.resolve(); }
    cancelSteer(): Promise<void> { return Promise.resolve(); }
    rewindSession(): Promise<void> { return Promise.resolve(); }
    forkSession(): Promise<{ sessionId: string }> { return Promise.resolve({ sessionId: 'forked' }); }
    sessionAnchors(): Promise<Array<{ turn: number; text: string }>> { return Promise.resolve([]); }
    removeMemory(): Promise<{ removed: string[]; failed: never[] }> { return Promise.resolve({ removed: [], failed: [] }); }
    runCommand(): Promise<void> { return Promise.resolve(); }
    commands(): Promise<{ commands: string[]; descriptions: Record<string, string>; supported: string[] }> {
      return Promise.resolve({ commands: [], descriptions: {}, supported: [] });
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
      const bySession = this.treeBySession[sessionId]?.[p];
      if (bySession !== undefined) return Promise.resolve(bySession);
      return Promise.resolve(this.treeByPath[p] ?? { entries: [] });
    }
    settings(root?: string): Promise<SettingsView> {
      this.settingsCalls.push(root ?? '');
      const gate = this.settingsGate;
      this.settingsGate = Promise.resolve(); // 单发:只拦 hold 后首发一笔,后续直通
      const view = this.settingsView; // 应答体调用时定格(慢应答迟到仍回旧视图)
      return gate.then(() => view);
    }
    putSettings(root: string, updates: Record<string, string | number | null>): Promise<void> {
      if (this.putSettingsReject !== null) return Promise.reject(this.putSettingsReject);
      this.putSettingsCalls.push([root, updates]);
      return Promise.resolve();
    }
    memoryStats(root?: string): Promise<{ entries: number; lastWriteAt: number | null }> {
      this.memoryStatsCalls.push(root ?? '');
      return Promise.resolve(this.memoryStatsResp);
    }
    mcpServers(root?: string): Promise<{ servers: McpRow[] }> {
      this.mcpServersCalls.push(root ?? '');
      return Promise.resolve(this.mcpServersResp);
    }
    mcpProbe(root: string | undefined, name: string): Promise<McpProbeResult> {
      this.mcpProbeCalls.push([root ?? '', name]);
      return Promise.resolve(this.mcpProbeResp);
    }
    putMcpServers(root: string, servers: McpRowInput[]): Promise<void> {
      if (this.putMcpServersReject !== null) return Promise.reject(this.putMcpServersReject);
      this.putMcpServersCalls.push([root, servers]);
      return Promise.resolve();
    }
    agentsView(root?: string): Promise<{ builtins: BuiltinRole[]; view: AgentsView }> {
      this.agentsViewCalls.push(root ?? '');
      return Promise.resolve(this.agentsViewResp);
    }
    putAgent(input: PutAgentInput): Promise<void> {
      if (this.putAgentReject !== null) return Promise.reject(this.putAgentReject);
      this.putAgentCalls.push(input);
      return Promise.resolve();
    }
    agentBody(scope: 'project' | 'global', id: string, root?: string): Promise<{ body: string }> {
      this.agentBodyCalls.push([scope, id, root ?? '']);
      if (this.agentBodyReject !== null) return Promise.reject(this.agentBodyReject);
      if (this.agentBodyResp !== null) return Promise.resolve(this.agentBodyResp);
      return Promise.reject(new Error(`/settings/agents/body?scope=${scope}&id=${encodeURIComponent(id)} -> 404`));
    }
    skillsGroups(root?: string): Promise<{ groups: SkillsGroup[] }> {
      this.skillsGroupsCalls.push(root ?? '');
      return Promise.resolve(this.skillsGroupsResp);
    }
    settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }> {
      this.settingsRawCalls.push([scope, root ?? '', file]);
      if (this.rawReject !== null) return Promise.reject(this.rawReject);
      const gate = this.rawGate;
      this.rawGate = Promise.resolve(); // 单发:只拦 hold 后首发一笔,后续直通
      const resp = this.rawResp; // 应答体调用时定格(慢应答迟到仍回旧内容)
      return gate.then(() => resp);
    }
    putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void> {
      if (this.putSettingsRawReject !== null) return Promise.reject(this.putSettingsRawReject);
      this.putSettingsRawCalls.push([scope, root ?? '', file, content]);
      return Promise.resolve();
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

/** G8c T8/T9 SettingsView fixture:keys 可编程;T9 起 permissions/providers 面可选覆写(缺省恒空) */
function settingsViewOf(
  keys: SettingsKeyRow[],
  over: { permissions?: SettingsView['permissions']; providers?: SettingsView['providers'] } = {},
): SettingsView {
  const emptyPerms = { deny: [], allow: [], additionalDirs: [] };
  return {
    keys,
    permissions: over.permissions ?? { merged: emptyPerms, project: emptyPerms, global: emptyPerms },
    providers: over.providers ?? { choices: [] as ProviderChoice[], apiKeyPresent: {}, warnings: [] },
  };
}

type Conn = InstanceType<typeof h.FakeConn>;

/** 挂载(token 经 localStorage 注入,同 main 装配的开发持久形态)→ 捕获的 mock conn + 卸载句柄;初始 welcome */
function mount(): { conn: Conn; unmount: () => void } {
  const { unmount } = render(<App />);
  return { conn: h.created.at(-1)!, unmount };
}

/** 左栏项目组头定位(ProjectMenu 组头钮可及名 = slug + 会话数;G8a:Home 行退役,组头即展开钮) */
const GROUP_HEAD = { name: /^root-a 1$/ }; // G8f 可读性:组头=basename(root)+纯数字计数

/** 左栏真流程进 chat(G8a:ProjectMenu 组头展开 → Attach 两步链(newSession+attach)→ Chat
 *  会话 chip 在场)→ 连接 open + 播种落定(输入启用——seeding 门:基线快照在途时输入禁用) */
async function enterChat(): Promise<{ conn: Conn; unmount: () => void }> {
  const { conn, unmount } = mount();
  fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
  fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
  await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined());
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
    expect(screen.queryByText('s1', { selector: '.chat-title' })).toBeNull();
  });

  it('左栏 Attach 链 → chat:Chat 页挂载渲染 sessionId(newSession→attach 两步)+ 返回 welcome', async () => {
    const { conn, unmount } = await enterChat();
    // 两步链:Attach = newSession(root) + attach(sessionId, journalId)
    expect(conn.newSessionCalls).toEqual(['/w/root-a']);
    expect(conn.attachCalls).toEqual([['s1', 'j1']]);
    // Chat 页面:会话 chip 在场、占位条退役(T4δ 真组件装配)
    expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined();
    expect(document.querySelector('.session-placeholder')).toBeNull();
    expect(screen.getByLabelText('message input')).toBeDefined();
    // 返回:对话面退场 → 欢迎空态(左栏常驻)
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
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
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    type('s1 目标');
    pressEnter();
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 's1 流内容'));
    expect(conn.sessionSubmitCalls).toEqual([['s1', 's1 目标']]);
    expect(screen.getByText('s1 目标')).toBeDefined();
    // —— back → welcome(Chat 卸毁:s1 本地态随组件销毁;左栏组仍展开——壳常驻)——
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    await screen.findByLabelText('welcome');
    // —— s2:FakeConn 下一会话号;组已展开(常驻),Attach 直点 ——
    conn.nextSessionId = 's2';
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('s2', { selector: '.chat-title' })).toBeDefined());
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
    await act(async () => {}); // ProjectMenu 首载 workspaces 微任务在 act 内落定(act 警告收敛)
    expect(screen.getByLabelText('connection: connecting')).toBeDefined();
    expect(screen.getByText('连接中')).toBeDefined(); // G8f:连接态中文标签
    openConn(conn);
    expect(screen.getByLabelText('connection: open')).toBeDefined();
    expect(screen.getByText('已连接')).toBeDefined();
  });

  it('reconnecting/closed 两态色 hook 亦可表达(onStateChange 透传)', async () => {
    const { conn } = mount();
    await act(async () => {}); // 同上:首载微任务在 act 内落定(同步断言前冲净异步面)
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
    const title = (document.querySelector('.chat-title') as HTMLElement | null)?.getAttribute('title') ?? '';
    expect(title).toContain('340 tokens');
    expect(title).toContain('2 steps');
    expect(title).toContain('运行中');
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
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined());
    openConn(conn);
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText('build the widget')).toBeDefined(); // `> …` → blockquote
    expect(document.querySelector('.tool-summary')?.textContent).toContain('read'); // 图标化行(●/⎿ 记号退役,G10-C3)
    expect(document.querySelector('.tool-summary')?.textContent).toContain('ok');
    expect(screen.getByText('✻ dev started')).toBeDefined();
    expect(screen.getByText('boom')).toBeDefined();
    expect(document.querySelector('.entry-user blockquote')).not.toBeNull();
    expect((document.querySelector('.chat-title') as HTMLElement).getAttribute('title')).toContain('运行中');
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

describe('G8d T5 交互清单:输入区自增高/流式光标/状态条图标数字组', () => {
  it('输入区 textarea:多行内容 rows 随行数自增(帽 6),清空回 1;Shift+Enter 不提交', async () => {
    const { conn, unmount } = await enterChat();
    const box = screen.getByLabelText('message input') as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA'); // 输入面已迁 textarea
    expect(box.rows).toBe(1); // 单行起步
    fireEvent.change(box, { target: { value: 'a\nb\nc\nd' } }); // 3 次换行
    expect(box.rows).toBe(4); // 行数 = 换行数 + 1(3-6 界内)
    fireEvent.change(box, { target: { value: '1\n2\n3\n4\n5\n6\n7\n8' } }); // 8 行内容
    expect(box.rows).toBe(6); // 帽 6 行(不自增无限高)
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true }); // Shift+Enter = 换行(不提交)
    expect(conn.sessionSubmitCalls).toEqual([]);
    expect(conn.sessionSteerCalls).toEqual([]);
    fireEvent.change(box, { target: { value: '' } }); // 清空回 1
    expect(box.rows).toBe(1);
    unmount();
  });

  it('流式光标:streaming 条末 .sx-stream-cursor 在场;done 收段退场', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start'));
    fire(conn, ev('token', '流内容'));
    expect(document.querySelector('.entry-assistant.streaming .sx-stream-cursor')).not.toBeNull(); // 流式条末光标
    fire(conn, ev('done', '流内容'));
    expect(document.querySelector('.sx-stream-cursor')).toBeNull(); // 收段去光标
    unmount();
  });

  it('状态条图标+数字组:tokens/steps 组类名+aria-label+lucide svg 图标在场', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start'));
    fire(conn, ev('usage', undefined, { turnTotal: 77 }));
    fire(conn, ev('step', 'x'));
    const title = (document.querySelector('.chat-title') as HTMLElement | null)?.getAttribute('title') ?? '';
    expect(title).toContain('77 tokens'); // 指标收进 hover tooltip(G10 去常显文字)
    expect(title).toContain('1 steps');
    unmount();
  });
});

describe('种子竞态缓冲(T3 收口):seed 在途帧缓冲→种子落定过滤补投', () => {
  /** 进 chat 且 seed 应答悬挂(在途窗):返回后可先投帧再落定种子 */
  async function enterChatHeld(): Promise<{ conn: Conn; unmount: () => void }> {
    const { conn, unmount } = mount();
    conn.holdSnapshot();
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined());
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
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    expect(conn.sessionInterruptCalls).toEqual(['s1']);
    fire(conn, ev('done', 'fin'));
    expect(screen.queryByRole('button', { name: 'stop' })).toBeNull();
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
    const { conn, unmount } = mount();
    conn.snapshotResp = snapshotOf({
      status: 'running',
      pending: [{ pid: 'p-snap-1', kind: 'approval', req: apReq }],
    });
    await act(async () => {}); // 首载 workspaces 在 act 内落定(await mount() 裸 await 会在 env=true 处冲净致 act 警告)
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined());
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

  it('file 标签预览面:「+」菜单开标签 → 路径输入回车加载(readFile 断参)+ 高亮 + 换路径重载(G8d 起 path 钮改开 diff,本面经输入框直达)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '文件' }));
    fireEvent.change(screen.getByLabelText('file path input'), { target: { value: 'src/a.ts' } });
    fireEvent.keyDown(screen.getByLabelText('file path input'), { key: 'Enter' });
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'src/a.ts']]));
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
    // G8d 起 Chat path 钮改开 diff 标签——file 标签按 path 开档的入口改为目录树文件行(openTab('file',{path}))
    conn.treeByPath = {
      '': { entries: [{ name: 'dirA', kind: 'dir' }] },
      dirA: { entries: [{ name: 'a.ts', kind: 'file' }, { name: 'b.ts', kind: 'file' }] },
    };
    // —— 开 file 标签 A(dirA/a.ts:目录文件行跳转,initialPath 自动加载)——
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '目录' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'dirA' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'a.ts' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }));
    expect(document.querySelector('.sx-tab[title="dirA/a.ts"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'dirA/a.ts']]));
    // —— 开 file 标签 B:切回目录标签(重挂重拉+展开)再点 b.ts 行 ——
    fireEvent.click(screen.getByRole('button', { name: '目录' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'dirA' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'b.ts' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'b.ts' }));
    // 两文件标签在场且 B 活动(判重经 path:两 uid 两页)
    expect(document.querySelector('.sx-tab[title="dirA/a.ts"]')).not.toBeNull();
    expect(document.querySelector('.sx-tab[title="dirA/b.ts"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'dirA/a.ts'], ['s1', 'dirA/b.ts']]));
    // —— 切回 A:tabbody key=uid 强制重挂——initialPath 重新生效(第三笔加载请求 path=A)+ 路径输入回 A
    // (无 key 时 React 复用 B 的 Files 实例:effect no-op,无第三笔请求且路径输入残留 dirA/b.ts)
    fireEvent.click(screen.getByRole('button', { name: 'dirA/a.ts' }));
    expect(document.querySelector('.sx-tab[title="dirA/a.ts"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'dirA/a.ts'], ['s1', 'dirA/b.ts'], ['s1', 'dirA/a.ts']]));
    expect((screen.getByLabelText('file path input') as HTMLInputElement).value).toBe('dirA/a.ts');
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
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    await screen.findByLabelText('welcome');
    expect(conn.killPtyCalls).toEqual([]);
    // 重进同会话(journal 重挂 s1):终端标签还原 → 重挂走重连径(记账命中,不重开 pty)
    conn.nextSessionId = 's1';
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined());
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

  it('G8e-T2 错误层重试:展开失败 → 收起再展开重拉(错误态缓存不命中跳过)→ 第二笔成功行在场', async () => {
    const { conn, unmount } = await enterChat();
    conn.treeByPath = {
      '': { entries: [{ name: 'dirA', kind: 'dir' }] },
      dirA: { entries: [{ name: 'fileA.ts', kind: 'file' }] },
    };
    openDirectory();
    await waitFor(() => expect(screen.getByRole('button', { name: 'dirA' })).toBeDefined());
    // 首拉 dirA 失败:层落 error 行内态
    conn.treeReject = new Error('/session/s1/tree?path=dirA -> 500');
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    await waitFor(() => expect(screen.getByText('/session/s1/tree?path=dirA -> 500')).toBeDefined());
    // 收起再展开:错误层清除重拉(而非 nodes.has 命中跳过)→ 第二笔 dirA 成功 → 子文件行在场
    conn.treeReject = null;
    fireEvent.click(screen.getByRole('button', { name: 'dirA' })); // 收起
    fireEvent.click(screen.getByRole('button', { name: 'dirA' })); // 再展开 → 重拉
    await waitFor(() => expect(screen.getByRole('button', { name: 'fileA.ts' })).toBeDefined());
    expect(conn.treeCalls).toEqual([['s1', ''], ['s1', 'dirA'], ['s1', 'dirA']]); // dirA 两笔(重试面)
    unmount();
  });

  it('会话切换层缓存重置(单例 uid 跨会话不重挂):直切回 s1 无 s2 陈旧层,展开重拉 + 文件行开标签用本会话路径', async () => {
    const { conn, unmount } = await enterChat();
    // 两会话同名目录 dirA 而子层各异(s1 层=fileA.ts / s2 层=fileB.ts)——陈旧层缓存唯一可观测形
    conn.treeBySession = {
      s1: {
        '': { entries: [{ name: 'dirA', kind: 'dir' }] },
        dirA: { entries: [{ name: 'fileA.ts', kind: 'file' }] },
      },
      s2: {
        '': { entries: [{ name: 'dirA', kind: 'dir' }] },
        dirA: { entries: [{ name: 'fileB.ts', kind: 'file' }] },
      },
    };
    // —— s1:开目录标签,展开 dirA(fileA.ts 层缓存落定)——
    openDirectory();
    await waitFor(() => expect(conn.treeCalls).toEqual([['s1', '']]));
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    await waitFor(() => expect(conn.treeCalls).toEqual([['s1', ''], ['s1', 'dirA']]));
    expect(screen.getByRole('button', { name: 'fileA.ts' })).toBeDefined();
    // —— 直切 s2(左栏 Attach,不经返回——page 恒 chat;s2 缺省任务页,目录标签经 key 变更重挂)——
    // 再开目录:s2 目录标签在场且活动(构造两会话同 uid 'directory:' 的不重挂现场),展开 dirA 缓存 s2 层
    conn.nextSessionId = 's2';
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('s2', { selector: '.chat-title' })).toBeDefined());
    openDirectory();
    await waitFor(() => expect(conn.treeCalls).toEqual([['s1', ''], ['s1', 'dirA'], ['s2', '']]));
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    await waitFor(() => expect(conn.treeCalls).toEqual([['s1', ''], ['s1', 'dirA'], ['s2', ''], ['s2', 'dirA']]));
    expect(screen.getByRole('button', { name: 'fileB.ts' })).toBeDefined();
    // —— 直切回 s1:tabbody key 仍 'directory:' 不重挂(仅 sessionId prop 变)——修复契约:
    // 层缓存+展开集随 sessionId 整体重置 + root 重拉——s2 陈旧子层(fileB.ts)退场,dirA 收起
    conn.nextSessionId = 's1';
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined());
    await waitFor(() =>
      expect(conn.treeCalls).toEqual([['s1', ''], ['s1', 'dirA'], ['s2', ''], ['s2', 'dirA'], ['s1', '']]),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'fileB.ts' })).toBeNull()); // 陈旧层根除
    expect(screen.getByRole('button', { name: 'dirA' })).toBeDefined(); // 新会话 root(dirA 在场)
    expect(screen.queryByRole('button', { name: 'fileA.ts' })).toBeNull(); // 展开集已清:未展开不渲染
    // 展开 dirA:缓存已清 → 重新拉 s1 层 → fileA.ts 在场(fileB.ts 仍无)
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    await waitFor(() =>
      expect(conn.treeCalls).toEqual([
        ['s1', ''],
        ['s1', 'dirA'],
        ['s2', ''],
        ['s2', 'dirA'],
        ['s1', ''],
        ['s1', 'dirA'],
      ]),
    );
    expect(screen.getByRole('button', { name: 'fileA.ts' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'fileB.ts' })).toBeNull();
    // 点 fileA.ts:文件标签开且活动(title=相对路径),initialPath 以本会话 s1 寻址加载
    fireEvent.click(screen.getByRole('button', { name: 'fileA.ts' }));
    expect(document.querySelector('.sx-tab[title="dirA/fileA.ts"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', 'dirA/fileA.ts']]));
    unmount();
  });
});

describe('G8d Diff 标签:write 条目接线(callId 多实例/判重/404 降级/双列渲染)', () => {
  /** write 工具条目注入(实时帧 callId 配对面:tool-call+tool-result 两帧) */
  const fireWrite = (conn: Conn, callId: string, path: string, content: string): void => {
    fire(conn, ev('tool-call', 'write', { input: { path, content }, callId, status: 'pending' }));
    fire(conn, ev('tool-result', 'written', { tool: 'write', callId, status: 'completed' }));
  };

  it('write 条目 path 钮 → diff 标签开且活动(title=path)+ fetchDiff 断参 + 双列渲染(old/new 两列区)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    conn.diffResp = { path: 'src/a.ts', oldContent: 'const x = 1;\n', newContent: 'const y = 2;\n' };
    fireWrite(conn, 'c1', 'src/a.ts', 'const y = 2;\n');
    fireEvent.click(toolRow('write src/a.ts')!); // 展开 write 条目(●/⎿ 记号退役)
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' })); // tool-path 钮(可及名=路径)→ onOpenDiff 主通道
    // diff 标签开且活动:title=params.path(比 callId 可读——G8d 开档参数带 path)
    expect(document.querySelector('.sx-tab[title="src/a.ts"]')?.classList.contains('active')).toBe(true);
    // fetchDiff 断参:Chat 展开面一笔(G7 既有)+ DiffTab mount 一笔(均 ['s1','c1'])
    await waitFor(() => expect(conn.diffCalls).toEqual([['s1', 'c1'], ['s1', 'c1']]));
    // 标题行 path + 双列面(.sx-tabbody 域——Chat 展开面同有 DiffPanel,以标签体 scope 区隔)
    expect(document.querySelector('.sx-tabbody .sx-diff-path')?.textContent).toBe('src/a.ts');
    expect(document.querySelector('.sx-tabbody .diff-old')?.textContent).toBe('const x = 1;\n');
    expect(document.querySelector('.sx-tabbody .diff-new')?.textContent).toBe('const y = 2;\n');
    expect(document.querySelector('.sx-tabbody .sx-diff-badge')).toBeNull(); // oldContent 在场:无「新建」标
    unmount();
  });

  it('同 callId 重开判重(一标签聚焦不重复,不重挂不重拉);异 callId 多实例并存', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    conn.diffResp = { path: 'src/a.ts', oldContent: 'old a\n', newContent: 'new a\n' };
    fireWrite(conn, 'c1', 'src/a.ts', 'new a\n');
    fireEvent.click(toolRow('write src/a.ts')!);
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }));
    await waitFor(() => expect(conn.diffCalls).toHaveLength(2)); // Chat 展开面 + DiffTab mount
    // 重开同 callId:判重聚焦(仍一标签;条目仍展开故 path 钮唯一,经类名直取避标签同名歧义)
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tool-path')!);
    expect(document.querySelectorAll('.sx-tab[title="src/a.ts"]')).toHaveLength(1);
    expect(conn.diffCalls).toHaveLength(2); // 同 uid 聚焦:DiffTab 不重挂不重拉
    // 异 callId:多实例并存(by callId 判键——两标签互不判重)
    conn.diffResp = { path: 'src/b.ts', newContent: 'new b\n' };
    fireWrite(conn, 'c2', 'src/b.ts', 'new b\n');
    fireEvent.click(toolRow('write src/b.ts')!);
    fireEvent.click(screen.getByRole('button', { name: 'src/b.ts' })); // b 的 path 钮(其标签尚不存在,名无歧义)
    expect(document.querySelectorAll('.sx-tab[title="src/a.ts"]')).toHaveLength(1);
    expect(document.querySelector('.sx-tab[title="src/b.ts"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.diffCalls).toHaveLength(4)); // c2:Chat 展开面 + DiffTab mount
    unmount();
  });

  it('404 无快照 → 行内降级错误条(callId 示出,标签体无 diff 双列面)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    // diffResp 缺省 null → FakeConn 拒 404(Chat 展开面退单列现内容——G7 既有;DiffTab 错误条——G8d)
    fireWrite(conn, 'c3', 'src/gone.ts', 'fallback content\n');
    fireEvent.click(toolRow('write src/gone.ts')!);
    fireEvent.click(screen.getByRole('button', { name: 'src/gone.ts' }));
    await waitFor(() => expect(screen.getByText('无快照(环已裁或非 write)——callId: c3')).toBeDefined());
    expect(document.querySelector('.sx-tabbody .sx-diff-error')).not.toBeNull();
    expect(document.querySelector('.sx-tabbody .diff-panel')).toBeNull(); // 标签体无 diff 渲染面(降级不双列)
    unmount();
  });

  it('oldContent 缺场:单列现内容 +「新建」标;truncated → 截断横幅', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    conn.diffResp = { path: 'src/new.ts', newContent: 'fresh\n', truncated: true };
    fireWrite(conn, 'c4', 'src/new.ts', 'fresh\n');
    fireEvent.click(toolRow('write src/new.ts')!);
    fireEvent.click(screen.getByRole('button', { name: 'src/new.ts' }));
    await waitFor(() => expect(document.querySelector('.sx-tabbody .sx-diff-path')?.textContent).toBe('src/new.ts'));
    expect(screen.getByText('新建')).toBeDefined(); // 新建写无 pre-image:单列 + 新建标
    expect(screen.getByText('内容超限已截断')).toBeDefined(); // truncated 横幅
    expect(document.querySelector('.sx-tabbody .diff-old')).toBeNull(); // 单列(old 列不渲染)
    expect(document.querySelector('.sx-tabbody .diff-new')?.textContent).toBe('fresh\n');
    unmount();
  });
});

describe('G8d Agents 标签:子代理事件分流 + 聚合卡渲染', () => {
  it('payload.subagent 事件进 Agents 聚合不进 Chat 流;卡(label/状态徽标/tokens/currentTool/running 点)+ 点卡展开 mini 转录', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, ev('tool-call', 'write', { subagent: 'searcher', input: { path: 'src/a.ts' }, callId: 'c1' }));
    fire(conn, ev('token', '分析中', { subagent: 'searcher' }));
    fire(conn, ev('usage', undefined, { subagent: 'searcher', turnTotal: 1200 }));
    // Chat 主流零污染:子代理事件另一轨(无工具条/无流式条)
    expect(document.querySelector('.entry-tool')).toBeNull();
    expect(document.querySelector('.entry-assistant')).toBeNull();
    // 「+」菜单开 Agents 标签(session 组单例):标签开且活动
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agents' }));
    expect(document.querySelector('.sx-tab[title="Agents"]')?.classList.contains('active')).toBe(true);
    expect(screen.getByLabelText('agents tab')).toBeDefined();
    // 卡面:label + running 徽标 + tokens + currentTool 行 + accent 动画点类
    expect(screen.getByText('searcher')).toBeDefined();
    expect(screen.getByText('运行中')).toBeDefined();
    expect(screen.getByText('1200 tokens')).toBeDefined();
    expect(screen.getByText('write')).toBeDefined();
    expect(document.querySelector('.sx-subagent-dot')).not.toBeNull();
    // 点卡头展开:mini 转录(工具行 + token 行,等宽渲染)
    expect(document.querySelector('.sx-subagent-lines')).toBeNull(); // 折叠态
    fireEvent.click(screen.getByRole('button', { name: 'agent card searcher' }));
    expect(screen.getByText(/write src\/a\.ts/)).toBeDefined();
    expect(document.querySelector('.sx-subagent-lines')?.textContent).toContain('分析中');
    unmount();
  });

  it('status 流转与清板:delegation-ended failed → 失败徽标(running 点退场);onResetSession 清卡回空态', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, ev('token', 'x', { subagent: 'reviewer' }));
    fire(conn, ev('delegation-ended', undefined, { label: 'reviewer', delegationId: 'reviewer', kind: 'subagent', status: 'failed' }));
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agents' }));
    expect(screen.getByText('reviewer')).toBeDefined();
    expect(screen.getByText('失败')).toBeDefined();
    expect(document.querySelector('.sx-subagent-dot')).toBeNull(); // 非 running:动画点退场
    // 本会话 reset:卡区清空(空态文案;他会话 reset 不清)
    fireResetSession(conn, 's9');
    expect(screen.getByText('reviewer')).toBeDefined();
    fireResetSession(conn, 's1');
    await waitFor(() => expect(screen.getByText('暂无子 agent 活动')).toBeDefined());
    unmount();
  });

  it('他会话子代理帧不进聚合(sessionRef 过滤在聚合面前)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fireOther(conn, ev('token', '他会话子代理', { subagent: 'ghost' }));
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agents' }));
    expect(screen.getByText('暂无子 agent 活动')).toBeDefined();
    unmount();
  });
});

describe('G8d Web 标签:url 输入开档/scheme 补全/判重/外开/刷新重挂', () => {
  /** +菜单开 web(tools 节 'Web' 直调 onOpenType;裸开无 url → 引导面) */
  const openWeb = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Web' }));
  };

  /** url 输入回车开档(active 面) */
  const submitUrl = (url: string): void => {
    fireEvent.change(screen.getByLabelText('web url input'), { target: { value: url } });
    fireEvent.keyDown(screen.getByLabelText('web url input'), { key: 'Enter' });
  };

  it('+菜单开 web → url 输入 example.com 回车 → iframe 在场 title=https://example.com(无 scheme 补全)+ sandbox 四值', async () => {
    const { conn, unmount } = await enterChat();
    openWeb();
    expect(document.querySelector('.sx-tab[title="Web"]')?.classList.contains('active')).toBe(true);
    expect(screen.getByLabelText('web tab')).toBeDefined();
    // 裸开无 active:引导文案在场、无 iframe
    expect(screen.getByText(/输入 URL 回车打开/)).toBeDefined();
    expect(document.querySelector('.sx-web-frame')).toBeNull();
    // 回车开档:无 :// 前缀 → 补 https://(title=规范化 url);沙盒四值原样
    submitUrl('  example.com ');
    const frame = document.querySelector('.sx-web-frame');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('title')).toBe('https://example.com'); // 首尾空白亦去
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin allow-popups');
    expect(frame?.getAttribute('src')).toBe('https://example.com');
    // X-Frame 拒嵌引导文案常驻(iframe 侧)
    expect(screen.getByText(/X-Frame-Options 拒绝内嵌/)).toBeDefined();
    unmount();
  });

  it('同 url 再开判重:url 输入不铸新 params(uid 恒 web:)——+菜单再开仍一条标签且聚焦', async () => {
    const { conn, unmount } = await enterChat();
    openWeb();
    submitUrl('example.com');
    expect(document.querySelector('.sx-web-frame')).not.toBeNull();
    // 切去任务页(web 失活)→ +菜单再开 web:判重聚焦既有(仍一条,不并立)
    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    expect(document.querySelector('.sx-tab[title="Web"]')?.classList.contains('active')).toBe(false);
    openWeb();
    expect(document.querySelectorAll('.sx-tab[title="Web"]')).toHaveLength(1);
    expect(document.querySelector('.sx-tab[title="Web"]')?.classList.contains('active')).toBe(true);
    unmount();
  });

  it('外开钮 → window.open(url, _blank, noopener,noreferrer) 断参', async () => {
    const { conn, unmount } = await enterChat();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      openWeb();
      // 无 active:外开钮不渲染(无可外开目标)
      expect(screen.queryByRole('button', { name: '外开' })).toBeNull();
      submitUrl('example.com');
      fireEvent.click(screen.getByRole('button', { name: '外开' }));
      expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
      expect(openSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
    unmount();
  });

  it('刷新钮:nonce bump → iframe key 变更强制重挂(DOM 节替换,title 不变)', async () => {
    const { conn } = await enterChat();
    openWeb();
    submitUrl('example.com');
    const before = document.querySelector('.sx-web-frame');
    expect(before).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    const after = document.querySelector('.sx-web-frame');
    expect(after).not.toBe(before); // key=`${url}#${nonce}` 变更 → 重挂(新 DOM 节)
    expect(after?.getAttribute('title')).toBe('https://example.com'); // url 未变仅 bump
  });

  it('带 scheme 输入原样:http://localhost:3000 → title 原样(含 :// 不补 https)', async () => {
    const { conn, unmount } = await enterChat();
    openWeb();
    submitUrl('http://localhost:3000');
    expect(document.querySelector('.sx-web-frame')?.getAttribute('title')).toBe('http://localhost:3000');
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
    // G8d T5:⚠ 已 Badge 化(sx-badge-warn span,⚠ 文本在内)——行文本断言剥 ⚠,徽标单独断言
    expect(screen.getByText('t1 [pending] Demo @w1')).toBeDefined(); // 任务页默认在场:板随事件直显
    expect(document.querySelector('.sx-badge.sx-badge-warn')?.textContent).toBe('⚠');
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
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined());
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
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    await screen.findByLabelText('welcome');
    conn.nextSessionId = 's2';
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('s2', { selector: '.chat-title' })).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText(/任务板为空/)).toBeDefined(); // s2 快照空板(而非 s1 残留)
    // —— 重开 s1:快照带板 → onSeeded 回填,任务页即快照权威态(无需事件帧)——
    conn.snapshotResp = snapshotOf({
      board: applyBoardEvent(emptyBoard(), { t: 'task-created', taskId: 't1', title: 'Demo', spec: '', dependsOn: [], ts: 1 }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    await screen.findByLabelText('welcome');
    conn.nextSessionId = 's1';
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined());
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
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined());
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

  it('G8e-T2 播种窗内 delegation 帧补投聚合:buffered delegation-ended(failed) → onSeeded 重放后卡终态 error', async () => {
    const { conn, unmount } = await enterChatHeldBoard();
    // 窗内:子代理帧直投聚合建卡(running);delegation-ended(failed) 入 boardPending 缓冲(不直投)
    fire(conn, ev('token', 'x', { subagent: 'reviewer' }), 1);
    fire(conn, ev('delegation-ended', undefined, { label: 'reviewer', delegationId: 'reviewer', kind: 'subagent', status: 'failed' }), 2);
    conn.releaseSnapshot(); // 种子 lastSeq 0:seq 1/2 > 0 → 重放面
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    // Agents 标签:卡 reviewer 终态 error(失败徽标;running 动画点退场)——重放循环补投聚合生效
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agents' }));
    expect(screen.getByText('reviewer')).toBeDefined();
    expect(screen.getByText('失败')).toBeDefined();
    expect(document.querySelector('.sx-subagent-dot')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'chat actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(conn.deleteSessionCalls).toEqual([]); // 假:不发
    expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined(); // 留在会话
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'chat actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }));
    await waitFor(() => expect(conn.deleteSessionCalls).toEqual(['s1'])); // daemon 会话 id(非 journal id)
    await waitFor(() => expect(screen.getByLabelText('welcome')).toBeDefined()); // onBack → 欢迎空态(会话关窗)
    unmount();
  });

  it('Delete 失败(running 409):error 条示出不静默,留在会话', async () => {
    const { conn, unmount } = await enterChat();
    conn.deleteReject = new Error('/session/s1/delete -> 409');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'chat actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }));
    await waitFor(() => expect(screen.getByText('/session/s1/delete -> 409')).toBeDefined());
    expect(screen.getByText('s1', { selector: '.chat-title' })).toBeDefined();
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

describe('G8c 设置态壳:左栏切换导航/项目上下文/表单引擎/来源徽标/toast', () => {
  /** 通用面板四来源 fixture(env 覆盖/project/global/default 各一)+ 限额面板数字键 */
  const generalRows: SettingsKeyRow[] = [
    { key: 'language', value: 'en', source: 'project', envOverride: false },
    { key: 'shell', value: '/bin/zsh', source: 'env', envOverride: true },
    { key: 'projectsDir', value: '/home/u/projects', source: 'global', envOverride: false },
    { key: 'userSkillsDir', value: null, source: 'default', envOverride: false },
  ];

  /** 打开设置态(从 chat 面:settingsRoot 默认 = openRoot '/w/root-a') */
  const openSettings = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'open settings' }));
  };

  it('设置钮 → 设置态:SettingsShell 在场(项目选择器+四导航项)、右标签栏与 Chat 退场;「← 返回」→ 回会话态(Chat 重挂)', async () => {
    const { conn, unmount } = await enterChat();
    openSettings();
    // 左栏切换:SettingsShell 在场——项目选择器(值=openRoot,选项经 workspaces() 惰拉后落位)+ 四已实现导航项
    expect(screen.getByLabelText('settings project')).toBeDefined();
    await waitFor(() => expect((screen.getByLabelText('settings project') as HTMLSelectElement).value).toBe('/w/root-a'));
    expect(screen.getByRole('button', { name: '通用' })).toBeDefined();
    expect(screen.getByRole('button', { name: '上下文与限额' })).toBeDefined();
    expect(screen.getByRole('button', { name: '记忆' })).toBeDefined();
    expect(screen.getByRole('button', { name: '知识库与搜索' })).toBeDefined();
    // ProjectMenu 退场(组头不在)
    expect(screen.queryByRole('button', GROUP_HEAD)).toBeNull();
    // 右标签栏整体不渲染 + Chat 主区不在(裁定:设置态 Chat 卸载,返回重播种同 backHome 语义)
    expect(document.querySelector('.sx-tabstrip')).toBeNull();
    expect(screen.queryByLabelText('message input')).toBeNull();
    // 返回 → 回会话态:Chat 重新在场(重挂重播种,输入门落定后启用)
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(document.querySelector('.sx-tabstrip')).not.toBeNull();
    await screen.findByRole('button', GROUP_HEAD); // ProjectMenu 重挂,组列表经 workspaces() 重拉
    unmount();
  });

  it('Esc → 回会话态(与返回钮同路径)', async () => {
    const { conn, unmount } = await enterChat();
    openSettings();
    expect(screen.getByLabelText('settings project')).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    unmount();
  });

  it('通用面板:行渲染+来源徽标类名+envOverride 禁编;改动保存 → putSettings 断参(数字键 number 化)+ toast + 重拉', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = settingsViewOf([...generalRows, { key: 'contextWindow', value: '100000', source: 'project', envOverride: false }]);
    openSettings();
    // 面板拉取:settings(root=openRoot)
    // [0]=App 语言同步全局拉取(G10-C3c)
    await waitFor(() => expect(conn.settingsCalls).toEqual(['', '/w/root-a']));
    // 行渲染:值 = 行 value ?? 缺省空(default 行空串)
    expect((screen.getByLabelText('language') as HTMLInputElement).value).toBe('en');
    expect((screen.getByLabelText('userSkillsDir') as HTMLInputElement).value).toBe('');
    // 来源徽标类名:四态各归其位
    expect(document.querySelector('.sx-src-env')).not.toBeNull();
    expect(document.querySelector('.sx-src-project')).not.toBeNull();
    expect(document.querySelector('.sx-src-global')).not.toBeNull();
    expect(document.querySelector('.sx-src-default')).not.toBeNull();
    // envOverride 行禁编 + title 说明
    expect((screen.getByLabelText('shell') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByLabelText('shell').title).toBe('env 覆盖中,改文件不生效');
    // 空改动:保存禁用
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    // 改 project 行值 → 保存 → putSettings(root, {改键:新值})
    fireEvent.change(screen.getByLabelText('language'), { target: { value: 'zh-CN' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(conn.putSettingsCalls).toEqual([['/w/root-a', { language: 'zh-CN' }]]));
    // toast 出现(sx-toast,3s 自隐——测试窗内恒在场)
    expect(screen.getByText('已生效:新建会话起')).toBeDefined();
    expect(document.querySelector('.sx-toast')).not.toBeNull();
    // 保存成功后重拉 settings
    await waitFor(() => expect(conn.settingsCalls).toEqual(['', '/w/root-a', '/w/root-a']));
    // 切「上下文与限额」面板:数字键改动保存 → number 化(非字符串)
    fireEvent.click(screen.getByRole('button', { name: '上下文与限额' }));
    await screen.findByLabelText('contextWindow');
    fireEvent.change(screen.getByLabelText('contextWindow'), { target: { value: '200000' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(conn.putSettingsCalls).toEqual([['/w/root-a', { language: 'zh-CN' }], ['/w/root-a', { contextWindow: 200000 }]]));
    unmount();
  });

  it('保存失败(400):行内错误条原文示出(不静默)', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = settingsViewOf(generalRows);
    conn.putSettingsReject = new Error('/settings -> 400 unknown key');
    openSettings();
    await screen.findByLabelText('projectsDir');
    fireEvent.change(screen.getByLabelText('projectsDir'), { target: { value: 'x' } }); // 自由文本键(G10 枚举键已下拉化;shell 行 env 覆盖禁编)
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByText('/settings -> 400 unknown key')).toBeDefined());
    unmount();
  });

  it('项目选择器切换:root 变 → 面板重拉 settings(仅全局 = 无 root 参)', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = settingsViewOf(generalRows);
    openSettings();
    // [0]=App 语言同步全局拉取(G10-C3c)
    await waitFor(() => expect(conn.settingsCalls).toEqual(['', '/w/root-a']));
    // 切「(仅全局)」:root='' → settings() 无 root 参(FakeConn 记 '')
    fireEvent.change(screen.getByLabelText('settings project'), { target: { value: '' } });
    await waitFor(() => expect(conn.settingsCalls).toEqual(['', '/w/root-a', '']));
    // 切回项目:root 复位
    fireEvent.change(screen.getByLabelText('settings project'), { target: { value: '/w/root-a' } });
    await waitFor(() => expect(conn.settingsCalls).toEqual(['', '/w/root-a', '', '/w/root-a']));
    unmount();
  });

  it('G8e-T2 load 代守卫:root 快切后陈旧慢应答弃——终态=新 root 值(旧应答不覆写)', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = settingsViewOf([{ key: 'language', value: 'slow-a', source: 'project', envOverride: false }]);
    conn.holdSettings(); // A(项目 root)首笔应答悬挂(单发门:后续直通)
    openSettings();
    // [0]=App 语言同步全局拉取(G10-C3c)
    await waitFor(() => expect(conn.settingsCalls).toEqual(['', '/w/root-a']));
    // 快切「(仅全局)」:B 应答直通落定(fast-b)
    conn.settingsView = settingsViewOf([{ key: 'language', value: 'fast-b', source: 'global', envOverride: false }]);
    fireEvent.change(screen.getByLabelText('settings project'), { target: { value: '' } });
    await waitFor(() => expect((screen.getByLabelText('language') as HTMLInputElement).value).toBe('fast-b'));
    // A 迟到落定:陈旧代弃——终态仍 fast-b(无守卫则被 slow-a 覆写)
    await act(async () => {
      conn.releaseSettings();
    });
    expect(conn.settingsCalls).toEqual(['', '/w/root-a', '']);
    expect((screen.getByLabelText('language') as HTMLInputElement).value).toBe('fast-b');
    unmount();
  });

  it('记忆面板:概览行 memoryStats 只读展示「N 条记忆·最近 X」', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = settingsViewOf([{ key: 'autoMemory', value: 'on', source: 'default', envOverride: false }]);
    conn.memoryStatsResp = { entries: 12, lastWriteAt: Date.now() - 60_000 };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '记忆' }));
    // 概览行数据源:memoryStats(root)
    await waitFor(() => expect(conn.memoryStatsCalls).toEqual(['/w/root-a']));
    await waitFor(() => expect(screen.getByText(/12 条记忆/)).toBeDefined());
    expect(screen.getByText(/最近/)).toBeDefined();
    // 面板行照常(键行 + 保存)
    expect((screen.getByLabelText('autoMemory') as HTMLInputElement).value).toBe('on');
    unmount();
  });
});

describe('G8c 复杂面板五件:模型与提供方/MCP/智能体/技能+权限/高级 raw', () => {
  const openSettings = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'open settings' }));
  };

  it('模型与提供方:模型键表单行在场(SettingsForm 复用)+ providers 只读两卡(apiKeyPresent 点类名/槽名 title)+ warnings 行', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = settingsViewOf(
      [
        { key: 'model', value: 'gpt-x', source: 'project', envOverride: false },
        { key: 'baseUrl', value: 'https://api.example.com', source: 'global', envOverride: false },
      ],
      {
        providers: {
          choices: [
            { id: 'main', provider: 'openai', model: 'gpt-5', baseUrl: 'https://a', apiKeyEnv: 'OPENAI_API_KEY' },
            { id: 'aux', provider: 'anthropic', model: 'claude-x', baseUrl: 'https://b', apiKeyEnv: 'ANTHROPIC_API_KEY' },
          ],
          apiKeyPresent: { openai: true, anthropic: false },
          warnings: ['anthropic: api key missing'],
        },
      },
    );
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '模型与提供方' }));
    // 上:模型键表单引擎复用(行 = daemon 报键面;未报键行省略)
    await screen.findByLabelText('model');
    expect((screen.getByLabelText('model') as HTMLInputElement).value).toBe('gpt-x');
    expect((screen.getByLabelText('baseUrl') as HTMLInputElement).value).toBe('https://api.example.com');
    // 下:providers 只读卡两枚 + api key 圆点类名(绿=在场/灰=缺)+ 槽名 title
    await waitFor(() => expect(screen.getByText('gpt-5')).toBeDefined());
    expect(screen.getByText('claude-x')).toBeDefined();
    expect(document.querySelector('.sx-api-dot.present')).not.toBeNull();
    expect((document.querySelector('.sx-api-dot.missing') as HTMLElement | null)?.title).toBe('ANTHROPIC_API_KEY');
    expect(screen.getByText('anthropic: api key missing')).toBeDefined();
    unmount();
  });

  it('MCP:两级清单卡(shadowed 灰显+遮蔽标+envKeys 打码)+ 测试连接 ok:false error 行内 + 添加表单 putMcpServers 整块提交', async () => {
    const { conn, unmount } = await enterChat();
    conn.mcpServersResp = {
      servers: [
        { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-fs'], envKeys: ['MCP_FS_TOKEN'], source: 'project', shadowed: false },
        { name: 'fs', transport: 'http', url: 'https://global/fs', envKeys: [], source: 'global', shadowed: true },
        { name: 'web', transport: 'sse', url: 'https://global/web', envKeys: [], source: 'global', shadowed: false },
      ],
    };
    conn.mcpProbeResp = { ok: false, error: 'connect timeout after 10s' };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'MCP' }));
    await waitFor(() => expect(conn.mcpServersCalls).toEqual(['/w/root-a']));
    // shadowed 全局卡灰显 + 「被项目遮蔽」标 + env 键名列表(值打码不回传)
    expect(document.querySelector('.sx-mcp-card.shadowed')).not.toBeNull();
    expect(screen.getByText('被项目遮蔽')).toBeDefined();
    expect(screen.getByText('MCP_FS_TOKEN')).toBeDefined();
    // shadowed 全局卡:删除钮禁用(写面恒项目级)
    expect((screen.getByRole('button', { name: '删除 fs(全局)' }) as HTMLButtonElement).disabled).toBe(true);
    // 测试连接 → mcpProbe(root, name);ok:false → 卡内 error 文本行
    fireEvent.click(screen.getByRole('button', { name: '测试连接 web' }));
    await waitFor(() => expect(conn.mcpProbeCalls).toEqual([['/w/root-a', 'web']]));
    await waitFor(() => expect(screen.getByText('connect timeout after 10s')).toBeDefined());
    // + 添加服务器:表单 → 保存 = putMcpServers(root, 现项目清单 + 新机;全局卡不入清单)
    fireEvent.click(screen.getByRole('button', { name: '+ 添加服务器' }));
    fireEvent.change(screen.getByLabelText('mcp name'), { target: { value: 'search' } });
    fireEvent.change(screen.getByLabelText('mcp command'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByLabelText('mcp args'), { target: { value: '-y, mcp-search' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(conn.putMcpServersCalls).toEqual([
        [
          '/w/root-a',
          [
            { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-fs'] },
            { name: 'search', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-search'] },
          ],
        ],
      ]),
    );
    await waitFor(() => expect(conn.mcpServersCalls).toEqual(['/w/root-a', '/w/root-a'])); // 保存后重拉
    unmount();
  });

  it('MCP:删除项目卡 → putMcpServers 清单减一', async () => {
    const { conn, unmount } = await enterChat();
    conn.mcpServersResp = {
      servers: [
        { name: 'fs', transport: 'stdio', command: 'npx', envKeys: [], source: 'project', shadowed: false },
        { name: 'web', transport: 'sse', url: 'https://g/web', envKeys: [], source: 'global', shadowed: false },
      ],
    };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'MCP' }));
    await screen.findByText('fs');
    fireEvent.click(screen.getByRole('button', { name: '删除 fs(项目)' }));
    await waitFor(() => expect(conn.putMcpServersCalls).toEqual([['/w/root-a', []]])); // 全局卡不入项目清单
    await waitFor(() => expect(conn.mcpServersCalls).toEqual(['/w/root-a', '/w/root-a']));
    unmount();
  });

  it('MCP 修复环 C1:编辑带 envKeys 卡不改 env(勾选确认移除)→ 断参服务器行无 env 键;填 KEY=v → env 含全值', async () => {
    const { conn, unmount } = await enterChat();
    conn.mcpServersResp = {
      servers: [{ name: 'fs', transport: 'stdio', command: 'npx', envKeys: ['MCP_FS_TOKEN'], source: 'project', shadowed: false }],
    };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'MCP' }));
    await screen.findByText('fs');
    // 编辑:env 预填「KEY=」空值行(值视图打码不可知)——不改 env 直接保存:env 丢失确认门拦
    // (终审 B:未勾选确认→保存 disabled;勾选=显式确认丢键)→ 空值条目跳过,行无 env 键
    // (daemon 原样写盘——env:{KEY:''} 空值坏文件的根除判据)
    fireEvent.click(screen.getByRole('button', { name: '编辑 fs(项目)' }));
    expect((screen.getByLabelText('mcp env') as HTMLTextAreaElement).value).toBe('MCP_FS_TOKEN=');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true); // 未勾选确认:保存禁用
    fireEvent.click(screen.getByLabelText('confirm env drop'));
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(conn.putMcpServersCalls).toEqual([['/w/root-a', [{ name: 'fs', transport: 'stdio', command: 'npx' }]]]));
    // 重填值保存 → env 含 {KEY:'v'}(全值回写;原键全覆盖→确认门不出现)
    await waitFor(() => expect(conn.mcpServersCalls).toEqual(['/w/root-a', '/w/root-a'])); // 保存后重拉落定
    fireEvent.click(screen.getByRole('button', { name: '编辑 fs(项目)' }));
    fireEvent.change(screen.getByLabelText('mcp env'), { target: { value: 'MCP_FS_TOKEN=v' } });
    expect(screen.queryByLabelText('confirm env drop')).toBeNull(); // 无键将丢失:确认 checkbox 不渲染
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(conn.putMcpServersCalls).toEqual([
        ['/w/root-a', [{ name: 'fs', transport: 'stdio', command: 'npx' }]],
        ['/w/root-a', [{ name: 'fs', transport: 'stdio', command: 'npx', env: { MCP_FS_TOKEN: 'v' } }]],
      ]),
    );
    unmount();
  });

  it('MCP 终审 B:编辑带 2 envKeys 卡不动 env → 保存 disabled;勾选确认 → putMcp 调用且 env 缺席;重填 1 键+勾选 → env 含该 1 键', async () => {
    const { conn, unmount } = await enterChat();
    conn.mcpServersResp = {
      servers: [{ name: 'fs', transport: 'stdio', command: 'npx', envKeys: ['K1', 'K2'], source: 'project', shadowed: false }],
    };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'MCP' }));
    await screen.findByText('fs');
    fireEvent.click(screen.getByRole('button', { name: '编辑 fs(项目)' }));
    // 2 键均未重填:确认 checkbox 在场(计数=2)+ 保存 disabled + 零写调用(静默丢 env 根除)
    expect(screen.getByText('确认移除未重填的 2 个 env 键')).toBeDefined();
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    expect(conn.putMcpServersCalls).toEqual([]);
    // 勾选确认 → 放行:putMcpServers 调用且断参行 env 缺席
    fireEvent.click(screen.getByLabelText('confirm env drop'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(conn.putMcpServersCalls).toEqual([['/w/root-a', [{ name: 'fs', transport: 'stdio', command: 'npx' }]]]));
    // 重填 1 键(另 1 键仍将丢失→checkbox 计 1+仍须勾选)→ env 恰含该 1 键
    await waitFor(() => expect(conn.mcpServersCalls).toEqual(['/w/root-a', '/w/root-a'])); // 保存后重拉落定
    fireEvent.click(screen.getByRole('button', { name: '编辑 fs(项目)' }));
    fireEvent.change(screen.getByLabelText('mcp env'), { target: { value: 'K1=v1' } });
    expect(screen.getByText('确认移除未重填的 1 个 env 键')).toBeDefined();
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('confirm env drop'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(conn.putMcpServersCalls).toEqual([
        ['/w/root-a', [{ name: 'fs', transport: 'stdio', command: 'npx' }]],
        ['/w/root-a', [{ name: 'fs', transport: 'stdio', command: 'npx', env: { K1: 'v1' } }]],
      ]),
    );
    unmount();
  });

  it('MCP 修复环 I2:全局卡(含被遮蔽)编辑钮禁用 + title 引流 raw;项目卡编辑钮可用', async () => {
    const { conn, unmount } = await enterChat();
    conn.mcpServersResp = {
      servers: [
        { name: 'fs', transport: 'stdio', command: 'npx', envKeys: [], source: 'project', shadowed: false },
        { name: 'fs', transport: 'http', url: 'https://g/fs', envKeys: [], source: 'global', shadowed: true },
        { name: 'web', transport: 'sse', url: 'https://g/web', envKeys: [], source: 'global', shadowed: false },
      ],
    };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'MCP' }));
    await screen.findByText('web');
    // 全局卡(未遮蔽/被遮蔽)编辑钮均禁用——写面恒项目级(编辑全局会替换项目同名卡,错路径根除);
    // title 同删除钮口径:全局级经高级 raw 编辑
    for (const label of ['编辑 fs(全局)', '编辑 web(全局)']) {
      const btn = screen.getByRole('button', { name: label }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.title).toBe('全局级经高级 raw 编辑');
    }
    // 项目卡编辑钮不受染(可用)
    expect((screen.getByRole('button', { name: '编辑 fs(项目)' }) as HTMLButtonElement).disabled).toBe(false);
    unmount();
  });

  it('MCP 修复环 M4:表单在途时项目选择器清空 root → 保存放行空 root(服务端 400 示出,不静默 return)', async () => {
    const { conn, unmount } = await enterChat();
    conn.mcpServersResp = { servers: [] };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'MCP' }));
    await waitFor(() => expect(conn.mcpServersCalls).toEqual(['/w/root-a']));
    // 开表单后项目选择器切「(仅全局)」:已开表单的保存不再静默——请求带空 root 发出(真链路服务端
    // 400 root required → 行内错误条;AgentsPane 同口径)
    fireEvent.click(screen.getByRole('button', { name: '+ 添加服务器' }));
    fireEvent.change(screen.getByLabelText('mcp name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('mcp command'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByLabelText('settings project'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(conn.putMcpServersCalls).toEqual([['', [{ name: 'x', transport: 'stdio', command: 'npx' }]]]));
    unmount();
  });

  it('智能体:builtins 四预设位 + 清单卡(chips/遮蔽/warnings)+ 新增表单 putAgent upsert 断参 + 删除 op:delete', async () => {
    const { conn, unmount } = await enterChat();
    conn.agentsViewResp = {
      builtins: [
        { role: 'builder', name: '构建者', framing: '实现计划步骤' },
        { role: 'reviewer', name: '评审者', framing: '评审交付质量' },
      ],
      view: {
        entries: [
          { id: 'dev', name: '开发者', description: '写代码', memory: true, isolation: 'workspace', executor: 'local', source: 'project', shadowed: false, bodyPreview: '你是项目内开发者。' },
          { id: 'dev', name: '全局开发者', source: 'global', shadowed: true, bodyPreview: '全局版。' },
        ],
        warnings: ['agents/broken/agent.md: frontmatter parse failed'],
      },
    };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '智能体' }));
    await waitFor(() => expect(conn.agentsViewCalls).toEqual(['/w/root-a']));
    // builtins 只读卡(role/name/framing)
    expect(screen.getByText('构建者')).toBeDefined();
    expect(screen.getByText('builder')).toBeDefined();
    // entries 卡:属性 chips + shadowed 灰显 + 畸形文件告警卡
    expect(screen.getByText('开发者')).toBeDefined();
    expect(screen.getByText('memory')).toBeDefined();
    expect(screen.getByText('isolation:workspace')).toBeDefined();
    expect(screen.getByText('executor:local')).toBeDefined();
    expect(document.querySelector('.sx-agent-card.shadowed')).not.toBeNull();
    expect(screen.getByText(/frontmatter parse failed/)).toBeDefined();
    // + 新增 → putAgent upsert(root/scope/op/frontmatter 形/body)
    fireEvent.click(screen.getByRole('button', { name: '+ 新增' }));
    fireEvent.change(screen.getByLabelText('agent id'), { target: { value: 'writer' } });
    fireEvent.change(screen.getByLabelText('agent name'), { target: { value: '写手' } });
    fireEvent.change(screen.getByLabelText('agent description'), { target: { value: '写文档' } });
    fireEvent.click(screen.getByLabelText('agent memory'));
    fireEvent.change(screen.getByLabelText('agent body'), { target: { value: '正文内容' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(conn.putAgentCalls).toEqual([
        { root: '/w/root-a', scope: 'project', op: 'upsert', id: 'writer', frontmatter: { name: '写手', description: '写文档', memory: true }, body: '正文内容' },
      ]),
    );
    await waitFor(() => expect(conn.agentsViewCalls).toEqual(['/w/root-a', '/w/root-a'])); // 保存后重拉
    // 删除 → putAgent op:'delete'(scope = 卡 source)
    fireEvent.click(screen.getByRole('button', { name: '删除 dev(项目)' }));
    await waitFor(() => expect(conn.putAgentCalls).toHaveLength(2));
    expect(conn.putAgentCalls[1]).toEqual({ root: '/w/root-a', scope: 'project', op: 'delete', id: 'dev' });
    unmount();
  });

  it('智能体终审 A:编辑 bodyPreview 恰 200 字卡不改正文保存 → 截断守卫阻断(错误条+putAgent 未调);改写正文 → 放行', async () => {
    const { conn, unmount } = await enterChat();
    conn.agentsViewResp = {
      builtins: [],
      view: { entries: [{ id: 'dev', name: '开发者', source: 'project', shadowed: false, bodyPreview: 'x'.repeat(200) }], warnings: [] },
    };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '智能体' }));
    await waitFor(() => expect(conn.agentsViewCalls).toEqual(['/w/root-a']));
    fireEvent.click(screen.getByRole('button', { name: '编辑 dev(项目)' }));
    // 不改正文(仍=播种的 200 字预览切片)直接保存 → 守卫阻断:行内错误条 + putAgent 未调
    // (直接保存即把截断文写盘毁掉余文——GUI 本地守卫根除)
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByText(/已被预览截断/)).toBeDefined());
    expect(screen.getByText(/agents\/dev\/agent\.md/)).toBeDefined(); // 提示指明完整原文兜底路径
    expect(conn.putAgentCalls).toEqual([]);
    // 改写正文(≠播种值)= 有意重写 → 放行(body=改写文)
    fireEvent.change(screen.getByLabelText('agent body'), { target: { value: '改写后的完整正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(conn.putAgentCalls).toHaveLength(1));
    expect(conn.putAgentCalls[0]).toMatchObject({ root: '/w/root-a', scope: 'project', op: 'upsert', id: 'dev', body: '改写后的完整正文' });
    unmount();
  });

  it('智能体 G8d 全文装载:编辑钮 → conn.agentBody(source,id,root) 播种全文(≥200 不再触发截断守卫);失败回退 bodyPreview+行内提示(守卫兜底)', async () => {
    const { conn, unmount } = await enterChat();
    const preview = 'x'.repeat(200); // 恰触预览帽:全文装载成功前守卫本会拦截
    conn.agentsViewResp = {
      builtins: [],
      view: { entries: [{ id: 'dev', name: '开发者', source: 'project', shadowed: false, bodyPreview: preview }], warnings: [] },
    };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '智能体' }));
    await waitFor(() => expect(conn.agentsViewCalls).toEqual(['/w/root-a']));
    // —— 全文装载成功:编辑 → agentBody('project','dev','/w/root-a') → 正文=全文;未改保存放行 ——
    const full = `${'全文正文行。'.repeat(60)}收尾`;
    conn.agentBodyResp = { body: full };
    fireEvent.click(screen.getByRole('button', { name: '编辑 dev(项目)' }));
    await waitFor(() => expect(conn.agentBodyCalls).toEqual([['project', 'dev', '/w/root-a']]));
    await waitFor(() => expect((screen.getByLabelText('agent body') as HTMLTextAreaElement).value).toBe(full));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(conn.putAgentCalls).toHaveLength(1));
    expect(conn.putAgentCalls[0]).toMatchObject({ root: '/w/root-a', scope: 'project', op: 'upsert', id: 'dev', body: full });
    // —— 失败面:回退 bodyPreview + 行内提示;截断守卫兜底(未改正文保存阻断,零写) ——
    conn.agentBodyResp = null;
    conn.agentBodyReject = new Error('/settings/agents/body?scope=project&id=dev -> 404');
    fireEvent.click(screen.getByRole('button', { name: '编辑 dev(项目)' }));
    await waitFor(() => expect(conn.agentBodyCalls).toHaveLength(2));
    await waitFor(() => expect(screen.getByText(/已回退预览/)).toBeDefined());
    expect((screen.getByLabelText('agent body') as HTMLTextAreaElement).value).toBe(preview);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByText(/已被预览截断/)).toBeDefined());
    expect(conn.putAgentCalls).toHaveLength(1); // 守卫兜底:失败回退面未再写盘
    unmount();
  });

  it('技能+权限:三源分组只读行 + permissions 三列(merged/project/global)渲染', async () => {
    const { conn, unmount } = await enterChat();
    conn.skillsGroupsResp = {
      groups: [
        { source: 'project', skills: [{ id: 'proj-skill', name: '项目技能', description: '项目内装载' }] },
        { source: 'user', skills: [{ id: 'user-skill', description: '用户目录技能' }] },
        { source: 'learned', skills: [{ id: 'learned-skill' }] },
      ],
    };
    conn.settingsView = settingsViewOf([], {
      permissions: {
        merged: { deny: ['Bash(rm *)'], allow: ['Read'], additionalDirs: ['/tmp/x'] },
        project: { deny: ['Bash(rm *)'], allow: [], additionalDirs: [] },
        global: { deny: [], allow: ['Read'], additionalDirs: ['/tmp/x'] },
      },
    });
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '插件:技能' }));
    await waitFor(() => expect(conn.skillsGroupsCalls).toEqual(['/w/root-a']));
    // 三源分组(组标 + 行 id + description)
    expect(document.querySelector('.sx-skills-src-project')).not.toBeNull();
    expect(document.querySelector('.sx-skills-src-user')).not.toBeNull();
    expect(document.querySelector('.sx-skills-src-learned')).not.toBeNull();
    expect(screen.getByText('proj-skill')).toBeDefined();
    expect(screen.getByText('user-skill')).toBeDefined();
    expect(screen.getByText('learned-skill')).toBeDefined();
    // 权限三列:级别徽标 ×3 + deny/allow/additionalDirs 行(合并列 + 层级列各一现)
    expect(document.querySelectorAll('.sx-perm-level')).toHaveLength(3);
    expect(screen.getAllByText('Bash(rm *)')).toHaveLength(2);
    expect(screen.getAllByText('Read')).toHaveLength(2);
    expect(screen.getAllByText('/tmp/x')).toHaveLength(2);
    unmount();
  });

  it('高级 raw:读取装载 textarea + 保存失败(400)行内错误原文 + 成功 toast', async () => {
    const { conn, unmount } = await enterChat();
    conn.rawResp = { content: '{\n  "language": "zh"\n}\n' };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '高级' }));
    // 读取:settingsRaw(scope=project, root, file=settings) → textarea 装载原文
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect(conn.settingsRawCalls).toEqual([['project', '/w/root-a', 'settings']]));
    expect((screen.getByLabelText('raw editor') as HTMLTextAreaElement).value).toContain('"language": "zh"');
    // 保存失败(服务端 400 解析错误原文)→ 行内错误条
    conn.putSettingsRawReject = new Error('/settings/raw -> 400 Unexpected token } in JSON');
    fireEvent.change(screen.getByLabelText('raw editor'), { target: { value: '{ bad' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }));
    await waitFor(() => expect(screen.getByText('/settings/raw -> 400 Unexpected token } in JSON')).toBeDefined());
    // 成功 → toast(FakeConn 拒面不记调用:仅成功笔在账——[scope, root, file, content])
    conn.putSettingsRawReject = null;
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }));
    await waitFor(() => expect(screen.getByText(/已保存:新建会话起/)).toBeDefined());
    expect(conn.putSettingsRawCalls).toEqual([['project', '/w/root-a', 'settings', '{ bad']]);
    unmount();
  });

  it('高级 raw 修复环 I3:读取后切 scope/file → content/错误/toast 清回未读取态,保存钮 disabled(陈旧不跨目标写)', async () => {
    const { conn, unmount } = await enterChat();
    conn.rawResp = { content: '{\n  "language": "zh"\n}\n' };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '高级' }));
    // 初始未读取态:保存禁用(先「读取」)
    expect((screen.getByRole('button', { name: '验证并保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect((screen.getByLabelText('raw editor') as HTMLTextAreaElement).value).toContain('"language": "zh"'));
    expect((screen.getByRole('button', { name: '验证并保存' }) as HTMLButtonElement).disabled).toBe(false);
    // 切 scope → 回未读取态:content 清空(placeholder 提示先读取)+ 保存禁用
    fireEvent.change(screen.getByLabelText('raw scope'), { target: { value: 'global' } });
    expect((screen.getByLabelText('raw editor') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByRole('button', { name: '验证并保存' }) as HTMLButtonElement).disabled).toBe(true);
    // 重新读取 → 再切 file 维:同款清空+禁用(陈旧内容不得写进另一目标文件)
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect((screen.getByLabelText('raw editor') as HTMLTextAreaElement).value).toContain('"language": "zh"'));
    fireEvent.change(screen.getByLabelText('raw file'), { target: { value: 'mcp' } });
    expect((screen.getByLabelText('raw editor') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByRole('button', { name: '验证并保存' }) as HTMLButtonElement).disabled).toBe(true);
    // 未读取态点击保存:零 putSettingsRaw(A 目标内容写进 B 目标的跨目标错写根除)
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }));
    expect(conn.putSettingsRawCalls).toEqual([]);
    unmount();
  });

  it('G8e 终审 A read 代守卫:慢读在途切目标 → 迟到应答弃——不置 loaded/内容不装载/保存仍禁', async () => {
    const { conn, unmount } = await enterChat();
    conn.rawResp = { content: '{\n  "language": "zh"\n}\n' }; // A 目标(项目 settings)内容——迟到面
    conn.holdRaw(); // A 首笔读取应答悬挂(单发门:后续直通)
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '高级' }));
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect(conn.settingsRawCalls).toEqual([['project', '/w/root-a', 'settings']]));
    // 在途窗切 scope(→global,resetUnread):同步回未读取态
    fireEvent.change(screen.getByLabelText('raw scope'), { target: { value: 'global' } });
    expect((screen.getByLabelText('raw editor') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByRole('button', { name: '验证并保存' }) as HTMLButtonElement).disabled).toBe(true);
    // A 迟到应答落定:陈旧代弃——不置 loaded/不装内容(无守卫则 loaded=true + A 内容入 B 目标)
    await act(async () => {
      conn.releaseRaw();
    });
    expect((screen.getByLabelText('raw editor') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByRole('button', { name: '验证并保存' }) as HTMLButtonElement).disabled).toBe(true);
    // 保存点击零发:陈旧内容不写 B 目标(global settings)
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }));
    expect(conn.putSettingsRawCalls).toEqual([]);
    unmount();
  });

  it('G8e-T2 scope 回落:项目上下文在(=project)→ 切「(仅全局)」→ scope 自动回落 global(project 选项禁,不滞留)', async () => {
    const { conn, unmount } = await enterChat();
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '高级' }));
    // 初始:有项目上下文 → scope=project
    expect((await screen.findByLabelText('raw scope') as HTMLSelectElement).value).toBe('project');
    // root → '':scope 不滞留已禁选的 project——自动回落 global
    fireEvent.change(screen.getByLabelText('settings project'), { target: { value: '' } });
    await waitFor(() => expect((screen.getByLabelText('raw scope') as HTMLSelectElement).value).toBe('global'));
    expect(
      ((screen.getByLabelText('raw scope') as HTMLSelectElement).querySelector('option[value="project"]') as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    unmount();
  });

  it('G8d T5 高级 raw:退役键/未知键告警透出(GET /settings warnings 逐行渲染,role=alert)', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = {
      ...settingsViewOf([]),
      warnings: ['settings: 未知语义键 "nope"，已忽略', 'settings: dataDir 须走 projectsDir（按工作区分目录隔离）'],
    };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: '高级' }));
    // 挂载即拉 settings(root)(告警与所选 scope 无关——两级文件整面透出)
    await waitFor(() => expect(conn.settingsCalls).toContain('/w/root-a'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('未知语义键 "nope"');
    expect(alert.textContent).toContain('dataDir 须走 projectsDir');
    expect(document.querySelector('.sx-raw-warnings')).not.toBeNull();
    unmount();
  });
});
