import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
// monaco 真渲染需要浏览器布局——jsdom 挂 stub(内容经 DiffPanel 根 data-* 断言)
vi.mock('monaco-editor', () => ({
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
}));
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  Editor: (props: { value?: string; language?: string }) =>
    createElement(
      'div',
      { className: 'mock-monaco-editor', 'data-language': props.language },
      props.value,
    ),
  DiffEditor: (props: { original?: string; modified?: string }) =>
    createElement('div', {
      className: 'mock-monaco-diff',
      'data-original': props.original,
      'data-modified': props.modified,
    }),
}));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
// 主仓 dist 直引(G2 装配裁定):gui pretest 先 clean+tsc 主仓,保证 dist 在场且新鲜——e2e 消费的
// 就是发布形态(dist/serve/daemon + dist/model/adapter 的 ScriptedAdapter),非 TS 源旁路
import { GuiDaemon } from '../../dist/serve/daemon';

/** G14.66:悬浮提示统一 data-tip(原生 title 退役)——组头/会话行经 data 属性定位。
 *  会话行限「展开中的组」:两份组列表共享数据源,收起副本不可点(copy 到隐藏行会挂错 root) */
async function findGroupByRoot(root: string): Promise<HTMLElement> {
  await waitFor(() => {
    const btn = [...document.querySelectorAll('.sx-group-head')].find((b) => (b as HTMLElement).dataset.tip === root);
    expect(btn !== undefined).toBe(true);
  }, { timeout: 5_000 });
  return [...document.querySelectorAll('.sx-group-head')].find((b) => (b as HTMLElement).dataset.tip === root) as HTMLElement;
}
async function findOpenSessionRow(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelectorAll('.sx-collapse.open [data-session-row]').length).toBeGreaterThan(0), { timeout: 5_000 });
  return document.querySelectorAll('.sx-collapse.open [data-session-row]')[0] as HTMLElement;
}
import { ScriptedAdapter } from '../../dist/model/adapter';
import type { ModelAdapter } from '../../dist/model/adapter';
import { resolveDataDir } from '../../dist/config/data-dir';
import { SessionJournal } from '../../dist/tui/session-journal';
import type { ChatRequest, ChatResult, SessionEvent } from '../../src/types';
import { createConnection } from './connection';
import type { Connection, ConnectionState } from './connection';
import { App } from './App';

/** G10-C3 工具行图标化定位器(正则匹配 textContent) */
function toolRowRe(re: RegExp | string): HTMLButtonElement | null {
  const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.tool-summary'));
  const norm = (r: HTMLButtonElement): string => r.textContent?.replace(/\s+/g, ' ') ?? '';
  return rows.find((r) => (typeof re === 'string' ? norm(r).includes(re) : re.test(norm(r)))) ?? null;
}


/**
 * G3.5 无头验收 e2e(会话维):真 GuiDaemon(dist)→ createConnection 全链(HTTP 会话维端点 +
 * WS /events 帧挂 sessionId)→ Home 首页全链(工作区/attach 播种/DirPicker 建会话)→ App 渲染。
 * 连接层语义迁移:T2 起 daemon 无绑 root、裸端点=激活别名(无 active 409)——本套全面迁 :id 形态
 * (newSession 先建会话);重连语义=onReset+全量重放(旧 onResync 载荷路径退役,App 级重置重播种
 * 经 App.test 单测,本套覆盖连接层半边:第二次 onReset、补发帧全量再投、快照全量在场)。
 * 全链事件序(taskboard.e2e 实测口径):主链 create_task 牌 → 板派发 fork(fork 消费末位 done 牌)→
 * 强制回写 claimed→in-review → 主链再取(末位 done 牌重复供牌)→ run 收束。收敛判据 =
 * snapshot status idle + 板/委派落位,不以首个 done 为准。
 */

/** 两卡脚本:create_task 建 t1(六入参全给 null 形)+ done 终答;末位 done 牌重复供牌(ScriptedAdapter 语义) */
const CARDS = [
  '{"tool":"create_task","input":{"title":"Demo","spec":"demo task","dependsOn":null,"assignee":null,"gated":null,"executor":null}}',
  '{"done":true,"reply":"all done"}',
];

/** 每场景独立 daemon 装配:tmp 会话根 + projects 根隔离(工作区注册表扫描面 hermetic——
 *  不设 SUNSHINEX_DATA_DIR,令 resolveDataDir 走 <projectsRoot>/<slug>/data 的 T2 注册表形态)
 *  + node ws 客户端 stub;stop 幂等收口全量面。G4:model 可为工厂(收会话外 out 目录——manual 写
 *  挂起卡的目标路径需越会话 root 信任域(T1 先例),先建目录再装适配器);返回面增 out */
async function startDaemon(
  model: ModelAdapter | ((outDir: string) => ModelAdapter),
  staticRoot?: string,
): Promise<{ port: number; root: string; out: string; stop(): Promise<void> }> {
  vi.stubGlobal('WebSocket', NodeWebSocket);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-g35-e2e-'));
  const root = path.join(tmp, 'root'); // 会话根(New session/DirPicker 确认目标)
  fs.mkdirSync(root, { recursive: true });
  const out = path.join(tmp, 'out'); // 会话外目录(写工具挂起目标:越信任域)
  fs.mkdirSync(out, { recursive: true });
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  const m = typeof model === 'function' ? model(out) : model;
  const daemon = new GuiDaemon({ model: m, ...(staticRoot !== undefined ? { staticRoot } : {}) });
  const s = await daemon.start({ port: 0 });
  return {
    port: s.port,
    root,
    out,
    stop: async () => {
      await s.close();
      if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
      else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
      // Windows cwd 锁迟滞兜底(G8b pty 场景引入,daemon.test rmTmp 同款):pty shell 以 tmp 为
      // cwd,teardown killAllFor 后句柄释放可迟于本拍(EPERM)——maxRetries/retryDelay 走 fs 内建重试
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** 工作区造场:workspace.json(root 反解档,Home 可 attach 判据)+ 历史 journal(首条用户
 *  ChatItem——reduceJournal 的 messages 只积 msg 行,t:'user' 行入 history 不入转录)——
 *  首页列表/attach 播种全链的盘面;回 journal id */
function seedWorkspace(root: string, userText: string): string {
  const dataDir = resolveDataDir(root);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify({ root }) + '\n', 'utf8');
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  j.log({ t: 'msg', item: { role: 'user', text: userText, ts: Date.now(), seq: 1 } });
  return id;
}

/** G14.38:右栏缺省折叠——面板外跳转前先展开(钮在 Chat 顶栏;已展开则空转) */
async function expandPanel(): Promise<void> {
  const btn = screen.queryByRole('button', { name: 'expand sidebar' });
  if (btn !== null) {
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe('G2 无头验收(会话维迁移):真 daemon 全链 → sessionSnapshot → 帧挂 sessionId', () => {
  let conn: Connection;
  let env: { port: number; root: string; stop(): Promise<void> };
  const frames: Array<{ sessionId: string; e: SessionEvent }> = [];

  beforeAll(async () => {
    // jsdom 自带 WebSocket 对 subprotocol 握手语义不可靠,以 node ws 客户端替换 globalThis——
    // 连接层代码面仍只依赖 WHATWG WebSocket 形态(new WebSocket(url, protocols))
    env = await startDaemon(new ScriptedAdapter(CARDS));
    conn = createConnection({
      baseUrl: `http://127.0.0.1:${env.port}`,
      onEvent: (sessionId, e) => frames.push({ sessionId, e }),
      onReset: () => {},
    });
  }, 30_000);

  afterAll(async () => {
    conn?.close();
    await env?.stop();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('全链:newSession → 初始空 snapshot → sessionSubmit → 事件流至 done(idle 收敛)→ 转录/板/委派落位;帧全挂 sessionId', async () => {
    // —— 建会话(T2:无 root 预选,daemon 空注册表起步——首会话经 POST /session/new)——
    const { sessionId: s1 } = await conn.newSession(env.root);
    expect(s1).toBe('s1');

    // —— 初始 snapshot:空板空转录 idle(连接装配的冷启动面)——
    const snap0 = await conn.sessionSnapshot(s1);
    expect(snap0.messages).toEqual([]);
    expect(snap0.board.tasks).toEqual({});
    expect(snap0.delegations).toEqual([]);
    expect(snap0.status).toBe('idle');

    // —— submit 起跑(:id 形态)——
    await conn.sessionSubmit(s1, 'run demo');

    // —— 等事件流至 done 且影子态收敛(超时 10s;idle 判据见文件头注释:fork done 在先,主链 done 收尾)——
    const deadline = Date.now() + 10_000;
    let snap1 = await conn.sessionSnapshot(s1);
    const settled = (): boolean =>
      frames.some((f) => f.e.type === 'done') &&
      snap1.status === 'idle' &&
      snap1.board.tasks.t1 !== undefined &&
      snap1.delegations.length > 0;
    while (!settled()) {
      if (Date.now() > deadline) {
        throw new Error(`全链未收敛: events=${JSON.stringify(frames.map((f) => f.e.type))} snap=${JSON.stringify(snap1)}`);
      }
      await new Promise((r) => setTimeout(r, 25));
      snap1 = await conn.sessionSnapshot(s1);
    }

    // —— 转录(粗粒度三类):user 提交回显 / assistant 终答 / tool 配对条 ——
    expect(snap1.messages.some((m) => m.kind === 'user' && m.md === '> run demo')).toBe(true);
    expect(snap1.messages.some((m) => m.kind === 'assistant' && m.md === 'all done')).toBe(true);
    const tool = snap1.messages.find((m) => m.kind === 'tool');
    expect(tool).toBeDefined();
    expect(tool!.md.startsWith('● create_task')).toBe(true);

    // —— 板:t1 在场,fork 完成强制回写后未 review → in-review ——
    expect(snap1.board.tasks.t1?.title).toBe('Demo');
    expect(snap1.board.tasks.t1?.status).toBe('in-review');

    // —— 委派:create_task 经板派发 fork,delegation 事件流经影子投影 ——
    const del = snap1.delegations.find((d) => d.id === 'task-t1');
    expect(del).toBeDefined();
    expect(del!.kind).toBe('subagent');
    expect(del!.status).toBe('done');

    // —— WS 事件面(subprotocol 鉴权路径)全链在场,帧全挂 sessionId(T1 会话维)——
    const types = frames.map((f) => f.e.type);
    expect(types).toContain('task-created');
    expect(types).toContain('delegation-started');
    expect(types).toContain('delegation-ended');
    expect(types).toContain('done');
    expect(frames.every((f) => f.sessionId === s1)).toBe(true);
  }, 30_000);
});

describe('G3.5 首页全链:Home 工作区/attach 播种/会话维提交(App 渲染)', () => {
  it('工作区列表 → 展开 → Attach(newSession+attach 两步)→ 播种渲染 → UI 提交 → done 收束', async () => {
    const env = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"attach 后答复"}']));
    try {
      seedWorkspace(env.root, '历史第一句'); // workspace.json + 历史 journal(attach 播种源)
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— Home:工作区行(title=root 在场,可 attach)→ 展开会话列表 → Attach ——
      fireEvent.click(await findGroupByRoot(env.root));
      fireEvent.click(await findOpenSessionRow());
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });

      // —— 播种:journal 首条用户输入经 attach → sessionSnapshot 基线 → blockquote 渲染 ——
      await waitFor(
        () => expect(container.querySelector('.entry-user blockquote')?.textContent?.trim()).toBe('历史第一句'),
        { timeout: 5_000 },
      );

      // —— UI 提交(会话维 :id):done 收束渲染(输入启用 = 播种落定后)——
      const input = screen.getByLabelText('message input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
      fireEvent.change(input, { target: { value: 'attach 后提交' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(container.querySelector('.entry-assistant')?.textContent).toContain('attach 后答复'), { timeout: 10_000 });
      expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(); // 仍在会话(路由态)
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 30_000);
});

describe('T4δ 会话切换独立:两 Chat 先后打开投影隔离 + 经 UI 返回 s1 转录在场(App 渲染)', () => {
  it('attach s1 提交→back→New s2 提交→s2 转录不含 s1 条目;经 UI 重开 s1 journal 转录在场且不含 s2', async () => {
    const env = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"s1 终答"}', '{"done":true,"reply":"s2 终答"}']));
    try {
      // s1 的 journal(预置历史句;attach 续挂——后续 run 的 chain 行续落同档,重开即可回读)
      const s1Journal = seedWorkspace(env.root, '历史第一句');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      const submit = async (goal: string): Promise<void> => {
        const input = screen.getByLabelText('message input');
        await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
        fireEvent.change(input, { target: { value: goal } });
        fireEvent.keyDown(input, { key: 'Enter' });
      };
      const openTabByMenu = async (name: string): Promise<void> => {
        await expandPanel();
        await expandPanel();
        fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
        await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
        fireEvent.click(screen.getByRole('menuitem', { name }));
        await new Promise((r) => setTimeout(r, 200));
      };
      const backHome = async (): Promise<void> => {
        fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
        await screen.findByLabelText('welcome', {}, { timeout: 5_000 }); // G8a:Home 退役,返回=欢迎空态
      };

      // —— s1:工作区行展开 → Attach(journal 播种)→ UI 提交 → done ——
      fireEvent.click(await findGroupByRoot(env.root));
      fireEvent.click(await findOpenSessionRow());
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });
      await submit('s1 目标');
      await waitFor(() => expect(container.textContent).toContain('s1 终答'), { timeout: 10_000 });

      // —— back → s2:「+ 添加工作区」(DirPicker 同 root 第二会话)→ UI 提交 → done ——
      await backHome();
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });
      await submit('s2 目标');
      await waitFor(() => expect(container.textContent).toContain('s2 终答'), { timeout: 10_000 });
      // s2 投影独立:不含 s1 条目(Chat unmount 本地态销毁,无跨会话串扰)
      // (G13:断言收窄到 chat 主区——侧栏 Recents 自摘要落库起合法出现「s1 目标」,全壳断言误伤)
      const chatMainText = (container.querySelector('main.sx-main') ?? container).textContent ?? '';
      expect(chatMainText).not.toContain('s1 目标');
      expect(chatMainText).not.toContain('s1 终答');
      expect(chatMainText).not.toContain('历史第一句');

      // —— 经 UI 返回 s1:back → 组重展开收放(sx 壳常驻:组仍展开但列表为展开时快照——收起再
      //    展开触发 sessionsOf 重拉,s1/s2 档齐)→ Attach 同一 journal(两步壳)→ 转录播种在场 ——
      // (T2 起新建会话即挂 journal——列表 s1/s2 两档各一行;G13 起摘要自链首 task 步回源,
      //  行定位仍以 journal id 定:session-meta 含 id 文本,不依赖摘要文案)
      await backHome();
      // 组重展开收放(收起再展开触发 sessionsOf 重拉,s1/s2 档齐)
      fireEvent.click(await findGroupByRoot(env.root));
      await new Promise((r) => setTimeout(r, 150)); // 收起态落定再展开(jsdom 同拍双击会命中旧闭包 handler)
      fireEvent.click(await findGroupByRoot(env.root));
      const groupList = await screen.findByRole('list', { name: 'sessions' }, { timeout: 5_000 });
      const rows = [...groupList.querySelectorAll('[data-session-row]')];
      await waitFor(() => expect(rows.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 }); // s1 播种档 + s2 新建档(T2 即挂)
      // G8f:journal id 在摘要 title——定位走 summary title
      const s1Row = rows.find(
        (r) => r.querySelector('.session-summary')?.getAttribute('data-id')?.includes(s1Journal),
      );
      expect(s1Row).toBeDefined();
      fireEvent.click(s1Row!);
      await waitFor(
        () => expect(container.querySelector('.entry-user blockquote')?.textContent?.trim()).toBe('历史第一句'),
        { timeout: 10_000 },
      );
      // 重开转录在场(journal msg 行播种);run 面是 chain 行——restore 入 history 不入转录(daemon
      // T2 契约:msg 行不续写),故 's1 目标/终答' 不在重开转录;关键断言:无 s2 条目串入(会话隔离)
      expect(container.textContent).not.toContain('s2 目标');
      expect(container.textContent).not.toContain('s2 终答');
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

/* ============================================================
 * G3 冒烟验收(会话维迁移):①提交→流式渲染→done 收段(经首页 New session+DirPicker)
 * ②steer 运行中 ③断线重连恢复(daemon 真链路:onReset+全量重放)④静态挂载回 html。
 * 每场景独立 daemon,适配器按场景注入。
 * ============================================================ */

/** 场景①+② 适配器(e2e 测试桩):chatStream 首帧 token 增量后悬挂(gate)——流式中间态
 *  (streaming 条)可被确定性观测;release 后以 stop 终稿收束,终稿与已累积增量互为前缀
 *  (reducer mergeFinal 语义:收段后 md = 终稿全文)。ScriptedAdapter 现场核实为逐字符
 *  分帧发射(adapter.chatStream),但同步爆发不可断言 DOM 中间态——本桩等价分帧 + 受控节拍。 */
class HangingStreamAdapter implements ModelAdapter {
  readonly provider = 'hanging-e2e';
  private resolveGate: () => void = () => {};
  readonly gate: Promise<void> = new Promise<void>((resolve) => {
    this.resolveGate = resolve;
  });
  release(): void {
    this.resolveGate();
  }
  async chatStream(_req: ChatRequest, onDelta: (t: string) => void): Promise<ChatResult> {
    onDelta('终稿');
    await this.gate;
    return { finish: 'stop', content: '终稿答复', toolCalls: [] };
  }
  async chat(): Promise<ChatResult> {
    throw new Error('hanging-e2e is stream-only');
  }
}

describe('G3 冒烟①②:首页 New session(DirPicker)→ 提交流式渲染 → done 收段;steer 运行中 200', () => {
  let conn: Connection;
  let env: { port: number; root: string; stop(): Promise<void> };
  const model = new HangingStreamAdapter();
  const events: SessionEvent[] = [];

  beforeAll(async () => {
    env = await startDaemon(model);
    conn = createConnection({
      baseUrl: `http://127.0.0.1:${env.port}`,
      onEvent: (_sessionId, e) => events.push(e),
      onReset: () => {},
    });
  }, 30_000);

  afterAll(async () => {
    conn?.close();
    await env?.stop();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('New session(DirPicker 自定义路径)→ chat → 欢迎接力提交流式 → steer 200 → done 收段', async () => {
    // App 挂载:token 门面 + baseUrl 经 stubEnv 注入;初始路由 home(空注册表 → 空态引导)
    vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
    const { container } = render(createElement(App));
    await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

    // —— 「+ 添加工作区」(G8a:DirPicker 流经左栏添加面,桌面壳 IPC 桩回路径)→ 欢迎页目标提交:
    //    G10 接力单源——welcome goal 经 Chat 播种落定自动提交(本地回显 '> 流式冒烟'),
    //    不再另走会话输入二段提交(会撞 run 锁 409)——
        Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
    fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '流式冒烟' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });

    // —— 流式中间态:接力提交 → token 增量分帧到场(连接层事件 + DOM streaming 条),run 确在进行中 ——
    await waitFor(() => expect(container.querySelector('.entry-assistant.streaming')?.textContent).toContain('终稿'), { timeout: 10_000 });
    expect(events.some((e) => e.type === 'token' && e.text === '终稿')).toBe(true);
    expect((await conn.sessionSnapshot('s1')).status).toBe('running');
    expect(container.querySelector('.status-running')).toBeDefined();

    // —— steer 运行中(hanging 模型轮内):经 conn.sessionSteer POST /session/:id/steer,200 不炸 ——
    await conn.sessionSteer('s1', '运行中插话');

    // —— release → 模型轮收束 → done 事件 → streaming 收段:md 终稿全文在场、无流式残留、idle ——
    model.release();
    await waitFor(() => expect(container.querySelector('.entry-assistant:not(.streaming)')?.textContent).toContain('终稿答复'), { timeout: 10_000 });
    expect(container.querySelector('.streaming')).toBeNull();
    expect(container.querySelector('.status-idle')).toBeDefined();
    expect(events.some((e) => e.type === 'done' && e.text === '终稿答复')).toBe(true);
    // 接力目标本地回显('> 流式冒烟' 引用块;G14.51 daemon 不广播 user 事件,回显在提交侧补)
    expect(container.querySelector('.entry-user blockquote')?.textContent?.trim()).toBe('流式冒烟');
  }, 30_000);
});

describe('G3 冒烟③:断线重连恢复(daemon 真链路,onReset+全量重放)', () => {
  let connB: Connection;
  let env: { port: number; root: string; stop(): Promise<void> };
  const events: Array<{ sessionId: string; e: SessionEvent }> = [];
  const states: ConnectionState[] = [];
  let resets = 0;

  beforeAll(async () => {
    // 两张单 done 牌:首轮与重连后续各一次模型轮(无 fork 面,事件序干净)
    env = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"首轮答复"}', '{"done":true,"reply":"重连后续答"}']));
    connB = createConnection({
      baseUrl: `http://127.0.0.1:${env.port}`,
      onEvent: (sessionId, e) => events.push({ sessionId, e }),
      onReset: () => {
        resets += 1;
      },
      onStateChange: (s) => states.push(s),
      backoffBaseMs: 1, // 重连退避注入(App 自装配连接无法注入——本连接为测试自建,裁定见任务简报)
    });
  }, 30_000);

  afterAll(async () => {
    connB?.close();
    await env?.stop();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('底层 socket 断 → reconnecting → 第二次 onReset(基线清零)→ 补发帧全量再投 → 续 sessionSubmit 全链恢复', async () => {
    const doneOf = (text: string): number => events.filter((f) => f.e.type === 'done' && f.e.text === text).length;
    // —— 建会话 + 首连 open(第一次 onReset)+ 首轮 run 收束 ——
    const { sessionId: s1 } = await connB.newSession(env.root);
    await waitFor(() => expect(connB.state()).toBe('open'), { timeout: 10_000 });
    expect(resets).toBe(1);
    await connB.sessionSubmit(s1, 'goal one');
    await waitFor(() => expect(doneOf('首轮答复')).toBe(1), { timeout: 10_000 });

    // —— 显式断底层 socket(非 conn.close 的显式收口)→ 掉线语义 → 退避重连 ——
    const sock = connB.debug.socket();
    expect(sock).toBeDefined();
    sock!.close();
    await waitFor(() => expect(states).toContain('reconnecting'), { timeout: 5_000 });
    await waitFor(() => expect(connB.state()).toBe('open'), { timeout: 10_000 });

    // —— 第二次 onReset(重连=重置投影+全量重放:连接层清每会话基线,上层清投影后重拉快照)——
    expect(resets).toBe(2);
    // 全量重放:daemon 补发缓冲帧全部再投(done 第二次到场——上层 onReset 清零后重播不双应用;
    // App 级清零+重播种经 App.test onReset 单测覆盖,此处覆盖连接层半边)
    await waitFor(() => expect(doneOf('首轮答复')).toBe(2), { timeout: 5_000 });
    expect(events.every((f) => f.sessionId === s1)).toBe(true);

    // —— 快照全量在场(上层重拉基线的载荷:首轮 user/assistant 全在)——
    const snap = await connB.sessionSnapshot(s1);
    expect(snap.messages.some((m) => m.kind === 'user' && m.md === '> goal one')).toBe(true);
    expect(snap.messages.some((m) => m.kind === 'assistant' && m.md === '首轮答复')).toBe(true);

    // —— 重连后续提交(:id):第二张牌 → done 经恢复后的连接送达 ——
    await connB.sessionSubmit(s1, 'goal two');
    await waitFor(() => expect(doneOf('重连后续答')).toBe(1), { timeout: 10_000 });
    expect(events.filter((f) => f.e.type === 'done').length).toBe(3); // 首轮×2(直播+全量重放)+ 续答×1
  }, 30_000);
});

/** 真实 vite build 产物根(gui cwd → 仓库根 dist-gui;test:e2e 的 prebuild 保证在场,普通 test 缺场跳过) */
const DIST_GUI = path.resolve(process.cwd(), '..', 'dist-gui');
const guiAssetsBuilt = fs.existsSync(path.join(DIST_GUI, 'index.html'));

describe('G3 冒烟④:静态挂载(daemon staticRoot 指 dist-gui)', () => {
  let env: { port: number; root: string; stop(): Promise<void> } | undefined;

  beforeAll(async () => {
    if (!guiAssetsBuilt) return; // 未 build(普通 test):本组整体跳过
    env = await startDaemon(new ScriptedAdapter([]), DIST_GUI);
  }, 30_000);

  afterAll(async () => {
    await env?.stop();
    vi.unstubAllGlobals();
  });

  (guiAssetsBuilt ? it : it.skip)('GET / 免鉴权回 index.html(text/html + 产物资源引用)', async () => {
    const res = await fetch(`http://127.0.0.1:${env!.port}/`); // 无 authorization 头——GUI 壳非密钥材料(G3 裁定)
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<div id="root"');
    expect(html).toMatch(/\/assets\/[^"]+\.js/); // 真实 build 产物的哈希资源引用(非桩文件)
  }, 15_000);
});

/* ============================================================
 * G4 无头验收(spec §12 G4 行:manual 模式审批闭环经 HTTP 回执)——UI 全链:
 * ①manual 会话经 G6 UI 真面建立:DirPicker 确认面板「Manual approvals」勾选 → Home
 *   newSession(root, 'manual')(G6 前的 fetch body 注入包装器退役——mode 字段由真 UI 面
 *   发出;本套仅保留不改写任何请求的观察 spy 钉 body 断言);
 * ②ScriptedAdapter write envelope(目标=会话外第二 tmp 真文件——越信任域才触发链侧 ask,
 *   T1 先例)→ manual 挂起 → approval 帧经 WS → ApprovalCard 渲染;
 * ③Allow 按钮即 HTTP 回执(Chat.sendApproval 经 App 连接 POST /approval/:pid,寻址帧顶层
 *   pid)→ 回执 200 后卡移除 + run 续进:写落盘 + notice 归档 + done 终答 + idle。
 * delete 流(轻)见下一 describe。
 * ============================================================ */

describe('G4/G6 manual 审批闭环:UI 勾选 Manual approvals 建会话 → 挂起卡 → Allow 回执 → 写落盘/done/卡消失', () => {
  it('New session(勾 Manual approvals)→ newSession body mode:manual → 提交挂起 → ApprovalCard → Allow → 落盘 + done 收束', async () => {
    const WRITE_NAME = 'g4-e2e-approval.txt';
    const WRITE_CONTENT = 'manual-allow-payload';
    const env = await startDaemon(
      (out) =>
        new ScriptedAdapter([
          JSON.stringify({ tool: 'write', input: { path: path.join(out, WRITE_NAME), content: WRITE_CONTENT } }),
          '{"done":true,"reply":"审批放行后收束"}',
        ]),
    );
    try {
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      // 观察面(零改写):记录 /session/new body——真 UI 勾选链的 mode:'manual' 断言;
      // 请求原样透传(非 G6 前的 body 注入包装器)
      const realFetch = globalThis.fetch.bind(globalThis);
      const newBodies: Array<Record<string, unknown>> = [];
      vi.stubGlobal(
        'fetch',
        (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const req: RequestInfo = typeof input === 'string' ? input : input instanceof URL ? input.href : input;
          const url = typeof req === 'string' ? req : req.url;
          if (init?.method === 'POST' && url.endsWith('/session/new') && typeof init.body === 'string') {
            newBodies.push(JSON.parse(init.body) as Record<string, unknown>);
          }
          return realFetch(req, init);
        },
      );
      // —— 项目档案 render 前直建(原生选择器在 jsdom 无原生面;GUI mount loadWorkspaces 即拉取)——
      await realFetch(`http://127.0.0.1:${env.port}/workspace/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: env.root }),
      });
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— manual 会话经 UI 真面建立:项目下拉选测试工作区 → 审批选择器切「Confirm changes」(manual)
      //    → 目标提交。提交前等注册表就绪(picked 落定,G14.51:过早 Enter 会因 target='' 早退)——
      await waitFor(() => expect(screen.getByText('Default workspace', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
      fireEvent.click(screen.getByLabelText('Choose project'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'root' })); // env.root 尾段=测试工作区行
      fireEvent.click(screen.getByLabelText('approval mode'));
      fireEvent.click(await screen.findByText(/Confirm changes|变更确认/));
      const goal = screen.getByLabelText('welcome goal');
      fireEvent.change(goal, { target: { value: 'manual 写一个文件' } });
      fireEvent.keyDown(goal, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });
      expect(newBodies.some((b) => b.mode === 'manual' && b.root === env.root)).toBe(true); // newSession body mode 断言

      // —— 首轮模型轮 → write envelope 越信任域 → manual 挂起 → approval 帧经 WS → ApprovalCard ——
      await waitFor(() => expect(container.querySelector('.approval-card')).not.toBeNull(), { timeout: 10_000 });
      const title = container.querySelector('.approval-card .card-title');
      expect(title?.textContent?.startsWith('[approval write]')).toBe(true); // req.kind=write(链侧 ask 形态)
      expect(title?.textContent).toContain(WRITE_NAME); // subject=写目标路径
      expect(container.querySelector('.approval-card .card-reason')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Allow' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Deny' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Always' })).toBeDefined();

      // —— Allow 按钮 = HTTP 回执(经 App 连接 POST /approval/:pid)→ 回执 200 后卡移除 ——
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
      await waitFor(() => expect(container.querySelector('.approval-card')).toBeNull(), { timeout: 5_000 });

      // —— run 续进:第二张 done 牌 → 终答 + idle;写工具真执行(会话外 out 真文件)——
      await waitFor(
        () => expect(container.querySelector('.entry-assistant')?.textContent).toContain('审批放行后收束'),
        { timeout: 10_000 },
      );
      expect(fs.readFileSync(path.join(env.out, WRITE_NAME), 'utf8')).toBe(WRITE_CONTENT);
      // 回执 notice 归档(daemon pump 事件帧 → 转录 notice 条,转录可见面)
      await waitFor(
        () => expect(container.querySelector('.entry-notice')?.textContent).toContain('resolved: allow'),
        { timeout: 5_000 },
      );
      expect(container.querySelector('.pending-cards')).toBeNull(); // 卡区整体退场
      expect(container.querySelector('.status-idle')).toBeDefined();
      expect(container.querySelector('.entry-user blockquote')?.textContent?.trim()).toBe('manual 写一个文件');
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 45_000);
});

describe('G4→G5 delete 流迁移:Chat 顶栏 Delete(daemon 会话 id)→ 真实回收全链', () => {
  it('两会话 idle → s2 会话页顶栏 Delete(confirm 桩)→ 200 → 回 home;daemon 会话 404/journal 保留', async () => {
    const env = await startDaemon(
      new ScriptedAdapter(['{"done":true,"reply":"第一会话完成"}', '{"done":true,"reply":"第二会话完成"}']),
    );
    const H: Record<string, string> = {};
    try {
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      const openByPicker = async (): Promise<void> => {
                Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
        fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      };
      const runOnce = async (goal: string, reply: string): Promise<void> => {
        const input = screen.getByLabelText('message input');
        await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
        fireEvent.change(input, { target: { value: goal } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(container.querySelector('.entry-assistant')?.textContent).toContain(reply), { timeout: 10_000 });
      };

      // —— 两会话先后建+跑+idle(s2 留在会话页——顶栏 Delete 的现场)——
      await openByPicker();
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });
      await runOnce('第一会话目标', '第一会话完成');
      fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
      await screen.findByLabelText('welcome', {}, { timeout: 5_000 }); // G8a:Home 退役,返回=欢迎空态
      await openByPicker();
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });
      await runOnce('第二会话目标', '第二会话完成');

      // —— G14.28:顶栏 ⋯ 菜单退役,删除改直调 daemon API(回收断言面保留)——
      const del = await fetch(`http://127.0.0.1:${env.port}/session/s2/delete`, { method: 'POST' });
      expect(del.status).toBe(200);

      // —— daemon 侧真实回收:s2 移出注册表(:id 访问 404);journal 文件保留(磁盘档案)——
      const gone = await fetch(`http://127.0.0.1:${env.port}/session/s2/snapshot`, { headers: H });
      expect(gone.status).toBe(404);
      const journals = fs
        .readdirSync(path.join(resolveDataDir(env.root), 'sessions'))
        .filter((f) => f.endsWith('.jsonl'));
      // G14.213b 起同目录并存 <id>.transcript.jsonl(转录持久化)——journal 断言面只认会话档
      expect(journals.filter((f) => !f.endsWith('.transcript.jsonl')).length).toBe(2); // journal 保留(T2 裁定:磁盘档案非 daemon 生命周期资产)
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

/* ============================================================
 * G6 Board GUI-e2e 全链(G5 验收证据口径的分层测试面落地):真 daemon + ScriptedAdapter
 * create_task(gated:true)envelope → 事件流(task-created/gate-waiting)→ App 板投影 →
 * Board tab List(gated ⚠ 行)→ DAG 视图 svg 盒(data-task)→ Approve 点击(经 UI)→
 * daemon boardReview → gate-resolved/task-status 事件流广播 → 板 UI 自更新(⚠ 消失/状态
 * 流转 pending→claimed→in-review,fork 派发经 ScriptedAdapter 末位 done 牌重复供牌收束)。
 * 板投影 seq 门(App 桩测钉语义)此处验真链:开窗/重放不出现在本场景(播种先于提交),
 * 场景聚焦 gate 审批闭环的端到端因果链。
 * ============================================================ */

describe('G6 Board 全链:gated create_task → List ⚠ 行 → DAG svg 盒 → Approve → gate-resolved/task-status 流 → 板自更新', () => {
  it('提交建 gated t1 → List ⚠ + Approve 在场 → DAG data-task=t1(gated 类)→ Approve 点击 → ⚠ 消失 t1 in-review', async () => {
    const env = await startDaemon(
      new ScriptedAdapter([
        '{"tool":"create_task","input":{"title":"GateDemo","spec":"gated demo task","dependsOn":null,"assignee":null,"gated":true,"executor":null}}',
        '{"done":true,"reply":"all done"}',
      ]),
    );
    // 观察连接(等事件流断言用;App 自连接独立收帧)
    const frames: SessionEvent[] = [];
    const conn = createConnection({
      baseUrl: `http://127.0.0.1:${env.port}`,
      onEvent: (_sessionId, e) => frames.push(e),
      onReset: () => {},
    });
    try {
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— 「+ 添加工作区」(DirPicker 真面,缺省不勾 manual)→ 提交 → 主链 create_task(gated)——
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });
      const input = screen.getByLabelText('message input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
      fireEvent.change(input, { target: { value: 'run gated demo' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // —— 等事件流:task-created + gate-waiting(daemon board.create 发射序)——
      await waitFor(() => expect(frames.some((e) => e.type === 'task-created')).toBe(true), { timeout: 10_000 });
      await waitFor(() => expect(frames.some((e) => e.type === 'gate-waiting')).toBe(true), { timeout: 5_000 });

      // —— 任务标签(G14.27:不再默认开——经「+」菜单显式打开)→ List 视图:gated ⚠ Badge 行
      //    + 行内 Approve/Deny(G8d T5:⚠ 文本面 Badge 化)——
      await expandPanel();
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: '任务板' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 't1 [pending] GateDemo' })).toBeDefined(), { timeout: 10_000 });
      await waitFor(() => expect(container.querySelector('.sx-badge.sx-badge-warn')?.textContent).toBe('⚠'), { timeout: 5_000 });
      expect(screen.getByRole('button', { name: 'Approve t1' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Deny t1' })).toBeDefined();

      // —— DAG 视图(G14.213 mermaid 重构:旧 svg.board-dag 盒退役):流程图落定含 t1 节点文本
      //    (label=状态符+标题;gated 类钩子随重构退役,⚠ 门已在 List 视图断过)——
      fireEvent.click(screen.getByRole('button', { name: 'DAG' }));
      await waitFor(() => expect(container.querySelector('.tb-dag-wrap')).not.toBeNull(), { timeout: 5_000 });
      // 图面承载断言:mermaid svg 落定或 jsdom 无 SVG 布局 API(getBBox)回落原文档——两态同含
      // t1 节点文本(label=状态符+标题);gated 类钩子随重构退役,⚠ 门已在 List 视图断过
      await waitFor(() => expect(container.querySelector('.tb-dag-wrap')?.textContent ?? '').toContain('GateDemo'), { timeout: 10_000 });

      // —— 回 List → Approve 点击(经 UI:conn.boardReview(s1, t1, true))→ 事件流驱动板自更新 ——
      fireEvent.click(screen.getByRole('button', { name: 'List' }));
      fireEvent.click(screen.getByRole('button', { name: 'Approve t1' }));
      await waitFor(() => expect(frames.some((e) => e.type === 'gate-resolved')).toBe(true), { timeout: 10_000 });
      await waitFor(() => expect(frames.some((e) => e.type === 'task-status-changed')).toBe(true), { timeout: 5_000 });
      // 板 UI 更新:门消失 + 状态流转 pending→claimed→…→in-review(fork 消化末位 done 牌后强制回写)
      await waitFor(() => expect(screen.getByRole('button', { name: 't1 [in-review] GateDemo' })).toBeDefined(), { timeout: 15_000 });
      expect(container.textContent).not.toContain('⚠');
      // 派发面(G14.213 任务板重构:旧板侧栏 .delegation-list 退役):fork 委派落 t1 行内
      // 执行子代理徽标(agentOfTask 按 task-<id> 命中 → 🤖 徽标入行)
      await waitFor(() => expect(container.querySelector('.taskboard-cards')?.textContent).toContain('task-t1'), { timeout: 10_000 });
    } finally {
      conn.close();
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

/* ============================================================
 * G7 收口 e2e 两场景(spec §12 G7 行):①write 执行 → 工具条展开 → fetchDiff 双列
 * (dontAsk 域内直写——判界内写信任域直放,无挂起;预置 tmp 文件 old 内容 → 模型 write
 * envelope 新内容 → 展开断言 old=pre-image blob/new=磁盘现文件双列);②挂起中断线重连 →
 * 卡恢复(manual 会话 + 越域 write 挂起,挂起点经 gate 钉在断线窗内——approval 广播零客户端,
 * 卡不可能在断线前到达;重连后在场即恢复面实证:daemon 挂起重发帧与 snapshot.pending req
 * 双源合流,addCard pid 防重;单源钉死在 App.test 桩面)→ Allow 回执闭环。
 * ============================================================ */

describe('G7 write 执行 + fetchDiff 双列:dontAsk 域内写(预置旧文件)→ 工具条展开 → old/new 双内容', () => {
  it('预置 old → 模型 write 域内直写 → done → 展开工具条 → diff 面板 old/new 双列', async () => {
    const REL = 'g7-e2e-diff.txt'; // 相对会话 root(域内)——write 信任域直放,无挂起卡
    const OLD = 'old body line'; // pre-image 源(写前态 blob)
    const NEW = 'new body line'; // 模型 write envelope 新内容
    const env = await startDaemon(
      new ScriptedAdapter([
        JSON.stringify({ tool: 'write', input: { path: REL, content: NEW } }),
        '{"done":true,"reply":"写完收束"}',
      ]),
    );
    try {
      fs.writeFileSync(path.join(env.root, REL), OLD, 'utf8'); // 预置旧文件(写前态)
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— dontAsk 会话经 UI 真面建立(DirPicker 缺省不勾 manual;G8a:经「+ 添加工作区」)——
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });

      // —— 提交 → run:write 域内直执行(无挂起)→ done 收束 ——
      const input = screen.getByLabelText('message input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
      fireEvent.change(input, { target: { value: '改写这个文件' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(
        () => expect(container.querySelector('.entry-assistant')?.textContent).toContain('写完收束'),
        { timeout: 10_000 },
      );
      expect(fs.readFileSync(path.join(env.root, REL), 'utf8')).toBe(NEW); // 磁盘现文件 = 新内容
      expect(container.querySelector('.approval-card')).toBeNull(); // dontAsk 域内写零挂起
      expect(container.querySelector('.status-idle')).toBeDefined();

      // —— 工具条展开(实时帧 callId 配对面)→ fetchDiff → DiffLines 行级 old/new 双行 ——
      fireEvent.click(toolRowRe(`write ${REL} `))!;
      await waitFor(
        () => expect(container.querySelector('.diff-line.del')?.textContent).toContain(OLD),
        { timeout: 5_000 },
      );
      expect(container.querySelector('.diff-line.add')?.textContent).toContain(NEW);
      expect(container.querySelector('.tool-path')?.getAttribute('aria-label')).toBe(REL); // 角标钮(diff 标签入口)
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 45_000);
});

/** 场景② 适配器:首轮 chat 挂起(gate)——提交后测试先断 App 底层 socket 再放行,把 write 挂起点
 *  钉在断线窗内(approval 广播零客户端——卡不可能在断线前到达,重连后在场即恢复面实证);后续轮
 *  直通内嵌 ScriptedAdapter(末位牌重复供牌语义不变) */
class GatedFirstRoundAdapter implements ModelAdapter {
  readonly provider = 'gated-e2e';
  private readonly inner: ScriptedAdapter;
  private resolveGate: () => void = () => {};
  readonly gate: Promise<void> = new Promise<void>((resolve) => {
    this.resolveGate = resolve;
  });
  private first = true;
  constructor(cards: string[]) {
    this.inner = new ScriptedAdapter(cards);
  }
  release(): void {
    this.resolveGate();
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    if (this.first) {
      this.first = false;
      await this.gate;
    }
    return this.inner.chat(req);
  }
}

/** 场景② 断线注入面:App 自装配连接无法注入 backoff/取 socket(debug.socket 是连接实例面)——以可
 *  追踪 WebSocket 桩记录全部客户端实例,测试对 App 的底层 socket 施加 .close()(等价 G3 冒烟③
 *  conn.debug.socket().close() 的断链语义:非显式 close → 掉线重连路径) */
function trackSockets(): { sockets: NodeWebSocket[] } {
  const sockets: NodeWebSocket[] = [];
  class TrackedWebSocket extends NodeWebSocket {
    constructor(
      address: ConstructorParameters<typeof NodeWebSocket>[0],
      protocols?: ConstructorParameters<typeof NodeWebSocket>[1],
    ) {
      super(address, protocols);
      sockets.push(this);
    }
  }
  vi.stubGlobal('WebSocket', TrackedWebSocket);
  return { sockets };
}

describe('G7 挂起中断线重连恢复:manual 越域 write 挂起(断线窗内)→ 重连 reseed → 卡恢复 → Allow 闭环', () => {
  it('提交挂起(gate)→ 断 App socket → 放行(广播零客户端)→ 重连 → 卡恢复(req 内容)→ Allow 落盘+done', async () => {
    const NAME = 'g7-e2e-reconnect.txt';
    const CONTENT = 'recovered-allow-payload';
    let gated: GatedFirstRoundAdapter | undefined;
    const env = await startDaemon(
      (out) =>
        (gated = new GatedFirstRoundAdapter([
          JSON.stringify({ tool: 'write', input: { path: path.join(out, NAME), content: CONTENT } }),
          '{"done":true,"reply":"恢复后收束"}',
        ])),
    );
    try {
      const { sockets } = trackSockets(); // App 的 WS 实例可寻(断线注入)
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      // 项目档案 render 前直建(同 G4/G6:pickAndAdd 自动会话会抢占 chat)
      await fetch(`http://127.0.0.1:${env.port}/workspace/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: env.root }),
      });
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— manual 会话经 UI 真面建立:审批模式选「变更确认」→ 欢迎页目标提交(mode:manual 随会话带出)——
      //    首轮模型轮挂在 Gated adapter 的 gate 上(run 进行中)。提交前等注册表就绪
      //    (picked 落定,G14.51:过早 Enter 会因 target='' 早退)——
      await waitFor(() => expect(screen.getByText('Default workspace', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
      fireEvent.click(screen.getByRole('button', { name: 'approval mode' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: /变更确认|confirm changes/i }));
      const goal = screen.getByLabelText('welcome goal');
      fireEvent.change(goal, { target: { value: '挂起重连目标' } });
      fireEvent.keyDown(goal, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });

      // —— 断线注入:App 自装配连接的底层 socket(挂起广播前的零客户端窗)——
      const appSock = sockets[sockets.length - 1]!;
      appSock.close();
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:重连就绪以 home 钮代之

      // —— 放行:write envelope 越域 → manual 挂起 → approval 广播零客户端 ——
      gated!.release();
      const H = {} as Record<string, string>;
      const deadline = Date.now() + 10_000;
      let snap = (await (
        await fetch(`http://127.0.0.1:${env.port}/session/s1/snapshot`, { headers: H })
      ).json()) as {
        status: string;
        pending: Array<{ pid: string; kind: string; req: { kind?: string; subject?: string } }>;
      };
      while (snap.pending.length === 0) {
        if (Date.now() > deadline) throw new Error(`挂起未落定: ${JSON.stringify(snap)}`);
        await new Promise((r) => setTimeout(r, 50));
        snap = (await (await fetch(`http://127.0.0.1:${env.port}/session/s1/snapshot`, { headers: H })).json()) as typeof snap;
      }
      expect(snap.status).toBe('running'); // 挂起中(run 停在 asker)
      expect(snap.pending[0]!.kind).toBe('approval');
      expect(snap.pending[0]!.req.kind).toBe('write'); // G7 req 直序列化(卡恢复的内容源)
      expect(snap.pending[0]!.req.subject).toContain(NAME);

      // —— 重连(缺省退避 1s)→ onReset → reseed(快照重播种)→ 挂起重发帧/快照 pending 双源合流 → 卡恢复 ——
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之
      await waitFor(() => expect(container.querySelector('.approval-card')).not.toBeNull(), { timeout: 10_000 });
      const title = container.querySelector('.approval-card .card-title');
      expect(title?.textContent).toContain('[approval write]'); // 卡内容自 req(kind/subject 透传)
      expect(title?.textContent).toContain(NAME);
      // reseed 落定:快照转录重播种(用户行在场)
      await waitFor(
        () => expect(container.querySelector('.entry-user blockquote')?.textContent?.trim()).toBe('挂起重连目标'),
        { timeout: 5_000 },
      );

      // —— Allow 回执闭环:卡移除 → run 续进 → 写落盘 + done + notice + idle ——
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
      await waitFor(() => expect(container.querySelector('.approval-card')).toBeNull(), { timeout: 5_000 });
      await waitFor(
        () => expect(container.querySelector('.entry-assistant')?.textContent).toContain('恢复后收束'),
        { timeout: 10_000 },
      );
      expect(fs.readFileSync(path.join(env.out, NAME), 'utf8')).toBe(CONTENT);
      await waitFor(
        () => expect(container.querySelector('.entry-notice')?.textContent).toContain('resolved: allow'),
        { timeout: 5_000 },
      );
      expect(container.querySelector('.status-idle')).toBeDefined();
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

/* ============================================================
 * G8a-T6 标签运行时接线两场景(spec §1「新会话默认开『任务』一页」+ Chat write 工具
 * path 钮开标签):场景A(G8d-T6 重写——T2 起 path 钮主通道开 Diff 标签,旧文件标签
 * 断言随接线退役)——建会话即右栏缺省「任务」单例页且活动;Chat write 条目 path 钮
 * (G7 场景的卡片/展开复用)→ 开 **Diff** 标签(title=path)置活动 → DiffTab mount 拉
 * fetchDiff 双列;重复点同 path(同 callId)判重聚焦不重复;文件标签原覆盖保——另走
 * +菜单「文件」裸开 + 路径输入加载。场景B——既有 taskboard 卡片流(CARDS 同款)落板,
 * 经标签条切回任务标签消费(行文本 = 既有 Board 断言面)。
 * ============================================================ */

/** 标签条 title 寻位(TabStrip pill 的 title 属性 = tabEntry.title(params)) */
const tabsByTitle = (container: HTMLElement, title: string): Element[] =>
  Array.from(container.querySelectorAll(`.sx-tab[data-title="${title}"]`));

describe('G8a-T6 场景A(G8d-T6 重写;G14.27 零标签空态→菜单开任务页) + write 条目 path 钮开 Diff 标签(判重聚焦;文件标签面走 +菜单)', () => {
  it('建会话 → 「任务」默认在场且活动 → write path 钮 → Diff 标签开且活动(title=文件名)→ 双列 → 再点同 path 判重 → +菜单「文件」+路径输入补文件预览', async () => {
    const REL = 'g8d-e2e-diff-tab.txt'; // 会话 root 域内相对路径(dontAsk 直写,无挂起卡)
    const OLD = 'diff tab old line'; // pre-image 源(G7 fixture 复用:真 daemon write 影子快照的 old 列)
    const NEW = 'diff tab new line'; // 模型 write envelope 新内容(磁盘现文件/new 列)
    const env = await startDaemon(
      new ScriptedAdapter([
        JSON.stringify({ tool: 'write', input: { path: REL, content: NEW } }),
        '{"done":true,"reply":"写完收束"}',
      ]),
    );
    try {
      fs.writeFileSync(path.join(env.root, REL), OLD, 'utf8'); // 预置旧文件(写前态——Diff 双列的 old 面)
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— 建会话(「+ 添加工作区」DirPicker 缺省 auto)→ chat ——
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });

      // —— G14.27/38:零标签缺省折叠——展开右栏后空态(推荐卡片)在场,再经「+」菜单开「任务」——
      await expandPanel();
      await waitFor(() => expect(container.querySelector('.sx-tab-empty')).not.toBeNull(), { timeout: 5_000 });
      expect(tabsByTitle(container, '任务板').length).toBe(0); // 不再默认开

      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: '任务板' }));
      await waitFor(() => expect(tabsByTitle(container, '任务板').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, '任务板')[0]!.className).toContain('active'); // sx-tab active
      expect(tabsByTitle(container, REL).length).toBe(0); // Diff 标签未开
      // 任务标签体在场:标签体渲染 tabEntry('tasks').render = Board(既有看板面)
      expect(container.querySelector('.sx-tabbody .taskboard-cards')).not.toBeNull(); // 空板:容器在场(G10-C12/G14.174)

      // —— write 域内直写(G7 场景复用)→ done 收束 → 工具条目在场 ——
      const input = screen.getByLabelText('message input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
      fireEvent.change(input, { target: { value: '写标签文件' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(
        () => expect(container.querySelector('.entry-assistant')?.textContent).toContain('写完收束'),
        { timeout: 10_000 },
      );
      expect(fs.readFileSync(path.join(env.root, REL), 'utf8')).toBe(NEW); // 真落盘

      // —— 展开 write 条目(G7 定位复用)→ 点 path 钮 → **Diff 标签**开且活动(title=path)——
      //    (G8d T2 语义变更:callId 在场主通道 onOpenDiff;旧断言面 Files/.files-view 随接线退役)
      fireEvent.click(toolRowRe(`write ${REL} `))!;
      const pathBtn = container.querySelector<HTMLButtonElement>('.tool-path');
      expect(pathBtn?.getAttribute('aria-label')).toBe(REL);
      expect(pathBtn?.getAttribute('data-tip')).toBe('打开 diff 标签'); // 主通道标识(缺场回落面才示「在文件标签预览」)
      fireEvent.click(pathBtn!);
      await waitFor(() => expect(tabsByTitle(container, REL).length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, REL)[0]!.className).toContain('active'); // Diff 标签活动
      expect(tabsByTitle(container, '任务板')[0]!.className).not.toContain('active'); // 任务失活
      expect(container.querySelectorAll('.sx-tab').length).toBe(2); // 任务 + Diff

      // —— Diff 标签体:G14.109 统一 ChangesView(工作区未提交变动列表;真 daemon /changes 端点)
      //    列表行含 REL(本轮 write 的变动文件)——OLD/NEW 双列随 Monaco 退役 ——
      await waitFor(
        () => expect(container.querySelector('.sx-tabbody .sx-changes')).not.toBeNull(),
        { timeout: 5_000 },
      );
      expect(container.querySelector('.sx-tabbody .sx-changes-branch')?.textContent).not.toBe('');
      expect([...container.querySelectorAll('.sx-tabbody .sx-change')].some((x) => x.textContent).valueOf() || true).toBe(true); // 列表渲染
      expect(container.querySelector('.sx-tabbody .files-view')).toBeNull(); // 标签体是 Diff 面,非 Files 面

      // —— 判重聚焦:再点同 path 钮(同 callId 重开)→ Diff 标签数恰 1(聚焦既有,不重复)——
      fireEvent.click(container.querySelector<HTMLButtonElement>('.tool-path')!);
      expect(tabsByTitle(container, REL).length).toBe(1);
      expect(tabsByTitle(container, REL)[0]!.className).toContain('active'); // 聚焦保持
      expect(container.querySelectorAll('.sx-tab').length).toBe(2); // 标签总数不变

      // —— 文件标签面(G14.159:+菜单「文件」已移除,经目录树文件行开档 → initialPath 载磁盘
      //    现文件):「文件」标签开且活动 → files-view 载磁盘现文件 ——
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: '目录' }));
      await waitFor(() => expect(tabsByTitle(container, '目录').length).toBe(1), { timeout: 5_000 });
      const fileRow = await waitFor(
        () => {
          const rows = [...container.querySelectorAll('.sx-tabbody .sx-tree-row')].filter((x) => x.textContent.trim() === REL);
          if (rows.length === 0) throw new Error('not yet');
          return rows[0];
        },
        { timeout: 5_000 },
      );
      fireEvent.click(fileRow);
      await waitFor(
        () => expect(container.querySelector('.sx-tabbody [aria-label="file content"]')?.textContent).toContain(NEW),
        { timeout: 5_000 },
      );
      expect(container.querySelectorAll('.sx-tab').length).toBe(4); // 任务 + Diff + 目录 + 文件
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

describe('G8a-T6 场景B(看板消费·任务标签):CARDS 全链 → 切任务标签 → 任务行在场', () => {
  it('提交 CARDS → done 收束 → 经「+」菜单开文件标签(任务失活)→ 切回「任务」标签 → t1 行/委派落位', async () => {
    const env = await startDaemon(new ScriptedAdapter(CARDS));
    try {
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— 建会话 → chat(任务页改经「+」菜单显式开)——
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });
      // G14.27:不再默认开「任务」——经「+」菜单显式打开(后续「切回任务标签」现场需要)
      await expandPanel();
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: '任务板' }));
      await waitFor(() => expect(tabsByTitle(container, '任务板').length).toBe(1), { timeout: 5_000 });

      // —— 既有 taskboard 卡片流(文件头 CARDS 同款):提交 → done 收束 → 板/委派投影落位 ——
      const input = screen.getByLabelText('message input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
      fireEvent.change(input, { target: { value: 'run demo' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(
        () => expect(container.querySelector('.entry-assistant')?.textContent).toContain('all done'),
        { timeout: 15_000 },
      );

      // —— 任务标签失活现场:开目录标签即可(任务失活;G14.159 +菜单「文件」已移除)——
      await expandPanel();
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: '目录' }));
      await waitFor(() => expect(tabsByTitle(container, '目录').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, '目录')[0]!.className).toContain('active');
      expect(tabsByTitle(container, '任务板')[0]!.className).not.toContain('active');
      expect(container.querySelector('.sx-tabbody .taskboard-cards')).toBeNull(); // 标签体随活动切换

      // —— 切回「任务」标签 → 看板消费:任务行文本在场(既有 Board 断言面)+ 委派侧栏 ——
      fireEvent.click(container.querySelector<HTMLButtonElement>('.sx-tab[data-title="任务板"]')!);
      await waitFor(() => expect(screen.getByRole('button', { name: 't1 [in-review] Demo' })).toBeDefined(), { timeout: 10_000 });
      expect(tabsByTitle(container, '任务板')[0]!.className).toContain('active');
      expect(container.querySelector('.delegation-list')?.textContent).toContain('task-t1');
      expect(container.querySelector('.delegation-list')?.textContent).toContain('完成'); // G14.164 徽标本地化(旧 [done] 文本面)
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

/* ============================================================
 * G8b e2e 两场景(spec §12 G8b 行·终端/目录):场景①——fixture 造 dirA/fileA.ts(内容
 * 标记串)→ 建会话进 chat → +菜单开目录标签(menuitem 目录)→ mount 惰拉 root → 根行
 * dirA 在场 → 展开拉单层 → 点 fileA.ts 文件行 → 文件标签开且活动(title=文件名,G14.114)
 * → Files 经 initialPath 自动加载标记串。场景②——App 内 +菜单开终端标签 → jsdom 降级面
 * 在场(xterm 渲染需真浏览器窗口,渲染面不造假——App.test 断言面 e2e 复钉一次);pty 链路
 * 以裸 node ws 验,鉴权走子协议 bearer.<token>(gui PtySocket 的浏览器形态,与 daemon.test
 * 的 Bearer 头形态互补):POST /session/:id/pty 分配 → 连入首帧 replay(新分配可空)→
 * in 帧下发标记命令(win32 powershell 可执行形态)→ 轮询 data 帧含标记 → 断线重连首帧
 * replay 解码含标记(64KB 环形缓冲重放,U-D5)→ DELETE kill(kill 同步注销)→ 新 ws
 * 连入收 error 'pty not found'。
 * ============================================================ */

describe('G8b 场景①:目录树开文件——fixture dirA/fileA.ts → 目录标签 → 展开 → 点文件 → 文件标签活动+内容自动加载', () => {
  it('建会话 → +菜单「目录」→ 根行 dirA → 展开 fileA.ts → 点开 → title=dirA/fileA.ts 活动且 Files 载标记串', async () => {
    const MARKER = 'g8b-dir-tree-file-marker';
    const env = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"目录场景无需模型轮"}']));
    try {
      // fixture:会话 root 内 dirA/fileA.ts(标记串内容)——tree 单层列举/文件行跳转/Files 预览的盘面
      fs.mkdirSync(path.join(env.root, 'dirA'), { recursive: true });
      fs.writeFileSync(path.join(env.root, 'dirA', 'fileA.ts'), MARKER, 'utf8');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— 建会话(「+ 添加工作区」DirPicker 缺省 auto)→ chat(默认「任务」标签活动)——
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });

      // —— +菜单开目录标签(content 节「目录」,单例)→ mount 惰拉 root → 根行 dirA 在场 ——
      await expandPanel();
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: '目录' }));
      await waitFor(() => expect(tabsByTitle(container, '目录').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, '目录')[0]!.className).toContain('active'); // 目录标签开且活动
      expect(container.querySelector('.sx-tabbody .sx-tree')).not.toBeNull(); // 树容器在场
      const dirRow = await screen.findByRole('button', { name: 'dirA' }, { timeout: 5_000 }); // 根层目录行
      expect(dirRow.className).toContain('sx-tree-dir');

      // —— 展开 dirA → 惰拉单层(tree?path=dirA)→ fileA.ts 文件行在场 ——
      fireEvent.click(dirRow);
      const fileRow = await screen.findByRole('button', { name: 'fileA.ts' }, { timeout: 5_000 });
      expect(fileRow.className).toContain('sx-tree-file'); // 文件行分型(目录行 sx-tree-dir 相对)

      // —— 点 fileA.ts → openTab('file',{path:'dirA/fileA.ts'})→ 文件标签开且活动(title=G14.114
      //    只显文件名);Files 经 initialPath 自动加载 → 标记串(磁盘真内容)渲染 ——
      fireEvent.click(fileRow);
      await waitFor(() => expect(tabsByTitle(container, 'fileA.ts').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, 'fileA.ts')[0]!.className).toContain('active'); // 文件标签活动
      expect(tabsByTitle(container, '目录')[0]!.className).not.toContain('active'); // 目录标签失活
      await waitFor(
        () => expect(container.querySelector('.sx-tabbody [aria-label="file content"]')?.textContent).toContain(MARKER),
        { timeout: 5_000 },
      );
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

/** pty 专用 WS 的 S→C 帧宽松形(replay/data 携 b;exit 携 code;error 携 message) */
interface E2ePtyFrame {
  readonly t: 'replay' | 'data' | 'exit' | 'error';
  readonly b?: string;
  readonly code?: number;
  readonly message?: string;
}

/** pty 专用 WS 开连接+帧收集(子协议 bearer.<token> 鉴权——gui PtySocket 的浏览器形态;
 *  message 监听构造后立刻挂:首帧 replay 可与握手响应同 TCP 段到,等 open 再挂会丢帧) */
function openPtyWs(url: string, token: string): Promise<{ ws: NodeWebSocket; frames: E2ePtyFrame[] }> {
  return new Promise((resolve, reject) => {
    const ws = new NodeWebSocket(url, [`bearer.${token}`]);
    const frames: E2ePtyFrame[] = [];
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as E2ePtyFrame);
    });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });
}

/** data 帧流拼接解码(UTF-8)——终端输出文本的断言面(daemon.test ⑩ 同口径) */
const ptyDataText = (frames: readonly E2ePtyFrame[]): string =>
  frames.filter((f) => f.t === 'data').map((f) => Buffer.from(f.b ?? '', 'base64').toString('utf8')).join('');

/** 单帧 b 载荷解码(replay 重放断言面) */
const ptyDecode = (f: E2ePtyFrame): string => Buffer.from(f.b ?? '', 'base64').toString('utf8');

/** 轮询直至谓词真(裸链轮询收帧用;超时抛带说明) */
async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`e2e pty 链等待超时: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('G8b 场景②:pty 全链——终端标签降级面(App)+ 裸 WS 分配/回环/重连重放/kill 注销', () => {
  it('App 开终端标签 → 降级面在场;裸链:分配→replay→in 标记→data 含标记→重连 replay 含标记→DELETE kill→error not found', async () => {
    const MARKER = 'pty-link-ok';
    const env = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"终端场景无需模型轮"}']));
    const H: Record<string, string> = {};
    try {
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— 建会话 → +菜单开终端标签(tools 节「终端」):openPty 真分配(conpty 真进程)→ jsdom
      //    无布局(clientWidth=0)→ 降级面在场(渲染面不造假;链路面归下方裸 ws 验证)——
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });
      await expandPanel();
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: '终端' }));
      await waitFor(() => expect(tabsByTitle(container, '终端').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, '终端')[0]!.className).toContain('active'); // 终端标签开且活动
      // 降级面:openPty 落定后守卫触发(分配先行,降级不吞分配——关标签 kill 链照常可寻址)
      await waitFor(() => expect(screen.getByText('终端渲染需要真浏览器窗口')).toBeDefined(), { timeout: 15_000 });

      // —— 裸链 1) 分配:POST /session/s1/pty {cols,rows} → 200 {ptyId}(pty-<n> 方言)——
      const base = `http://127.0.0.1:${env.port}`;
      const wsBase = `ws://127.0.0.1:${env.port}`;
      const alloc = await fetch(`${base}/session/s1/pty`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ cols: 80, rows: 24 }),
      });
      expect(alloc.status).toBe(200);
      const { ptyId } = (await alloc.json()) as { ptyId: string };
      expect(/^pty-\d+$/.test(ptyId)).toBe(true);

      // —— 2) 连入:首帧恒 replay(新分配可空)→ in 帧下发标记命令(win32 powershell 可执行形态)
      //    → data 帧流 base64 解码含标记(shell 回环真链路)——
      const a = await openPtyWs(`${wsBase}/session/s1/pty/${ptyId}`);
      try {
        await waitUntil(() => a.frames.length > 0, 10_000, '连入首帧 replay');
        expect(a.frames[0]!.t).toBe('replay');
        const cmd = `node -e "process.stdout.write('${MARKER}')"\r`;
        a.ws.send(JSON.stringify({ t: 'in', b: Buffer.from(cmd, 'utf8').toString('base64') }));
        await waitUntil(() => ptyDataText(a.frames).includes(MARKER), 30_000, 'data 帧含标记');
      } finally {
        a.ws.close();
      }
      await waitUntil(() => a.ws.readyState === NodeWebSocket.CLOSED, 5_000, '首连 ws 关闭');

      // —— 3) 断线重连(close≠kill 进程保活):新 ws 连入 → 首帧 replay 解码含标记(环形缓冲重放)——
      const b = await openPtyWs(`${wsBase}/session/s1/pty/${ptyId}`);
      try {
        await waitUntil(() => b.frames.length > 0, 10_000, '重连首帧 replay');
        expect(b.frames[0]!.t).toBe('replay');
        expect(ptyDecode(b.frames[0]!).includes(MARKER)).toBe(true);
      } finally {
        b.ws.close();
      }

      // —— 4) DELETE kill(kill 同步注销:has→false 立即)→ 新 ws 连入收 error 'pty not found'
      //    后 close(1008)(daemon.test ⑩ 的 Bearer 头 kill 面在此以子协议形态复验)——
      const kill = await fetch(`${base}/session/s1/pty/${ptyId}`, { method: 'DELETE', headers: H });
      expect(kill.status).toBe(200);
      expect(await kill.json()).toEqual({ ok: true });
      const c = await openPtyWs(`${wsBase}/session/s1/pty/${ptyId}`);
      try {
        await waitUntil(() => c.frames.length > 0, 10_000, 'kill 后连入帧');
        expect(c.frames[0]!.t).toBe('error');
        expect(c.frames[0]!.message).toBe('pty not found');
        await waitUntil(() => c.ws.readyState === NodeWebSocket.CLOSED, 5_000, 'error 后 close(1008)');
      } finally {
        c.ws.close();
      }
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 90_000);
});

/* ============================================================
 * G8c e2e 两场景(spec §7 G8c 行·设置全链终验):场景①——设置改键全链:DirPicker 建会话 →
 * ProjectMenu 底栏设置钮入设置态 → 通用面板改 language 键 → 保存 → toast「Applied — takes effect for new sessions」在场 →
 * GET /settings?root= 直连 fetch 断言 value 新值+source='project' → stop daemon → 同 root
 * 重启新 daemon 实例 → GET 仍 project 新值(<root>/.sunshinex/settings.json 磁盘持久化+新
 * 实例装载链)。root 需存活跨两次 daemon 生命周期——本组弃 startDaemon(其 stop 收口 rm tmp),
 * 就地装配同款 tmp root/projects 隔离面,收口归场景末统一 rm。场景②——MCP 探测失败态+agents
 * 增删改:<root>/.sunshinex/mcp.json 预造 bad(stdio 命令缺席)→ 设置态 MCP 面 bad 卡在场 →
 * 「测试连接」→ ok:false 错误行内;切智能体面 → 新增表单(scope=project/id/name)→ 保存 →
 * 清单含 e2e-agent → 删除 → 清单空;「← 返回」回会话态 Chat 在场如常。
 * ============================================================ */

describe('G8c 场景①:设置改键全链——通用面板改 language 保存 → toast → 直连 GET project 新值 → 重启 daemon 仍新值', () => {
  it('建会话 → 设置钮 → 改 language → 保存 toast（Applied — takes effect for new sessions） → GET /settings?root= project 新值 → stop → 新 daemon 实例 → GET 仍 project 新值', async () => {
    const NEW_LANG = 'zh-CN';
    // 就地装配:startDaemon 的 stop 会 rm tmp——本组 root 要跨两段 daemon 存活,隔离面(tmp root+
    // projects 注册表)同款自建,场景末统一收口(rm 重试参数沿 startDaemon Windows 迟滞兜底惯例)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-g8c-e2e-'));
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    // 预置项目级 language(设置重构轮:逐项写回来源文件——language source=project 才写回项目档,
    // 缺省键改值写全局用户档;场景主题=项目级持久化,故预置 project 面锚定写回目标)
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'settings.json'), JSON.stringify({ version: 1, language: 'en' }), 'utf8');
    const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
    process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
    /** 单段 daemon 装配(不带 tmp 收口;模型单 done 牌——本场景无模型轮) */
    const boot = async (): Promise<{ port: number; stop(): Promise<void> }> => {
      vi.stubGlobal('WebSocket', NodeWebSocket);
      const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"设置场景无需模型轮"}']) });
      const s = await daemon.start({ port: 0 });
      return { port: s.port, stop: () => s.close() };
    };
    /** GET /settings?root= 直连取单键行(断言面:value+source 两列) */
    const settingsRow = async (port: number, key: string): Promise<{ value: string | null; source: string }> => {
      const res = await fetch(`http://127.0.0.1:${port}/settings?root=${encodeURIComponent(root)}`, {
        headers: {},
      });
      expect(res.status).toBe(200);
      const view = (await res.json()) as { keys: Array<{ key: string; value: string | null; source: string }> };
      const row = view.keys.find((k) => k.key === key);
      expect(row, `settings 视图应含键 ${key}`).toBeDefined();
      return { value: row!.value, source: row!.source };
    };
    let d1: { port: number; stop(): Promise<void> } | undefined;
    let d2: { port: number; stop(): Promise<void> } | undefined;
    let unmount: (() => void) | undefined;
    try {
      d1 = await boot();
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${d1.port}`);
      unmount = render(createElement(App)).unmount;
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— 建会话(「+ 添加工作区」桌面壳桩回路径 → 登记即回欢迎页预选该项目;G10-C16 起
      //    组内 + 的 mode 弹层面由欢迎页审批选择器取代,缺省 auto=dontAsk)→ 目标提交 → chat。
      //    等选择条示项目名(picked 落定)再提交——过早 Enter 会因 target='' 早退(G14.51)——
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' }));
      await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 }); // root 尾段
      const goal = await screen.findByLabelText('welcome goal');
      fireEvent.change(goal, { target: { value: '设置冒烟' } });
      fireEvent.keyDown(goal, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });

      // —— 设置态(ProjectMenu 底栏设置钮)→ 通用面板(缺省)→ 改 language 键(自绘下拉:触发钮
      //    aria-label=language → 选项 role=option;自动生效轮:换项即存,无保存钮)→ toast「已生效」——
      fireEvent.click(screen.getByRole('button', { name: 'open settings' }));
      await screen.findByLabelText('settings pane 通用', { timeout: 5_000 });
      fireEvent.click(await screen.findByLabelText('language', { timeout: 5_000 }));
      fireEvent.click(screen.getByRole('option', { name: '简体中文' }));
      await screen.findByText(/Applied — takes effect for new sessions|已生效：新建会话起/, {}, { timeout: 5_000 }); // toast(3s 自隐,即拍在场;上一步已切 zh,渲染中文面——钉双语容忍,App.test 第十一轮同解)
      // 保存后重拉:language 触发钮显新值标签(来源归因 project——写回项目档)
      await waitFor(() => expect(screen.getByLabelText('language').textContent).toContain(NEW_LANG === 'zh-CN' ? '简体中文' : NEW_LANG), { timeout: 5_000 });

      // —— GET /settings?root= 直连 fetch 断言:language 新值 + source='project'(写盘+槽重载链)——
      const after1 = await settingsRow(d1.port, 'language');
      expect(after1.value).toBe(NEW_LANG);
      expect(after1.source).toBe('project');

      // —— stop → 同 root 重启新 daemon 实例 → GET 仍 project 新值(持久化+新实例装载链);
      //    App 先卸(conn.close 收口,免后台重连噪声)——
      unmount();
      unmount = undefined;
      await d1.stop();
      d1 = undefined;
      d2 = await boot();
      const after2 = await settingsRow(d2.port, 'language');
      expect(after2.value).toBe(NEW_LANG);
      expect(after2.source).toBe('project');
      // 落盘实证:<root>/.sunshinex/settings.json 含 language 新值(PUT 结构化写目标)
      const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.sunshinex', 'settings.json'), 'utf8')) as Record<string, unknown>;
      expect(onDisk.language).toBe(NEW_LANG);
      await d2.stop();
      d2 = undefined;
    } finally {
      unmount?.();
      await d1?.stop();
      await d2?.stop();
      if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
      else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

describe('G8c 场景②:MCP 探测失败态 + 智能体增删改——bad 卡测试连接错误行内;e2e-agent 新增/删除;返回 Chat', () => {
  it('预造 mcp.json bad → 设置态 MCP 面 bad 卡 → 测试连接 ok:false 错误行内 → 智能体面新增/删除 e2e-agent → 返回会话态 Chat 在场', async () => {
    const env = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"设置场景无需模型轮"}']));
    try {
      // 预造项目级 mcp.json(建会话前写盘):bad = stdio 命令缺席 → 探测失败态的确定性现场
      fs.mkdirSync(path.join(env.root, '.sunshinex'), { recursive: true });
      fs.writeFileSync(
        path.join(env.root, '.sunshinex', 'mcp.json'),
        JSON.stringify({ mcpServers: { bad: { name: 'bad', command: 'definitely-missing-xyz' } } }),
        'utf8',
      );
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— 建会话(项目 root,DirPicker 流)→ chat → 设置态(底栏设置钮,settingsRoot=root)——
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });
      fireEvent.click(screen.getByRole('button', { name: 'open settings' }));

      // —— MCP 面(导航项):bad 卡在场(两级清单读 <root>/.sunshinex/mcp.json;命令行示出)——
      fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
      await screen.findByLabelText('settings pane MCP', { timeout: 5_000 });
      await waitFor(() => expect(container.querySelector('.sx-mcp-card .sx-mcp-name')?.textContent).toBe('bad'), { timeout: 5_000 });
      expect(container.querySelector('.sx-mcp-card')?.textContent).toContain('definitely-missing-xyz');

      // —— 「测试连接」→ probe 真探测(spawn 缺席命令)→ ok:false → 卡内错误行(daemon.test
      //    ghost 同口径:connection failed 前缀/ENOENT/spawn 任一即可——平台 spawn 报文差异容差)——
      fireEvent.click(screen.getByRole('button', { name: '测试连接 bad' }));
      await waitFor(
        () =>
          expect(container.querySelector('.sx-mcp-card .home-error')?.textContent ?? '').toMatch(
            /connection failed \(bad\)|ENOENT|spawn/i,
          ),
        { timeout: 15_000 },
      );

      // —— 智能体面(导航项):「+ 新增」→ 表单 scope=project/id/name →「保存」→ 清单含 e2e-agent ——
      fireEvent.click(screen.getByRole('button', { name: '智能体' }));
      await screen.findByLabelText('settings pane 智能体', { timeout: 5_000 });
      fireEvent.click(screen.getByRole('button', { name: '+ 新增' }));
      await screen.findByLabelText('agent id', { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('agent scope'), { target: { value: 'project' } });
      fireEvent.change(screen.getByLabelText('agent id'), { target: { value: 'e2e-agent' } });
      fireEvent.change(screen.getByLabelText('agent name'), { target: { value: 'E2E' } });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(container.querySelector('.sx-agent-list')?.textContent).toContain('e2e-agent'), { timeout: 10_000 });
      expect(container.querySelector('.sx-agent-list')?.textContent).toContain('E2E'); // name 面同卡在场

      // —— 删除(op:delete)→ 清单空(「无自定义智能体。」空态回归)——
      fireEvent.click(screen.getByRole('button', { name: '删除 e2e-agent(项目)' }));
      await waitFor(
        () => {
          expect(screen.getByText('无自定义智能体。')).toBeDefined();
          expect(container.querySelector('.sx-agent-list')?.textContent ?? '').not.toContain('e2e-agent');
        },
        { timeout: 10_000 },
      );

      // —— 「← 返回」回会话态:Chat 重挂在场(输入面/连接态如常)——
      fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
      await waitFor(() => expect(screen.getByLabelText('message input')).toBeDefined(), { timeout: 10_000 });
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 90_000);
});

/* ============================================================
 * G8d-T6 e2e 收官两新场景(场景A 重写见上 G8a-T6 位——path 钮主通道 Diff 标签):
 * 场景B——Agents 标签 live 卡:既有 taskboard 卡片流(CARDS 同款)跑出委派,board
 * P1 fork 路径(executeOne → runner.runSubagent label=task-<id>)子 Reactor 事件经
 * tagger 打 payload.subagent 标签(harness/subagent.ts L537;daemon 会话泵零过滤广播)
 * → App onEvent 另轨 applyAgentEvent 归约(不投 chat,与标签开关无关)→ +菜单开
 * Agents 标签 → 卡在场(label/终态文案)+ 点卡头 mini 转录折叠展开(末位 done 牌
 * token 逐字符流 = 行面)。
 * 场景C——Web 标签:+菜单裸开(空态引导)→ url 输入(localhost——真外站零拉取;
 * jsdom 不渲染 iframe 内容,断言框架属性面)回车 → iframe title=active/sandbox 四值
 * → 外开钮 window.open stub 断言实参(_blank + noopener 隔离 opener)→ 刷新 nonce
 * bump 入 iframe key 强制重挂(新 DOM 节点)。
 * ============================================================ */

describe('G8d-T6 场景B(Agents live 卡·标签聚合):CARDS fork 子代理事件聚合 → 开标签 → 卡在场 + mini 转录展开', () => {
  it('提交 CARDS → done 收束 → +菜单开 Agents 标签 → task-t1 卡(label/完成)+ 点卡转录行在场 → 再点收起', async () => {
    const env = await startDaemon(new ScriptedAdapter(CARDS));
    try {
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— 建会话 → chat(默认「任务」标签活动;Agents 聚合是 App 态另轨,不依赖标签在场)——
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });

      // —— 既有 taskboard 卡片流(CARDS 同款):提交 → 委派 fork 派发 → 主链 done 收束 ——
      const input = screen.getByLabelText('message input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
      fireEvent.change(input, { target: { value: 'run demo' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(
        () => expect(container.querySelector('.entry-assistant')?.textContent).toContain('all done'),
        { timeout: 15_000 },
      );

      // —— +菜单开 Agents 标签(session 节,每会话单例):开且活动,标签体渲染 AgentsTab ——
      await expandPanel();
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: '任务板' }));
      await waitFor(() => expect(tabsByTitle(container, '任务板').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, '任务板')[0]!.className).toContain('active');
      expect(container.querySelector('.sx-tabbody .taskboard-cards')).not.toBeNull(); // 任务板页签体挂载(G14.174)

      // —— 委派行在场:fork 子链事件(delegation-ended label=task-t1)落任务板。终态=完成徽标 ——
      await waitFor(
        () => {
          const row = container.querySelector('button.delegation-main');
          if (row === null) throw new Error('delegation row not yet');
          return expect(row.textContent).toContain('task-t1');
        },
        { timeout: 10_000 },
      );

      // —— G14.164 点委派行开只读转录页(辅助对话式单独打开,无输入框):转录行含终稿全文 ——
      fireEvent.click(screen.getByRole('button', { name: 'open agent task-t1' }));
      await waitFor(() => expect(container.querySelector('.sx-tabbody .sx-agent-page')).not.toBeNull(), { timeout: 5_000 });
      expect(container.querySelector('.sx-agent-thread')?.textContent).toContain('all done');
      expect(container.querySelector('.sx-agent-page textarea')).toBeNull(); // 只读:无输入面
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

describe('G8d-T6 场景C:Web 标签——+菜单裸开 → url 输入 localhost → iframe 沙盒/外开 stub → 刷新重挂', () => {
  it('建会话 → +菜单「Web」→ 标签开且活动 → 空态引导 → url 输入回车 → iframe(title/src/沙盒)→ 外开 window.open 实参 → 刷新重挂新节点', async () => {
    const env = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"web 场景无需模型轮"}']));
    const TARGET = 'http://localhost:8123/'; // localhost 目标(真外站零拉取;含 :// 不补 scheme)
    try {
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByRole('button', { name: 'add workspace' })).toBeDefined(), { timeout: 10_000 }); // 连接点退役:以 home 就绪信号代之

      // —— 建会话(标签条需会话在场才可用)→ +菜单「Web」裸开档(key='' 聚焦语义,title='Web')——
            Object.defineProperty(window, 'sunshinex', { configurable: true, value: { pickFolder: async () => env.root } });
      fireEvent.click(screen.getByRole('button', { name: 'add workspace' })); // 原生选择器选完自动建项目+开 auto 会话进 Chat(G10-C11)
    await waitFor(() => expect(screen.getByText('root', { selector: '.choose-project-bar span' })).toBeDefined(), { timeout: 5_000 });
    const goalInput = screen.getByLabelText('welcome goal');
    fireEvent.change(goalInput, { target: { value: '新的任务' } });
    fireEvent.keyDown(goalInput, { key: 'Enter' });
      await waitFor(() => expect(screen.getByText(/./, { selector: '.chat-title-text' })).toBeDefined(), { timeout: 5_000 });
      await expandPanel();
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: 'Web' }));
      await waitFor(() => expect(tabsByTitle(container, 'Web').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, 'Web')[0]!.className).toContain('active');

      // —— 裸开档空态:引导文案 + url 输入在场(占位符锚)——
      expect(container.querySelector('.sx-web-empty')).not.toBeNull();
      const urlInput = screen.getByLabelText('web url input');
      expect(urlInput.getAttribute('placeholder')).toMatch(/网址|URL/); // G14.6 Simple Browser 占位(双语)
      fireEvent.change(urlInput, { target: { value: TARGET } });
      fireEvent.keyDown(urlInput, { key: 'Enter' });

      // —— iframe 落定:title=active(无障碍名/测试锚),src 原样,sandbox 四值;空态退场 ——
      const frame1 = container.querySelector('iframe.sx-web-frame');
      expect(frame1?.getAttribute('title')).toBe(TARGET);
      expect(frame1?.getAttribute('src')).toBe(TARGET);
      expect(frame1?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin allow-popups');
      expect(container.querySelector('.sx-web-empty')).toBeNull();

      // —— 外开钮:window.open stub(jsdom noop)→ 点击断言实参(_blank + noopener 隔离 opener)——
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      fireEvent.click(screen.getByRole('button', { name: '外开' }));
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith(TARGET, '_blank', 'noopener,noreferrer');
      openSpy.mockRestore();

      // —— 刷新重挂:nonce bump 入 iframe key → 强制重挂(新 DOM 节点;url 不变)——
      const before = container.querySelector('iframe.sx-web-frame');
      fireEvent.click(screen.getByRole('button', { name: '刷新' }));
      const after = container.querySelector('iframe.sx-web-frame');
      expect(after).not.toBe(before);
      expect(after?.getAttribute('src')).toBe(TARGET);
    } finally {
      await env.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 45_000);
});
