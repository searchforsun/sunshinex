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
 *  + node ws 客户端 stub;stop 幂等收口全量面 */
async function startDaemon(model: ModelAdapter, staticRoot?: string): Promise<{ port: number; root: string; stop(): Promise<void> }> {
  vi.stubGlobal('WebSocket', NodeWebSocket);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-g35-e2e-'));
  const root = path.join(tmp, 'root'); // 会话根(New session/DirPicker 确认目标)
  fs.mkdirSync(root, { recursive: true });
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  const daemon = new GuiDaemon({ model, ...(staticRoot !== undefined ? { staticRoot } : {}) });
  const s = await daemon.start({ port: 0, token: 'e2e-token' });
  return {
    port: s.port,
    root,
    stop: async () => {
      await s.close();
      if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
      else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
      fs.rmSync(tmp, { recursive: true, force: true });
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

    // —— New session → DirPicker 模态:自定义路径输入(真 daemon /dirpicker 服务端)→ 确认 → newSession → chat ——
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
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
