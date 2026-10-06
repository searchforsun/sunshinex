import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import { createElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
// 主仓 dist 直引（G2 装配裁定）：gui pretest 先 clean+tsc 主仓，保证 dist 在场且新鲜——e2e 消费的
// 就是发布形态（dist/serve/daemon + dist/model/adapter 的 ScriptedAdapter），非 TS 源旁路
import { GuiDaemon } from '../../dist/serve/daemon';
import { ScriptedAdapter } from '../../dist/model/adapter';
import type { SessionEvent } from '../../src/types';
import { createConnection } from './connection';
import type { Connection, SnapshotResponse } from './connection';
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
