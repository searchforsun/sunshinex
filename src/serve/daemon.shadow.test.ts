import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { GuiDaemon } from './daemon';
import { isShadowEvent } from './session';
import type { SessionRuntime } from './session';
import type { ModelAdapter } from '../model/adapter';
import type { SessionEvent } from '../types';

/** G14.2xx b 影子投影水合面测试:journal subagent 行全量读端点(shadow-events)+ WS 回放面跳过
 *  shadow 帧。病根背景:WS 环窗(512)对长会话子代理流必溢出且 GUI 刷新时连接建立常先于会话
 *  attach——刷新后子代理转录「无活动记录」;恢复唯一可靠入口=journal 全量(落档先于广播)。 */

const noopModel: ModelAdapter = (async () => {
  throw new Error('model not used in this suite');
}) as unknown as ModelAdapter;

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Ctx {
  daemon: GuiDaemon;
  http: string;
  sid: string;
  runtime: SessionRuntime;
  H: Record<string, string>;
}

async function withShadowDaemon(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = tmpdir('sunshinex-serve-shadow-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model: noopModel, staticRoot: path.join(tmp, 'dist-gui-absent') });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const http = `http://127.0.0.1:${s.port}`;
    const H = { authorization: 'Bearer test-token' } as Record<string, string>;
    const nr = await fetch(`${http}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root: tmp }) });
    assert.equal(nr.status, 200, 'session/new 应 200');
    const sid = ((await nr.json()) as { sessionId: string }).sessionId;
    const sessions = (daemon as unknown as { sessions: Map<string, SessionRuntime> }).sessions;
    const runtime = sessions.get(sid);
    assert.ok(runtime !== undefined, '会话运行时在座');
    try {
      await fn({ daemon, http, sid, runtime, H });
    } finally {
      await s.close();
    }
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 子代理 token 帧构造糖 */
const subToken = (label: string, text: string): SessionEvent => ({ type: 'token', text, payload: { subagent: label }, ts: Date.now() });

test('journal shadow 行全量读面:环窗溢出后端点仍返回全量 subagent 事件 + cut 水位', async () => {
  await withShadowDaemon(async ({ http, sid, runtime, H }) => {
    // 泵 600 帧 subagent token(> EVENT_BUFFER_CAP=512,环窗必挤出最早段)+ 少量主链帧
    for (let i = 0; i < 600; i++) runtime.pump(subToken('an', `t${i} `));
    runtime.pump({ type: 'token', text: 'main', ts: Date.now() });

    const r = await fetch(`${http}/session/${sid}/shadow-events`, { headers: H });
    assert.equal(r.status, 200, 'shadow-events 应 200');
    const body = (await r.json()) as { events: SessionEvent[]; cut: number };
    assert.equal(body.events.length, 600, 'journal 全量:600 帧 subagent 事件一张不少(环窗溢出不影响)');
    for (const e of body.events) {
      assert.equal(e.type, 'token');
      assert.equal(typeof (e.payload as { subagent?: unknown }).subagent, 'string', '行集恒为子代理事件');
    }
    assert.ok(body.cut >= 601, 'cut=读档时刻泵水位(≥ 全部已泵帧)');
    // 全量行集可重建聚合面(GUI applyAgentEvent 同构消费):首帧建卡、token 全量在卡
    const first = body.events[0]!;
    assert.ok(typeof first.text === 'string' && first.text.startsWith('t0'), '首帧即环窗早已挤出的最早事件');
  });
});

test('WS 回放面跳过 shadow 帧:新连接补发窗只含主链帧(恢复唯一入口=HTTP 水合,防双应用)', async () => {
  await withShadowDaemon(async ({ http, sid, runtime, H }) => {
    for (let i = 0; i < 20; i++) runtime.pump(subToken('an', `t${i}`));
    runtime.pump({ type: 'token', text: 'main-line', ts: Date.now() });

    const frames: Array<{ kind: string; e?: { type?: string; payload?: { subagent?: unknown } } }> = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(http.replace('http', 'ws'), { headers: H });
      ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
      ws.on('open', () => {
        setTimeout(() => {
          ws.close();
          resolve();
        }, 300);
      });
      ws.on('error', reject);
    });
    const eventFrames = frames.filter((f) => f.kind === 'event');
    assert.ok(eventFrames.length > 0, '回放帧在(主链补发窗)');
    for (const f of eventFrames) {
      assert.equal(
        typeof f.e?.payload?.subagent,
        'undefined',
        '回放面零 shadow 帧——子代理恢复唯一入口=HTTP 水合(双应用防线)',
      );
      void sid;
    }
    assert.ok(eventFrames.some((f) => f.e?.type === 'token'), '主链帧照常补发');
  });
});

test('isShadowEvent 判定单点:板面/委派/子代理三族命中,主链流内事件不命中', () => {
  for (const type of ['task-created', 'gate-requested', 'delegation-started']) {
    assert.equal(isShadowEvent({ type, ts: 0 } as SessionEvent), true, `${type} 命中`);
  }
  assert.equal(isShadowEvent({ type: 'token', payload: { subagent: 'w' }, ts: 0 } as SessionEvent), true, 'subagent 标签命中');
  assert.equal(isShadowEvent({ type: 'token', text: 'x', ts: 0 } as SessionEvent), false, '主链 token 不命中');
  assert.equal(isShadowEvent({ type: 'usage', payload: { turnTotal: 5 }, ts: 0 } as SessionEvent), false, '主链 usage 不命中');
});
