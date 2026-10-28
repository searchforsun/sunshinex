import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleAgentsPut, handleMcpGet, handleMcpOp, type ConfigHandlerIo } from './config-handlers';

/** /settings/mcp/op + /settings/agents op 扩展处理器直测（Task 15；沿 config-handlers.test 先例：
 *  handler 纯函数形 req/res+io，io 全 fake 不起真 daemon——daemon.test 的 fetch 面锚既有端点契约，
 *  此处补 op 面单元粒度：单条目手术写、批准阀接线、注释/畸形守卫、agents enable/disable/migrate） */

/** fake io：send 回执收集 + readJson 回放预设 body（op 面不触发链重载，reloadSettingsChain 恒空转） */
function fakeIo(body: unknown): { io: ConfigHandlerIo; sends: Array<{ status: number; body: Record<string, unknown> }> } {
  const sends: Array<{ status: number; body: Record<string, unknown> }> = [];
  const io: ConfigHandlerIo = {
    send: (_res, status, b) => sends.push({ status, body: b as Record<string, unknown> }),
    readJson: async () => ({ ok: true, body }),
    reloadSettingsChain: () => {},
  };
  return { io, sends };
}

const dummyRes = {} as http.ServerResponse;

/** HOME 桩（config-handlers.test withFakeHome 同款）：全局 mcp.json / agents / settings 定位面
 *  （userConfigDir = <home>/.sunshinex）随之隔离真实用户家；项目 root 一并落在桩内（随用例回收） */
async function withFakeHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-op-handlers-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function mcpOp(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { io, sends } = fakeIo(body);
  await handleMcpOp(io, { url: '/settings/mcp/op' } as http.IncomingMessage, dummyRes);
  assert.equal(sends.length, 1, 'op 恰一次回执');
  return { status: sends[0]!.status, body: sends[0]!.body };
}

async function mcpGet(root?: string): Promise<{ status: number; body: { servers: Array<Record<string, unknown>> } }> {
  const { io, sends } = fakeIo(null);
  const url = root === undefined ? '/settings/mcp' : `/settings/mcp?root=${encodeURIComponent(root)}`;
  handleMcpGet(io, { url } as http.IncomingMessage, dummyRes);
  assert.equal(sends.length, 1, 'GET 恰一次回执');
  return { status: sends[0]!.status, body: sends[0]!.body as unknown as { servers: Array<Record<string, unknown>> } };
}

async function agentsPut(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { io, sends } = fakeIo(body);
  await handleAgentsPut(io, { url: '/settings/agents' } as http.IncomingMessage, dummyRes);
  assert.equal(sends.length, 1, 'agents PUT 恰一次回执');
  return { status: sends[0]!.status, body: sends[0]!.body };
}

/** 项目 mcp.json 落位（与 catalog mcpJsonPath project 分支同几何） */
function projMcpFile(home: string): string {
  return path.join(home, 'proj', '.sunshinex', 'mcp.json');
}

test('mcp/op add：单条目落盘（既有条目/顶层键不动）+ 同值重加零落盘 + enable/disable 翻转 enabled 键 + remove（缺失 409）', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    const file = projMcpFile(home);
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, note: 'keepme', mcpServers: { keep: { command: 'node' } } }), 'utf8');

    // add（project）：单条目手术写——新条目落 mcpServers.<name>，mcpServers 以外顶层键与既有条目原样保留
    const addBody = { op: 'add', scope: 'project', root: proj, name: 'fetcher', server: { command: 'node', args: ['f.js'], env: { K: 'V' } } };
    let r = await mcpOp(addBody);
    assert.equal(r.status, 200, 'add 应 200');
    assert.deepEqual(r.body, { ok: true });
    let onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown>; note?: string };
    assert.deepEqual(onDisk.mcpServers['fetcher'], { command: 'node', args: ['f.js'], env: { K: 'V' } }, '条目按 name 落盘（server 原样）');
    assert.deepEqual(onDisk.mcpServers['keep'], { command: 'node' }, '既有条目不动（对比整块 PUT 的整块替换）');
    assert.equal(onDisk.note, 'keepme', 'mcpServers 以外顶层键原样保留');

    // 同值重加：幂等零落盘（mtime 不动——watcher/notify 不因重放产帧的盘面前提）
    const mtime1 = fs.statSync(file).mtimeMs;
    r = await mcpOp(addBody);
    assert.equal(r.status, 200);
    assert.equal(fs.statSync(file).mtimeMs, mtime1, '同值重加零落盘');

    // enable/disable 翻转：整机开关键 enabled 手术改写（条目其余字段不动）
    r = await mcpOp({ op: 'disable', scope: 'project', root: proj, name: 'fetcher' });
    assert.equal(r.status, 200, 'disable 应 200');
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal((onDisk.mcpServers['fetcher'] as { enabled?: unknown }).enabled, false, 'disable 落 enabled:false');
    r = await mcpOp({ op: 'enable', scope: 'project', root: proj, name: 'fetcher' });
    assert.equal(r.status, 200, 'enable 应 200');
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal((onDisk.mcpServers['fetcher'] as { enabled?: unknown }).enabled, true, 'enable 翻回 enabled:true');

    // remove：单条目移除（其余保留）；再删同条目 → 409（catalog INVALID 写面拒写——控制器裁定
    // 2026-10-28：内容/写面错误一律 409+hint，非幂等语义不变）
    r = await mcpOp({ op: 'remove', scope: 'project', root: proj, name: 'fetcher' });
    assert.equal(r.status, 200, 'remove 应 200');
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(!('fetcher' in onDisk.mcpServers), '条目已移除');
    assert.deepEqual(onDisk.mcpServers['keep'], { command: 'node' }, '其余条目保留');
    r = await mcpOp({ op: 'remove', scope: 'project', root: proj, name: 'fetcher' });
    assert.equal(r.status, 409, 'remove 缺失条目 → 409（INVALID）');
    // enable 缺失条目同写面拒写语义
    r = await mcpOp({ op: 'enable', scope: 'project', root: proj, name: 'ghost' });
    assert.equal(r.status, 409, 'enable 缺失条目 → 409');
  });
});

test('mcp/op add：global 无需 root 落 userConfigDir；形状坏 409（catalog INVALID 写面拒写→409+hint）；零盘上副作用', async () => {
  await withFakeHome(async (home) => {
    const globalFile = path.join(home, '.sunshinex', 'mcp.json');
    // global add：无需 root（定位面恒 userConfigDir——与其余配置写面同裁定）
    const r = await mcpOp({ op: 'add', scope: 'global', name: 'mine', server: { transport: 'http', url: 'https://x.example/mcp' } });
    assert.equal(r.status, 200, 'global add 应 200（无需 root）');
    const onDisk = JSON.parse(fs.readFileSync(globalFile, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(onDisk.mcpServers['mine'], { transport: 'http', url: 'https://x.example/mcp' }, 'global 条目落 <home>/.sunshinex/mcp.json');

    // 形状坏 → 409（catalog 校验沿 parseMcpJsonFile 接受口径 fail-fast，INVALID 属内容/写面错误——
    // 控制器裁定 2026-10-28：409 {error, hint:'use raw editor'}，400 恒留纯请求形状面）
    const proj = path.join(home, 'proj');
    const cases: Array<[string, unknown]> = [
      ['command/url 皆缺', { description: 'no transport fields' }],
      ['transport 越枚举', { transport: 'grpc', url: 'https://e' }],
      ['http 缺 url', { transport: 'http' }],
      ['stdio 缺 command', { transport: 'stdio' }],
      ['server 非对象', 'node'],
    ];
    for (const [label, server] of cases) {
      const bad = await mcpOp({ op: 'add', scope: 'project', root: proj, name: 'x', server });
      assert.equal(bad.status, 409, `${label} → 409`);
      assert.equal((bad.body as { hint?: string }).hint, 'use raw editor', `${label} → 409 带 hint`);
    }
    assert.equal(fs.existsSync(projMcpFile(home)), false, '409 面零盘上副作用（project mcp.json 不因坏形建文件）');
  });
});

test('mcp/op approve/deny：全局 settings mcpApprovals/mcpDenied 互斥落键 + GET approval 字段（denied→approved 翻转，global 恒 none，序项目先全局后）', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
    fs.writeFileSync(projMcpFile(home), JSON.stringify({ mcpServers: { repoSrv: { command: 'node' } } }), 'utf8');
    fs.mkdirSync(path.join(home, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.sunshinex', 'mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'node' } } }), 'utf8');

    // deny：全局 settings mcpDenied.<slug> 落名（slug 折叠规则不在此钉——只对账名单含目标名）
    let r = await mcpOp({ op: 'deny', scope: 'project', root: proj, name: 'repoSrv' });
    assert.equal(r.status, 200, 'deny 应 200');
    const settingsPath = path.join(home, '.sunshinex', 'settings.json');
    const flatLists = (): string[] => {
      const doc = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      return [...Object.values(doc['mcpApprovals'] ?? {}), ...Object.values(doc['mcpDenied'] ?? {})].flat() as string[];
    };
    assert.ok(flatLists().includes('repoSrv'), 'deny 落全局 settings 名单');
    let g = await mcpGet(proj);
    assert.deepEqual(g.body.servers.map((s) => [s.name, s.source, s.approval]), [
      ['repoSrv', 'project', 'denied'],
      ['mine', 'global', 'none'],
    ], 'GET approval 字段：denied 生效；global 恒 none（用户手配不过阀）；序项目先全局后');

    // approve：互斥翻转（mcpDenied 除名 → mcpApprovals 落名）→ GET approval:'approved'
    r = await mcpOp({ op: 'approve', scope: 'project', root: proj, name: 'repoSrv' });
    assert.equal(r.status, 200, 'approve 应 200');
    const doc = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { mcpApprovals?: Record<string, string[]>; mcpDenied?: Record<string, string[]> };
    assert.ok(Object.values(doc.mcpApprovals ?? {}).some((l) => l.includes('repoSrv')), 'approve 落 mcpApprovals');
    assert.ok(!Object.values(doc.mcpDenied ?? {}).some((l) => l.includes('repoSrv')), '互斥：mcpDenied 已除名');
    g = await mcpGet(proj);
    assert.equal((g.body.servers.find((s) => s.name === 'repoSrv') as { approval: string }).approval, 'approved', 'approve 后 GET approval=approved');

    // approve/deny 仅 project 有效：global → 400（全局条目用户手配不过批准阀）
    r = await mcpOp({ op: 'approve', scope: 'global', name: 'mine' });
    assert.equal(r.status, 400, 'global approve → 400');
    r = await mcpOp({ op: 'deny', scope: 'global', name: 'mine' });
    assert.equal(r.status, 400, 'global deny → 400');
  });
});

test('mcp/op 守卫面：注释既有文件 409 hint 引流 raw（原文逐字保真）；畸形 JSON 409（INVALID 同桶）；project 缺 root/未知 op/缺 name/坏 scope 400', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    const file = projMcpFile(home);
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });

    // 注释文件 → 409 {error, hint:'use raw editor'}（结构化写不毁注释，引流 raw 编辑面；盘原样）
    const commented = '{\n  // 手写注释\n  "mcpServers": {}\n}\n';
    fs.writeFileSync(file, commented, 'utf8');
    let r = await mcpOp({ op: 'add', scope: 'project', root: proj, name: 'x', server: { command: 'node' } });
    assert.equal(r.status, 409, '注释文件 → 409');
    assert.equal((r.body as { hint?: string }).hint, 'use raw editor', '409 带 hint 引流 raw');
    assert.equal(fs.readFileSync(file, 'utf8'), commented, '409 面零盘上副作用（注释原样）');

    // 畸形 JSON → 409（catalog 写面 INVALID 属内容/写面错误——控制器裁定 2026-10-28 与 brief 契约行：
    // COMMENTS/INVALID → 409 {error, hint}；readJsoncDoc 降级空 doc 照写等于毁既有内容，拒写引流）
    fs.writeFileSync(file, '{ not json', 'utf8');
    r = await mcpOp({ op: 'add', scope: 'project', root: proj, name: 'x', server: { command: 'node' } });
    assert.equal(r.status, 409, '畸形 JSON → 409（INVALID）');
    assert.equal((r.body as { hint?: string }).hint, 'use raw editor', 'INVALID 409 带 hint');
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', '409 面零盘上副作用');

    // 请求形态面：project 缺 root / 未知 op / 缺 name / 坏 scope
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }), 'utf8');
    r = await mcpOp({ op: 'add', scope: 'project', name: 'x', server: { command: 'node' } });
    assert.equal(r.status, 400, 'project 缺 root → 400');
    r = await mcpOp({ op: 'bogus', scope: 'project', root: proj, name: 'x' });
    assert.equal(r.status, 400, '未知 op → 400');
    r = await mcpOp({ op: 'add', scope: 'project', root: proj, server: { command: 'node' } });
    assert.equal(r.status, 400, '缺 name → 400');
    r = await mcpOp({ op: 'add', scope: 'team', root: proj, name: 'x', server: { command: 'node' } });
    assert.equal(r.status, 400, '坏 scope → 400');
  });
});

test('agents op：enable/disable 落 frontmatter enabled 行（原位替换非重复行；upsert 已走 catalog 落新家）；enable 缺失 409', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    // upsert（既有 op——实现改走 catalog）：落位=新家 <root>/.sunshinex/agents/<id>/agent.md
    let r = await agentsPut({ op: 'upsert', scope: 'project', root: proj, id: 'e1', frontmatter: { name: 'E One' }, body: 'b' });
    assert.equal(r.status, 200, 'upsert 应 200');
    const newHomeFile = path.join(proj, '.sunshinex', 'agents', 'e1', 'agent.md');
    assert.equal(fs.readFileSync(newHomeFile, 'utf8'), '---\nname: E One\n---\nb', 'upsert 落新家（catalog agentsDir 单点）');

    // enable：frontmatter 落 enabled: true 行（保序插入）
    r = await agentsPut({ op: 'enable', scope: 'project', root: proj, id: 'e1' });
    assert.equal(r.status, 200, 'enable 应 200');
    assert.deepEqual(await r.body, { ok: true });
    assert.ok(fs.readFileSync(newHomeFile, 'utf8').includes('enabled: true'), 'enable 落 frontmatter enabled:true');
    // disable：既有行原位替换（单行，非重复追加）
    r = await agentsPut({ op: 'disable', scope: 'project', root: proj, id: 'e1' });
    assert.equal(r.status, 200, 'disable 应 200');
    const md = fs.readFileSync(newHomeFile, 'utf8');
    assert.equal(md.split('enabled:').length - 1, 1, 'enabled 行原位替换（恰一行）');
    assert.ok(md.includes('enabled: false'), 'disable 落 enabled:false');

    // 缺失条目 → 409（catalog INVALID 写面拒写；旧位置条目须先 migrate——写面只认新家）
    fs.mkdirSync(path.join(proj, 'agents', 'legacy1'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'agents', 'legacy1', 'agent.md'), '---\nname: L1\n---\nold\n', 'utf8');
    r = await agentsPut({ op: 'enable', scope: 'project', root: proj, id: 'ghost' });
    assert.equal(r.status, 409, 'enable 缺失条目 → 409');
    r = await agentsPut({ op: 'disable', scope: 'project', root: proj, id: 'legacy1' });
    assert.equal(r.status, 409, 'enable/disable 不认旧位置条目（迁移前置）→ 409');
    assert.equal((r.body as { hint?: string }).hint, 'use raw editor', '写面 INVALID 409 带 hint');
  });
});

test('agents op migrate：legacy→新家整目录拷贝（旧位置保留）；非 legacy 条目 404；缺 root 400；delete 兼容旧位置（catalog 收口+serve 旧位回退）', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    const legacyFile = path.join(proj, 'agents', 'm1', 'agent.md');
    const newHomeFile = path.join(proj, '.sunshinex', 'agents', 'm1', 'agent.md');
    fs.mkdirSync(path.join(proj, 'agents', 'm1'), { recursive: true });
    fs.writeFileSync(legacyFile, '---\nname: M One\n---\nold body\n', 'utf8');

    // migrate：legacy <root>/agents/m1 → 新家 <root>/.sunshinex/agents/m1（整目录拷贝，旧位置保留不删）
    let r = await agentsPut({ op: 'migrate', root: proj, id: 'm1' });
    assert.equal(r.status, 200, 'migrate 应 200');
    assert.deepEqual(await r.body, { ok: true });
    assert.equal(fs.readFileSync(newHomeFile, 'utf8'), '---\nname: M One\n---\nold body\n', '新家同内容');
    assert.equal(fs.existsSync(legacyFile), true, '旧位置保留（只迁不删）');

    // 非 legacy 条目 → 404（迁移是 legacy 专属动作——无 legacy 源目录即无从迁，brief 明定 404）
    r = await agentsPut({ op: 'migrate', root: proj, id: 'never' });
    assert.equal(r.status, 404, '不存在的 legacy 条目 → 404');
    // 已迁条目再迁：legacy 源仍在（只迁不删）→ 过 404 预检，撞新家已存在 → 400（裁定例外项保留
    // 原判——撞新家属请求所指目标状态冲突，不入「内容/写面错误 → 409」桶）
    r = await agentsPut({ op: 'migrate', root: proj, id: 'm1' });
    assert.equal(r.status, 400, '撞新家已存在 → 400（裁定例外项）');
    r = await agentsPut({ op: 'migrate', id: 'm1' });
    assert.equal(r.status, 400, 'migrate 缺 root → 400');

    // delete 兼容：catalog removeAgent 收口新家；旧位置条目（catalog 无删除面——只迁不删）由 serve 幂等回退收口
    r = await agentsPut({ op: 'delete', scope: 'project', root: proj, id: 'm1' });
    assert.equal(r.status, 200, 'delete 应 200');
    assert.equal(fs.existsSync(newHomeFile), false, '新家条目已删（catalog removeAgent）');
    assert.equal(fs.existsSync(legacyFile), true, '旧位置尚在（第一刀只删新家）');
    r = await agentsPut({ op: 'delete', scope: 'project', root: proj, id: 'm1' });
    assert.equal(r.status, 200, '再删幂等 200');
    assert.equal(fs.existsSync(legacyFile), false, '旧位置回退收口（幂等契约不回退——手建旧位条目仍可删）');
  });
});

test('INVALID → 409+hint 钉测（控制器裁定 2026-10-28：400=纯请求形状错误、409=内容/写面错误；同资源族 settings/mcp/plugins 结构化写面文件畸形同判 409）', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    const file = projMcpFile(home);
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: 'node' } } }), 'utf8');

    // 写面 INVALID（条目缺失）→ 409 {error, hint:'use raw editor'}，error 指名目标，盘零触碰
    const r = await mcpOp({ op: 'remove', scope: 'project', root: proj, name: 'ghost' });
    assert.equal(r.status, 409, '写面 INVALID → 409');
    assert.deepEqual(r.body, { error: r.body['error'], hint: 'use raw editor' }, '409 包络 = {error, hint}');
    assert.ok(((r.body as { error?: string }).error ?? '').includes('ghost'), 'error 指名缺失条目');
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ mcpServers: { keep: { command: 'node' } } }), '409 面零盘上副作用');

    // 对照组：请求形状错误仍 400（不带 hint）——坏 op / project 缺 root / global approve
    const badOp = await mcpOp({ op: 'bogus', scope: 'project', root: proj, name: 'keep' });
    assert.equal(badOp.status, 400, '坏 op → 400（纯请求形状）');
    assert.equal((badOp.body as { hint?: string }).hint, undefined, '400 不带 hint');
    const noRoot = await mcpOp({ op: 'remove', scope: 'project', name: 'keep' });
    assert.equal(noRoot.status, 400, 'project 缺 root → 400（纯请求形状）');
    const gApprove = await mcpOp({ op: 'approve', scope: 'global', name: 'keep' });
    assert.equal(gApprove.status, 400, 'global approve → 400（纯请求形状）');
  });
});
