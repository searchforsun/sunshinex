import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleChannelsBindingDelete,
  handleChannelsBindingPut,
  handleChannelsBindingsGet,
  handleChannelsList,
  handleChannelsDelete,
  handleChannelsSessions,
  handleChannelsTest,
  type ChannelsHandlerIo,
} from './handlers';
import type { ChannelsEngine, ChannelHealthRow } from './engine';
import { ChannelsBindingsStore } from './store';
import type { Binding } from './model';
import type { SessionRuntime } from '../session';

/** 通道 handlers 单测(Task 9,spec §2/§8.3):io 桩(send 记录回执/readJson 回放桩 body)——
 *  engine 用形状桩(只消费 health/test 两面)、bindings 用真档(tmp 隔离)、sessions 空表;
 *  /channels/sessions 的域扫描走真 channelsContainerDir(SUNSHINEX_CHANNELS_DIR 运行期重定向,
 *  data-dir 惰性求值惯例)。daemon 级 HTTP 行为锚在 daemon.test.ts 通道 HTTP 面 describe。 */

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** io 桩装配:send 记录 {status,body} 序列、readJson 回放 readBody、engine 形状桩(缺省 health=[]
 *  test={ok:true})、bindings 真档必注入、releaseSession 记录回收序列(判据断言用) */
function stubIo(opts: {
  bindings: ChannelsBindingsStore;
  engine?: { health?: () => ChannelHealthRow[]; test?: (id: string) => Promise<{ ok: boolean; botId?: string; error?: string }> };
  readBody?: unknown;
  sessions?: Map<string, SessionRuntime>;
  activeSessionId?: () => string | undefined;
}): { io: ChannelsHandlerIo; replies: Array<{ status: number; body: object }>; released: string[] } {
  const replies: Array<{ status: number; body: object }> = [];
  const released: string[] = [];
  const io: ChannelsHandlerIo = {
    send: (res, status, body) => {
      void res;
      replies.push({ status, body });
    },
    readJson: async () => ({ ok: true, body: opts.readBody }),
    engine: {
      health: () => (opts.engine?.health !== undefined ? opts.engine.health() : []),
      test: async (id: string) =>
        opts.engine?.test !== undefined ? opts.engine.test(id) : { ok: true, botId: `stub:${id}` },
    } as unknown as ChannelsEngine,
    bindings: opts.bindings,
    sessions: opts.sessions ?? new Map<string, SessionRuntime>(),
    activeSessionId: opts.activeSessionId ?? (() => undefined),
    releaseSession: (id) => released.push(id),
  };
  return { io, replies, released };
}

/** 绑定夹具(键=通道:聊天惯例形;journalId/lockedUserId 在场——PUT 保留断言的对像) */
function fixtureBinding(): Binding {
  return { key: 'm1:c1', sessionId: 'sun-x-1', journalId: 'j-1', lockedUserId: 'u1', updatedAt: 1 };
}

function makeStore(dir: string): ChannelsBindingsStore {
  return new ChannelsBindingsStore(path.join(dir, 'channels-bindings.json'));
}

describe('通道 handlers(Task 9)', () => {
  test('GET /channels → engine.health() 快照直出', () => {
    const dir = tmpdir('sunshinex-ch-handlers-');
    try {
      const rows: ChannelHealthRow[] = [{ id: 'm1', platform: 'mock', enabled: true, connected: true, detail: 'd' }];
      const { io, replies } = stubIo({ bindings: makeStore(dir), engine: { health: () => rows } });
      handleChannelsList(io, {} as http.ServerResponse);
      assert.equal(replies.length, 1);
      assert.deepEqual(replies[0], { status: 200, body: { channels: rows } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('POST /channels/:id/test → engine.test 回执直出(诊断面失败也是 200,mcp probe 同裁定)', async () => {
    const dir = tmpdir('sunshinex-ch-handlers-');
    try {
      const fail = { ok: false, error: '通道 m2 未配置' };
      const { io, replies } = stubIo({ bindings: makeStore(dir), engine: { test: async () => fail } });
      await handleChannelsTest(io, {} as http.ServerResponse, 'm2');
      assert.deepEqual(replies[0], { status: 200, body: fail });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GET /channels/bindings → store.all() 全列(行含 rootOverride)', () => {
    const dir = tmpdir('sunshinex-ch-handlers-');
    try {
      const store = makeStore(dir);
      store.upsert({ ...fixtureBinding(), rootOverride: 'D:/w' });
      const { io, replies } = stubIo({ bindings: store });
      handleChannelsBindingsGet(io, {} as http.ServerResponse);
      assert.deepEqual(replies[0], { status: 200, body: { bindings: store.all() } });
      assert.equal((replies[0].body as { bindings: Binding[] }).bindings[0]?.rootOverride, 'D:/w');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('PUT binding:不存在 404;非空串=设置(trim);null/缺席=清除;空串/非串 400;其余字段保留+updatedAt 刷新', async () => {
    const dir = tmpdir('sunshinex-ch-handlers-');
    try {
      const store = makeStore(dir);
      const put = async (body: unknown): Promise<Array<{ status: number; body: object }>> => {
        const { io, replies } = stubIo({ bindings: store, readBody: body });
        await handleChannelsBindingPut(io, {} as http.IncomingMessage, {} as http.ServerResponse, 'm1:c1');
        return replies;
      };
      // 不存在 → 404(先于 rootOverride 字段校验——readJson 形状错仍最前;写面锚定既有绑定)
      assert.equal((await put({ rootOverride: 'x' }))[0]?.status, 404);
      store.upsert(fixtureBinding());
      // 非空串=设置(trim 归一)
      assert.deepEqual(await put({ rootOverride: '  D:/w  ' }), [{ status: 200, body: { ok: true } }]);
      const afterSet = store.get('m1:c1')!;
      assert.equal(afterSet.rootOverride, 'D:/w');
      assert.equal(afterSet.journalId, 'j-1', 'journalId 保留');
      assert.equal(afterSet.lockedUserId, 'u1', 'lockedUserId 保留');
      assert.equal(afterSet.sessionId, 'sun-x-1');
      assert.ok(afterSet.updatedAt > 1, 'updatedAt 刷新');
      // null=清除;缺席(字段不在场)=清除(写面全量定态:每次 PUT 完全决定 rootOverride,无合并歧义)
      assert.deepEqual(await put({ rootOverride: null }), [{ status: 200, body: { ok: true } }]);
      assert.equal('rootOverride' in store.get('m1:c1')!, false, 'null 清除后键不在场');
      store.upsert(fixtureBinding());
      assert.deepEqual(await put({}), [{ status: 200, body: { ok: true } }]);
      assert.equal('rootOverride' in store.get('m1:c1')!, false, '缺席=清除');
      // 空串/纯空白/非串非空 → 400(写面从严;400 前档不动)
      store.upsert(fixtureBinding());
      assert.equal((await put({ rootOverride: '' }))[0]?.status, 400);
      assert.equal((await put({ rootOverride: '   ' }))[0]?.status, 400);
      assert.equal((await put({ rootOverride: 5 }))[0]?.status, 400);
      assert.equal(store.get('m1:c1')?.rootOverride, undefined, '400 零部分写');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('DELETE binding:不存在 404;非 active 解除+回收绑定会话;active(用户正在看)不释放但档仍移除', () => {
    const dir = tmpdir('sunshinex-ch-handlers-');
    try {
      const store = makeStore(dir);
      // 不存在 → 404(不触回收)
      const missing = stubIo({ bindings: store, activeSessionId: () => undefined });
      handleChannelsBindingDelete(missing.io, {} as http.ServerResponse, 'm1:nope');
      assert.deepEqual(missing.replies, [{ status: 404, body: { error: 'unknown binding' } }]);
      assert.deepEqual(missing.released, []);
      // 非 active → 解除(store.remove)+回收 releaseSession(binding.sessionId)
      store.upsert(fixtureBinding());
      const nonActive = stubIo({ bindings: store, activeSessionId: () => 'sun-other' });
      handleChannelsBindingDelete(nonActive.io, {} as http.ServerResponse, 'm1:c1');
      assert.deepEqual(nonActive.replies, [{ status: 200, body: { ok: true } }]);
      assert.deepEqual(nonActive.released, ['sun-x-1'], '绑定会话被回收(journal 留盘由 releaseSession 语义保证)');
      assert.equal(store.get('m1:c1'), undefined);
      // active=绑定会话本身 → 不释放(拆掉观感中的会话不可接受,schedules 删除同判据),档仍移除
      store.upsert(fixtureBinding());
      const active = stubIo({ bindings: store, activeSessionId: () => 'sun-x-1' });
      handleChannelsBindingDelete(active.io, {} as http.ServerResponse, 'm1:c1');
      assert.deepEqual(active.replies, [{ status: 200, body: { ok: true } }]);
      assert.deepEqual(active.released, [], 'active 会话不释放');
      assert.equal(store.get('m1:c1'), undefined, '绑定关系仍解除');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GET /channels/sessions:容器缺席=空列;捏域档出行(root=域目录/kind=channel/channel 透出);data 缺席域与杂散文件不列;updatedAt 降序', () => {
    const container = path.join(tmpdir('sunshinex-ch-handlers-'), 'channels');
    const prev = process.env.SUNSHINEX_CHANNELS_DIR;
    process.env.SUNSHINEX_CHANNELS_DIR = container;
    try {
      // 空容器(目录不存在)=合法空态(裸 SessionRow[] 应答,sunx 面同款无信封)
      const empty = stubIo({ bindings: makeStore(path.dirname(container)) });
      handleChannelsSessions(empty.io, {} as http.ServerResponse);
      assert.deepEqual(empty.replies, [{ status: 200, body: [] }]);
      // 捏域档:im-m1-c1 带 data(sessions/j-ch-a.jsonl + meta channel/title);im-m1-c2 无 data;
      // 杂散文件不列。j-ch-b mtime 更新置顶(降序断言)
      const domainA = path.join(container, 'im-m1-c1');
      const sessionsA = path.join(domainA, 'data', 'sessions');
      fs.mkdirSync(sessionsA, { recursive: true });
      fs.writeFileSync(path.join(sessionsA, 'j-ch-a.jsonl'), '{"t":"header","createdAt":"2026-01-01T00:00:00.000Z"}\n', 'utf8');
      fs.writeFileSync(path.join(sessionsA, 'j-ch-a.meta.json'), JSON.stringify({ channel: 'm1', title: '聊天标题' }), 'utf8');
      fs.mkdirSync(path.join(container, 'im-m1-c2'), { recursive: true }); // 无 data 域
      fs.writeFileSync(path.join(container, 'stray.txt'), 'x', 'utf8'); // 杂散文件
      const domainB = path.join(container, 'im-m1-c3');
      const sessionsB = path.join(domainB, 'data', 'sessions');
      fs.mkdirSync(sessionsB, { recursive: true });
      fs.writeFileSync(path.join(sessionsB, 'j-ch-b.jsonl'), '{"t":"header","createdAt":"2026-01-02T00:00:00.000Z"}\n', 'utf8');
      const now = Date.now() + 60_000;
      fs.utimesSync(path.join(sessionsB, 'j-ch-b.jsonl'), new Date(now), new Date(now));
      const { io, replies } = stubIo({ bindings: makeStore(path.dirname(container)) });
      handleChannelsSessions(io, {} as http.ServerResponse);
      assert.equal(replies[0]?.status, 200);
      const rows = replies[0].body as Array<Record<string, unknown>>; // 裸 SessionRow[] 应答
      assert.deepEqual(rows.map((r) => r['id']), ['j-ch-b', 'j-ch-a'], 'updatedAt 降序;无 data 域与杂散文件不列');
      const rowA = rows[1]!;
      assert.equal(rowA['root'], domainA, '行 root=域目录(GUI attach 直寻址)');
      assert.equal(rowA['kind'], 'channel', '域容器恒 channel');
      assert.equal(rowA['channel'], 'm1', '出生 meta 通道 id 透出(Task 13 分组键)');
      assert.equal(rowA['title'], '聊天标题');
      assert.equal(typeof rowA['updatedAt'], 'number');
      assert.equal('liveSessionId' in rowA, false, '注册表空表=无活跃标注');
    } finally {
      if (prev === undefined) delete process.env.SUNSHINEX_CHANNELS_DIR;
      else process.env.SUNSHINEX_CHANNELS_DIR = prev;
      fs.rmSync(path.dirname(container), { recursive: true, force: true });
    }
  });
});

describe('DELETE /channels/:id 真删除(2026-11-23 用户裁定「弹窗确认,真正的删除各种配置和目录」)', () => {
  test('条目移除+绑定解绑+在座释放+聊天域目录真删;缺条目 404', () => {
    const dir = tmpdir('sunshinex-ch-del-');
    const prevCh = process.env.SUNSHINEX_CHANNELS_DIR;
    const container = path.join(dir, 'channels');
    process.env.SUNSHINEX_CHANNELS_DIR = container;
    try {
      // 全局 settings(HOME 已被 test-env 钉到私有 home):channels 带 del1/keep 两条
      const settingsPath = path.join(process.env.HOME ?? dir, '.sunshinex', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ version: 1, channels: [
          { id: 'del1', platform: 'feishu', enabled: true, root: 'auto', mode: 'read-only', allow: { kind: 'all' } },
          { id: 'keep', platform: 'mock', enabled: true, root: 'auto', mode: 'read-only', allow: { kind: 'all' } },
        ] }),
        'utf8',
      );
      // 聊天域:del1 一域+keep 一域(del1 前缀匹配删除,keep 不动)
      for (const name of ['im-del1-oc-a', 'im-keep-x']) {
        fs.mkdirSync(path.join(container, name, 'data', 'sessions'), { recursive: true });
        fs.writeFileSync(path.join(container, name, 'data', 'sessions', 'j.jsonl'), '{"t":"header"}\n', 'utf8');
      }
      const store = makeStore(dir);
      store.upsert({ key: 'del1:c1', sessionId: 'sun-x-1', updatedAt: 1 });
      store.upsert({ key: 'keep:c2', sessionId: 'sun-x-2', updatedAt: 1 });
      const sessions = new Map<string, SessionRuntime>();
      sessions.set('sun-x-1', { status: () => 'idle' } as unknown as SessionRuntime);
      const { io, replies, released } = stubIo({ bindings: store, sessions });
      handleChannelsDelete(io, {} as http.ServerResponse, 'del1');
      assert.equal(replies[0]!.status, 200);
      assert.equal((replies[0]!.body as { removedDomains: number }).removedDomains, 1, '域计数');
      const removed = (replies[0]!.body as { removedSessionIds: string[] }).removedSessionIds;
      assert.ok(removed.includes('sun-x-1'), '绑定座直收（GUI 回欢迎页事件源）');
      assert.ok(!removed.includes('sun-x-2'), '保留通道的绑定座零波及');
      // 条目移除(keep 原样)
      const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { channels: Array<{ id: string }> };
      assert.deepEqual(onDisk.channels.map((c) => c.id), ['keep']);
      // 绑定解绑+在座释放
      assert.equal(store.get('del1:c1'), undefined);
      assert.ok(store.get('keep:c2') !== undefined);
      assert.deepEqual(released, ['sun-x-1']);
      // 域目录:del1 真删,keep 原样
      assert.ok(!fs.existsSync(path.join(container, 'im-del1-oc-a')));
      assert.ok(fs.existsSync(path.join(container, 'im-keep-x')));
      // 缺条目 404
      handleChannelsDelete(io, {} as http.ServerResponse, 'del1');
      assert.equal(replies[1]!.status, 404);
    } finally {
      if (prevCh === undefined) delete process.env.SUNSHINEX_CHANNELS_DIR;
      else process.env.SUNSHINEX_CHANNELS_DIR = prevCh;
    }
  });

  test('rootOverride 工作区会话(dataDir 在容器外)+journalId 双列也进 removedSessionIds（2026-11-25「删除后没回欢迎页」根修）', () => {
    const dir = tmpdir('sunshinex-ch-del-');
    const prevCh = process.env.SUNSHINEX_CHANNELS_DIR;
    const container = path.join(dir, 'channels');
    process.env.SUNSHINEX_CHANNELS_DIR = container;
    try {
      const settingsPath = path.join(process.env.HOME ?? dir, '.sunshinex', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ version: 1, channels: [
          { id: 'ws1', platform: 'feishu', enabled: true, root: 'auto', mode: 'read-only', allow: { kind: 'all' } },
        ] }),
        'utf8',
      );
      // 绑定座落在工作区(container 外)——旧扫描只认容器前缀,收不进=GUI 不回欢迎页
      const store = makeStore(dir);
      store.upsert({ key: 'ws1:c9', sessionId: 'sun-ws-1', journalId: 'j-ws-1', updatedAt: 1 });
      const { io, replies } = stubIo({ bindings: store });
      handleChannelsDelete(io, {} as http.ServerResponse, 'ws1');
      assert.equal(replies[0]!.status, 200);
      const removed = (replies[0]!.body as { removedSessionIds: string[] }).removedSessionIds;
      assert.ok(removed.includes('sun-ws-1'), '运行时 id 收集');
      assert.ok(removed.includes('j-ws-1'), 'journalId 收集（GUI 双寻址 ref 任一命中即回欢迎页）');
    } finally {
      if (prevCh === undefined) delete process.env.SUNSHINEX_CHANNELS_DIR;
      else process.env.SUNSHINEX_CHANNELS_DIR = prevCh;
    }
  });

  test('raw 守卫可删解析弃条目+sunx 容器滞留域顺带清（2026-11-25「删除也删除不掉」根修）', () => {
    const dir = tmpdir('sunshinex-ch-del-');
    const prevCh = process.env.SUNSHINEX_CHANNELS_DIR;
    const prevSunx = process.env.SUNSHINEX_SUNX_DIR;
    const container = path.join(dir, 'channels');
    const sunxDir = path.join(dir, 'sunx');
    process.env.SUNSHINEX_CHANNELS_DIR = container;
    process.env.SUNSHINEX_SUNX_DIR = sunxDir;
    try {
      // settings:bad 条目(mode 非法=parseChannelsKey 跳过——解析态无此条目,raw 在)
      const settingsPath = path.join(process.env.HOME ?? dir, '.sunshinex', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ version: 1, channels: [
          { id: 'bad', platform: 'feishu', enabled: true, root: 'auto', mode: 'weird-mode', allow: { kind: 'all' } },
        ] }),
        'utf8',
      );
      // sunx 容器滞留域:meta.channel='bad'(旧布局通道 Sunx 会话)+纯手建(no channel)
      const stranded = path.join(sunxDir, 'j-sx-stranded', 'data', 'sessions');
      fs.mkdirSync(stranded, { recursive: true });
      fs.writeFileSync(path.join(stranded, 'j-sx-stranded.jsonl'), '{"t":"header"}\n', 'utf8');
      fs.writeFileSync(path.join(stranded, 'j-sx-stranded.meta.json'), JSON.stringify({ channel: 'bad' }), 'utf8');
      const pure = path.join(sunxDir, 'j-sx-pure', 'data', 'sessions');
      fs.mkdirSync(pure, { recursive: true });
      fs.writeFileSync(path.join(pure, 'j-sx-pure.jsonl'), '{"t":"header"}\n', 'utf8');
      const store = makeStore(dir);
      const { io, replies } = stubIo({ bindings: store });
      handleChannelsDelete(io, {} as http.ServerResponse, 'bad');
      assert.equal(replies[0]!.status, 200, 'raw 在=可删(解析弃条目不再 404 永卡)');
      const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { channels: Array<{ id: string }> };
      assert.deepEqual(onDisk.channels.map((c) => c.id), [], '条目已移除');
      assert.ok(!fs.existsSync(path.join(sunxDir, 'j-sx-stranded')), 'sunx 容器滞留域顺带清');
      assert.ok(fs.existsSync(path.join(sunxDir, 'j-sx-pure')), '纯手建 Sunx 零波及');
    } finally {
      if (prevCh === undefined) delete process.env.SUNSHINEX_CHANNELS_DIR;
      else process.env.SUNSHINEX_CHANNELS_DIR = prevCh;
      if (prevSunx === undefined) delete process.env.SUNSHINEX_SUNX_DIR;
      else process.env.SUNSHINEX_SUNX_DIR = prevSunx;
    }
  });
});

test('GET /channels/sessions:Sunx 域行不并入（2026-11-25 用户裁定「不能直接改到 channels 下,不然和 sunx 重叠了」）——sunx 容器行（含 meta.channel）零混入,SUNX 组独家承载', () => {
  const container = path.join(tmpdir('sunshinex-ch-handlers-'), 'channels');
  const sunxDir = tmpdir('sunshinex-ch-sunx-');
  const prevCh = process.env.SUNSHINEX_CHANNELS_DIR;
  const prevSunx = process.env.SUNSHINEX_SUNX_DIR;
  process.env.SUNSHINEX_CHANNELS_DIR = container;
  process.env.SUNSHINEX_SUNX_DIR = sunxDir;
  try {
    // channels 容器:一个普通通道会话
    const domainA = path.join(container, 'im-m1-c1');
    const sessionsA = path.join(domainA, 'data', 'sessions');
    fs.mkdirSync(sessionsA, { recursive: true });
    fs.writeFileSync(path.join(sessionsA, 'j-ch-a.jsonl'), '{"t":"header","createdAt":"2026-01-01T00:00:00.000Z"}\n', 'utf8');
    // sunx 容器:带通道标的 Sunx 会话（历史形态/手建+channel 标）——即便 meta.channel 在场也不入通道列
    const sunxDomain = path.join(sunxDir, 'j-sx-a', 'data', 'sessions');
    fs.mkdirSync(sunxDomain, { recursive: true });
    fs.writeFileSync(path.join(sunxDomain, 'j-sx-a.jsonl'), '{"t":"header","createdAt":"2026-01-02T00:00:00.000Z"}\n', 'utf8');
    fs.writeFileSync(path.join(sunxDomain, 'j-sx-a.meta.json'), JSON.stringify({ channel: 'm1', chatId: 'oc-x', chatTitle: '评审群' }), 'utf8');
    const { io, replies } = stubIo({ bindings: makeStore(path.dirname(container)) });
    handleChannelsSessions(io, {} as http.ServerResponse);
    assert.equal(replies[0]?.status, 200);
    const rows = replies[0].body as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => r['id']), ['j-ch-a'], '只列通道容器;sunx 域行零混入（防两组重叠）');
  } finally {
    if (prevCh === undefined) delete process.env.SUNSHINEX_CHANNELS_DIR;
    else process.env.SUNSHINEX_CHANNELS_DIR = prevCh;
    if (prevSunx === undefined) delete process.env.SUNSHINEX_SUNX_DIR;
    else process.env.SUNSHINEX_SUNX_DIR = prevSunx;
    fs.rmSync(path.dirname(container), { recursive: true, force: true });
    fs.rmSync(sunxDir, { recursive: true, force: true });
  }
});
