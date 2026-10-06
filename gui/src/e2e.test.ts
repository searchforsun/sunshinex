import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
// 主仓 dist 直引（G2 装配裁定）：gui pretest 先 clean+tsc 主仓，保证 dist 在场且新鲜——e2e 消费的
// 就是发布形态（dist/serve/daemon + dist/model/adapter 的 ScriptedAdapter），非 TS 源旁路
import { GuiDaemon } from '../../dist/serve/daemon';
import { ScriptedAdapter } from '../../dist/model/adapter';
import type { ModelAdapter } from '../../dist/model/adapter';
import type { ChatRequest, ChatResult, SessionEvent } from '../../src/types';
import { createConnection } from './connection';
import type { Connection, ConnectionState, SnapshotResponse } from './connection';
import { App } from './App';

/**
 * G2 无头验收 e2e（spec §12）：真 GuiDaemon（dist）→ createConnection 全链（HTTP /snapshot+/submit +
 * WS /events 经 subprotocol 鉴权——浏览器路径）→ snapshot 出静态转录与板 → App 纯渲染断言。
 * 全链事件序（taskboard.e2e 实测口径）：主链 create_task 牌 → 板派发 fork（fork 消费末位 done 牌）→
 * 强制回写 claimed→in-review → 主链再取（末位 done 牌重复供牌）→ run 收束。注意 fork 自身也发 done
 * （先于主链 done），故收敛判据 = snapshot status idle + 板/委派落位，不以首个 done 为准。
 */

/** 两卡脚本：create_task 建 t1（六入参全给 null 形）+ done 终答；末位 done 牌重复供牌（ScriptedAdapter 语义） */
const CARDS = [
  '{"tool":"create_task","input":{"title":"Demo","spec":"demo task","dependsOn":null,"assignee":null,"gated":null,"executor":null}}',
  '{"done":true,"reply":"all done"}',
];

describe('G2 无头验收：真 daemon 全链 → snapshot → App 渲染', () => {
  let conn: Connection;
  let handle: { close(): Promise<void> };
  let tmp: string;
  let port = 0;
  let prevDataDir: string | undefined;
  const events: SessionEvent[] = [];

  beforeAll(async () => {
    // jsdom 自带 WebSocket 对 subprotocol 握手语义不可靠，以 node ws 客户端替换 globalThis——
    // 连接层代码面仍只依赖 WHATWG WebSocket 形态（new WebSocket(url, protocols)）
    vi.stubGlobal('WebSocket', NodeWebSocket);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-gui-e2e-'));
    prevDataDir = process.env.SUNSHINEX_DATA_DIR;
    process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
    const daemon = new GuiDaemon({ root: tmp, model: new ScriptedAdapter(CARDS) });
    const s = await daemon.start({ port: 0, token: 'e2e-token' });
    handle = s;
    port = s.port;
    // G3 连接层重做：单连接生命周期（创建即连 WS，事件经 onEvent 回调消费）——subscribe 退场
    conn = createConnection({
      baseUrl: `http://127.0.0.1:${s.port}`,
      token: 'e2e-token',
      onEvent: (e) => events.push(e),
      onResync: () => {},
    });
  }, 30_000);

  afterAll(async () => {
    conn?.close();
    await handle?.close();
    if (prevDataDir === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevDataDir;
    if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true });
    localStorage.removeItem('sunshinex.token');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('全链：初始空 snapshot → submit → 事件流至 done（idle 收敛）→ 转录/板/委派落位 → App 渲染出转录行与板行', async () => {
    // —— 初始 snapshot：空板空转录 idle（连接装配的冷启动面）——
    const snap0 = await conn.snapshot();
    expect(snap0.messages).toEqual([]);
    expect(snap0.board.tasks).toEqual({});
    expect(snap0.delegations).toEqual([]);
    expect(snap0.status).toBe('idle');

    // —— submit 起跑 ——
    await conn.submit('run demo');

    // —— 等事件流至 done 且影子态收敛（超时 10s；idle 判据见文件头注释：fork done 在先，主链 done 收尾）——
    const deadline = Date.now() + 10_000;
    let snap1 = await conn.snapshot();
    const settled = (): boolean =>
      events.some((e) => e.type === 'done') &&
      snap1.status === 'idle' &&
      snap1.board.tasks.t1 !== undefined &&
      snap1.delegations.length > 0;
    while (!settled()) {
      if (Date.now() > deadline) {
        throw new Error(`全链未收敛: events=${JSON.stringify(events.map((e) => e.type))} snap=${JSON.stringify(snap1)}`);
      }
      await new Promise((r) => setTimeout(r, 25));
      snap1 = await conn.snapshot();
    }

    // —— 转录（粗粒度三类）：user 提交回显 / assistant 终答 / tool 配对条 ——
    expect(snap1.messages.some((m) => m.kind === 'user' && m.md === '> run demo')).toBe(true);
    expect(snap1.messages.some((m) => m.kind === 'assistant' && m.md === 'all done')).toBe(true);
    const tool = snap1.messages.find((m) => m.kind === 'tool');
    expect(tool).toBeDefined();
    expect(tool!.md.startsWith('● create_task')).toBe(true);

    // —— 板：t1 在场，fork 完成强制回写后未 review → in-review ——
    expect(snap1.board.tasks.t1?.title).toBe('Demo');
    expect(snap1.board.tasks.t1?.status).toBe('in-review');

    // —— 委派：create_task 经板派发 fork，delegation 事件流经影子投影 ——
    const del = snap1.delegations.find((d) => d.id === 'task-t1');
    expect(del).toBeDefined();
    expect(del!.kind).toBe('subagent');
    expect(del!.status).toBe('done');

    // —— WS 事件面（subprotocol 鉴权路径）全链在场 ——
    const types = events.map((e) => e.type);
    expect(types).toContain('task-created');
    expect(types).toContain('delegation-started');
    expect(types).toContain('delegation-ended');
    expect(types).toContain('done');

    // —— App 装配渲染（G3：App() 无 props 自装配——真连接指向本 daemon，baseUrl 经 vi.stubEnv
    //    注入 VITE_SERVE_URL、token 经 localStorage 注入；onResync 以 snapshot.messages 种子渲染
    //    转录 md 面（user 引用块/assistant 终答/tool 配对条）。板行断言随 Board 视图 G5 退场——
    //    板态本身保留在前段 snapshot 断言）——
    localStorage.setItem('sunshinex.token', 'e2e-token');
    vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${port}`);
    const { container } = render(createElement(App));
    await waitFor(() => expect(container.querySelector('.entry-assistant')?.textContent).toContain('all done'), { timeout: 5_000 });
    expect(container.querySelector('.entry-user blockquote')?.textContent?.trim()).toBe('run demo');
    const toolRow = container.querySelector('.entry-tool');
    expect(toolRow?.textContent).toContain('● create_task');
    expect(screen.getByLabelText('connection: open')).toBeDefined();
  }, 30_000);
});

/* ============================================================
 * G3 冒烟验收（spec §12）：①提交→流式渲染→done 收段 ②steer 运行中
 * ③断线重连恢复（daemon 真链路）④静态挂载回 html。每场景独立 daemon
 * （hermetic tmp root + SUNSHINEX_DATA_DIR 隔离），适配器按场景注入。
 * ============================================================ */

/** 每场景独立 daemon 装配：tmp root + data 隔离 + node ws 客户端 stub；stop 幂等收口全量面 */
async function startDaemon(model: ModelAdapter, staticRoot?: string): Promise<{ port: number; stop(): Promise<void> }> {
  vi.stubGlobal('WebSocket', NodeWebSocket);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-g3-e2e-'));
  const prev = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  const daemon = new GuiDaemon({ root: tmp, model, ...(staticRoot !== undefined ? { staticRoot } : {}) });
  const s = await daemon.start({ port: 0, token: 'e2e-token' });
  return {
    port: s.port,
    stop: async () => {
      await s.close();
      if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
      else process.env.SUNSHINEX_DATA_DIR = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** 场景①+② 适配器（e2e 测试桩）：chatStream 首帧 token 增量后悬挂（gate）——流式中间态
 *  （streaming 条）可被确定性观测；release 后以 stop 终稿收束，终稿与已累积增量互为前缀
 *  （reducer mergeFinal 语义：收段后 md = 终稿全文）。ScriptedAdapter 现场核实为逐字符
 *  分帧发射（adapter.chatStream），但同步爆发不可断言 DOM 中间态——本桩等价分帧 + 受控节拍。 */
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

describe('G3 冒烟①②：提交→流式渲染→done 收段；steer 运行中 200', () => {
  let conn: Connection;
  let env: { port: number; stop(): Promise<void> };
  const model = new HangingStreamAdapter();
  const events: SessionEvent[] = [];

  beforeAll(async () => {
    env = await startDaemon(model);
    conn = createConnection({
      baseUrl: `http://127.0.0.1:${env.port}`,
      token: 'e2e-token',
      onEvent: (e) => events.push(e),
      onResync: () => {},
    });
  }, 30_000);

  afterAll(async () => {
    conn?.close();
    await env?.stop();
    localStorage.removeItem('sunshinex.token');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('UI 提交 → streaming 条在场（分帧 token）→ 运行中 steer 200 → done 收段（streaming 消失、md 终稿）', async () => {
    // App 先挂载再提交（live 事件面）：token 门面 + baseUrl 经 stubEnv 注入（T4 自装配形态）
    localStorage.setItem('sunshinex.token', 'e2e-token');
    vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
    const { container } = render(createElement(App));
    await waitFor(() => expect(screen.getByLabelText('connection: open')).toBeDefined(), { timeout: 10_000 });

    // —— 真实 UI 提交路径：输入 + Enter（idle 分流 = submit）——
    const input = screen.getByLabelText('message input');
    fireEvent.change(input, { target: { value: '流式冒烟' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // —— 流式中间态：token 增量分帧到场（连接层事件 + DOM streaming 条），run 确在进行中 ——
    await waitFor(() => expect(container.querySelector('.entry-assistant.streaming')?.textContent).toContain('终稿'), { timeout: 10_000 });
    expect(events.some((e) => e.type === 'token' && e.text === '终稿')).toBe(true);
    expect((await conn.snapshot()).status).toBe('running');
    expect(container.querySelector('.status-running')).toBeDefined();

    // —— steer 运行中（hanging 模型轮内）：经 conn.steer POST /steer，200 不炸（resolve 即断言）——
    await conn.steer('运行中插话');

    // —— release → 模型轮收束 → done 事件 → streaming 收段：md 终稿全文在场、无流式残留、idle ——
    model.release();
    await waitFor(() => expect(container.querySelector('.entry-assistant:not(.streaming)')?.textContent).toContain('终稿答复'), { timeout: 10_000 });
    expect(container.querySelector('.streaming')).toBeNull();
    expect(container.querySelector('.status-idle')).toBeDefined();
    expect(events.some((e) => e.type === 'done' && e.text === '终稿答复')).toBe(true);
    // UI 提交的本地 user 回显（> 流式冒烟 引用块）
    expect(container.querySelector('.entry-user blockquote')?.textContent?.trim()).toBe('流式冒烟');
  }, 30_000);
});

describe('G3 冒烟③：断线重连恢复（daemon 真链路）', () => {
  let connB: Connection;
  let env: { port: number; stop(): Promise<void> };
  const events: SessionEvent[] = [];
  const resyncs: SnapshotResponse[] = [];
  const states: ConnectionState[] = [];

  beforeAll(async () => {
    // 两张单 done 牌：首轮与重连后续各一次模型轮（无 fork 面，事件序干净）
    env = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"首轮答复"}', '{"done":true,"reply":"重连后续答"}']));
    connB = createConnection({
      baseUrl: `http://127.0.0.1:${env.port}`,
      token: 'e2e-token',
      onEvent: (e) => events.push(e),
      onResync: (s) => resyncs.push(s),
      onStateChange: (s) => states.push(s),
      backoffBaseMs: 1, // 重连退避注入（App 自装配连接无法注入——本连接为测试自建，裁定见任务简报）
    });
  }, 30_000);

  afterAll(async () => {
    connB?.close();
    await env?.stop();
    localStorage.removeItem('sunshinex.token');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('底层 socket 断 → reconnecting → 第二次 onResync（基线重置全量在场 + 补发帧 seq 去重）→ 续 submit 全链恢复', async () => {
    const doneCount = (): number => events.filter((e) => e.type === 'done').length;
    // —— 首连 open + 首轮 run 收束 ——
    await waitFor(() => expect(connB.state()).toBe('open'), { timeout: 10_000 });
    expect(resyncs.length).toBe(1);
    await connB.submit('goal one');
    await waitFor(() => expect(events.some((e) => e.type === 'done' && e.text === '首轮答复')).toBe(true), { timeout: 10_000 });
    expect(doneCount()).toBe(1);

    // —— 显式断底层 socket（非 conn.close 的显式收口）→ 掉线语义 → 退避重连 ——
    const sock = connB.debug.socket();
    expect(sock).toBeDefined();
    sock!.close();
    await waitFor(() => expect(states).toContain('reconnecting'), { timeout: 5_000 });
    await waitFor(() => expect(connB.state()).toBe('open'), { timeout: 10_000 });

    // —— 第二次 onResync：基线重置（快照是权威全量态——首轮 user/assistant 全在场）；
    //    daemon 补发缓冲帧全部 seq ≤ 新基线被丢弃（done 不重复——真链路防双应用）——
    expect(resyncs.length).toBe(2);
    expect(resyncs[1]!.messages.some((m) => m.kind === 'user' && m.md === '> goal one')).toBe(true);
    expect(resyncs[1]!.messages.some((m) => m.kind === 'assistant' && m.md === '首轮答复')).toBe(true);
    expect(doneCount()).toBe(1);

    // —— 重连后续提交：第二张牌 → done 经恢复后的连接送达 ——
    await connB.submit('goal two');
    await waitFor(() => expect(events.some((e) => e.type === 'done' && e.text === '重连后续答')).toBe(true), { timeout: 10_000 });
    expect(doneCount()).toBe(2);

    // —— App 快照种子渲染：两轮全量转录（跨断线会话连续性）+ 连接 open ——
    localStorage.setItem('sunshinex.token', 'e2e-token');
    vi.stubEnv('VITE_SERVE_URL', `http://127.0.0.1:${env.port}`);
    const { container } = render(createElement(App));
    await waitFor(() => expect(container.textContent).toContain('重连后续答'), { timeout: 5_000 });
    expect(container.textContent).toContain('首轮答复');
    expect(container.querySelectorAll('.entry-user').length).toBe(2);
    expect(screen.getByLabelText('connection: open')).toBeDefined();
  }, 30_000);
});

/** 真实 vite build 产物根（gui cwd → 仓库根 dist-gui；test:e2e 的 prebuild 保证在场，普通 test 缺场跳过） */
const DIST_GUI = path.resolve(process.cwd(), '..', 'dist-gui');
const guiAssetsBuilt = fs.existsSync(path.join(DIST_GUI, 'index.html'));

describe('G3 冒烟④：静态挂载（daemon staticRoot 指 dist-gui）', () => {
  let env: { port: number; stop(): Promise<void> } | undefined;

  beforeAll(async () => {
    if (!guiAssetsBuilt) return; // 未 build（普通 test）：本组整体跳过
    env = await startDaemon(new ScriptedAdapter([]), DIST_GUI);
  }, 30_000);

  afterAll(async () => {
    await env?.stop();
    vi.unstubAllGlobals();
  });

  (guiAssetsBuilt ? it : it.skip)('GET / 免鉴权回 index.html（text/html + 产物资源引用）', async () => {
    const res = await fetch(`http://127.0.0.1:${env!.port}/`); // 无 authorization 头——GUI 壳非密钥材料（G3 裁定）
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<div id="root"');
    expect(html).toMatch(/\/assets\/[^"]+\.js/); // 真实 build 产物的哈希资源引用（非桩文件）
  }, 15_000);
});
