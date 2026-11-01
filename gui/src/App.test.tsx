import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// monaco 真渲染需要浏览器布局——jsdom 挂 stub(内容经 DiffPanel 根 data-* 断言)
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
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { SessionEvent } from '../../src/types';
import { App } from './App';
import { setLanguage } from './i18n';
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

/** 双语容忍正解(D37 家族):产品面 t() 化后,测试环境钉 en(setLanguage('en')),单语 zh 钉必脆
 *  (语言切换用例先行即破)——可访问名/可见文案断言一律双语 regex,zh|en 任一渲染态都过;字面经 regex 元字符转义 */
const bi = (en: string, zh: string): RegExp =>
  new RegExp(`^(?:${[en, zh].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);


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
    /** G14.113 分支面桩:ProjectMenu/WelcomeComposer 装配即拉,缺法=未处理 rejection 连坐全文件 */
    gitBranches(): Promise<{ current: string; branches: string[] }> {
      return Promise.resolve({ current: 'main', branches: ['main'] });
    }
    gitCheckout(): Promise<void> { return Promise.resolve(); }
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
    boardStopCalls: Array<[string, string]> = [];
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
     *  (仅全局)记 ''(与有值 root 分异的断言面);putSettings 记 [scope, root 归一 '', updates]
     *  + 可编程拒(设置重构轮:逐项写回来源文件——global/project 双桶);memoryStats 同 settings
     *  形(记忆面板概览行数据源) */
    settingsView: SettingsView = settingsViewOf([]);
    settingsCalls: string[] = [];
    putSettingsCalls: Array<['project' | 'global', string, Record<string, string | number | null>]> = [];
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
    /** G8c T9 技能面:skillsGroups 应答可编程(缺省空组);调用记录 [root 归一 '', all] */
    skillsGroupsResp: { groups: SkillsGroup[] } = { groups: [] };
    skillsGroupsCalls: Array<[string, boolean]> = [];
    /** G8c T9 raw 面:读取应答/双拒可编程;调用记录 [scope, root 归一 '', file](+content) */
    rawResp: { content: string | null } = { content: null };
    /** G8c MCP raw 面(file='mcp' 应答;与 settings 原文分立——McpPane JSON 编辑窗数据源) */
    rawMcpResp: { content: string | null } = { content: null };
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
      // G14.9 IA:会话只在 RECENTS 列——mock 与 sessionsOf 同源,补 root/slug 供行点击寻址
      return Promise.resolve(this.sessionRows.map((s) => ({ ...s, root: '/w/root-a', slug: 'root-a' })));
    }
    sessionModel(): Promise<{ current: undefined; choices: never[] }> {
      return Promise.resolve({ current: undefined, choices: [] });
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
    attach(sessionId: string, journalId: string): Promise<{ sessionId: string }> {
      this.attachCalls.push([sessionId, journalId]);
      return Promise.resolve({ sessionId }); // 缺省无收编(收编面在 daemon 钉测)
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
    /** 辅助对话页签恢复面:缺省空(测不关心 side 恢复时零页签) */
    sessionSides(_id: string): Promise<Array<{ journalId: string; sessionId?: string; title: string; updatedAt: number }>> {
      return Promise.resolve([]);
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
    boardStop(sessionId: string, taskId: string): Promise<void> {
      this.boardStopCalls.push([sessionId, taskId]);
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
    putSettings(scope: 'project' | 'global', root: string | undefined, updates: Record<string, string | number | null>): Promise<void> {
      if (this.putSettingsReject !== null) return Promise.reject(this.putSettingsReject);
      this.putSettingsCalls.push([scope, root ?? '', updates]);
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
    skillsGroups(root?: string, all?: boolean): Promise<{ groups: SkillsGroup[] }> {
      this.skillsGroupsCalls.push([root ?? '', all === true]);
      return Promise.resolve(this.skillsGroupsResp);
    }
    settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }> {
      this.settingsRawCalls.push([scope, root ?? '', file]);
      if (this.rawReject !== null) return Promise.reject(this.rawReject);
      const gate = this.rawGate;
      this.rawGate = Promise.resolve(); // 单发:只拦 hold 后首发一笔,后续直通
      const resp = file === 'mcp' ? this.rawMcpResp : this.rawResp; // 应答体调用时定格(慢应答迟到仍回旧内容)
      return gate.then(() => resp);
    }
    putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void> {
      if (this.putSettingsRawReject !== null) return Promise.reject(this.putSettingsRawReject);
      this.putSettingsRawCalls.push([scope, root ?? '', file, content]);
      return Promise.resolve();
    }
    /** T25 权限 op 面:PermissionsPane 结构化增删桩(缺省恒成;调用记录供断言) */
    putPermissionOpCalls: Array<{ op: 'add' | 'remove'; scope: 'project' | 'global'; root?: string; list: 'deny' | 'allow' | 'additionalDirs'; value: string }> = [];
    putPermissionOp(input: {
      op: 'add' | 'remove';
      scope: 'project' | 'global';
      root?: string;
      list: 'deny' | 'allow' | 'additionalDirs';
      value: string;
    }): Promise<void> {
      this.putPermissionOpCalls.push(input);
      return Promise.resolve();
    }
    guiState(_id: string): Promise<{ state: unknown }> {
      return Promise.resolve({ state: null }); // G14.2xx 面私有态:测试缺省无盘档
    }
    async saveGuiState(_id: string, _state: object): Promise<void> {}
    appGuiState(): Promise<{ state: unknown }> {
      return Promise.resolve({ state: null }); // 应用级指针档:测试缺省无现场
    }
    async saveAppGuiState(_state: object): Promise<void> {}
    appPins(): Promise<{ pins: Array<{ id: string; root: string; title?: string; updatedAt?: number }> }> {
      return Promise.resolve({ pins: [] }); // 置顶档:测试缺省无钉(ProjectMenu 装配即拉)
    }
    async saveAppPins(_pins: Array<{ id: string; root: string; title?: string; updatedAt?: number }>): Promise<void> {}
    archivedSessions(): Promise<Array<{ id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number }>> {
      return Promise.resolve([]); // 归档清单:测试缺省空
    }
    /** G14.2xx b 影子水合面:测试缺省空行集(子智能体投影恢复无档);可编程面留 shadowResp */
    shadowResp: { events: import('../../src/types').SessionEvent[]; cut: number } = { events: [], cut: 0 };
    shadowEvents(_id: string): Promise<{ events: import('../../src/types').SessionEvent[]; cut: number }> {
      return Promise.resolve(this.shadowResp);
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
// P1 Task 5 起 highlight.ts 导入面为 highlight.js/lib/common——mock 指向同面方能拦截(主入口 mock 已脱钩)
vi.mock('highlight.js/lib/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('highlight.js/lib/common')>();
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
const GROUP_HEAD = { name: 'root-a' }; // G8f 组头可访问名=wsName(basename);2026-10-28 计数徽章移出按钮

/** 左栏真流程进 chat(G8a:ProjectMenu 组头展开 → Attach 两步链(newSession+attach)→ Chat
 *  会话 chip 在场)→ 连接 open + 播种落定(输入启用——seeding 门:基线快照在途时输入禁用) */
/** G14.27:任务页不再默认开——测试经 new tab 菜单显式打开(单例判重,已开即聚焦) */
/** G14.38:缺省折叠——条不在场时先点顶栏「展开侧边栏」(+钮在条上) */
function expandSidebarIfCollapsed(): void {
  // 右栏缺席才点右上窗控簇 [|] 钮(toggle side panel;全局唯一切换钮,点它=展开)
  if (document.querySelector('.sx-sidebar') === null) {
    fireEvent.click(screen.getByRole('button', { name: 'toggle side panel' }));
  }
}

function openTasksTab(): void {
  expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
  fireEvent.click(screen.getByRole('menuitem', { name: bi('Agent teams', '智能体团队') })); // G14.174:看板面迁任务板页签
}

/** 目录树入口(2026-10-27 用户裁定·目录树入左菜单):组行目录钮开左菜单 dirview——
 *  树不再是右栏页签,文件行点击经 onOpenFileFromTree 开 file 页签 */
function openSidebarTree(): void {
  fireEvent.click(screen.getByRole('button', { name: 'open directory ws-root-a' }));
}

async function enterChat(): Promise<{ conn: Conn; unmount: () => void }> {
  const { conn, unmount } = mount();
  fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
  await clickSessionRow();
  await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
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
    expect(screen.queryByText('s1', { selector: '.chat-title-text' })).toBeNull();
  });

  it('左栏 Attach 链 → chat:Chat 页挂载渲染 sessionId(newSession→attach 两步)+ 返回 welcome', async () => {
    const { conn, unmount } = await enterChat();
    // 两步链:Attach = newSession(root) + attach(sessionId, journalId)
    expect(conn.newSessionCalls).toEqual(['/w/root-a']);
    expect(conn.attachCalls).toEqual([['s1', 'j1']]);
    // Chat 页面:会话 chip 在场、占位条退役(T4δ 真组件装配)
    expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined();
    expect(document.querySelector('.session-placeholder')).toBeNull();
    expect(screen.getByLabelText('message input')).toBeDefined();
    // 返回:对话面退场 → 欢迎空态(左栏常驻)
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
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
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    type('s1 目标');
    pressEnter();
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 's1 流内容'));
    expect(conn.sessionSubmitCalls).toEqual([['s1', 's1 目标']]);
    expect(screen.getAllByText('s1 目标')[0]).toBeDefined(); // G14.15:标题回落同文——scope 到用户气泡
    // —— back → welcome(Chat 卸毁:s1 本地态随组件销毁;左栏组仍展开——壳常驻)——
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
    await screen.findByLabelText('welcome');
    // —— s2:FakeConn 下一会话号;组已展开(常驻),会话行直点 ——
    conn.nextSessionId = 's2';
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s2', { selector: '.chat-title-text' })).toBeDefined());
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
    expect(screen.getAllByText('s2 目标')[0]).toBeDefined();
    unmount();
  });
});

describe('应用级导航历史:前进/后退(2026-10-25)', () => {
  it('s1→New chat(welcome)→后退回 s1(零 attach 链——会话常驻直接重开)→前进回 welcome;两端禁用', async () => {
    const { conn, unmount } = await enterChat();
    const navBtn = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
    // s1 为历史起点:后退/前进皆到边界,双钮禁用
    expect(navBtn('nav back').disabled).toBe(true);
    expect(navBtn('nav forward').disabled).toBe(true);
    // 菜单开着:钮对驻菜单头(2026-10-25 用户裁定),顶栏无副本
    expect(document.querySelector('.sx-menu-head .sx-navbtns')).not.toBeNull();
    expect(document.querySelector('.chat-topbar .sx-navbtns')).toBeNull();
    // New chat → welcome(记 welcome 位);菜单仍开——收起菜单,浮出簇(导航钮对)显形
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
    await screen.findByLabelText('welcome');
    fireEvent.click(screen.getByRole('button', { name: 'collapse menu' }));
    await waitFor(() => expect(document.querySelector('.sx-welcome-nav')).not.toBeNull());
    // 菜单收起:菜单头退场,浮出簇接管(单点不双显)
    expect(document.querySelector('.sx-menu-head')).toBeNull();
    expect(navBtn('nav back').disabled).toBe(false);
    expect(navBtn('nav forward').disabled).toBe(true);
    // 后退:回 s1——不经 newSession/attach(记录的 sessionId 仍常驻 daemon)
    const attachBefore = conn.attachCalls.length;
    const newSessionsBefore = conn.newSessionCalls.length;
    fireEvent.click(navBtn('nav back'));
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
    expect(conn.newSessionCalls.length).toBe(newSessionsBefore);
    expect(conn.attachCalls.length).toBe(attachBefore);
    // 菜单关闭态回会话页:顶栏最左接管
    expect(document.querySelector('.chat-topbar .sx-navbtns')).not.toBeNull();
    expect(navBtn('nav back').disabled).toBe(true);
    expect(navBtn('nav forward').disabled).toBe(false);
    // 前进:回 welcome(菜单关闭态不左栏重开,纯壳层路由)
    fireEvent.click(navBtn('nav forward'));
    await screen.findByLabelText('welcome');
    expect(navBtn('nav forward').disabled).toBe(true);
    unmount();
  });

  it('跨两会话键盘回放(Alt+←/→):s1→welcome→s2 双双后退再前进;回放零 attach;越界按键 no-op', async () => {
    const { conn, unmount } = mount();
    openConn(conn);
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
    await screen.findByLabelText('welcome');
    conn.nextSessionId = 's2';
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s2', { selector: '.chat-title-text' })).toBeDefined());
    // [s1, w, s2]:两步后退落 s1,两步前进回 s2——全经键盘,回放零新 attach
    const keyNav = (key: 'ArrowLeft' | 'ArrowRight'): void => {
      fireEvent.keyDown(window, { key, altKey: true });
    };
    keyNav('ArrowLeft');
    await screen.findByLabelText('welcome');
    keyNav('ArrowLeft');
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
    keyNav('ArrowLeft'); // 越界 no-op
    expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined();
    keyNav('ArrowRight');
    await screen.findByLabelText('welcome');
    keyNav('ArrowRight');
    await waitFor(() => expect(screen.getByText('s2', { selector: '.chat-title-text' })).toBeDefined());
    keyNav('ArrowRight'); // 越界 no-op
    expect(screen.getByText('s2', { selector: '.chat-title-text' })).toBeDefined();
    expect(conn.attachCalls).toEqual([['s1', 'j1'], ['s2', 'j1']]);
    unmount();
  });
});


/** G14.66:悬浮提示统一 data-tip——会话行经 [data-tip=打开会话] 定位 */
async function clickSessionRow(): Promise<void> {
  await waitFor(() => expect(document.querySelectorAll('[data-session-row]').length).toBeGreaterThan(0), { timeout: 5_000 });
  fireEvent.click(document.querySelectorAll('[data-session-row]')[0] as HTMLElement);
}

describe('对话流渲染:会话播种基线 + 事件续推(md/gfm)', () => {
  it('打开会话即播种:snapshotResp.messages 五 kind 直映射渲染(md 裸文直用,P11)', async () => {
    const { conn, unmount } = mount();
    conn.snapshotResp = snapshotOf({
      status: 'running',
      openRun: 1, // P10:status 读内核游标(快照 status 字段退役)
      messages: [
        { seq: 1, ts: 1, kind: 'user', md: 'build the widget' },
        { seq: 2, ts: 2, kind: 'tool', md: '', name: 'read', result: { text: 'ok', ok: true } },
        { seq: 3, ts: 3, kind: 'notice', md: '✻ dev started' },
        { seq: 4, ts: 4, kind: 'error', md: 'boom' },
      ],
    });
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
    openConn(conn);
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getAllByText('build the widget')[0]).toBeDefined(); // P11:内核 user md 裸文,直渲染
    expect(document.querySelector('.tool-summary')?.textContent).toContain('read'); // 图标化行(●/⎿ 记号退役,G10-C3)
    expect(document.querySelector('.tool-summary')?.textContent).not.toContain('⎿'); // 结果行记号不回归
    expect(document.querySelector('.run-live-line')?.textContent).toContain('0 steps'); // G14.52:运行状态行常驻流区末行(原工具行尾参)
    expect(screen.getByText('✻ dev started')).toBeDefined();
    expect(screen.getByText('Error: boom')).toBeDefined(); // P10:error 前缀归渲染面(与 TUI live/restore 同形)
    expect(document.querySelector('.entry-user')?.textContent).toContain('build the widget');
    // 2026-10-25 裁定:tooltip 只显完整会话名(运行中标记归侧栏会话行圆点,顶栏不双显);id 走隐形属性
    const tipEl = document.querySelector('.chat-title') as HTMLElement;
    expect(tipEl.getAttribute('data-tip')).toBe('build the widget');
    expect(tipEl.getAttribute('data-session-id')).toBe('s1'); // 夹具 id 原样镜像(真实面=sun-*,e2e openSessionId 持严格格式校验)
    unmount();
  });

  it('token 流式:在途尾块 markdown 实时渲染(2026-10-25 裁定:实时渲染从上层统一定);done 收段终渲染不变', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 'widget '));
    fire(conn, ev('token', '**done**'));
    const entry = document.querySelector('.entry-assistant');
    expect(entry?.textContent).toBe('widget done'); // 尾块恒进解析器:**done** 流中即粗体(实时渲染统一裁定)
    expect(entry?.querySelector('strong')?.textContent).toBe('done');
    expect(document.querySelector('.entry-assistant.streaming')).not.toBeNull();
    fire(conn, ev('done', 'widget **done**')); // 终稿=已累积(流即原文 md)
    expect(document.querySelector('.entry-assistant.streaming')).toBeNull();
    expect(document.querySelector('.entry-assistant')?.textContent).toBe('widget done'); // done 整段 markdown 终渲染
    expect(document.querySelector('.entry-assistant strong')?.textContent).toBe('done');
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
        { seq: 1, ts: 1, kind: 'user', md: 'goal one' },
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

  it('条目 React.memo:流式 token 帧只有流式条重渲染(尾块恒进解析器实时渲染,稳定条零重解析)', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    type('stable');
    pressEnter(); // user 条 → 1 次 md 渲染
    fire(conn, ev('model-start'));
    fire(conn, ev('token', 'a')); // 流式条开条 → 尾块 markdown 实时渲染(+1)
    const before = md.renders;
    fire(conn, ev('token', 'b')); // 流式增量:尾块重解析(2026-10-25 恒进解析器裁定)——恰 +1/帧;
    fire(conn, ev('token', 'c')); // 稳定条(user)memo 跳过零重跑,若破 memo 会是 +2/帧
    expect(md.renders).toBe(before + 2);
    expect(document.querySelector('.entry-assistant')?.textContent).toBe('abc');
    expect(document.querySelector('.entry-user')?.textContent).toContain('stable');
  });

  it('agent-message 气泡展示来源名与正文;delegation 状态行零渲染', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    fire(conn, ev('delegation-started', undefined, { label: 'dev', delegationId: 'd1' }));
    fire(conn, ev('agent-message', undefined, { from: 'a', to: 'lead', text: 'ping' }));
    expect(screen.queryByText('✻ dev started')).toBeNull();
    expect(document.querySelector('.agent-msg-from')?.textContent).toBe('a');
    expect(document.querySelector('.agent-msg-text')?.textContent).toBe('ping');
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

  it('流式光标退役(G14.63):流式/收段均无 .sx-stream-cursor', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start'));
    fire(conn, ev('token', '流内容'));
    expect(document.querySelector('.entry-assistant.streaming')).not.toBeNull(); // 流式条在场
    expect(document.querySelector('.sx-stream-cursor')).toBeNull(); // 光标不显示
    fire(conn, ev('done', '流内容'));
    expect(document.querySelector('.sx-stream-cursor')).toBeNull(); // 收段同样无光标
    unmount();
  });

  it('状态条图标+数字组:tokens/steps 组类名+aria-label+lucide svg 图标在场', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start'));
    fire(conn, ev('usage', undefined, { turnTotal: 77 }));
    fire(conn, ev('step', 'x'));
    // 2026-10-25 裁定:tooltip 只显会话名(tokens/steps 指标归上下文圆环 hover 弹层,见 G14.18 用例)
    const title = (document.querySelector('.chat-title') as HTMLElement | null)?.getAttribute('data-tip') ?? '';
    expect(title).not.toContain('77 tokens');
    expect(title).not.toContain('tokens');
    unmount();
  });
});

describe('种子竞态缓冲(T3 收口):seed 在途帧缓冲→种子落定过滤补投', () => {
  /** 进 chat 且 seed 应答悬挂(在途窗):返回后可先投帧再落定种子 */
  async function enterChatHeld(): Promise<{ conn: Conn; unmount: () => void }> {
    const { conn, unmount } = mount();
    conn.holdSnapshot();
    fireEvent.click(await screen.findByRole('button', GROUP_HEAD));
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
    openConn(conn);
    return { conn, unmount };
  }

  it('在途窗内本会话帧缓冲不投;种子落定后 seq≤lastSeq 丢、>lastSeq 依序补投(无丢帧/无双应用)', async () => {
    const { conn, unmount } = await enterChatHeld();
    conn.snapshotResp = snapshotOf({
      lastSeq: 5,
      messages: [{ seq: 1, ts: 1, kind: 'user', md: '基线目标' }],
    });
    // —— seed 在途窗:本会话帧到达(补发/直播混合)——缓冲不投 ——
    fire(conn, ev('token', '旧帧'), 3); // ≤ lastSeq:种子已含(直播帧先于应答落定)
    fire(conn, ev('model-start'), 7);
    fire(conn, ev('token', '新帧'), 8); // > lastSeq:种子切割序之后,须补投
    expect(document.querySelector('.entry-assistant')).toBeNull(); // 未投(缓冲中)
    // —— 种子落定:基线直映射 + 缓冲过滤补投 ——
    conn.releaseSnapshot();
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getAllByText('基线目标')[0]).toBeDefined(); // 种子条(md `> …` → blockquote)
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
    expect(screen.getAllByText('do the thing')[0]).toBeDefined(); // `> do the thing` → blockquote 正文(标题回落同文——scope 到气泡)
    expect((screen.getByLabelText('message input') as HTMLInputElement).value).toBe('');
  });

  it('running:Enter 发 sessionSteer(不 submit)+ 不本地回显(G14.89 入队语义,气泡等轮收束)', async () => {
    const { conn } = await enterChat();
    openConn(conn);
    fire(conn, ev('model-start'));
    type('mid-run nudge');
    pressEnter();
    expect(conn.sessionSteerCalls).toEqual([['s1', 'mid-run nudge']]);
    expect(conn.sessionSubmitCalls).toEqual([]);
    expect(screen.queryByText('mid-run nudge')).toBeNull(); // 入队不回显——气泡随补跑轮的 user 帧上屏
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
    await waitFor(() => expect(screen.getByText('Error: /session/s1/submit -> 409')).toBeDefined()); // P10:error 前缀归渲染面
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
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
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
    await waitFor(() => expect(screen.getAllByText('重播种基线')[0]).toBeDefined());
    expect(screen.queryByText('reset 前内容')).toBeNull();
    expect(screen.queryByText(apTitle)).toBeNull();
    unmount();
  });

  it('连接级 onReset(重连):卡保留——daemon 未决重发被连接层 pid 去重,不重挂不丢卡', async () => {
    const { conn, unmount } = await enterChat();
    fireApproval(conn, 's1', 'p-keep', apReq);
    act(() => conn.opts.onReset());
    // G14.88 审批挂起 dock=确认框:输入框隐藏,卡保留在场
    expect(screen.getByText(apTitle)).toBeDefined();
    expect(screen.queryByLabelText('message input')).toBeNull();
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
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
    openConn(conn);
    // G14.88 快照 pending 审批 → dock=确认框(输入框隐藏);卡出现即 attach+播种落定
    await waitFor(() => expect(screen.getByText(apTitle)).toBeDefined());
    expect(screen.queryByLabelText('message input')).toBeNull();
    // 卡内容来自快照 req(kind/subject/reason 直序列化)——刷新后回执闭环照常可用
    expect(screen.getByText('destructive command')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(conn.replyApprovalCalls).toEqual([['p-snap-1', 'allow']]));
    await waitFor(() => expect(screen.queryByText(apTitle)).toBeNull());
    // 回执后 dock 恢复输入框
    await waitFor(() => expect(screen.getByLabelText('message input')).toBeDefined());
    unmount();
  });
});


describe('G6/G8a 文件标签:右栏标签面 + write 工具 path 按钮跳转', () => {
  it('右栏标签切换:默认「任务」页(Board);「+」菜单开文件标签 → Files 预览面,Chat 恒挂零重播种', async () => {
    const { conn, unmount } = await enterChat();
    openTasksTab(); // G14.27:不再默认开,显式打开
    expect(document.querySelector('.sx-tab[data-title="智能体团队"], .sx-tab[data-title="Agent teams"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(document.querySelector('.taskboard-cards')).not.toBeNull()); // lazy 标签体 chunk 解析
    expect(screen.getByLabelText('message input')).toBeDefined();
    expect(conn.snapshotCalls).toHaveLength(1); // Chat 常驻:开标签不重播种
    // G14.159 文件已移出「+」菜单;2026-10-27 目录树入左菜单——经左菜单树文件行开档(真实用户路径)
    conn.treeByPath = { '': { entries: [{ name: 'fileA.ts', kind: 'file' }] } };
    openSidebarTree();
    fireEvent.click(await screen.findByRole('button', { name: 'fileA.ts' }));
    await waitFor(() => expect(screen.getByLabelText('files')).toBeDefined()); // lazy 标签体 chunk 解析
    expect(document.querySelector('.sx-tab[data-title="fileA.ts"]')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('.taskboard-cards')?.closest('.sx-tabbody')?.getAttribute('inert')).toBe(''); // keep-alive:board 面隐藏保留
    expect(conn.snapshotCalls).toHaveLength(1); // 无第二次播种
    // 切回「任务」标签:Board 回归(仍零重播种)
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Todos', '待办') }));
    await waitFor(() => expect(document.querySelector('.todo-cards')).not.toBeNull()); // lazy 标签体
    expect(conn.snapshotCalls).toHaveLength(1);
    unmount();
  });

  it('file 标签预览面:「+」菜单开标签 → 路径输入回车加载(readFile 断参)+ 高亮 + 换路径重载(G8d 起 path 钮改开 diff,本面经输入框直达)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    expandSidebarIfCollapsed();
    // G14.159 文件已移出「+」菜单;2026-10-27 目录树入左菜单——树文件行开档(initialPath 自动加载)
    conn.treeByPath = { '': { entries: [{ name: 'dirA', kind: 'dir' }], }, dirA: { entries: [{ name: 'a.ts', kind: 'file' }] } };
    openSidebarTree();
    await waitFor(() => expect(screen.getByRole('button', { name: 'dirA' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', '/w/root-a/dirA/a.ts']]));
    await waitFor(() => expect(screen.getByLabelText('file content')).toBeDefined());
    expect(document.querySelector('.mock-monaco-editor')!.getAttribute('data-language')).toBe('typescript'); // G14.5 monaco 面
    expect(document.querySelector('.files-breadcrumb')?.textContent).toContain('a.ts'); // 面包屑末级
    // G14.5 UX:已加载态无常驻输入行——换路径经目录树/工具行重开(手动输入仅空/错误态)
    expect(screen.queryByLabelText('file path input')).toBeNull();
    unmount();
  });

  it('两个文件标签互切:keep-alive 零重挂——切回 A 实例状态保留(内容/路径不丢,无重拉)', { timeout: 30_000 }, async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    // G8d 起 Chat path 钮改开 diff 标签——file 标签按 path 开档的入口为左菜单目录树文件行(openTab('file',{path}))
    conn.treeByPath = {
      '': { entries: [{ name: 'dirA', kind: 'dir' }] },
      dirA: { entries: [{ name: 'a.ts', kind: 'file' }, { name: 'b.ts', kind: 'file' }] },
    };
    // —— 开 file 标签 A(dirA/a.ts:目录文件行跳转,initialPath 自动加载)——
    openSidebarTree();
    await waitFor(() => expect(screen.getByRole('button', { name: 'dirA' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'dirA' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'a.ts' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }));
    expect(document.querySelector('.sx-tab[data-title="a.ts"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', '/w/root-a/dirA/a.ts']]));
    // —— 开 file 标签 B:左菜单树常驻(dirview 不随开档收起)点 b.ts 行 ——
    fireEvent.click(screen.getByRole('button', { name: 'b.ts' }));
    // 两文件标签在场且 B 活动(判重经 path:两 uid 两页)
    expect(document.querySelector('.sx-tab[data-title="a.ts"]')).not.toBeNull();
    expect(document.querySelector('.sx-tab[data-title="b.ts"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.readFileCalls).toEqual([['s1', '/w/root-a/dirA/a.ts'], ['s1', '/w/root-a/dirA/b.ts']]));
    // —— 切回 A:tabbody key=uid 强制重挂——initialPath 重新生效(第三笔加载请求 path=A)+ 路径输入回 A
    // (无 key 时 React 复用 B 的 Files 实例:effect no-op,无第三笔请求且路径输入残留 dirA/b.ts)
    // 左菜单树常驻(2026-10-27):树行与页签同名,页签用 DOM 定位
    fireEvent.click(document.querySelector('.sx-tab[data-title="a.ts"]') as HTMLElement);
    expect(document.querySelector('.sx-tab[data-title="a.ts"]')?.classList.contains('active')).toBe(true);
    expect(conn.readFileCalls).toEqual([['s1', '/w/root-a/dirA/a.ts'], ['s1', '/w/root-a/dirA/b.ts']]); // 无重拉(去重)
    expect(document.querySelector('.files-breadcrumb .files-crumb-name')?.textContent).toBe('a.ts');
    unmount();
  });

  it('Files 403 错误态:越界路径错误消息示出', async () => {
    const { conn, unmount } = await enterChat();
    conn.fileReject = new Error('/session/s1/file?path=../x -> 403');
    expandSidebarIfCollapsed();
    // G14.159 树路由开档(2026-10-27 树入左菜单):readFile 拒绝 403 → 行内错误消息示出
    conn.fileReject = new Error('/session/s1/file?path=fileX.ts -> 403');
    conn.treeByPath = { '': { entries: [{ name: 'fileX.ts', kind: 'file' }] } };
    openSidebarTree();
    fireEvent.click(await screen.findByRole('button', { name: 'fileX.ts' }));
    await waitFor(() => expect(screen.getByText('/session/s1/file?path=fileX.ts -> 403')).toBeDefined());
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
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Terminal', '终端') }));
  };

  it('+菜单开终端:openPty(s1,80,24) 分配 + 降级面在场(jsdom 无布局)+ nonce 两开两标签', async () => {
    const { conn, unmount } = await enterChat();
    openTerminal();
    // 分配链:TerminalTab mount → conn.openPty(sessionId, 80, 24) → onPtyAllocated(App ptyIdsRef 记账)
    // ——降级面在场即分配续体已跑(同微任务:记账先于守卫渲染)
    await waitFor(() => expect(conn.openPtyCalls).toEqual([['s1', 80, 24]]));
    await waitFor(() => expect(screen.getByText(bi('Terminal rendering requires a real browser window', '终端渲染需要真浏览器窗口'))).toBeDefined());
    // nonce 多实例:mintParams 铸唯一 resolveKey → 再开 = 第二个终端标签(非判重聚焦既有)
    openTerminal();
    // 终端标签题=项目名(openRoot basename);多开递增「root-a 2」
    expect(document.querySelectorAll('.sx-tab[data-type="terminal"]')).toHaveLength(2);
    await waitFor(() => expect(conn.openPtyCalls).toHaveLength(2)); // 活动切换重挂:新实例再分配
    unmount();
  });

  it('关终端标签 → conn.killPty(s1, p1);backHome 切走不 kill(标签还原重挂后才可关链)', async () => {
    const { conn, unmount } = await enterChat();
    openTerminal();
    await waitFor(() => expect(screen.getByText(bi('Terminal rendering requires a real browser window', '终端渲染需要真浏览器窗口'))).toBeDefined()); // 记账落定(uid→p1)
    // backHome:会话切走不 kill——pty 生命周期归标签关闭链,tabStates 每会话保留(spec §1)
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
    await screen.findByLabelText('welcome');
    expect(conn.killPtyCalls).toEqual([]);
    // 重进同会话(journal 重挂 s1):终端标签还原 → 重挂走重连径(记账命中,不重开 pty)
    conn.nextSessionId = 's1';
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
    await waitFor(() => expect(screen.getByText(bi('Terminal rendering requires a real browser window', '终端渲染需要真浏览器窗口'))).toBeDefined()); // 重挂完成(重连既有 p1)
    expect(conn.openPtyCalls).toHaveLength(1); // 重连径:还原面不再分配
    fireEvent.click(screen.getByRole('button', { name: /^close tab root-a$/ }));
    await waitFor(() => expect(conn.killPtyCalls).toEqual([['s1', 'p1']]));
    expect(document.querySelector('.sx-tab[data-type="terminal"]')).toBeNull(); // 标签已移除(承继「任务」)
    unmount();
  });

  it('裁定修复:切标签往返重连既有 pty——终端→任务→终端 不再 openPty(记账复用+replay 恢复)', async () => {
    const { conn, unmount } = await enterChat();
    openTerminal();
    await waitFor(() => expect(screen.getByText(bi('Terminal rendering requires a real browser window', '终端渲染需要真浏览器窗口'))).toBeDefined()); // 首挂分配+记账(uid→p1)
    expect(conn.openPtyCalls).toHaveLength(1);
    // 切到「任务」:TerminalTab 卸载——socket dispose 但不 kill(pty 服务侧存活)
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Todos', '待办') }));
    expect(screen.getByText(bi('Terminal rendering requires a real browser window', '终端渲染需要真浏览器窗口')).closest('.sx-tabbody')?.getAttribute('inert')).toBe(''); // keep-alive:终端面隐藏保留
    await waitFor(() => expect(document.querySelector('.todo-cards')).not.toBeNull()); // lazy 标签体
    expect(conn.killPtyCalls).toEqual([]); // 卸载≠kill
    // 切回终端页签(题=项目名):重挂走重连径(ptyIdFor 命中既有记账)——openPty 计数不变,降级面照常
    fireEvent.click(document.querySelector('.sx-tab[data-type="terminal"]')!);
    await waitFor(() => expect(screen.getByText(bi('Terminal rendering requires a real browser window', '终端渲染需要真浏览器窗口'))).toBeDefined());
    expect(conn.openPtyCalls).toHaveLength(1); // 重连既有 pty,不再分配(spec U-D5 等同本地底线)
    unmount();
  });
});

/** G8b 目录标签簇退役(2026-10-27 目录页签除名,树挪左菜单 dirview):树惰拉/截断/错误重试/
 *  会话切换缓存重置四行为下沉 DirectoryTab 组件专测——src/tabs/DirectoryTab.test.tsx verbatim 承接 */

describe('G8d Diff 标签:write 条目接线(G14.109 统一 ChangesView;callId 判重保留)', () => {
  /** write 工具条目注入(实时帧 callId 配对面:tool-call+tool-result 两帧) */
  const fireWrite = (conn: Conn, callId: string, path: string, content: string): void => {
    fire(conn, ev('tool-call', 'write', { input: { path, content }, callId, status: 'pending' }));
    fire(conn, ev('tool-result', 'written', { tool: 'write', callId, status: 'completed' }));
  };

  it('write 条目 path 钮 → diff 标签开且活动(title=文件名);渲染统一 ChangesView(空态)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    conn.diffResp = { path: 'src/a.ts', oldContent: 'const x = 1;\n', newContent: 'const y = 2;\n' };
    fireWrite(conn, 'c1', 'src/a.ts', 'const y = 2;\n');
    fireEvent.click(toolRow('a.ts src/')!); // 展开 write 条目
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' })); // tool-path 钮 → onOpenDiff 主通道
    expect(document.querySelector('.sx-tab[data-title=\'a.ts\']')?.classList.contains('active')).toBe(true);
    // G14.109:DiffTab 统一 ChangesView(mock 无 sessionChanges → 可选链空变动集,空态文案)
    await waitFor(() => expect(document.querySelector('.sx-tabbody .sx-changes')).not.toBeNull());
    expect(document.querySelector('.sx-tabbody .board-empty-title')).not.toBeNull();
    // Chat 展开面仍走 fetchDiff(G7 既有,DiffLines 行级)
    await waitFor(() => expect(conn.diffCalls).toEqual([['s1', 'c1']]));
    unmount();
  });

  it('同 callId 重开判重(一标签聚焦不重复);异 callId 多实例并存', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    conn.diffResp = { path: 'src/a.ts', oldContent: 'old a\n', newContent: 'new a\n' };
    fireWrite(conn, 'c1', 'src/a.ts', 'new a\n');
    fireEvent.click(toolRow('a.ts src/')!);
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }));
    await waitFor(() => expect(conn.diffCalls).toHaveLength(1)); // Chat 展开面一笔
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tool-path')!);
    expect(document.querySelectorAll('.sx-tab[data-title=\'a.ts\']')).toHaveLength(1);
    // 异 callId:多实例并存(by callId 判键——ChangesView 渲染统一,标签粒度保留);
    // 2026-10-22 用户裁定:编辑/写入行不聚合——c2 为独立行,diff 钮直达(无聚合头展开步)
    conn.diffResp = { path: 'src/b.ts', newContent: 'new b\n' };
    fireWrite(conn, 'c2', 'src/b.ts', 'new b\n');
    fireEvent.click(toolRow('b.ts src/')!);
    fireEvent.click(screen.getByRole('button', { name: 'src/b.ts' }));
    expect(document.querySelectorAll('.sx-tab[data-title=\'a.ts\']')).toHaveLength(1);
    expect(document.querySelector('.sx-tab[data-title=\'b.ts\']')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(conn.diffCalls).toHaveLength(2));
    unmount();
  });

  it('404 快照语义退役:ChangesView 统一渲染,无「无快照」降级面', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fireWrite(conn, 'c3', 'src/gone.ts', 'fallback content\n');
    fireEvent.click(toolRow('gone.ts src/')!);
    fireEvent.click(screen.getByRole('button', { name: 'src/gone.ts' }));
    await waitFor(() => expect(document.querySelector('.sx-tabbody .sx-changes')).not.toBeNull());
    expect(screen.queryByText(/无快照/)).toBeNull(); // G14.109 无 404 降级面
    unmount();
  });

  it('单列/新建标/截断横幅随 Monaco 退役:ChangesView 空态兜底', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    conn.diffResp = { path: 'src/new.ts', newContent: 'fresh\n', truncated: true };
    fireWrite(conn, 'c4', 'src/new.ts', 'fresh\n');
    fireEvent.click(toolRow('new.ts src/')!);
    fireEvent.click(screen.getByRole('button', { name: 'src/new.ts' }));
    await waitFor(() => expect(document.querySelector('.sx-tabbody .sx-changes')).not.toBeNull());
    expect(document.querySelector('.sx-tabbody .board-empty-title')).not.toBeNull(); // 空变动集兜底
    unmount();
  });
});
describe('G8d 任务板页签:子智能体事件分流 + 委派行点开只读转录页(G14.174 重定位)', () => {
  it('payload.subagent 事件进聚合不进 Chat 流;任务板委派行(状态徽标)点开 agent 只读页(转录/状态/tokens)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, ev('tool-call', 'write', { subagent: 'searcher', input: { path: 'src/a.ts' }, callId: 'c1' }));
    fire(conn, ev('tool-result', 'ok', { subagent: 'searcher', callId: 'c1', tool: 'write', ok: true }));
    fire(conn, ev('token', '分析中', { subagent: 'searcher' }));
    fire(conn, ev('usage', undefined, { subagent: 'searcher', turnTotal: 1200 }));
    fire(conn, ev('task-created', undefined, { taskId: 't1', title: 'searcher 分析', spec: 's', dependsOn: [] }));
    fire(conn, ev('delegation-started', undefined, { delegationId: 'searcher', kind: 'subagent', label: 'searcher', title: 'searcher 分析' }));
    // Chat 主流零污染:子智能体事件另一轨(无工具条/无流式条)
    expect(document.querySelector('.entry-tool')).toBeNull();
    expect(document.querySelector('.entry-assistant')).toBeNull();
    // 「+」菜单开任务板页签(G14.174:Agents → 任务板):任务行在场(状态点+任务名+子智能体名)
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Agent teams', '智能体团队') }));
    expect(document.querySelector('.sx-tab[data-title="智能体团队"], .sx-tab[data-title="Agent teams"]')?.classList.contains('active')).toBe(true);
    expect(screen.getByLabelText('agent teams')).toBeDefined();
    const row = await screen.findByRole('button', { name: 't1 [pending] searcher 分析' }); // P1 Task 8:live 板帧 100ms 尾随,findBy 轮询过窗
    expect(row.textContent).toContain('searcher'); // 执行子智能体名(委派 label)
    expect(row.closest('.tb-task-row')?.className).toContain('task-status-pending'); // 状态点=灰(等待)
    // G14.164 点行开只读转录页:agent 标签(title=显示名定格;页内无输入框),转录=工具行+token 行
    expect(document.querySelector('.sx-agent-page')).toBeNull(); // 未点行无 agent 页
    fireEvent.click(row);
    await new Promise((r) => setTimeout(r, 300));
    await waitFor(() => expect(document.querySelector('.sx-tabbody .sx-agent-page')).not.toBeNull());
    expect(document.querySelector('.sx-tab[data-title="searcher"]')?.classList.contains('active')).toBe(true);
    const thread = document.querySelector('.sx-agent-thread');
    expect(thread?.textContent).toContain('write'); // en 态动词原字面(配对后非执行中标签)
    expect(thread?.textContent).toContain('a.ts');
    expect(thread?.textContent).toContain('分析中');
    expect(document.querySelector('.sx-agent-page textarea')).toBeNull(); // 只读:无输入面

    unmount();
  });

  it('status 流转与清板:delegation-ended failed → 行带失败子智能体名;onResetSession 清活动行,任务简述仍在', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fire(conn, ev('task-created', undefined, { taskId: 't2', title: 'reviewer 审阅', spec: 's', dependsOn: [] }));
    fire(conn, ev('token', 'x', { subagent: 'reviewer' }));
    fire(conn, ev('delegation-started', undefined, { delegationId: 'reviewer', kind: 'subagent', label: 'reviewer', title: 'reviewer 审阅' }));
    fire(conn, ev('delegation-ended', undefined, { label: 'reviewer', delegationId: 'reviewer', kind: 'subagent', status: 'failed' }));
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Agent teams', '智能体团队') }));
    const row = await screen.findByRole('button', { name: 't2 [pending] reviewer 审阅' }); // P1 Task 8:live 板帧过窗
    expect(row.textContent).toContain('reviewer'); // 执行子智能体名(已执行态显)
    fireEvent.click(row);
    await waitFor(
      () =>
        expect(
          document.querySelector('.sx-tabbody .sx-agent-page'),
          `tabs=${[...document.querySelectorAll('.sx-tab')].map((x) => x.getAttribute('data-title')).join(',')}|body=${(document.querySelector('.sx-tabbody')?.textContent ?? 'NOBODY').slice(0, 150)}`,
        ).not.toBeNull(),
    );
 // 状态经转录取证(页头已随 G14.202 去除)
    // 本会话 reset:聚合清空(agent 页回退无活动态);他会话 reset 不清
    fireResetSession(conn, 's9');
    expect(document.querySelector('.sx-agent-page')).not.toBeNull(); // 他会话 reset:聚合不清,页在(名称归页签,G14.202)
    fireResetSession(conn, 's1');
    await waitFor(() => {
      const page = document.querySelector('.sx-agent-page');
      expect(page?.textContent).toContain('reviewer 审阅');
      expect(page?.querySelector('.entry-assistant, .entry-tool, .run-live-line')).toBeNull();
    });
    unmount();
  });

  it('他会话子智能体帧不进聚合(sessionRef 过滤在聚合面前)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    fireOther(conn, ev('token', '他会话子智能体', { subagent: 'ghost' }));
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Agent teams', '智能体团队') }));
    expect(screen.getByText(/^Agent teams is empty|智能体团队为空$/)).toBeDefined(); // 他会话帧零投影
    expect(screen.queryByLabelText('open agent ghost')).toBeNull();
    unmount();
  });
});

describe('G8d Web 标签:url 输入开档/scheme 补全/判重/外开/刷新重挂', () => {
  /** +菜单开 web(tools 节『浏览器』直调 onOpenType;裸开无 url → 引导面;G14.2xx 菜单项名随 title 改 Browser) */
  const openWeb = (): void => {
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Browser' }));
  };

  /** url 输入回车开档(active 面) */
  const submitUrl = (url: string): void => {
    fireEvent.change(screen.getByLabelText('web url input'), { target: { value: url } });
    fireEvent.keyDown(screen.getByLabelText('web url input'), { key: 'Enter' });
  };

  it('+菜单开 web → url 输入 example.com 回车 → webview 在场 src=https://example.com(无 scheme 补全)', async () => {
    const { unmount } = await enterChat();
    openWeb();
    expect(document.querySelector('.sx-tab[data-title="Browser"]')?.classList.contains('active')).toBe(true);
    await waitFor(() => expect(screen.getByLabelText('web tab')).toBeDefined()); // lazy 标签体 chunk 解析
    // 裸开无 active:VSCode Simple Browser 同形空态(地球+引导)、无 webview
    // (M1 融合:会话绑定档=webview 真实嵌入页面,截屏画布/iframe 双退役)
    expect(screen.getByText(/Paste or type a URL|粘贴或输入 URL/)).toBeDefined();
    expect(document.querySelector('webview')).toBeNull();
    // 回车开档:无 :// 前缀 → 补 https://(src=规范化 url)
    submitUrl('  example.com ');
    const wv = document.querySelector('webview');
    expect(wv).not.toBeNull();
    expect(wv?.getAttribute('src')).toBe('https://example.com');
    unmount();
  });

  it('G14.2xx 页内导航回写页名/判重键:+菜单再开裸档新立(浏览器多标签语义),原页档并存', async () => {
    const { unmount } = await enterChat();
    openWeb();
    submitUrl('example.com');
    expect(document.querySelector('webview')).not.toBeNull();
    // 导航即回写 params:标签条标题 url→页名(host),判重键随 url 演进(uid 不再恒 web:)
    expect(document.querySelector('.sx-tab[data-title="example.com"]')).not.toBeNull();
    // 切去任务页(web 失活)→ +菜单再开 web:裸档 key='' ≠ 导航后键 → 新立裸档(浏览器「+ 新标签页」语义)
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Todos', '待办') }));
    openWeb();
    expect(document.querySelectorAll('.sx-tab[data-title="Browser"]')).toHaveLength(1);
    expect(document.querySelector('.sx-tab[data-title="Browser"]')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('.sx-tab[data-title="example.com"]')).not.toBeNull(); // 原页档并存不丢
    unmount();
  });

  it('外开钮 → window.open(url, _blank, noopener,noreferrer) 断参(2026-10-31 起走 ⋯ 菜单)', async () => {
    const { unmount } = await enterChat();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      openWeb();
      // 无 active:菜单项禁用(无可外开目标;⋯ 菜单(更多操作)内两项均需已输入网址)
      fireEvent.click(screen.getByRole('button', { name: bi('More actions', '更多操作') }));
      expect((screen.getByRole('menuitem', { name: bi('Open in system browser', '在默认浏览器中打开') }) as HTMLButtonElement).disabled).toBe(true);
      submitUrl('example.com');
      fireEvent.click(screen.getByRole('menuitem', { name: bi('Open in system browser', '在默认浏览器中打开') }));
      expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
      expect(openSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
    unmount();
  });

  it('刷新钮(builtin webview 档):reload 语义,页签不重挂 url 不变', async () => {
    await enterChat();
    openWeb();
    submitUrl('example.com');
    const before = document.querySelector('webview');
    expect(before).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: bi('Reload', '刷新') }));
    const after = document.querySelector('webview');
    expect(after).toBe(before); // webview 原生 reload:节点不重挂,src 不变
    expect(after?.getAttribute('src')).toBe('https://example.com');
  });

  it('带 scheme 输入原样:http://localhost:3000 → src 原样(含 :// 不补 https)', async () => {
    const { unmount } = await enterChat();
    openWeb();
    submitUrl('http://localhost:3000');
    expect(document.querySelector('webview')?.getAttribute('src')).toBe('http://localhost:3000');
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

  it('任务板页默认在场(空板空态);开目录标签再切回,看板回归(Chat 恒挂不重播种)', async () => {
    const { conn, unmount } = await enterChat();
    openTasksTab(); // G14.27:不再默认开——菜单显式打开后空态在场
    await waitFor(() => expect(document.querySelector('.taskboard-cards')).not.toBeNull()); // lazy 标签体 chunk 解析
    expect(document.querySelector('.tb-task-list')).toBeNull(); // 空板无任务列表
    expect(screen.getByLabelText('message input')).toBeDefined();
    expect(conn.snapshotCalls).toHaveLength(1); // 播种恰一次
    // G14.159 文件已移出「+」菜单;2026-10-27 目录树入左菜单——开待办页签(任务板失活)→ 切回「任务板」:回归零重播种
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Todos', '待办') }));
    expect(document.querySelector('[aria-label="agent teams"]')?.closest('.sx-tabbody')?.getAttribute('inert')).toBe(''); // keep-alive:隐藏保留(裸 DOM 查询,inert 子树对 a11y 查询不可达)
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Agent teams', '智能体团队') }));
    await waitFor(() => expect(document.querySelector('.taskboard-cards')).not.toBeNull()); // lazy 标签体 chunk 解析
    expect(conn.snapshotCalls).toHaveLength(1); // 无第二次播种
    unmount();
  });

  it('板投影随事件:task-created 行在队卡;pending 停钮 → conn.boardStop', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    openTasksTab();
    fire(conn, taskCreated('t1', 'Demo'));
    fire(conn, taskCreated('t2', 'Next', ['t1']));
    fire(conn, ev('task-assigned', undefined, { taskId: 't1', assignee: 'w1' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 't1 [pending] Demo' })).toBeDefined());
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.getByRole('button', { name: 't2 [pending] Next' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Stop t1' }));
    await waitFor(() => expect(conn.boardStopCalls).toEqual([['s1', 't1']]));
    unmount();
  });

  it('他会话帧不进板投影(sessionRef 过滤在板面前)', async () => {
    const { conn, unmount } = await enterChat();
    fireOther(conn, taskCreated('t9', '他会话任务'));
    expect(document.querySelector('.tb-task-list')).toBeNull();
    unmount();
  });


  it('onResetSession(本会话)清 board/delegations 投影;他会话 reset 不清', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    openTasksTab();
    fire(conn, taskCreated('t1', 'Demo'));
    fire(conn, ev('delegation-started', undefined, { delegationId: 'd1', kind: 'subagent', label: 'dev', title: 'Demo' }));
    const devRow = await screen.findByRole('button', { name: 't1 [pending] Demo' }); // P1 Task 8:live 板帧过窗
    expect(devRow.textContent).toContain('dev'); // 执行子智能体名(委派 label)在任务行
    fireResetSession(conn, 's9'); // 他会话:板投影不动
    expect(screen.getByRole('button', { name: 't1 [pending] Demo' })).toBeDefined();
    fireResetSession(conn, 's1'); // 本会话:board/delegations 清(reset 语义 = swap 新 Harness,旧板作废;
    // 重播种快照板再经 onSeeded 回填——默认空快照,空态维持)
    expect(document.querySelector('.tb-task-list')).toBeNull(); // 清空后任务列表不渲染
    unmount();
  });

  it('会话切换板投影随快照(串态根除):s1 积任务 → back → s2 板为空;重开 s1 板回快照权威态', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    openTasksTab();
    fire(conn, taskCreated('t1', 'Demo'));
    await waitFor(() => expect(screen.getByRole('button', { name: 't1 [pending] Demo' })).toBeDefined()); // P1 Task 8:live 板帧过窗
    // —— back → 开 s2:openSession 清板投影 + s2 快照(空)回填——无 s1 残留(左栏组仍展开,会话行直点)——
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
    await screen.findByLabelText('welcome');
    conn.nextSessionId = 's2';
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s2', { selector: '.chat-title-text' })).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(document.querySelector('.tb-task-list')).toBeNull(); // s2 快照空板(而非 s1 残留)
    // —— 重开 s1:快照带板 → onSeeded 回填,任务页即快照权威态(无需事件帧)——
    conn.snapshotResp = snapshotOf({
      board: applyBoardEvent(emptyBoard(), { t: 'task-created', taskId: 't1', title: 'Demo', spec: '', dependsOn: [], teamId: 'alpha', ts: 1 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
    await screen.findByLabelText('welcome');
    conn.nextSessionId = 's1';
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByRole('button', { name: 't1 [pending] Demo' })).toBeDefined(); // 快照回填的权威板
    unmount();
  });

  it('P1 Task 8 串写竞态:切换后陈会话节流帧不入新会话板(队列项带会话标签,flush 丢陈)', async () => {
    const { conn, unmount } = await enterChat();
    openConn(conn);
    openTasksTab();
    fire(conn, taskCreated('t1', 'Demo')); // s1 live 帧入尾随窗(未落投影)
    // 同窗内切换到 s2 后再投 s2 帧(在途 timer 覆盖两帧,drain 同拍):陈会话帧必须被弃(D34 串态收口)
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
    await screen.findByLabelText('welcome');
    conn.nextSessionId = 's2';
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s2', { selector: '.chat-title-text' })).toBeDefined());
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false)); // 播种窗关(快照落定)——窗内帧走缓冲不入队
    openTasksTab(); // 页签集会话私有:s2 侧重开任务板(否则投影落板也不可见)
    act(() => conn.opts.onEvent('s2', taskCreated('t2', 'B-only'), 5)); // s2 帧共窗
    await waitFor(() => expect(screen.getByRole('button', { name: 't2 [pending] B-only' })).toBeDefined()); // 窗尾 drain:s2 帧落板
    expect(screen.queryByRole('button', { name: 't1 [pending] Demo' })).toBeNull(); // 陈会话 t1 不串写 s2 板
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
    await clickSessionRow();
    await waitFor(() => expect(screen.getByText('s1', { selector: '.chat-title-text' })).toBeDefined());
    openConn(conn);
    return { conn, unmount };
  }

  it('播种窗内 task/delegation 帧缓冲不投;整替后 ≤lastSeq 丢、>lastSeq 依序重放(增量不被整替吞)', async () => {
    const { conn, unmount } = await enterChatHeldBoard();
    openTasksTab();
    // 窗内三帧:seq 3(≤ lastSeq 丢)、seq 8 assigned(须重放)、seq 9 委派(须重放)
    fire(conn, ev('task-blocked', undefined, { taskId: 't1' }), 3);
    fire(conn, ev('task-assigned', undefined, { taskId: 't1', assignee: 'w1' }), 8);
    fire(conn, ev('delegation-started', undefined, { delegationId: 'd1', kind: 'subagent', label: 'dev', title: 'Base' }), 9);
    // 窗内不投:任务页默认在场,空板 + 委派空(帧在 boardPendingRef 缓冲)
    expect(document.querySelector('.tb-task-list')).toBeNull();
    expect(screen.queryByLabelText('delegations')).toBeNull(); // 窗内帧缓冲,委派未投
    // 种子:lastSeq 5;快照板已有 t1
    conn.snapshotResp = snapshotOf({
      lastSeq: 5,
      board: applyBoardEvent(emptyBoard(), { t: 'task-created', taskId: 't1', title: 'Base', spec: '', dependsOn: [], teamId: 'alpha', ts: 1 }),
    });
    conn.releaseSnapshot();
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    // 整替+过滤重放:seq 8/9 落在快照板上(t1 带委派名);seq 3 不重放
    expect(screen.getByRole('button', { name: 't1 [pending] Base' })).toBeDefined();
    expect(screen.getByRole('button', { name: 't1 [pending] Base' }).textContent).toContain('w1'); // task-assigned 优先于委派 label
    // 窗后帧直投(不再缓冲)
    fire(conn, taskEv('t2', 'Live'), 10);
    await waitFor(() => expect(screen.getByRole('button', { name: 't2 [pending] Live' })).toBeDefined()); // P1 Task 8:live 板帧过窗
    unmount();
  });

  it('onResetSession 清缓冲:窗内帧随 reset 弃(旧板作废),新种子不重放', async () => {
    const { conn, unmount } = await enterChatHeldBoard();
    fire(conn, taskEv('t1', 'Ghost'), 10); // 窗内缓冲(种子 lastSeq 0,若不清必重放)
    fireResetSession(conn, 's1'); // 本会话 reset:板投影+缓冲清 → Chat reseed(种子仍 held)
    conn.releaseSnapshot();
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    expect(document.querySelector('.tb-task-list')).toBeNull(); // Ghost 未重放(空板不渲染)
    unmount();
  });

  it('G8e-T2 播种窗内 delegation 帧补投聚合:buffered delegation-ended(failed) → onSeeded 重放后行带子智能体名', async () => {
    const { conn, unmount } = await enterChatHeldBoard();
    // 窗内:任务+子智能体帧直投聚合建卡(running);delegation-ended(failed) 入 boardPending 缓冲(不直投)
    fire(conn, ev('task-created', undefined, { taskId: 't1', title: 'reviewer', spec: 's', dependsOn: [] }), 1);
    fire(conn, ev('token', 'x', { subagent: 'reviewer' }), 2);
    fire(conn, ev('delegation-ended', undefined, { label: 'reviewer', delegationId: 'reviewer', kind: 'subagent', status: 'failed' }), 3);
    conn.releaseSnapshot(); // 种子 lastSeq 0:seq 1/2/3 > 0 → 重放面
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    // 任务板:任务行绑定委派(label=任务名同文)→ 行显子智能体名(重放循环补投聚合生效;
    // 失败终态现存委派投影,行内不再出「失败」徽标——G14.213 只显示任务)
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: bi('Agent teams', '智能体团队') }));
    expect(screen.getAllByText('reviewer').length).toBeGreaterThan(0);
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

  // G14.28:顶栏 ⋯ 菜单退役,删除会话暂无 UI 入口(conn.deleteSession API 面保留)——两用例随菜单移除

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
    // G14.88:审批在场 dock=确认框(输入框隐藏)——reseed 落定信号改用快照计数(原输入框 enabled 不再可用)
    const snapsBefore = conn.snapshotCalls.length - 1; // act 内 reseed 快照已同步发出
    await waitFor(() => expect(conn.snapshotCalls.length).toBe(snapsBefore + 1));
    expect(screen.getByText(apTitle)).toBeDefined(); // 瞬态不清——daemon 重发被 pid 去重拦,卡是唯一在场面
    expect(screen.queryByLabelText('message input')).toBeNull();
    // reseed 后真转换照常清:快照 idle → model-start(running)→ done(idle)
    fire(conn, ev('model-start'));
    fire(conn, ev('done', 'fin'));
    await waitFor(() => expect(screen.queryByText(apTitle)).toBeNull());
    unmount();
  });
});

describe('G8c 设置态壳:左栏切换导航/项目上下文/表单引擎/来源徽标/toast', () => {
  beforeEach(() => setLanguage('en')); // G14.213 设置面 t() 化:钉 en 防前序语言切换用例泄漏

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

  it('设置钮 → 设置态:SettingsShell 在场(导航项;顶部项目选择器已移除)、右标签栏与 Chat 退场;「← 返回」→ 回会话态(Chat 重挂)', async () => {
    const { unmount } = await enterChat();
    openSettings();
    // 左栏切换:SettingsShell 在场——顶部项目选择器/外观行已移除(设置重构轮:项目区分下沉到
    // 配置项徽标、外观移入通用卡),导航项在场
    expect(screen.queryByLabelText('settings project')).toBeNull();
    expect(screen.getByRole('button', { name: 'General' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Context & limits' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Memory' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Knowledge & search' })).toBeDefined();
    // ProjectMenu 退场(组头不在)
    expect(screen.queryByRole('button', GROUP_HEAD)).toBeNull();
    // 右标签栏整体不渲染 + Chat 主区不在(裁定:设置态 Chat 卸载,返回重播种同 backHome 语义)
    expect(document.querySelector('.sx-tabstrip')).toBeNull();
    expect(screen.queryByLabelText('message input')).toBeNull();
    // 返回 → 回会话态:Chat 重新在场(重挂重播种,输入门落定后启用)
    fireEvent.click(screen.getByRole('button', { name: 'back to sessions' }));
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    // G14.38:缺省折叠——条不在场,返回面以输入门与 Chat 在场断言

    await screen.findByRole('button', GROUP_HEAD); // ProjectMenu 重挂,组列表经 workspaces() 重拉
    unmount();
  });

  it('Esc → 回会话态(与返回钮同路径)', async () => {
    const { unmount } = await enterChat();
    openSettings();
    expect(screen.getByRole('button', { name: 'General' })).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect((screen.getByLabelText('message input') as HTMLInputElement).disabled).toBe(false));
    unmount();
  });

  it('通用面板:分组卡行渲染+来源徽标类名+envOverride 禁编;自动保存(select 换项/text 失焦逐字段写回来源文件)+ toast + 重拉', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = settingsViewOf([...generalRows, { key: 'contextWindow', value: '100000', source: 'project', envOverride: false }]);
    openSettings();
    // 面板拉取:settings(root=openRoot)
    // 前缀=App 语言同步 + agentTeams 解析(全局/项目) + 面板拉取
    await waitFor(() => expect(conn.settingsCalls).toEqual(['', '', '', '/w/root-a', '/w/root-a']));
    // 行渲染:select 触发钮显当值标签(en→English);text 行值 = 行 value ?? 缺省空(default 行空串)
    expect(screen.getByLabelText('language').textContent).toContain('English');
    expect((screen.getByLabelText('userSkillsDir') as HTMLInputElement).value).toBe('');
    // 来源徽标类名:仅 env/project 有 chip;global/default 无徽标不占位(SettingsForm 渲染条件)
    expect(document.querySelector('.sx-src-env')).not.toBeNull();
    expect(document.querySelector('.sx-src-project')).not.toBeNull();
    expect(document.querySelector('.sx-src-global')).toBeNull();
    expect(document.querySelector('.sx-src-default')).toBeNull();
    // envOverride 行禁编 + title 说明
    expect((screen.getByLabelText('shell') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByLabelText('shell').getAttribute('data-tip')).toBe('Overridden by env — read-only');
    // 自动生效轮:无保存钮(键值行失焦/换项即存;「添加类」表单才保留显式保存)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    // text 失焦自动保存(global 桶:projectsDir source=global)
    fireEvent.change(screen.getByLabelText('projectsDir'), { target: { value: '/home/u/other' } });
    fireEvent.blur(screen.getByLabelText('projectsDir'));
    await waitFor(() => expect(conn.putSettingsCalls).toEqual([['global', '', { projectsDir: '/home/u/other' }]]));
    // toast 出现(sx-toast,3s 自隐——测试窗内恒在场)
    expect(screen.getByText(/Applied — takes effect|已生效：新建会话起/)).toBeDefined();
    // 保存成功后重拉 settings
    await waitFor(() => expect(conn.settingsCalls).toEqual(['', '', '', '/w/root-a', '/w/root-a', '/w/root-a']));
    // select 换项自动保存(project 桶:language source=project)
    fireEvent.click(screen.getByLabelText('language'));
    fireEvent.click(screen.getByRole('option', { name: '简体中文' }));
    await waitFor(() =>
      expect(conn.putSettingsCalls).toEqual([['global', '', { projectsDir: '/home/u/other' }], ['project', '/w/root-a', { language: 'zh-CN' }]]),
    );
    // 切「上下文与限额」面板:数字键失焦 → number 化(非字符串);source=project → project 桶
    // (上一行 language 已切 zh-CN 且壳层 tick 重渲染——导航此刻是 zh 面,G14.213)
    fireEvent.click(screen.getByRole('button', { name: '上下文与限额' }));
    await screen.findByLabelText('contextWindow');
    fireEvent.change(screen.getByLabelText('contextWindow'), { target: { value: '200000' } });
    fireEvent.blur(screen.getByLabelText('contextWindow'));
    await waitFor(() =>
      expect(conn.putSettingsCalls).toEqual([
        ['global', '', { projectsDir: '/home/u/other' }],
        ['project', '/w/root-a', { language: 'zh-CN' }],
        ['project', '/w/root-a', { contextWindow: 200000 }],
      ]),
    );
    unmount();
  });

  it('保存失败(400):行内错误条原文示出(不静默),行值保持脏', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = settingsViewOf(generalRows);
    conn.putSettingsReject = new Error('/settings -> 400 unknown key');
    openSettings();
    await screen.findByLabelText('projectsDir');
    fireEvent.change(screen.getByLabelText('projectsDir'), { target: { value: 'x' } }); // 自由文本键(global 桶);shell 行 env 覆盖禁编
    fireEvent.blur(screen.getByLabelText('projectsDir'));
    await waitFor(() => expect(screen.getByText('/settings -> 400 unknown key')).toBeDefined());
    unmount();
  });

  it('G8e-T2 load 代守卫:面板快切后陈旧慢应答弃——终态=新应答值(旧应答不覆写)', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = settingsViewOf([{ key: 'language', value: 'slow-a', source: 'global', envOverride: false }]);
    conn.holdSettings(); // A(通用面板)首笔应答悬挂(单发门:后续直通)
    openSettings();
    // 前缀=语言同步+agentTeams;末项=通用面板拉取(被 hold)
    await waitFor(() => expect(conn.settingsCalls).toEqual(['', '', '', '/w/root-a', '/w/root-a']));
    // 快切「记忆」:B 应答直通落定(通用卸载,language 行不在场)
    conn.settingsView = settingsViewOf([{ key: 'autoMemory', value: 'on', source: 'default', envOverride: false }]);
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    await waitFor(() => expect(conn.settingsCalls).toEqual(['', '', '', '/w/root-a', '/w/root-a', '/w/root-a']));
    // 切回「通用」:C 应答直通落定(fast-b)
    conn.settingsView = settingsViewOf([{ key: 'language', value: 'fast-b', source: 'global', envOverride: false }]);
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    await waitFor(() => expect(screen.getByLabelText('language').textContent).toContain('fast-b'));
    // A 迟到落定:陈旧代弃——终态仍 fast-b(无守卫则被 slow-a 覆写)
    await act(async () => {
      conn.releaseSettings();
    });
    expect(screen.getByLabelText('language').textContent).toContain('fast-b');
    unmount();
  });

  it('记忆面板:概览行 memoryStats 只读展示「N 条记忆·最近 X」', async () => {
    const { conn, unmount } = await enterChat();
    conn.settingsView = settingsViewOf([{ key: 'autoMemory', value: 'on', source: 'default', envOverride: false }]);
    conn.memoryStatsResp = { entries: 12, lastWriteAt: Date.now() - 60_000 };
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Memory' }));
    // 概览行数据源:memoryStats(root)
    await waitFor(() => expect(conn.memoryStatsCalls).toEqual(['/w/root-a']));
    await waitFor(() => expect(screen.getByText(/12 memories/)).toBeDefined());
    expect(screen.getByText(/last write/)).toBeDefined();
    // 面板行照常(select 触发钮显当值 on + 保存)
    expect(screen.getByLabelText('autoMemory').textContent).toContain('on');
    unmount();
  });

  it('agentTeams=off:关设置后重读→剔除已开 agents 页签且 +菜单藏「智能体团队」', async () => {
    const { conn, unmount } = await enterChat();
    openTasksTab();
    expect(document.querySelector('.sx-tab[data-title="智能体团队"], .sx-tab[data-title="Agent teams"]')).not.toBeNull();
    conn.settingsView = settingsViewOf([{ key: 'agentTeams', value: 'off', source: 'global', envOverride: false }]);
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'back to sessions' }));
    await waitFor(() =>
      expect(document.querySelector('.sx-tab[data-title="智能体团队"], .sx-tab[data-title="Agent teams"]')).toBeNull(),
    );
    expandSidebarIfCollapsed();
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    expect(screen.queryByRole('menuitem', { name: bi('Agent teams', '智能体团队') })).toBeNull();
    unmount();
  });
});


/** G8c 复杂面板五件簇退役:模型与提供方/MCP/智能体/技能+权限/高级 raw 的 App 级走通测已由
 *  src/settings/__tests__/{ProvidersPane,McpPane,AgentsPane,SkillsPane,PermissionsPane,RawPane}.test.tsx 
 *  组件专测承接(壳装配/nav 切换由上方 G8c 设置态壳簇覆盖)——面板内行为断言不再双维护 */
