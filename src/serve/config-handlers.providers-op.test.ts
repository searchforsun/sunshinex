/** PUT /settings/providers/op + PUT /settings/permissions/op 处理器直测（Task 16；沿
 *  config-handlers.mcp-op.test 先例：handler 纯函数形 req/res+io，io 全 fake 不起真 daemon）。
 *  覆盖：providers op 七值各一正例（add/update/remove/modelAdd/modelRemove/modelMove/setKey）+
 *  INVALID/COMMENTS 409（CatalogWriteError→409+hint，T15 裁定同映射）+ 请求形状 400 + setKey 后
 *  GET /settings providers 面 apiKeyPresent 翻转且响应无键值 + permissions op add/remove 落对应
 *  数组、add 去重、remove 缺失 409。
 *  T9 评审移交（providers 读面语义）：ProviderEntry.models = 文件显式值（非继承源级缺省），生效值
 *  看 choices——GET 面 entries.models 断言按 explicit 语义（tier/contextWindow 逐条直取文件显式位），
 *  生效序/生效值断言走 choices 面。
 *  reloadSettingsChain 用 daemon.reloadSettingsChain 同款复刻（清自填槽 → 项目→全局重装）——
 *  setKey 写 env 块后 apiKeyPresent（resolveProviderApiKey 走 process.env）翻转的盘外语义即锚定。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleProvidersOp, handlePermissionsOp, handleSettingsGet, type ConfigHandlerIo } from './config-handlers';
import {
  applySettings,
  getSelfFilledSlots,
  loadGlobalSettings,
  loadProjectSettings,
  resetSelfFilledSlots,
} from '../config/settings';

/** fake io：send 回执收集 + readJson 回放预设 body；reloadSettingsChain 为 daemon 同款复刻
 *  （configIo 注入的 reloadSettingsChain 在 daemon 里即此语义——测试内联复刻使 env 面翻转可断言） */
function fakeIo(body: unknown): { io: ConfigHandlerIo; sends: Array<{ status: number; body: Record<string, unknown> }> } {
  const sends: Array<{ status: number; body: Record<string, unknown> }> = [];
  const io: ConfigHandlerIo = {
    send: (_res, status, b) => sends.push({ status, body: b as Record<string, unknown> }),
    readJson: async () => ({ ok: true, body }),
    reloadSettingsChain: (root) => {
      for (const slot of getSelfFilledSlots()) delete process.env[slot];
      resetSelfFilledSlots();
      for (const filePath of [...(root !== undefined ? [loadProjectSettings(root)] : []), loadGlobalSettings()]) {
        try {
          applySettings(filePath);
        } catch {
          // 测试夹具文件恒干净——防御分支照 daemon 形态保留
        }
      }
    },
  };
  return { io, sends };
}

const dummyRes = {} as http.ServerResponse;

/** HOME 桩（config-handlers.test withFakeHome 同款）：全局 settings 定位面（userConfigDir =
 *  <home>/.sunshinex）随之隔离真实用户家；项目 root 一并落在桩内（随用例回收） */
async function withFakeHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-prov-op-handlers-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // env 密钥槽清场防真实环境串入（禁真实密钥；用毕恢复）
  const prevSpecific = process.env.SUNSHINEX_API_KEY_P1;
  const prevMain = process.env.SUNSHINEX_API_KEY;
  delete process.env.SUNSHINEX_API_KEY_P1;
  delete process.env.SUNSHINEX_API_KEY;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    if (prevSpecific === undefined) delete process.env.SUNSHINEX_API_KEY_P1; else process.env.SUNSHINEX_API_KEY_P1 = prevSpecific;
    if (prevMain === undefined) delete process.env.SUNSHINEX_API_KEY; else process.env.SUNSHINEX_API_KEY = prevMain;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function providersOp(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { io, sends } = fakeIo(body);
  await handleProvidersOp(io, { url: '/settings/providers/op' } as http.IncomingMessage, dummyRes);
  assert.equal(sends.length, 1, 'providers op 恰一次回执');
  return { status: sends[0]!.status, body: sends[0]!.body };
}

async function permissionsOp(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { io, sends } = fakeIo(body);
  await handlePermissionsOp(io, { url: '/settings/permissions/op' } as http.IncomingMessage, dummyRes);
  assert.equal(sends.length, 1, 'permissions op 恰一次回执');
  return { status: sends[0]!.status, body: sends[0]!.body };
}

function settingsGet(root?: string): { status: number; body: Record<string, unknown> } {
  const { io, sends } = fakeIo(null);
  const url = root === undefined ? '/settings' : `/settings?root=${encodeURIComponent(root)}`;
  handleSettingsGet(io, { url } as http.IncomingMessage, dummyRes);
  assert.equal(sends.length, 1, 'GET /settings 恰一次回执');
  return { status: sends[0]!.status, body: sends[0]!.body };
}

interface ProvidersFace {
  choices: Array<Record<string, unknown>>;
  entries: Array<Record<string, unknown>>;
  apiKeyPresent: Record<string, boolean>;
  warnings: string[];
}

/** providers op 七值正例链：一次流程串起 add → update → modelAdd → modelMove → modelRemove →
 *  setKey → remove，盘上面（文件结构）与读面（GET choices/entries）逐站对账 */
test('providers op 七值正例：add 落盘/update 增量/modelAdd/modelMove 翻序/modelRemove/setKey 落 env 槽/remove 摘源', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    const projFile = path.join(proj, '.sunshinex', 'settings.json');

    // add：name=身份、provider=条目补丁（baseUrl+非空 models 必备）→ 200 {ok:true} + 盘上条目
    let r = await providersOp({
      op: 'add', scope: 'project', root: proj, name: 'p1',
      provider: { baseUrl: 'https://p1/v1', contextWindow: 64000, models: [{ model: 'm1' }, { model: 'm2', tier: 'small', contextWindow: 8000 }] },
    });
    assert.equal(r.status, 200, 'add 应 200');
    assert.deepEqual(r.body, { ok: true }, '成功响应恰 {ok:true}');
    let doc = JSON.parse(fs.readFileSync(projFile, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(doc['providers'], [
      { name: 'p1', baseUrl: 'https://p1/v1', contextWindow: 64000, models: [{ model: 'm1' }, { model: 'm2', tier: 'small', contextWindow: 8000 }] },
    ], 'add 落盘条目原样');

    // update：增量手术——baseUrl 改、models/源级 contextWindow 不动
    r = await providersOp({ op: 'update', scope: 'project', root: proj, name: 'p1', provider: { baseUrl: 'https://p1/v2' } });
    assert.equal(r.status, 200, 'update 应 200');
    doc = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    assert.equal((doc['providers'] as Array<Record<string, unknown>>)[0]!.baseUrl, 'https://p1/v2', 'baseUrl 已更新');
    assert.equal((doc['providers'] as Array<Record<string, unknown>>)[0]!.contextWindow, 64000, '未提字段不动');

    // modelAdd：entry=模型条目
    r = await providersOp({ op: 'modelAdd', scope: 'project', root: proj, name: 'p1', entry: { model: 'm3', tier: 'large' } });
    assert.equal(r.status, 200, 'modelAdd 应 200');
    doc = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    assert.deepEqual((doc['providers'] as Array<{ models: Array<Record<string, unknown>> }>)[0]!.models.map((m) => m.model), ['m1', 'm2', 'm3'], 'm3 追加');

    // modelMove：direction=up 相邻互换（choices 序 = providers 序 × models 序随之）
    r = await providersOp({ op: 'modelMove', scope: 'project', root: proj, name: 'p1', model: 'm3', direction: 'up' });
    assert.equal(r.status, 200, 'modelMove 应 200');
    doc = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    assert.deepEqual((doc['providers'] as Array<{ models: Array<Record<string, unknown>> }>)[0]!.models.map((m) => m.model), ['m1', 'm3', 'm2'], 'm3 上移一位');

    // modelRemove：摘 m1（settings reload 复刻后 GET choices 序随之——见下站 GET 断言）
    r = await providersOp({ op: 'modelRemove', scope: 'project', root: proj, name: 'p1', model: 'm1' });
    assert.equal(r.status, 200, 'modelRemove 应 200');
    doc = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    assert.deepEqual((doc['providers'] as Array<{ models: Array<Record<string, unknown>> }>)[0]!.models.map((m) => m.model), ['m3', 'm2'], 'm1 已摘');

    // setKey：落 env 专用槽；成功响应恰 {ok:true}——apiKey 值零回显
    r = await providersOp({ op: 'setKey', scope: 'project', root: proj, name: 'p1', apiKey: 'stub-value-not-a-real-key' });
    assert.equal(r.status, 200, 'setKey 应 200');
    assert.deepEqual(r.body, { ok: true }, 'setKey 响应不含 apiKey 值');
    doc = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    assert.equal((doc['env'] as Record<string, string>)['SUNSHINEX_API_KEY_P1'], 'stub-value-not-a-real-key', 'env 专用槽落盘');

    // remove：源整条摘除
    r = await providersOp({ op: 'remove', scope: 'project', root: proj, name: 'p1' });
    assert.equal(r.status, 200, 'remove 应 200');
    doc = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    assert.deepEqual(doc['providers'], [], 'providers 键空数组');
  });
});

test('setKey 后 GET /settings：apiKeyPresent 翻转（env 链重载语义）且响应全文无键值；GET providers 面消费 catalog（entries 含 tier/apiKeyEnv/explicit models + choices 序）', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    await providersOp({
      op: 'add', scope: 'project', root: proj, name: 'p1',
      provider: { baseUrl: 'https://p1/v1', contextWindow: 64000, models: [{ model: 'm1' }, { model: 'm2', tier: 'small', contextWindow: 8000 }] },
    });

    // setKey 前：apiKeyPresent.p1 = false（env 槽无值）
    let g = settingsGet(proj);
    assert.equal(g.status, 200);
    let face = g.body.providers as unknown as ProvidersFace;
    assert.equal(face.apiKeyPresent['p1'], false, 'setKey 前未配置');
    assert.deepEqual(face.choices.map((c) => c.id), ['p1/m1', 'p1/m2'], 'choices 序 = providers 序 × models 序');
    assert.equal(face.choices[1]!.tier, 'small', 'choices 面 = 生效值（tier 条目级显式）');
    assert.equal(face.choices[1]!.contextWindow, 8000, 'choices 面 contextWindow = 条目级 > 源级缺省');
    // T9 评审移交语义：entries.models = 文件显式值——m2 的 tier/contextWindow 为条目显式位、m1 无继承
    assert.deepEqual(face.entries[0]!.models, [{ model: 'm1' }, { model: 'm2', tier: 'small', contextWindow: 8000 }], 'entries.models = 条目显式值（源级 64000 不继承进 m1）');
    assert.equal(face.entries[0]!.apiKeyEnv, 'SUNSHINEX_API_KEY_P1', 'entries 携带槽名（值永不回传）');
    assert.equal(face.entries[0]!.apiKeyPresent, false, 'entries.apiKeyPresent 与 apiKeyPresent 映射同源');

    // setKey（fake io 的 reloadSettingsChain = daemon 同款复刻：env 块落 process.env）
    const r = await providersOp({ op: 'setKey', scope: 'project', root: proj, name: 'p1', apiKey: 'stub-value-not-a-real-key' });
    assert.equal(r.status, 200);

    // setKey 后：apiKeyPresent 翻转 true；GET 响应全文（choices/entries/keys/warnings）不含键值
    g = settingsGet(proj);
    face = g.body.providers as unknown as ProvidersFace;
    assert.equal(face.apiKeyPresent['p1'], true, 'setKey 后 apiKeyPresent 翻转');
    assert.equal((face.entries[0] as { apiKeyPresent: boolean }).apiKeyPresent, true, 'entries 面同步翻转');
    assert.equal(
      JSON.stringify(g.body).includes('stub-value-not-a-real-key'),
      false,
      'GET 响应无 apiKey 值（密钥永不回传——只有槽名与在场布尔）',
    );
  });
});

test('providers op global scope：无 root 落全局 settings；无 root GET 仅全局面', async () => {
  await withFakeHome(async (home) => {
    const r = await providersOp({ op: 'add', scope: 'global', name: 'g1', provider: { baseUrl: 'https://g/v1', models: [{ model: 'gm' }] } });
    assert.equal(r.status, 200, 'global add 应 200（无需 root）');
    const gDoc = JSON.parse(fs.readFileSync(path.join(home, '.sunshinex', 'settings.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(gDoc['providers'], [{ name: 'g1', baseUrl: 'https://g/v1', models: [{ model: 'gm' }] }], 'global 落 <home>/.sunshinex/settings.json');

    const g = settingsGet();
    const face = g.body.providers as unknown as ProvidersFace;
    assert.deepEqual(face.choices.map((c) => c.id), ['g1/gm'], '无 root GET 仅全局面');
  });
});

test('providers op 409 面：COMMENTS/畸形 JSON → 409+hint 且原文零改动；缺失/重复/边界等写面 INVALID → 409+hint', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    const projFile = path.join(proj, '.sunshinex', 'settings.json');
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });

    // 注释文件 → 409 {error, hint:'use raw editor'}（结构化写不毁注释；盘原样）
    const commented = '{\n  // 手写注释\n  "version": 1\n}\n';
    fs.writeFileSync(projFile, commented, 'utf8');
    let r = await providersOp({ op: 'add', scope: 'project', root: proj, name: 'p', provider: { baseUrl: 'https://p/v1', models: [{ model: 'm' }] } });
    assert.equal(r.status, 409, '注释文件 → 409');
    assert.equal((r.body as { hint?: string }).hint, 'use raw editor', '409 带 hint 引流 raw');
    assert.equal(fs.readFileSync(projFile, 'utf8'), commented, '409 面零盘上副作用（注释原样）');

    // 畸形 JSON → 409（INVALID 同桶：readJsoncDoc 降级空 doc 照写等于毁既有内容）
    fs.writeFileSync(projFile, '{ not json', 'utf8');
    r = await providersOp({ op: 'add', scope: 'project', root: proj, name: 'p', provider: { baseUrl: 'https://p/v1', models: [{ model: 'm' }] } });
    assert.equal(r.status, 409, '畸形 JSON → 409（INVALID）');
    assert.equal((r.body as { hint?: string }).hint, 'use raw editor', 'INVALID 409 带 hint');
    assert.equal(fs.readFileSync(projFile, 'utf8'), '{ not json', '409 面零盘上副作用');

    // 干净文件上的写面 INVALID：remove 缺源 / setKey 缺源 / modelMove 边界 / modelAdd 重复 / add 缺 baseUrl / update 改名撞源
    fs.writeFileSync(
      projFile,
      JSON.stringify({ version: 1, providers: [{ name: 'p', baseUrl: 'https://p/v1', models: [{ model: 'm1' }] }, { name: 'q', baseUrl: 'https://q/v1', models: [{ model: 'qm' }] }] }),
      'utf8',
    );
    const cases: Array<[string, unknown]> = [
      ['remove 缺源', { op: 'remove', scope: 'project', root: proj, name: 'ghost' }],
      ['setKey 缺源', { op: 'setKey', scope: 'project', root: proj, name: 'ghost', apiKey: 'stub-value-not-a-real-key' }],
      ['modelMove 已在顶部', { op: 'modelMove', scope: 'project', root: proj, name: 'p', model: 'm1', direction: 'up' }],
      ['modelMove 缺模型', { op: 'modelMove', scope: 'project', root: proj, name: 'p', model: 'ghost', direction: 'up' }],
      ['modelAdd 同名重复', { op: 'modelAdd', scope: 'project', root: proj, name: 'p', entry: { model: 'm1' } }],
      ['add 缺 baseUrl', { op: 'add', scope: 'project', root: proj, name: 'r', provider: { models: [{ model: 'm' }] } }],
      ['update 改名撞源', { op: 'update', scope: 'project', root: proj, name: 'p', provider: { name: 'q' } }],
    ];
    for (const [label, body] of cases) {
      const bad = await providersOp(body);
      assert.equal(bad.status, 409, `${label} → 409`);
      assert.equal((bad.body as { hint?: string }).hint, 'use raw editor', `${label} → 409 带 hint`);
    }
  });
});

test('providers op 400 面：坏 op/坏 scope/缺 name/project 缺 root/载荷形状（provider·entry 非对象、缺 model、坏 direction、apiKey 非字符串）→ 400 无 hint 且零盘上副作用', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    const projFile = path.join(proj, '.sunshinex', 'settings.json');
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });
    fs.writeFileSync(projFile, JSON.stringify({ version: 1, providers: [{ name: 'p', baseUrl: 'https://p/v1', models: [{ model: 'm1' }] }] }), 'utf8');
    const raw = fs.readFileSync(projFile, 'utf8');

    const cases: Array<[string, unknown]> = [
      ['坏 op', { op: 'bogus', scope: 'project', root: proj, name: 'p' }],
      ['坏 scope', { op: 'remove', scope: 'team', root: proj, name: 'p' }],
      ['缺 name', { op: 'remove', scope: 'project', root: proj }],
      ['project 缺 root', { op: 'remove', scope: 'project', name: 'p' }],
      ['add 缺 provider', { op: 'add', scope: 'project', root: proj, name: 'q' }],
      ['add provider 非对象', { op: 'add', scope: 'project', root: proj, name: 'q', provider: 'garbage' }],
      ['update provider 非对象', { op: 'update', scope: 'project', root: proj, name: 'p', provider: 42 }],
      ['modelAdd 缺 entry', { op: 'modelAdd', scope: 'project', root: proj, name: 'p' }],
      ['modelAdd entry 非对象', { op: 'modelAdd', scope: 'project', root: proj, name: 'p', entry: 'm9' }],
      ['modelRemove 缺 model', { op: 'modelRemove', scope: 'project', root: proj, name: 'p' }],
      ['modelMove 缺 direction', { op: 'modelMove', scope: 'project', root: proj, name: 'p', model: 'm1' }],
      ['modelMove 坏 direction', { op: 'modelMove', scope: 'project', root: proj, name: 'p', model: 'm1', direction: 'sideways' }],
      ['setKey 缺 apiKey', { op: 'setKey', scope: 'project', root: proj, name: 'p' }],
      ['setKey apiKey 非字符串', { op: 'setKey', scope: 'project', root: proj, name: 'p', apiKey: 42 }],
    ];
    for (const [label, body] of cases) {
      const bad = await providersOp(body);
      assert.equal(bad.status, 400, `${label} → 400（纯请求形状）`);
      assert.equal((bad.body as { hint?: string }).hint, undefined, `${label} → 400 不带 hint`);
    }
    assert.equal(fs.readFileSync(projFile, 'utf8'), raw, '400 面零盘上副作用');
  });
});

test('permissions op：add 落对应数组且同值重加去重零落盘；remove 摘除、缺失 409；GET /settings permissions 面随之', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    const projFile = path.join(proj, '.sunshinex', 'settings.json');
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });

    // add：落 project settings permissions.deny
    let r = await permissionsOp({ op: 'add', scope: 'project', root: proj, list: 'deny', value: 'Bash(rm -rf /*)' });
    assert.equal(r.status, 200, 'add 应 200');
    assert.deepEqual(r.body, { ok: true });
    let doc = JSON.parse(fs.readFileSync(projFile, 'utf8')) as { permissions?: Record<string, string[]> };
    assert.deepEqual(doc.permissions, { deny: ['Bash(rm -rf /*)'] }, 'deny 落 project settings permissions.deny');

    // 同值重加：200 去重（单条不重复、零字节变化）
    const before = fs.readFileSync(projFile, 'utf8');
    r = await permissionsOp({ op: 'add', scope: 'project', root: proj, list: 'deny', value: 'Bash(rm -rf /*)' });
    assert.equal(r.status, 200, '同值重加应 200（add 去重幂等）');
    assert.equal(fs.readFileSync(projFile, 'utf8'), before, '同值重加零落盘');

    // 第二清单 + GET /settings permissions 面对账（merged/project 分立）
    await permissionsOp({ op: 'add', scope: 'project', root: proj, list: 'additionalDirs', value: '/tmp/playground' });
    const g = settingsGet(proj);
    const perms = g.body.permissions as { merged: Record<string, string[]>; project: Record<string, string[]> };
    assert.deepEqual(perms.project.deny, ['Bash(rm -rf /*)'], 'GET project 面随之');
    assert.deepEqual(perms.merged.additionalDirs, ['/tmp/playground'], 'GET merged 面随之');

    // remove：摘除；再删同值 → 409（catalog INVALID 严格语义）
    r = await permissionsOp({ op: 'remove', scope: 'project', root: proj, list: 'deny', value: 'Bash(rm -rf /*)' });
    assert.equal(r.status, 200, 'remove 应 200');
    doc = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    assert.deepEqual((doc['permissions'] as Record<string, string[]>).deny, [], '条目已摘除');
    r = await permissionsOp({ op: 'remove', scope: 'project', root: proj, list: 'deny', value: 'Bash(rm -rf /*)' });
    assert.equal(r.status, 409, 'remove 缺失 → 409');
    assert.equal((r.body as { hint?: string }).hint, 'use raw editor', '409 带 hint');

    // global scope：无 root 落全局 settings
    r = await permissionsOp({ op: 'add', scope: 'global', list: 'allow', value: 'Read(**)' });
    assert.equal(r.status, 200, 'global add 应 200');
    const gDoc = JSON.parse(fs.readFileSync(path.join(home, '.sunshinex', 'settings.json'), 'utf8')) as { permissions?: Record<string, string[]> };
    assert.deepEqual(gDoc.permissions, { allow: ['Read(**)'] }, 'global 落全局 settings');
  });
});

test('permissions op 409/400 面：value 空串 → 409+hint、COMMENTS → 409+hint；坏 op/list/scope、value 非字符串、project 缺 root → 400 无 hint', async () => {
  await withFakeHome(async (home) => {
    const proj = path.join(home, 'proj');
    const projFile = path.join(proj, '.sunshinex', 'settings.json');
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });

    // 注释文件 → 409 + hint（COMMENTS 引流 raw）；value 空串 → 409 + hint（catalog INVALID）
    const commented = '{\n  // 手写注释\n  "version": 1\n}\n';
    fs.writeFileSync(projFile, commented, 'utf8');
    let r = await permissionsOp({ op: 'add', scope: 'project', root: proj, list: 'deny', value: 'X' });
    assert.equal(r.status, 409, '注释文件 → 409');
    assert.equal((r.body as { hint?: string }).hint, 'use raw editor', '409 带 hint');
    assert.equal(fs.readFileSync(projFile, 'utf8'), commented, '409 面零盘上副作用');

    fs.writeFileSync(projFile, JSON.stringify({ version: 1 }), 'utf8');
    r = await permissionsOp({ op: 'add', scope: 'project', root: proj, list: 'deny', value: '   ' });
    assert.equal(r.status, 409, 'value 空白串 → 409（catalog INVALID——内容校验归 catalog）');
    assert.equal((r.body as { hint?: string }).hint, 'use raw editor', '409 带 hint');

    // 请求形状面 → 400 无 hint
    const cases: Array<[string, unknown]> = [
      ['坏 op', { op: 'toggle', scope: 'project', root: proj, list: 'deny', value: 'X' }],
      ['坏 list', { op: 'add', scope: 'project', root: proj, list: 'ask', value: 'X' }],
      ['缺 list', { op: 'add', scope: 'project', root: proj, value: 'X' }],
      ['坏 scope', { op: 'add', scope: 'team', root: proj, list: 'deny', value: 'X' }],
      ['value 非字符串', { op: 'add', scope: 'project', root: proj, list: 'deny', value: 42 }],
      ['缺 value', { op: 'add', scope: 'project', root: proj, list: 'deny' }],
      ['project 缺 root', { op: 'add', scope: 'project', list: 'deny', value: 'X' }],
    ];
    for (const [label, body] of cases) {
      const bad = await permissionsOp(body);
      assert.equal(bad.status, 400, `${label} → 400（纯请求形状）`);
      assert.equal((bad.body as { hint?: string }).hint, undefined, `${label} → 400 不带 hint`);
    }
    assert.equal(fs.readFileSync(projFile, 'utf8'), JSON.stringify({ version: 1 }), '400/409 面零盘上副作用');
  });
});
