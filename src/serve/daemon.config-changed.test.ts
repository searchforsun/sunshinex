import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { GuiDaemon } from './daemon';
import { setPluginEnabled } from '../catalog/plugins';
import { upsertAgent } from '../catalog/agents';
import { ScriptedAdapter } from '../model/adapter';

/**
 * 任务14：daemon 集成（watch 生命周期 + config-changed 帧）——双向实时同步骨干的契约面：
 * ① 外部编辑走 watcher：写项目 mcp.json → ws 客户端收 `{kind:'config-changed',resource,scope,root}` 帧；
 * ② 内部写走直发：经 catalog 写路径（setPluginEnabled）→ suppress 抑制 watcher 回声，自触帧只收到一次
 *    （抑制的是 watcher 事件源，广播由 onCatalogWrite 直发——两路合一去重）；
 * ③ 会话关闭（受控删除）拆项目监听：此后写项目文件不再产生帧。
 * ④ 补监听（终审修复波 2026-10-28）：会话打开时 `.sunshinex` 缺失的 root，首个 project 写就地补挂
 *    watch——此后外部编辑同样产帧（onCatalogWrite 钩子的 watchProjectRoot 补挂半边）。
 * 环境隔离沿 daemon.ws.test 惯例 + HOME 重定向口（config/env.homeDir：HOME 显式设置优先，win32
 * 不读 USERPROFILE 判界）——tmp HOME 钉全局目录，项目 root 独立 tmp。
 */

/** config-changed 帧宽松形态（wire 契约断言面：gui Task 21 按此消费） */
interface ConfigChangedFrame {
  kind: 'config-changed';
  resource: string;
  scope: string;
  root: string | null;
}

type AnyFrame = { kind: string } & Record<string, unknown>;
const isConfigChanged = (f: AnyFrame): f is AnyFrame & ConfigChangedFrame => f.kind === 'config-changed';
const configChangedOf = (frames: AnyFrame[]): Array<AnyFrame & ConfigChangedFrame> => frames.filter(isConfigChanged);

/** 轮询等待（同 daemon.ws.test.ts 惯例）：20ms 片轮询直至 pred 为真，超时抛错 */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Ctx {
  http: string;
  ws: string;
  /** HOME 重定向后的全局配置目录（=tmpHome/.sunshinex，daemon watchGlobal 的对象） */
  globalDir: string;
  /** 项目根（.sunshinex 预建——监听前确保目录存在，缺失目录降级跳过口径） */
  projDir: string;
  H: Record<string, string>;
  newSession: (root: string) => Promise<string>;
  /** 受控关闭（归档→删除——会话删除唯一运行时路径，unwatchProject 挂点） */
  closeSession: (sid: string) => Promise<void>;
}

/** 装配样板：tmp HOME（全局目录）+ tmp 项目根（.sunshinex 预建）+ SUNSHINEX_DATA_DIR 钉 tmp；
 *  token 固定 test-token、port 0。收口序：daemon close（watcher.close+钩子摘除）→ HOME 还原 → tmp 清理 */
async function withConfigDaemon(model: ScriptedAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-serve-cc-'));
  const tmpHome = path.join(tmp, 'home');
  const globalDir = path.join(tmpHome, '.sunshinex');
  fs.mkdirSync(globalDir, { recursive: true });
  const projDir = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(projDir, '.sunshinex'), { recursive: true }); // 监听前确保目录存在
  const prevHome = process.env.HOME;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.HOME = tmpHome;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const daemon = new GuiDaemon({ model });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const http = `http://127.0.0.1:${s.port}`;
    const H = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;
    const newSession = async (root: string): Promise<string> => {
      const r = await fetch(`${http}/session/new`, { method: 'POST', headers: H, body: JSON.stringify({ root }) });
      assert.equal(r.status, 200, 'session/new 应 200');
      return ((await r.json()) as { sessionId: string }).sessionId;
    };
    const closeSession = async (sid: string): Promise<void> => {
      const a = await fetch(`${http}/session/${sid}/archive`, { method: 'POST', headers: H, body: JSON.stringify({ archived: true }) });
      assert.equal(a.status, 200, 'archive 应 200');
      const d = await fetch(`${http}/session/${sid}/delete`, { method: 'POST', headers: H });
      assert.equal(d.status, 200, 'delete 应 200');
    };
    try {
      await fn({ http, ws: `ws://127.0.0.1:${s.port}`, globalDir, projDir, H, newSession, closeSession });
    } finally {
      await s.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 开连接并同步挂帧收集器（沿 daemon.ws.test.ts openCollecting：监听先于 open 回执挂齐，不丢同段帧） */
function openCollecting(url: string): Promise<{ ws: WebSocket; frames: AnyFrame[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer test-token' } });
    const frames: AnyFrame[] = [];
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as AnyFrame);
    });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('error', reject);
  });
}

test('① 外部编辑走 watcher：写项目 mcp.json → ws 客户端收 config-changed 帧（wire 形状逐字段锚定）', async () => {
  await withConfigDaemon(new ScriptedAdapter([]), async (ctx) => {
    await ctx.newSession(ctx.projDir); // 会话打开 = watchProject 挂点
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      // 外部编辑（不经 catalog）：原子写项目 mcp.json
      const file = path.join(ctx.projDir, '.sunshinex', 'mcp.json');
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'ext-server': { command: 'echo' } } }) + '\n', 'utf8');
      await waitFor(() => configChangedOf(frames).length > 0, 5000);
      const [frame] = configChangedOf(frames);
      assert.ok(frame, '应收到 config-changed 帧');
      // wire 形状逐字段锚定（gui Task 21 消费契约）：{kind, resource, scope, root} 恰好四键
      assert.deepEqual(
        { kind: frame.kind, resource: frame.resource, scope: frame.scope, root: frame.root },
        { kind: 'config-changed', resource: 'mcp', scope: 'project', root: ctx.projDir },
      );
      assert.equal(Object.keys(frame).length, 4, '帧恰含 kind/resource/scope/root 四键');
    } finally {
      ws.close();
    }
  });
});

test('② 内部写走直发：catalog setPluginEnabled → 自触 config-changed 帧只收到一次（suppress 抑制 watcher 回声）', async () => {
  await withConfigDaemon(new ScriptedAdapter([]), async (ctx) => {
    // tmp HOME 造一枚用户插件（manifest 最小合法形态）——setPluginEnabled 定位面要求装载视图可见
    const pluginDir = path.join(ctx.globalDir, 'plugins', 'cfg-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ manifestVersion: 1, id: 'cfg-plugin', name: 'Cfg Plugin', version: '0.1.0', description: 'test plugin' }),
      'utf8',
    );
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      // 经 catalog 写路径（内部写）：全局 settings plugins.<id>.enabled 落盘
      setPluginEnabled(null, 'global', 'cfg-plugin', false);
      await waitFor(() => configChangedOf(frames).some((f) => f.resource === 'settings' && f.scope === 'global'), 5000);
      // 直发帧形状：写的是全局 settings.json → resource 'settings'、scope 'global'、root null
      // （与 watcher 对同一文件的映射口径一致——suppress 键与回声键同构才可去重）
      const direct = configChangedOf(frames).find((f) => f.resource === 'settings' && f.scope === 'global');
      assert.deepEqual(
        { kind: direct?.kind, resource: direct?.resource, scope: direct?.scope, root: direct?.root },
        { kind: 'config-changed', resource: 'settings', scope: 'global', root: null },
      );
      // 去重收口：watcher 防抖窗（300ms）+ 抑制窗（500ms）双倍静置后，同键帧仍恰 1 帧
      await new Promise((r) => setTimeout(r, 1000));
      const sameKey = configChangedOf(frames).filter((f) => f.resource === 'settings' && f.scope === 'global' && f.root === null);
      assert.equal(sameKey.length, 1, `自触帧只收到一次（suppress 生效），实收 ${sameKey.length}`);
    } finally {
      ws.close();
    }
  });
});

test('③ 会话关闭（受控删除）拆项目监听：此后写项目文件不再产生 config-changed 帧（unwatch）', async () => {
  await withConfigDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const sid = await ctx.newSession(ctx.projDir);
    // 受控删除门禁要求 journal 在档（出生 journal 惰性建档，未跑会话无 id → archive 404）——
    // 先跑一轮把档落盘（真实用户关闭路径），idle 后再归档删除
    const r = await fetch(`${ctx.http}/session/${sid}/submit`, { method: 'POST', headers: ctx.H, body: JSON.stringify({ goal: '跑一轮' }) });
    assert.equal(r.status, 202, 'submit 应 202');
    await waitForAsync(() => sessionIdle(ctx.http, ctx.H, sid), 10000);
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      // 前置证实监听在场：关闭会话前外部写 mcp.json 能收到帧（③ 不空转——先证有、再证无）
      const file = path.join(ctx.projDir, '.sunshinex', 'mcp.json');
      fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }) + '\n', 'utf8');
      await waitFor(() => configChangedOf(frames).some((f) => f.scope === 'project' && f.resource === 'mcp'), 5000);
      // 会话受控关闭：归档 → 删除（unwatchProject 挂点）
      await ctx.closeSession(sid);
      // 关闭后再写：watcher 防抖窗（300ms）+ 静置余量后零新帧
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { after: { command: 'echo' } } }) + '\n', 'utf8');
      await new Promise((r2) => setTimeout(r2, 1000));
      const projectFrames = configChangedOf(frames).filter((f) => f.scope === 'project' && f.resource === 'mcp');
      assert.equal(projectFrames.length, 1, `unwatch 后写项目文件不再产生帧，实收 ${projectFrames.length}`);
    } finally {
      ws.close();
    }
  });
});

test('④ 补监听（终审修复波 2026-10-28）：会话打开时 `.sunshinex` 尚不存在的 root，首个 project 写（catalog 直发）就地补挂 watch，此后外部编辑同样收到 config-changed 帧', async () => {
  await withConfigDaemon(new ScriptedAdapter([]), async (ctx) => {
    // 无 `.sunshinex` 的项目根：会话打开时 watchProjectRoot 静默跳过（任务14 降级口径）——
    // 此后首个 catalog 写（目录随写建）应触发补监听，外部编辑不再丢帧
    const late = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cc-late-'));
    await ctx.newSession(late); // 打开时 .sunshinex 缺失 → 未监听
    const { ws, frames } = await openCollecting(ctx.ws);
    try {
      assert.equal(fs.existsSync(path.join(late, '.sunshinex')), false, '前置：会话打开未建 .sunshinex');
      // 内部写（catalog 直发）：upsertAgent 落 <late>/.sunshinex/agents/<id>/agent.md（目录随写建）
      // → onCatalogWrite 钩子：补挂 watchProjectRoot + suppress + 直发帧
      upsertAgent(late, 'project', 'late-agent', { name: 'Late Agent' });
      assert.equal(fs.existsSync(path.join(late, '.sunshinex', 'agents', 'late-agent', 'agent.md')), true, '写落盘且目录随建');
      await waitFor(() => configChangedOf(frames).some((f) => f.resource === 'agents' && f.scope === 'project' && f.root === late), 5000);
      const direct = configChangedOf(frames).find((f) => f.resource === 'agents' && f.scope === 'project' && f.root === late);
      assert.deepEqual(
        { kind: direct?.kind, resource: direct?.resource, scope: direct?.scope, root: direct?.root },
        { kind: 'config-changed', resource: 'agents', scope: 'project', root: late },
        '首个 project 写直发帧（root=补挂对象）',
      );
      // 补挂生效的实证：此后外部编辑（不经 catalog）写同一 root 的 mcp.json → watcher 产帧
      fs.writeFileSync(path.join(late, '.sunshinex', 'mcp.json'), JSON.stringify({ mcpServers: { ext: { command: 'echo' } } }) + '\n', 'utf8');
      await waitFor(() => configChangedOf(frames).some((f) => f.resource === 'mcp' && f.scope === 'project' && f.root === late), 5000);
      assert.ok(configChangedOf(frames).some((f) => f.resource === 'mcp' && f.scope === 'project' && f.root === late), '外部编辑帧到达（补监听生效）');
    } finally {
      ws.close();
      fs.rmSync(late, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

/** 会话 idle 轮询（③ 辅助）：snapshot.status 回 idle */
async function sessionIdle(http: string, H: Record<string, string>, sid: string): Promise<boolean> {
  const r = await fetch(`${http}/session/${sid}/snapshot`, { headers: H });
  return ((await r.json()) as { status: string }).status === 'idle';
}

/** 异步谓词轮询（③ 辅助）：20ms 片轮询 await pred 为真，超时抛错 */
async function waitForAsync(pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('waitForAsync 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}
