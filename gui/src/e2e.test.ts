import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
// 主仓 dist 直引(G2 装配裁定):gui pretest 先 clean+tsc 主仓,保证 dist 在场且新鲜——e2e 消费的
// 就是发布形态(dist/serve/daemon + dist/model/adapter 的 ScriptedAdapter),非 TS 源旁路
import { GuiDaemon } from '../../dist/serve/daemon';
import { ScriptedAdapter } from '../../dist/model/adapter';
import type { ModelAdapter } from '../../dist/model/adapter';
import { resolveDataDir } from '../../dist/config/data-dir';
import { SessionJournal } from '../../dist/tui/session-journal';
import type { ChatRequest, ChatResult, SessionEvent } from '../../src/types';
import { createConnection } from './connection';
import type { Connection, ConnectionState } from './connection';
import { App } from './App';

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
  const s = await daemon.start({ port: 0, token: 'e2e-token' });
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
      token: 'e2e-token',
      onEvent: (sessionId, e) => frames.push({ sessionId, e }),
      onReset: () => {},
    });
  }, 30_000);

  afterAll(async () => {
    conn?.close();
    await env?.stop();
    localStorage.removeItem('sunshinex.token');
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— Home:工作区行(title=root 在场,可 attach)→ 展开会话列表 → Attach ——
      fireEvent.click(await screen.findByTitle(env.root, {}, { timeout: 5_000 }));
      fireEvent.click(await screen.findByRole('button', { name: 'Attach' }, { timeout: 5_000 }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });

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
      expect(screen.getByText('session s1')).toBeDefined(); // 仍在会话(路由态)
    } finally {
      await env.stop();
      localStorage.removeItem('sunshinex.token');
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      const submit = async (goal: string): Promise<void> => {
        const input = screen.getByLabelText('message input');
        await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
        fireEvent.change(input, { target: { value: goal } });
        fireEvent.keyDown(input, { key: 'Enter' });
      };
      const backHome = async (): Promise<void> => {
        fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
        await screen.findByLabelText('welcome', {}, { timeout: 5_000 }); // G8a:Home 退役,返回=欢迎空态
      };

      // —— s1:工作区行展开 → Attach(journal 播种)→ UI 提交 → done ——
      fireEvent.click(await screen.findByTitle(env.root, {}, { timeout: 5_000 }));
      fireEvent.click(await screen.findByRole('button', { name: 'Attach' }, { timeout: 5_000 }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });
      await submit('s1 目标');
      await waitFor(() => expect(container.textContent).toContain('s1 终答'), { timeout: 10_000 });

      // —— back → s2:「+ 添加工作区」(DirPicker 同 root 第二会话)→ UI 提交 → done ——
      await backHome();
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s2')).toBeDefined(), { timeout: 5_000 });
      await submit('s2 目标');
      await waitFor(() => expect(container.textContent).toContain('s2 终答'), { timeout: 10_000 });
      // s2 投影独立:不含 s1 条目(Chat unmount 本地态销毁,无跨会话串扰)
      expect(container.textContent).not.toContain('s1 目标');
      expect(container.textContent).not.toContain('s1 终答');
      expect(container.textContent).not.toContain('历史第一句');

      // —— 经 UI 返回 s1:back → 组重展开收放(sx 壳常驻:组仍展开但列表为展开时快照——收起再
      //    展开触发 sessionsOf 重拉,s1/s2 档齐)→ Attach 同一 journal(两步壳)→ 转录播种在场 ——
      // (T2 起新建会话即挂 journal——列表 s1/s2 两档各一行;播种档无 t:'user' 行 → 无摘要,
      //  以 journal id 定行:session-meta 含 id 文本)
      await backHome();
      fireEvent.click(await screen.findByTitle(env.root, {}, { timeout: 5_000 })); // 收起(壳常驻,组仍展开)
      fireEvent.click(screen.getByTitle(env.root)); // 重展开 → sessionsOf 重拉(含 s2 新建档)
      const attachButtons = await screen.findAllByRole('button', { name: 'Attach' }, { timeout: 5_000 });
      expect(attachButtons.length).toBeGreaterThanOrEqual(2); // s1 播种档 + s2 新建档(T2 即挂)
      const s1Attach = attachButtons.find((b) => b.closest('.session-row')?.textContent?.includes(s1Journal));
      expect(s1Attach).toBeDefined();
      fireEvent.click(s1Attach!);
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
      localStorage.removeItem('sunshinex.token');
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
      token: 'e2e-token',
      onEvent: (_sessionId, e) => events.push(e),
      onReset: () => {},
    });
  }, 30_000);

  afterAll(async () => {
    conn?.close();
    await env?.stop();
    localStorage.removeItem('sunshinex.token');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('New session(DirPicker 自定义路径)→ chat → 提交流式 → steer 200 → done 收段', async () => {
    // App 挂载:token 门面 + baseUrl 经 stubEnv 注入;初始路由 home(空注册表 → 空态引导)
    localStorage.setItem('sunshinex.token', 'e2e-token');
    vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
    const { container } = render(createElement(App));
    await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

    // —— 「+ 添加工作区」(G8a:New session 按钮退役,DirPicker 流经左栏添加面)→ DirPicker 模态:
    //    自定义路径输入(真 daemon /dirpicker 服务端)→ 确认 → newSession → chat ——
    fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
    await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
    fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
    await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });

    // —— 真实 UI 提交路径:输入 + Enter(idle 分流 = sessionSubmit;输入启用 = 播种落定后)——
    const input = screen.getByLabelText('message input');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
    fireEvent.change(input, { target: { value: '流式冒烟' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // —— 流式中间态:token 增量分帧到场(连接层事件 + DOM streaming 条),run 确在进行中 ——
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
    // UI 提交的本地 user 回显(> 流式冒烟 引用块)
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
      token: 'e2e-token',
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
    localStorage.removeItem('sunshinex.token');
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
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
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— manual 会话经 UI 真面建立:「+ 添加工作区」 → DirPicker 勾「Manual approvals」→ 确认 ——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByLabelText('Manual approvals'));
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });
      expect(newBodies.some((b) => b.mode === 'manual' && b.root === env.root)).toBe(true); // 真 UI 面 mode 断言

      // —— UI 提交 → write envelope 越信任域 → manual 挂起 → approval 帧经 WS → ApprovalCard ——
      const input = screen.getByLabelText('message input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
      fireEvent.change(input, { target: { value: 'manual 写一个文件' } });
      fireEvent.keyDown(input, { key: 'Enter' });
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
      localStorage.removeItem('sunshinex.token');
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
    const H: Record<string, string> = { authorization: 'Bearer e2e-token' };
    try {
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      const openByPicker = async (): Promise<void> => {
        fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
        await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
        fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
        fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
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
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });
      await runOnce('第一会话目标', '第一会话完成');
      fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
      await screen.findByLabelText('welcome', {}, { timeout: 5_000 }); // G8a:Home 退役,返回=欢迎空态
      await openByPicker();
      await waitFor(() => expect(screen.getByText('session s2')).toBeDefined(), { timeout: 5_000 });
      await runOnce('第二会话目标', '第二会话完成');

      // —— s2 会话页顶栏 Delete(confirm 桩真):以 openSessionId(daemon 会话 id)打
      //    /session/:id/delete——Home 行 Delete 以 journal id 寻址恒 404 的接线缺口就此退役 ——
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      // 删除成功 → onBack → 欢迎空态回归(会话关窗)
      await screen.findByLabelText('welcome', {}, { timeout: 5_000 });
      confirmSpy.mockRestore();

      // —— daemon 侧真实回收:s2 移出注册表(:id 访问 404);journal 文件保留(磁盘档案)——
      const gone = await fetch(`http://127.0.0.1:${env.port}/session/s2/snapshot`, { headers: H });
      expect(gone.status).toBe(404);
      const journals = fs
        .readdirSync(path.join(resolveDataDir(env.root), 'sessions'))
        .filter((f) => f.endsWith('.jsonl'));
      expect(journals.length).toBe(2); // journal 保留(T2 裁定:磁盘档案非 daemon 生命周期资产)
    } finally {
      await env.stop();
      localStorage.removeItem('sunshinex.token');
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
      token: 'e2e-token',
      onEvent: (_sessionId, e) => frames.push(e),
      onReset: () => {},
    });
    try {
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— 「+ 添加工作区」(DirPicker 真面,缺省不勾 manual)→ 提交 → 主链 create_task(gated)——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });
      const input = screen.getByLabelText('message input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
      fireEvent.change(input, { target: { value: 'run gated demo' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // —— 等事件流:task-created + gate-waiting(daemon board.create 发射序)——
      await waitFor(() => expect(frames.some((e) => e.type === 'task-created')).toBe(true), { timeout: 10_000 });
      await waitFor(() => expect(frames.some((e) => e.type === 'gate-waiting')).toBe(true), { timeout: 5_000 });

      // —— 任务标签(G8a:右栏默认开「任务」页,Board 恒挂——原 Board tab 钮退役)→ List
      //    视图(缺省):gated ⚠ Badge 行 + 行内 Approve/Deny(G8d T5:⚠ 文本面 Badge 化)——
      await waitFor(() => expect(screen.getByText('t1 [pending] GateDemo')).toBeDefined(), { timeout: 10_000 });
      await waitFor(() => expect(container.querySelector('.sx-badge.sx-badge-warn')?.textContent).toBe('⚠'), { timeout: 5_000 });
      expect(screen.getByRole('button', { name: 'Approve t1' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Deny t1' })).toBeDefined();

      // —— DAG 视图:svg 盒断言(data-task t1 在场,gated 类钩子)——
      fireEvent.click(screen.getByRole('button', { name: 'DAG' }));
      await waitFor(() => expect(container.querySelector('svg.board-dag [data-task="t1"]')).not.toBeNull(), { timeout: 5_000 });
      expect(container.querySelector('svg.board-dag [data-task="t1"]')?.getAttribute('class')).toContain('gated');

      // —— 回 List → Approve 点击(经 UI:conn.boardReview(s1, t1, true))→ 事件流驱动板自更新 ——
      fireEvent.click(screen.getByRole('button', { name: 'List' }));
      fireEvent.click(screen.getByRole('button', { name: 'Approve t1' }));
      await waitFor(() => expect(frames.some((e) => e.type === 'gate-resolved')).toBe(true), { timeout: 10_000 });
      await waitFor(() => expect(frames.some((e) => e.type === 'task-status-changed')).toBe(true), { timeout: 5_000 });
      // 板 UI 更新:门消失 + 状态流转 pending→claimed→…→in-review(fork 消化末位 done 牌后强制回写)
      await waitFor(() => expect(screen.getByText('t1 [in-review] GateDemo')).toBeDefined(), { timeout: 15_000 });
      expect(container.textContent).not.toContain('⚠');
      // 派发面:fork 委派(task-t1)在板侧栏落位
      await waitFor(() => expect(container.querySelector('.delegation-list')?.textContent).toContain('task-t1'), { timeout: 5_000 });
    } finally {
      conn.close();
      await env.stop();
      localStorage.removeItem('sunshinex.token');
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— dontAsk 会话经 UI 真面建立(DirPicker 缺省不勾 manual;G8a:经「+ 添加工作区」)——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });

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

      // —— 工具条展开(实时帧 callId 配对面)→ fetchDiff → DiffPanel 双列 ——
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`● write ${REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `) }));
      // 加载期先示右列现内容(单列+加载标)——双列落定以 old 列在场为准(waitFor 过拉取竞态窗)
      await waitFor(() => expect(container.querySelector('.diff-panel .diff-old')).not.toBeNull(), { timeout: 5_000 });
      expect(container.querySelector('.diff-panel .diff-old')?.textContent).toBe(OLD); // old 列 = pre-image blob
      expect(container.querySelector('.diff-panel .diff-new')?.textContent).toBe(NEW); // new 列 = 磁盘现文件
      expect(container.querySelectorAll('.diff-panel .diff-col').length).toBe(2); // 双列(old 缺场才单列)
      expect(container.querySelector('.diff-loading')).toBeNull(); // 拉取落定,非加载态
      expect(container.querySelector('.tool-path')?.textContent).toBe(REL); // path 跳转按钮(Files 预览入口)
    } finally {
      await env.stop();
      localStorage.removeItem('sunshinex.token');
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— manual 会话经 UI 真面建立:DirPicker 勾「Manual approvals」(G8a:经「+ 添加工作区」)——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByLabelText('Manual approvals'));
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });

      // —— 提交:首轮模型轮挂在 gate 上(run 进行中,未到 write 挂起点)——
      const input = screen.getByLabelText('message input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
      fireEvent.change(input, { target: { value: '挂起重连目标' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // —— 断线注入:App 自装配连接的底层 socket(挂起广播前的零客户端窗)——
      const appSock = sockets[sockets.length - 1]!;
      appSock.close();
      await waitFor(() => expect(screen.getByLabelText('connection: reconnecting')).toBeDefined(), { timeout: 5_000 });

      // —— 放行:write envelope 越域 → manual 挂起 → approval 广播零客户端 ——
      gated!.release();
      const H = { authorization: 'Bearer e2e-token' } as Record<string, string>;
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
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });
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
      localStorage.removeItem('sunshinex.token');
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
  Array.from(container.querySelectorAll(`.sx-tab[title="${title}"]`));

describe('G8a-T6 场景A(G8d-T6 重写):默认任务页 + write 条目 path 钮开 Diff 标签(判重聚焦;文件标签面走 +菜单)', () => {
  it('建会话 → 「任务」默认在场且活动 → write path 钮 → Diff 标签开且活动(title=path)→ 双列 → 再点同 path 判重 → +菜单「文件」+路径输入补文件预览', async () => {
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— 建会话(「+ 添加工作区」DirPicker 缺省 auto)→ chat ——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });

      // —— 默认任务页:右栏标签条唯一标签「任务」且活动(ensureSession 缺省开 tasks 单例)——
      await waitFor(() => expect(tabsByTitle(container, '任务').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, '任务')[0]!.className).toContain('active'); // sx-tab active
      expect(tabsByTitle(container, REL).length).toBe(0); // Diff 标签未开
      // 任务标签体在场:标签体渲染 tabEntry('tasks').render = Board(既有看板面)
      expect(container.querySelector('.sx-tabbody .board-main')).not.toBeNull();

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
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`● write ${REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `) }));
      const pathBtn = container.querySelector<HTMLButtonElement>('.tool-path');
      expect(pathBtn?.textContent).toBe(REL);
      expect(pathBtn?.title).toBe('打开 diff 标签'); // 主通道标识(缺场回落面才示「在文件标签预览」)
      fireEvent.click(pathBtn!);
      await waitFor(() => expect(tabsByTitle(container, REL).length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, REL)[0]!.className).toContain('active'); // Diff 标签活动
      expect(tabsByTitle(container, '任务')[0]!.className).not.toContain('active'); // 任务失活
      expect(container.querySelectorAll('.sx-tab').length).toBe(2); // 任务 + Diff

      // —— Diff 标签体:DiffTab mount 拉 conn.fetchDiff(callId)→ 标题行(path)+ DiffPanel
      //    双列(old=pre-image 影子快照 / new=磁盘现文件)——真 daemon write 影子快照的应答渲染 ——
      await waitFor(
        () => expect(container.querySelector('.sx-tabbody .diff-panel .diff-old')).not.toBeNull(),
        { timeout: 5_000 },
      );
      expect(container.querySelector('.sx-tabbody .diff-panel .diff-old')?.textContent).toBe(OLD);
      expect(container.querySelector('.sx-tabbody .diff-panel .diff-new')?.textContent).toBe(NEW);
      expect(container.querySelectorAll('.sx-tabbody .diff-panel .diff-col').length).toBe(2); // 双列
      expect(container.querySelector('.sx-tabbody .sx-diff-path')?.textContent).toBe(REL); // 标题行 path
      expect(container.querySelector('.sx-tabbody .files-view')).toBeNull(); // 标签体是 Diff 面,非 Files 面

      // —— 判重聚焦:再点同 path 钮(同 callId 重开)→ Diff 标签数恰 1(聚焦既有,不重复)——
      fireEvent.click(container.querySelector<HTMLButtonElement>('.tool-path')!);
      expect(tabsByTitle(container, REL).length).toBe(1);
      expect(tabsByTitle(container, REL)[0]!.className).toContain('active'); // 聚焦保持
      expect(container.querySelectorAll('.sx-tab').length).toBe(2); // 标签总数不变

      // —— 文件标签面(G8a 原覆盖保:path 钮主通道已迁 Diff,文件标签另走 +菜单裸开 → 路径输入
      //    加载):「文件」标签开且活动 → 输入 REL 回车 → files-view 载磁盘现文件 ——
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: '文件' }));
      await waitFor(() => expect(tabsByTitle(container, '文件').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, '文件')[0]!.className).toContain('active');
      const pathInput = screen.getByLabelText('file path input');
      fireEvent.change(pathInput, { target: { value: REL } });
      fireEvent.keyDown(pathInput, { key: 'Enter' });
      await waitFor(
        () => expect(container.querySelector('.sx-tabbody .files-view')?.textContent).toContain(NEW),
        { timeout: 5_000 },
      );
      expect(container.querySelectorAll('.sx-tab').length).toBe(3); // 任务 + Diff + 文件
    } finally {
      await env.stop();
      localStorage.removeItem('sunshinex.token');
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

describe('G8a-T6 场景B(看板消费·任务标签):CARDS 全链 → 切任务标签 → 任务行在场', () => {
  it('提交 CARDS → done 收束 → 经「+」菜单开文件标签(任务失活)→ 切回「任务」标签 → t1 行/委派落位', async () => {
    const env = await startDaemon(new ScriptedAdapter(CARDS));
    try {
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— 建会话 → chat;默认「任务」标签活动(场景A 已钉,此处直用)——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });
      await waitFor(() => expect(tabsByTitle(container, '任务').length).toBe(1), { timeout: 5_000 });

      // —— 既有 taskboard 卡片流(文件头 CARDS 同款):提交 → done 收束 → 板/委派投影落位 ——
      const input = screen.getByLabelText('message input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false), { timeout: 5_000 });
      fireEvent.change(input, { target: { value: 'run demo' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(
        () => expect(container.querySelector('.entry-assistant')?.textContent).toContain('all done'),
        { timeout: 15_000 },
      );

      // —— 任务标签失活现场:「+」菜单开文件标签(无参 file → 标签条第二页且活动)——
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: '文件' }));
      await waitFor(() => expect(tabsByTitle(container, '文件').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, '文件')[0]!.className).toContain('active');
      expect(tabsByTitle(container, '任务')[0]!.className).not.toContain('active');
      expect(container.querySelector('.sx-tabbody .board-main')).toBeNull(); // 标签体随活动切换

      // —— 切回「任务」标签 → 看板消费:任务行文本在场(既有 Board 断言面)+ 委派侧栏 ——
      fireEvent.click(container.querySelector<HTMLButtonElement>('.sx-tab[title="任务"]')!);
      await waitFor(() => expect(screen.getByText('t1 [in-review] Demo')).toBeDefined(), { timeout: 10_000 });
      expect(tabsByTitle(container, '任务')[0]!.className).toContain('active');
      expect(container.querySelector('.delegation-list')?.textContent).toContain('task-t1');
      expect(container.querySelector('.delegation-list')?.textContent).toContain('done');
    } finally {
      await env.stop();
      localStorage.removeItem('sunshinex.token');
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

/* ============================================================
 * G8b e2e 两场景(spec §12 G8b 行·终端/目录):场景①——fixture 造 dirA/fileA.ts(内容
 * 标记串)→ 建会话进 chat → +菜单开目录标签(menuitem 目录)→ mount 惰拉 root → 根行
 * dirA 在场 → 展开拉单层 → 点 fileA.ts 文件行 → 文件标签开且活动(title=dirA/fileA.ts)
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— 建会话(「+ 添加工作区」DirPicker 缺省 auto)→ chat(默认「任务」标签活动)——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });

      // —— +菜单开目录标签(content 节「目录」,单例)→ mount 惰拉 root → 根行 dirA 在场 ——
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

      // —— 点 fileA.ts → openTab('file',{path:'dirA/fileA.ts'})→ 文件标签开且活动;Files
      //    经 initialPath 自动加载 → 标记串(磁盘真内容)渲染 ——
      fireEvent.click(fileRow);
      await waitFor(() => expect(tabsByTitle(container, 'dirA/fileA.ts').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, 'dirA/fileA.ts')[0]!.className).toContain('active'); // 文件标签活动
      expect(tabsByTitle(container, '目录')[0]!.className).not.toContain('active'); // 目录标签失活
      await waitFor(
        () => expect(container.querySelector('.sx-tabbody .files-view')?.textContent).toContain(MARKER),
        { timeout: 5_000 },
      );
    } finally {
      await env.stop();
      localStorage.removeItem('sunshinex.token');
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
    const H: Record<string, string> = { authorization: 'Bearer e2e-token' };
    try {
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— 建会话 → +菜单开终端标签(tools 节「终端」):openPty 真分配(conpty 真进程)→ jsdom
      //    无布局(clientWidth=0)→ 降级面在场(渲染面不造假;链路面归下方裸 ws 验证)——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });
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
      const a = await openPtyWs(`${wsBase}/session/s1/pty/${ptyId}`, 'e2e-token');
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
      const b = await openPtyWs(`${wsBase}/session/s1/pty/${ptyId}`, 'e2e-token');
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
      const c = await openPtyWs(`${wsBase}/session/s1/pty/${ptyId}`, 'e2e-token');
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
      localStorage.removeItem('sunshinex.token');
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 90_000);
});

/* ============================================================
 * G8c e2e 两场景(spec §7 G8c 行·设置全链终验):场景①——设置改键全链:DirPicker 建会话 →
 * ProjectMenu 底栏设置钮入设置态 → 通用面板改 language 键 → 保存 → toast「已生效」在场 →
 * GET /settings?root= 直连 fetch 断言 value 新值+source='project' → stop daemon → 同 root
 * 重启新 daemon 实例 → GET 仍 project 新值(<root>/.sunshinex/settings.json 磁盘持久化+新
 * 实例装载链)。root 需存活跨两次 daemon 生命周期——本组弃 startDaemon(其 stop 收口 rm tmp),
 * 就地装配同款 tmp root/projects 隔离面,收口归场景末统一 rm。场景②——MCP 探测失败态+agents
 * 增删改:<root>/.sunshinex/mcp.json 预造 bad(stdio 命令缺席)→ 设置态 MCP 面 bad 卡在场 →
 * 「测试连接」→ ok:false 错误行内;切智能体面 → 新增表单(scope=project/id/name)→ 保存 →
 * 清单含 e2e-agent → 删除 → 清单空;「← 返回」回会话态 Chat 在场如常。
 * ============================================================ */

describe('G8c 场景①:设置改键全链——通用面板改 language 保存 → toast → 直连 GET project 新值 → 重启 daemon 仍新值', () => {
  it('建会话 → 设置钮 → 改 language → 保存 toast 已生效 → GET /settings?root= project 新值 → stop → 新 daemon 实例 → GET 仍 project 新值', async () => {
    const NEW_LANG = 'fr';
    // 就地装配:startDaemon 的 stop 会 rm tmp——本组 root 要跨两段 daemon 存活,隔离面(tmp root+
    // projects 注册表)同款自建,场景末统一收口(rm 重试参数沿 startDaemon Windows 迟滞兜底惯例)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-g8c-e2e-'));
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
    process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
    /** 单段 daemon 装配(不带 tmp 收口;模型单 done 牌——本场景无模型轮) */
    const boot = async (): Promise<{ port: number; stop(): Promise<void> }> => {
      vi.stubGlobal('WebSocket', NodeWebSocket);
      const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"设置场景无需模型轮"}']) });
      const s = await daemon.start({ port: 0, token: 'e2e-token' });
      return { port: s.port, stop: () => s.close() };
    };
    /** GET /settings?root= 直连取单键行(断言面:value+source 两列) */
    const settingsRow = async (port: number, key: string): Promise<{ value: string | null; source: string }> => {
      const res = await fetch(`http://127.0.0.1:${port}/settings?root=${encodeURIComponent(root)}`, {
        headers: { authorization: 'Bearer e2e-token' },
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${d1.port}`);
      unmount = render(createElement(App)).unmount;
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— 建会话(「+ 添加工作区」DirPicker 缺省 auto,项目 root=会话根)→ chat ——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });

      // —— 设置态(ProjectMenu 底栏设置钮)→ 通用面板(缺省)→ 改 language 键(SettingsForm 行
      //    label=键名,aria-label=language)→「保存」→ toast「已生效」在场 ——
      fireEvent.click(screen.getByRole('button', { name: 'open settings' }));
      await screen.findByLabelText('settings pane 通用', { timeout: 5_000 });
      const langInput = await screen.findByLabelText('language', { timeout: 5_000 });
      fireEvent.change(langInput, { target: { value: NEW_LANG } });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await screen.findByText('已生效:新建会话起', {}, { timeout: 5_000 }); // toast(3s 自隐,即拍在场)
      // 保存后重拉:language 行值回落为新值(来源归因 project)
      await waitFor(() => expect((screen.getByLabelText('language') as HTMLInputElement).value).toBe(NEW_LANG), { timeout: 5_000 });

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
      localStorage.removeItem('sunshinex.token');
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— 建会话(项目 root,DirPicker 流)→ chat → 设置态(底栏设置钮,settingsRoot=root)——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });
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
      expect(screen.getByLabelText('connection: open')).toBeDefined();
    } finally {
      await env.stop();
      localStorage.removeItem('sunshinex.token');
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— 建会话 → chat(默认「任务」标签活动;Agents 聚合是 App 态另轨,不依赖标签在场)——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });

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
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: 'Agents' }));
      await waitFor(() => expect(tabsByTitle(container, 'Agents').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, 'Agents')[0]!.className).toContain('active');
      expect(container.querySelector('.sx-tabbody .sx-agents-tab')).not.toBeNull(); // 标签体挂载

      // —— live 卡在场:fork 子链事件(payload.subagent=task-t1)聚合落卡。主链 done 在先不保
      //    fork 收束序(派发异步)——waitFor 过竞态窗;终态=完成(fork done 事件 + delegation-ended
      //    label 命中双源收敛)——
      await waitFor(
        () => expect(container.querySelector('.sx-agents-list .sx-subagent-card .sx-subagent-status')?.textContent).toBe('完成'),
        { timeout: 10_000 },
      );
      const card = container.querySelector('.sx-agents-list .sx-subagent-card')!;
      expect(card.textContent).toContain('task-t1'); // label(runSubagent finalLabel 口径)
      expect(container.querySelector('.sx-agents-empty')).toBeNull(); // 空态文案退场(卡在场)

      // —— mini 转录折叠展开:点卡头 → 行在场(末位 done 牌 token 逐字符流——剥行首两格
      //    token 缩进前缀后逐行拼回即终稿全文)——
      fireEvent.click(screen.getByRole('button', { name: 'agent card task-t1' }));
      const lines = container.querySelector('.sx-subagent-lines');
      expect(lines).not.toBeNull();
      expect(lines?.textContent?.split('\n').map((l) => l.replace(/^  /, '')).join('')).toBe('all done');
      // 折叠收起:再点卡头 → 转录退场
      fireEvent.click(screen.getByRole('button', { name: 'agent card task-t1' }));
      expect(container.querySelector('.sx-subagent-lines')).toBeNull();
    } finally {
      await env.stop();
      localStorage.removeItem('sunshinex.token');
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
      localStorage.setItem('sunshinex.token', 'e2e-token');
      vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
      const { container } = render(createElement(App));
      await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

      // —— 建会话(标签条需会话在场才可用)→ +菜单「Web」裸开档(key='' 聚焦语义,title='Web')——
      fireEvent.click(screen.getByRole('button', { name: '+ 添加工作区' }));
      await screen.findByRole('dialog', { name: 'choose directory' }, { timeout: 5_000 });
      fireEvent.change(screen.getByLabelText('custom path'), { target: { value: env.root } });
      fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));
      await waitFor(() => expect(screen.getByText('session s1')).toBeDefined(), { timeout: 5_000 });
      fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
      await screen.findByRole('menu', { name: 'new tab types' }, { timeout: 5_000 });
      fireEvent.click(screen.getByRole('menuitem', { name: 'Web' }));
      await waitFor(() => expect(tabsByTitle(container, 'Web').length).toBe(1), { timeout: 5_000 });
      expect(tabsByTitle(container, 'Web')[0]!.className).toContain('active');

      // —— 裸开档空态:引导文案 + url 输入在场(占位符锚)——
      expect(container.querySelector('.sx-web-empty')).not.toBeNull();
      const urlInput = screen.getByLabelText('web url input');
      expect(urlInput.getAttribute('placeholder')).toContain('https');
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
      localStorage.removeItem('sunshinex.token');
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }, 45_000);
});
