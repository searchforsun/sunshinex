import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { handlePluginsGet, handlePluginsPut, handleMcpPut, type ConfigHandlerIo } from './config-handlers';

/** 配置面处理器直测（Task 11 /settings/plugins 两端点）：handler 纯函数形（req/res + io），
 *  io 三面全 fake（send 收集回执/readJson 回放预设 body/reloadSettingsChain 记录调用），
 *  不起真 daemon（daemon.test 的 fetch 面已锚 G8c 全家，此处补 handler 单元粒度） */

/** fake io：send 回执收集 + reloadSettingsChain 调用记录，readJson 回放预设 body */
function fakeIo(body: unknown): { io: ConfigHandlerIo; sends: Array<{ status: number; body: Record<string, unknown> }>; reloaded: Array<string | undefined> } {
  const sends: Array<{ status: number; body: Record<string, unknown> }> = [];
  const reloaded: Array<string | undefined> = [];
  const io: ConfigHandlerIo = {
    send: (_res, status, b) => sends.push({ status, body: b as Record<string, unknown> }),
    readJson: async () => ({ ok: true, body }),
    reloadSettingsChain: (root) => reloaded.push(root),
  };
  return { io, sends, reloaded };
}

const dummyRes = {} as http.ServerResponse;

/** handler 直测环境隔离（daemon.test withSettingsDaemon 的轻量版）：HOME/USERPROFILE 重定向
 *  fakeHome——loadEffectivePlugins 用户级插件根（<home>/.sunshinex/plugins）与全局 settings 定位面
 *  随之隔离，不触碰真实用户家；进程内调用无 daemon 进程边界，用例结束必须复原环境面防串后续用例 */
async function withFakeHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plugins-handlers-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** 在用户级插件根造一个插件（目录名 = id，规避 id ≠ 目录名告警；形态沿 plugins.test mkPluginIn） */
function mkUserPlugin(home: string, id: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(home, '.sunshinex', 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ manifestVersion: 1, id, name: 'Demo', version: '0.1.0', description: 'demo plugin', ...extra }),
  );
}

interface PluginRow {
  id: string;
  name: string;
  version: string;
  description: string;
  source: 'builtin' | 'user';
  enabled: boolean;
  platformSupported: boolean;
  servers: string[];
  skillsCount: number;
  configSchema: unknown;
  config: Record<string, unknown>;
  warnings: string[];
}

interface PluginsBody {
  plugins: PluginRow[];
  warnings: string[];
}

const getReq = (root?: string): http.IncomingMessage =>
  ({ url: root === undefined ? '/settings/plugins' : `/settings/plugins?root=${encodeURIComponent(root)}` }) as http.IncomingMessage;

async function pluginsGet(root?: string): Promise<{ status: number; body: PluginsBody }> {
  const { io, sends } = fakeIo(null);
  handlePluginsGet(io, getReq(root), dummyRes);
  assert.equal(sends.length, 1, 'GET 恰一次回执');
  return { status: sends[0]!.status, body: sends[0]!.body as unknown as PluginsBody };
}

async function pluginsPut(body: unknown): Promise<{ status: number; body: Record<string, unknown>; reloaded: Array<string | undefined> }> {
  const { io, sends, reloaded } = fakeIo(body);
  await handlePluginsPut(io, { url: '/settings/plugins' } as http.IncomingMessage, dummyRes);
  assert.equal(sends.length, 1, 'PUT 恰一次回执');
  return { status: sends[0]!.status, body: sends[0]!.body, reloaded };
}

test('GET ?root=：清单行形态（id/name/version/description/source/enabled/platformSupported/servers/skillsCount/configSchema/config/warnings）+ 顶层 warnings', async () => {
  await withFakeHome(async (home) => {
    mkUserPlugin(home, 'demo', {
      mcpServers: { srv: { command: 'node', args: ['s.js'] } },
      skills: ['skills'],
      configSchema: { worker: { type: 'string', description: 'worker 名' } },
    });
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plugins-proj-'));
    try {
      const r = await pluginsGet(proj);
      assert.equal(r.status, 200);
      const demo = r.body.plugins.find((p) => p.id === 'demo');
      assert.notEqual(demo, undefined, '用户级插件入清单');
      assert.equal(demo!.name, 'Demo');
      assert.equal(demo!.version, '0.1.0');
      assert.equal(demo!.description, 'demo plugin');
      assert.equal(demo!.source, 'user');
      assert.equal(demo!.enabled, false, 'settings 未配 → defaultEnabled（缺省 false）');
      assert.equal(demo!.platformSupported, true, 'platforms 缺省全平台');
      assert.deepEqual(demo!.servers, ['srv'], 'servers = mcpServers 名数组');
      assert.equal(demo!.skillsCount, 1);
      assert.deepEqual(demo!.configSchema, { worker: { type: 'string', description: 'worker 名' } });
      assert.deepEqual(demo!.config, {}, 'settings 未配 → config 空对象');
      assert.deepEqual(demo!.warnings, []);
      assert.ok(Array.isArray(r.body.warnings), '顶层 warnings 恒在场');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

test('GET 无 root：仅全局面——项目 settings 的 enabled 覆盖不入读取', async () => {
  await withFakeHome(async (home) => {
    mkUserPlugin(home, 'demo');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plugins-proj-'));
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.sunshinex', 'settings.json'), JSON.stringify({ plugins: { demo: { enabled: true } } }));
    try {
      const r = await pluginsGet();
      const demo = r.body.plugins.find((p) => p.id === 'demo')!;
      assert.equal(demo.enabled, false, '无 root = 仅全局装载（项目级 enabled 不入）');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

test('GET：settings 畸形 JSON 不 fail-fast 穿透——尽力而为视图（空清单+顶层告警），与 PUT 409 对称裁量', async () => {
  await withFakeHome(async (home) => {
    mkUserPlugin(home, 'demo');
    fs.mkdirSync(path.join(home, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.sunshinex', 'settings.json'), '{oops');
    const r = await pluginsGet();
    assert.equal(r.status, 200, '清单面是尽力而为视图，装载失败不 500');
    assert.deepEqual(r.body.plugins, [], 'settings 装载失败 → 空清单');
    assert.ok(
      r.body.warnings.some((w) => w.includes('settings 装载失败')),
      '顶层告警点名装载失败（原因随告警透出，设置页可见）',
    );
  });
});

test('PUT enabled → 写项目 settings 语义键 plugins.demo.enabled（原子写：尾随换行+无 tmp 残片）→ 两级读取生效 + reloadSettingsChain(root)', async () => {
  await withFakeHome(async (home) => {
    mkUserPlugin(home, 'demo', { defaultEnabled: false });
    fs.mkdirSync(path.join(home, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.sunshinex', 'settings.json'), JSON.stringify({ plugins: { demo: { enabled: false } } }));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plugins-proj-'));
    try {
      const r = await pluginsPut({ root: proj, id: 'demo', enabled: true });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true });
      assert.deepEqual(r.reloaded, [path.resolve(proj)], '成功后链重载一次（root 锚）');
      // 盘面：项目 settings 语义键落 plugins.demo.enabled=true，version 保
      const file = path.join(proj, '.sunshinex', 'settings.json');
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(onDisk['plugins'], { demo: { enabled: true } });
      assert.equal(onDisk['version'], 1, '新档补 version:1（settings schema 口径）');
      assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'), '2 空格缩进 + 尾随换行（T2/T4 写面同款）');
      assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-')), [], 'tmp+rename 原子写零残片');
      // 两级读取：项目 true 覆盖全局 false；无 root 视角仍全局 false
      const after = await pluginsGet(proj);
      assert.equal(after.body.plugins.find((p) => p.id === 'demo')!.enabled, true, '项目级覆盖全局（两级合并读取生效）');
      const globalOnly = await pluginsGet();
      assert.equal(globalOnly.body.plugins.find((p) => p.id === 'demo')!.enabled, false, '无 root 视角仍全局值');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

test('PUT config：仅写入场字段（记录级整面替换，enabled 键不臆造）；config 落盘后 GET 读回', async () => {
  await withFakeHome(async (home) => {
    mkUserPlugin(home, 'demo');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plugins-proj-'));
    try {
      const r = await pluginsPut({ root: proj, id: 'demo', config: { worker: 'pwsh' } });
      assert.equal(r.status, 200);
      const onDisk = JSON.parse(fs.readFileSync(path.join(proj, '.sunshinex', 'settings.json'), 'utf8')) as { plugins: Record<string, Record<string, unknown>> };
      assert.deepEqual(onDisk.plugins['demo'], { config: { worker: 'pwsh' } }, '仅 config 入场 → enabled 键不臆造');
      const after = await pluginsGet(proj);
      assert.deepEqual(after.body.plugins.find((p) => p.id === 'demo')!.config, { worker: 'pwsh' });
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

test('PUT 无 root：写全局 settings（<home>/.sunshinex/settings.json）且不触发链重载（root 缺省无项目锚）', async () => {
  await withFakeHome(async (home) => {
    mkUserPlugin(home, 'demo');
    const r = await pluginsPut({ id: 'demo', enabled: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.reloaded, [], '无 root 不触发 reloadSettingsChain');
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, '.sunshinex', 'settings.json'), 'utf8')) as { plugins: Record<string, unknown> };
    assert.deepEqual(onDisk.plugins['demo'], { enabled: true });
    const after = await pluginsGet();
    assert.equal(after.body.plugins.find((p) => p.id === 'demo')!.enabled, true);
  });
});

test('PUT 守卫：缺/空 id 400；enabled/config 坏形 400；未知 id 404——全守卫零盘上副作用', async () => {
  await withFakeHome(async (home) => {
    mkUserPlugin(home, 'demo');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plugins-proj-'));
    try {
      assert.equal((await pluginsPut({ root: proj, enabled: true })).status, 400, 'id 缺 400');
      assert.equal((await pluginsPut({ root: proj, id: '', enabled: true })).status, 400, 'id 空 400');
      assert.equal((await pluginsPut({ root: proj, id: 'demo', enabled: 'yes' })).status, 400, 'enabled 非布尔 400');
      assert.equal((await pluginsPut({ root: proj, id: 'demo', config: 'oops' })).status, 400, 'config 非对象 400');
      assert.equal((await pluginsPut({ root: proj, id: 'demo', config: [1] })).status, 400, 'config 数组 400');
      assert.equal((await pluginsPut({ root: proj, id: 'demo', config: null })).status, 400, 'config null 400');
      const missing = await pluginsPut({ root: proj, id: 'nope', enabled: true });
      assert.equal(missing.status, 404, '未知 id 404（loadEffectivePlugins 定位面）');
      assert.equal(fs.existsSync(path.join(proj, '.sunshinex')), false, '全守卫路径零写盘（目录都不落）');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

test('PUT 既有文件含注释 → 409 引流 raw（原文逐字保真零触碰）；畸形 JSON → 409', async () => {
  await withFakeHome(async (home) => {
    mkUserPlugin(home, 'demo');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plugins-proj-'));
    try {
      const commented = '{\n  // 手写注释\n  "version": 1\n}\n';
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.sunshinex', 'settings.json'), commented);
      const r = await pluginsPut({ root: proj, id: 'demo', enabled: true });
      assert.equal(r.status, 409);
      assert.ok(String(r.body['error']).includes('comment'));
      assert.equal(r.body['hint'], 'use raw editor');
      assert.equal(fs.readFileSync(path.join(proj, '.sunshinex', 'settings.json'), 'utf8'), commented, '409 路径原文件零触碰');

      fs.writeFileSync(path.join(proj, '.sunshinex', 'settings.json'), '{ not json');
      const bad = await pluginsPut({ root: proj, id: 'demo', enabled: true });
      assert.equal(bad.status, 409);
      assert.ok(String(bad.body['error']).includes('not valid JSON'));
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

test('PUT 既有 plugins 键形状坏（非对象）→ 整键重置为对象（装载面本就告警忽略坏形状）', async () => {
  await withFakeHome(async (home) => {
    mkUserPlugin(home, 'demo');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plugins-proj-'));
    try {
      fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.sunshinex', 'settings.json'), JSON.stringify({ version: 1, plugins: 'oops' }));
      const r = await pluginsPut({ root: proj, id: 'demo', enabled: true });
      assert.equal(r.status, 200);
      const onDisk = JSON.parse(fs.readFileSync(path.join(proj, '.sunshinex', 'settings.json'), 'utf8')) as { plugins: Record<string, unknown> };
      assert.deepEqual(onDisk.plugins, { demo: { enabled: true } }, '坏形状整键重置（不保留垃圾）');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

async function mcpPut(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { io, sends } = fakeIo(body);
  await handleMcpPut(io, { url: '/settings/mcp' } as http.IncomingMessage, dummyRes);
  assert.equal(sends.length, 1, 'PUT 恰一次回执');
  return { status: sends[0]!.status, body: sends[0]!.body };
}

test('MCP PUT 新字段守卫：headers/enabled/disabledTools 坏形 400（装载面消费键写面拦形）；合法形原样落盘', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-put-'));
  try {
    assert.equal((await mcpPut({ root: proj, servers: [{ name: 'a', command: 'node', headers: ['x'] }] })).status, 400, 'headers 数组 400');
    assert.equal((await mcpPut({ root: proj, servers: [{ name: 'a', command: 'node', headers: { X: 1 } }] })).status, 400, 'headers 值非字符串 400');
    assert.equal((await mcpPut({ root: proj, servers: [{ name: 'a', command: 'node', enabled: 'yes' }] })).status, 400, 'enabled 非布尔 400');
    assert.equal((await mcpPut({ root: proj, servers: [{ name: 'a', command: 'node', disabledTools: [1] }] })).status, 400, 'disabledTools 非字符串数组 400');
    assert.equal(fs.existsSync(path.join(proj, '.sunshinex')), false, '守卫路径零写盘');
    const ok = await mcpPut({ root: proj, servers: [{ name: 'a', command: 'node', headers: { X: '1' }, enabled: false, disabledTools: ['t1'] }] });
    assert.equal(ok.status, 200, '三键合法形 200');
    const onDisk = JSON.parse(fs.readFileSync(path.join(proj, '.sunshinex', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(onDisk.mcpServers['a'], { name: 'a', command: 'node', headers: { X: '1' }, enabled: false, disabledTools: ['t1'] }, '合法三键原样落盘（row 含 name 整体入位——写面不擅自裁剪）');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
