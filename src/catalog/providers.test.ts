/** catalog/providers 读面 + 写面钉（providers 两级装载视图，§15 providers 归一化数据基座）：
 *  读面：两级整键遮蔽（项目键在场含空数组遮蔽全局）、tier 解析（对象形态合法进 ModelChoice.tier、
 *  非法 warning 忽略模型保留）、apiKeyPresent env 桩两态（不写真键）、choices 序 = providers 序 × models 序。
 *  写面（Task 10，brief 七组用例）：add/update 增量/modelAdd/modelRemove（摘空自动删源）/modelMove
 *  （choices 序随之）/setProviderApiKey（env 块专用槽、空串删行、void 无回显）/同名重复 INVALID/注释 COMMENTS。
 *  纪律：HOME 桩隔离（禁真实 ~/.sunshinex）；禁真实密钥（桩值明标 not-a-real-key）；函数 void 无回显断言。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listProviders, upsertProvider, removeProvider, modelAdd, modelRemove, modelMove, setProviderApiKey } from './providers';
import { parseProvidersSpec } from '../config/providers';
import { loadGlobalSettings, loadProjectSettings } from '../config/settings';
import { CatalogWriteError } from './io';

/** HOME/USERPROFILE 双变量重定向临时家目录夹具（win32 先例，与 config/providers.test 同款）：
 *  测试不触碰真实用户家目录；退出无论成败恒恢复环境变量并清盘 */
function withHome<T>(fn: (fakeHome: string, proj: string) => T): T {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-prov-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-prov-proj-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return fn(fakeHome, proj);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

function writeJson(file: string, doc: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
}

test('listProviders 两级整键遮蔽：项目 providers 键在场（含空数组）遮蔽全局；项目缺键回落全局；root:null 仅全局', () => {
  withHome((fakeHome, proj) => {
    writeJson(path.join(fakeHome, '.sunshinex', 'settings.json'), {
      version: 1,
      providers: [{ name: 'global-src', baseUrl: 'https://g/v1', models: ['gm'] }],
    });
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });

    const onlyGlobal = listProviders(proj);
    assert.deepEqual(onlyGlobal.providers.map((p) => p.name), ['global-src'], '项目缺键回落全局');
    assert.deepEqual(onlyGlobal.choices.map((c) => c.id), ['global-src/gm']);

    writeJson(path.join(proj, '.sunshinex', 'settings.json'), {
      version: 1,
      providers: [{ name: 'proj', baseUrl: 'https://p/v1', models: ['pm1', 'pm2'] }],
    });
    const shadowed = listProviders(proj);
    assert.deepEqual(shadowed.providers.map((p) => p.name), ['proj'], '项目键在场整键遮蔽全局');
    assert.deepEqual(shadowed.choices.map((c) => c.id), ['proj/pm1', 'proj/pm2']);
    assert.equal(shadowed.providers[0]!.baseUrl, 'https://p/v1');
    assert.equal(shadowed.providers[0]!.apiKeyEnv, 'SUNSHINEX_API_KEY_PROJ');

    writeJson(path.join(proj, '.sunshinex', 'settings.json'), { version: 1, providers: [] });
    const empty = listProviders(proj);
    assert.deepEqual(empty.providers, [], '项目空数组同为「在场」：遮蔽全局而非回落');
    assert.deepEqual(empty.choices, []);

    const rootless = listProviders(null);
    assert.deepEqual(rootless.providers.map((p) => p.name), ['global-src'], 'root:null 仅全局（globalProvidersOnly 先例）');
  });
});

test('parseProvidersSpec tier 解析：对象形态合法档位进 ModelChoice.tier；非法 warning 忽略档位、模型保留；字符串形态无 tier', () => {
  const r = parseProvidersSpec([
    {
      name: 'p',
      baseUrl: 'https://p/v1',
      models: [
        { model: 'm-small', tier: 'small' },
        { model: 'm-medium', tier: 'medium' },
        { model: 'm-large', tier: 'large' },
        { model: 'm-plain' }, // 对象形态未声明 tier
        'm-string',           // 字符串形态无 tier 位
        { model: 'm-bad', tier: 'huge' }, // 非法档位：warning、模型保留、tier 不落
      ],
    },
  ], 'test.json');
  assert.deepEqual(r.warnings, [
    'settings.json providers.p models 条目 tier 须为 small|medium|large（test.json），该档位已忽略',
  ]);
  const byId = new Map(r.choices.map((c) => [c.id, c]));
  assert.equal(byId.get('p/m-small')!.tier, 'small');
  assert.equal(byId.get('p/m-medium')!.tier, 'medium');
  assert.equal(byId.get('p/m-large')!.tier, 'large');
  assert.equal(byId.get('p/m-plain')!.tier, undefined, '未声明 = undefined（档位路由按缺省处理）');
  assert.equal(byId.get('p/m-string')!.tier, undefined, '字符串形态没有 tier 位');
  assert.equal(byId.get('p/m-bad')!.tier, undefined, '非法档位忽略（模型保留）');
  assert.equal(r.choices.length, 6, '坏档位不连坐，六个模型全保留');
});

test('listProviders apiKeyPresent：专用 env 槽有值 true、无值 false（env 桩注入，不写真键）', () => {
  withHome((_fakeHome, proj) => {
    writeJson(path.join(proj, '.sunshinex', 'settings.json'), {
      version: 1,
      providers: [{ name: 'stubprov', baseUrl: 'https://s/v1', models: ['sm'] }],
    });
    // env 桩保存/恢复：先清场防真实环境串入（专用槽与主槽都钉，禁真实密钥）
    const prevSpecific = process.env.SUNSHINEX_API_KEY_STUBPROV;
    const prevMain = process.env.SUNSHINEX_API_KEY;
    delete process.env.SUNSHINEX_API_KEY_STUBPROV;
    delete process.env.SUNSHINEX_API_KEY;
    try {
      const absent = listProviders(proj);
      assert.equal(absent.providers[0]!.apiKeyEnv, 'SUNSHINEX_API_KEY_STUBPROV');
      assert.equal(absent.providers[0]!.apiKeyPresent, false, '槽无值 = 未配置');

      process.env.SUNSHINEX_API_KEY_STUBPROV = 'stub-value-not-a-real-key';
      const present = listProviders(proj);
      assert.equal(present.providers[0]!.apiKeyPresent, true, '槽有值 = 已配置');
    } finally {
      if (prevSpecific === undefined) delete process.env.SUNSHINEX_API_KEY_STUBPROV;
      else process.env.SUNSHINEX_API_KEY_STUBPROV = prevSpecific;
      if (prevMain === undefined) delete process.env.SUNSHINEX_API_KEY;
      else process.env.SUNSHINEX_API_KEY = prevMain;
    }
  });
});

test('listProviders choices 序 = providers 序 × models 序；providers 面镜像文件结构（源级/条目级显式值）', () => {
  withHome((_fakeHome, proj) => {
    writeJson(path.join(proj, '.sunshinex', 'settings.json'), {
      version: 1,
      providers: [
        { name: 'p1', baseUrl: 'https://p1/v1', contextWindow: 64000, models: ['m1', { model: 'm2', contextWindow: 128000 }] },
        { name: 'p2', baseUrl: 'https://p2/v1', models: ['m3'] },
      ],
    });
    const r = listProviders(proj);
    assert.deepEqual(
      r.choices.map((c) => c.id),
      ['p1/m1', 'p1/m2', 'p2/m3'],
      '外层 providers 序 × 内层 models 序（默认 = 首源首模型的既定规则数据基座）',
    );
    assert.equal(r.choices[0]!.contextWindow, 64000, 'choices 面 = 生效值（条目级 > 源级缺省）');
    assert.equal(r.choices[1]!.contextWindow, 128000);

    const p1 = r.providers[0]!;
    assert.equal(p1.name, 'p1');
    assert.equal(p1.baseUrl, 'https://p1/v1');
    assert.equal(p1.contextWindow, 64000, 'providers 面源级字段 = 源级显式值');
    assert.deepEqual(p1.models, [{ model: 'm1' }, { model: 'm2', contextWindow: 128000 }], '模型条目 = 条目显式值（文件结构镜像）');
    const p2 = r.providers[1]!;
    assert.equal(p2.contextWindow, undefined, '源级未声明 = undefined');
    assert.deepEqual(p2.models, [{ model: 'm3' }]);
    assert.deepEqual(r.warnings, []);
  });
});

// ---- 写面（Task 10，brief 七组用例）----

/** ① add→list 出现且 env 槽名正确；新档补 version:1、盘上 2-space + 尾随换行 */
test('upsertProvider add：不存在则建（baseUrl+非空 models 必备），list 立即可见、env 槽名正确、盘上形态合规', () => {
  withHome((_fakeHome, proj) => {
    upsertProvider(proj, 'project', 'prov-a', {
      baseUrl: 'https://a/v1',
      contextWindow: 32000,
      models: [{ model: 'm1' }, { model: 'm2', tier: 'small', contextWindow: 8000 }],
    });
    const view = listProviders(proj);
    assert.deepEqual(view.providers.map((p) => p.name), ['prov-a'], '写后装载口径立即可见');
    assert.equal(view.providers[0]!.apiKeyEnv, 'SUNSHINEX_API_KEY_PROV_A', '槽名经 providerApiKeyEnv 单点生成');
    assert.deepEqual(view.choices.map((c) => c.id), ['prov-a/m1', 'prov-a/m2'], 'choices 序 = providers 序 × models 序');

    const projFile = loadProjectSettings(proj);
    const raw = fs.readFileSync(projFile, 'utf8');
    const doc = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(doc['version'], 1, '新档补 version:1');
    assert.ok(raw.endsWith('\n'), '尾随换行');
    assert.ok(raw.includes('\n  "providers"'), '2-space 缩进形态');
    assert.deepEqual(doc['providers'], [
      { name: 'prov-a', baseUrl: 'https://a/v1', contextWindow: 32000, models: [{ model: 'm1' }, { model: 'm2', tier: 'small', contextWindow: 8000 }] },
    ], '盘上条目 = 文件结构镜像（源级字段 + models 条目显式值）');
  });
});

/** ① 补钉：add 拒收面——缺 baseUrl / 缺或空 models / 模型名空白 → INVALID 且零盘上副作用 */
test('upsertProvider add 校验：缺 baseUrl、缺或空 models、models 条目缺模型名 → INVALID，目标文件零触碰', () => {
  withHome((_fakeHome, proj) => {
    const projFile = loadProjectSettings(proj);
    const invalid = (e: unknown): boolean => e instanceof CatalogWriteError && e.code === 'INVALID';
    assert.throws(() => upsertProvider(proj, 'project', 'p', { models: [{ model: 'm' }] }), invalid, '缺 baseUrl 拒收');
    assert.throws(() => upsertProvider(proj, 'project', 'p', { baseUrl: 'https://p/v1' }), invalid, '缺 models 拒收');
    assert.throws(() => upsertProvider(proj, 'project', 'p', { baseUrl: 'https://p/v1', models: [] }), invalid, '空 models 拒收');
    assert.throws(() => upsertProvider(proj, 'project', 'p', { baseUrl: 'https://p/v1', models: [{ model: '  ' }] }), invalid, '模型名空白拒收');
    assert.equal(fs.existsSync(projFile), false, '拒写零盘上副作用（目标文件不因拒写而创建）');
  });
});

/** ② update 增量（未提字段不动）；patch.models 在场整组替换；同值重写零字节变化 */
test('upsertProvider update：存在则增量——未提字段不动、patch.models 整组替换、零变化不落盘', () => {
  withHome((_fakeHome, proj) => {
    const projFile = loadProjectSettings(proj);
    upsertProvider(proj, 'project', 'p', {
      baseUrl: 'https://p/v1', contextWindow: 64000, supportsImages: false,
      models: [{ model: 'm1', contextWindow: 1000 }, { model: 'm2', tier: 'medium' }],
    });
    upsertProvider(proj, 'project', 'p', { supportsImages: true });
    let doc = JSON.parse(fs.readFileSync(projFile, 'utf8')) as { providers: Array<Record<string, unknown>> };
    assert.deepEqual(doc.providers, [{
      name: 'p', baseUrl: 'https://p/v1', contextWindow: 64000, supportsImages: true,
      models: [{ model: 'm1', contextWindow: 1000 }, { model: 'm2', tier: 'medium' }],
    }], '只动 supportsImages；baseUrl/contextWindow/models 原样不动');

    upsertProvider(proj, 'project', 'p', { models: [{ model: 'm9' }] });
    doc = JSON.parse(fs.readFileSync(projFile, 'utf8')) as { providers: Array<Record<string, unknown>> };
    assert.deepEqual(doc.providers[0]!.models, [{ model: 'm9' }], 'patch.models 在场整组替换（非增量合并）');

    const before = fs.readFileSync(projFile, 'utf8');
    upsertProvider(proj, 'project', 'p', { supportsImages: true });
    assert.equal(fs.readFileSync(projFile, 'utf8'), before, '同值重写零字节变化（零变化不落盘）');
  });
});

/** ③⑥ modelAdd/modelRemove：追加/摘除；同名 model 重复 add → INVALID（字符串速记在场同算）；
 *  最后一条 model 摘除后源整条删除（models 空即非法形态）；removeProvider 缺源 → INVALID */
test('modelAdd/modelRemove：同名重复 add → INVALID；models 摘空自动删源整条；removeProvider 缺源 → INVALID', () => {
  withHome((_fakeHome, proj) => {
    const projFile = loadProjectSettings(proj);
    upsertProvider(proj, 'project', 'p', { baseUrl: 'https://p/v1', models: [{ model: 'm1' }] });
    modelAdd(proj, 'project', 'p', { model: 'm2', tier: 'large' });
    assert.deepEqual(listProviders(proj).choices.map((c) => c.id), ['p/m1', 'p/m2'], '追加即装载可见');

    const invalid = (e: unknown): boolean => e instanceof CatalogWriteError && e.code === 'INVALID';
    assert.throws(() => modelAdd(proj, 'project', 'p', { model: 'm2' }), invalid, '同名 model 重复 add → INVALID');
    // 字符串速记形态在场也算同名（文件两形态同口径）
    const doc = JSON.parse(fs.readFileSync(projFile, 'utf8')) as { providers: Array<{ models: unknown[] }> };
    doc.providers[0]!.models.push('m3');
    fs.writeFileSync(projFile, JSON.stringify(doc, null, 2) + '\n');
    assert.throws(() => modelAdd(proj, 'project', 'p', { model: 'm3' }), invalid, '字符串速记同名的重复同样拒绝');

    modelRemove(proj, 'project', 'p', 'm1');
    modelRemove(proj, 'project', 'p', 'm2');
    modelRemove(proj, 'project', 'p', 'm3');
    assert.deepEqual(listProviders(proj).providers, [], '最后一条 model 摘除后源整条删除');
    const after = JSON.parse(fs.readFileSync(projFile, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(after['providers'], [], '盘上 providers 键同步为空数组');

    assert.throws(() => modelRemove(proj, 'project', 'p', 'm1'), invalid, '源已删 → INVALID');
    assert.throws(() => modelRemove(proj, 'project', 'ghost', 'm1'), invalid, '源不存在 → INVALID');
    assert.throws(() => removeProvider(proj, 'project', 'ghost'), invalid, 'removeProvider 缺源 → INVALID');
  });
});

/** ④ modelMove up/down 相邻互换且 choices 序随之；边界与缺模型 → INVALID */
test('modelMove：相邻互换且 choices 序随之；已在边界/缺模型 → INVALID', () => {
  withHome((_fakeHome, proj) => {
    upsertProvider(proj, 'project', 'p', { baseUrl: 'https://p/v1', models: [{ model: 'm1' }, { model: 'm2' }, { model: 'm3' }] });
    const invalid = (e: unknown): boolean => e instanceof CatalogWriteError && e.code === 'INVALID';
    modelMove(proj, 'project', 'p', 'm2', 'up');
    assert.deepEqual(listProviders(proj).choices.map((c) => c.id), ['p/m2', 'p/m1', 'p/m3'], 'up=与前一位互换，choices 序随之');
    modelMove(proj, 'project', 'p', 'm2', 'down');
    assert.deepEqual(listProviders(proj).choices.map((c) => c.id), ['p/m1', 'p/m2', 'p/m3'], 'down=与后一位互换');
    modelMove(proj, 'project', 'p', 'm3', 'up');
    assert.deepEqual(listProviders(proj).choices.map((c) => c.id), ['p/m1', 'p/m3', 'p/m2']);
    assert.throws(() => modelMove(proj, 'project', 'p', 'm1', 'up'), invalid, '已在顶部 → INVALID');
    assert.throws(() => modelMove(proj, 'project', 'p', 'm2', 'down'), invalid, '已在底部 → INVALID');
    assert.throws(() => modelMove(proj, 'project', 'p', 'ghost', 'up'), invalid, '缺模型 → INVALID');
  });
});

/** ⑤ setProviderApiKey：env 块写专用槽（providerApiKeyEnv 生成）、空串删行、返回 void（无回显路径）；缺源 → INVALID */
test('setProviderApiKey：写 env 专用槽、空串删行、返回 void（无回显路径）；缺源 → INVALID', () => {
  withHome((_fakeHome, proj) => {
    const projFile = loadProjectSettings(proj);
    upsertProvider(proj, 'project', 'my-prov', { baseUrl: 'https://p/v1', models: [{ model: 'm1' }] });
    const ret = setProviderApiKey(proj, 'project', 'my-prov', 'stub-value-not-a-real-key');
    assert.equal(ret, undefined, '返回 void：本面无任何响应/回显路径');
    let doc = JSON.parse(fs.readFileSync(projFile, 'utf8')) as { env?: Record<string, string> };
    assert.equal(doc.env?.['SUNSHINEX_API_KEY_MY_PROV'], 'stub-value-not-a-real-key', '槽名经 providerApiKeyEnv（非字母数字折叠 _）');

    setProviderApiKey(proj, 'project', 'my-prov', '');
    doc = JSON.parse(fs.readFileSync(projFile, 'utf8')) as { env?: Record<string, string> };
    assert.equal(doc.env?.['SUNSHINEX_API_KEY_MY_PROV'], undefined, '空串 = 删除该 env 行');
    assert.deepEqual(doc.env, {}, 'env 块保留（空对象）');

    const invalid = (e: unknown): boolean => e instanceof CatalogWriteError && e.code === 'INVALID';
    assert.throws(() => setProviderApiKey(proj, 'project', 'ghost', 'stub-value-not-a-real-key'), invalid, 'provider 不在该 scope 装载视图 → INVALID');
    assert.equal(fs.existsSync(loadGlobalSettings()), false, 'project 拒写零盘上副作用（全局文件零触碰）');
  });
});

/** ⑦ 注释 → COMMENTS（先于一切内容守卫：内容非法的 patch 也报 COMMENTS）；各写函数同口径且原文零改动 */
test('写纪律：目标 settings 含 JSONC 注释 → COMMENTS（先于一切内容守卫），各写函数同口径且原文零改动', () => {
  withHome((_fakeHome, proj) => {
    const projFile = loadProjectSettings(proj);
    fs.mkdirSync(path.join(projFile, '..'), { recursive: true });
    const raw = '{\n  // 手写注释\n  "version": 1,\n  "providers": [{ "name": "p", "baseUrl": "https://p/v1", "models": ["m1"] }]\n}\n';
    fs.writeFileSync(projFile, raw);
    const comments = (e: unknown): boolean => e instanceof CatalogWriteError && e.code === 'COMMENTS';
    assert.throws(() => upsertProvider(proj, 'project', 'p', { supportsImages: true }), comments);
    // 内容守卫本应拒收的 patch（新建缺 baseUrl）也须先报 COMMENTS：守卫序 = COMMENTS 在先
    assert.throws(() => upsertProvider(proj, 'project', 'brand-new', { models: [{ model: 'm' }] }), comments);
    // 参数形状守卫同样让位 COMMENTS：空名 / 非法 direction / 非字符串 apiKey 都不抢先报 INVALID
    assert.throws(() => upsertProvider(proj, 'project', '  ', { baseUrl: 'https://x/v1', models: [{ model: 'm' }] }), comments);
    assert.throws(() => modelMove(proj, 'project', 'p', 'm1', 'sideways' as 'up'), comments);
    assert.throws(() => setProviderApiKey(proj, 'project', 'p', 42 as unknown as string), comments);
    assert.throws(() => removeProvider(proj, 'project', 'p'), comments);
    assert.throws(() => modelAdd(proj, 'project', 'p', { model: 'm2' }), comments);
    assert.throws(() => modelRemove(proj, 'project', 'p', 'm1'), comments);
    assert.throws(() => modelMove(proj, 'project', 'p', 'm1', 'up'), comments);
    assert.throws(() => setProviderApiKey(proj, 'project', 'p', 'stub-value-not-a-real-key'), comments);
    assert.equal(fs.readFileSync(projFile, 'utf8'), raw, '零盘上副作用（原文逐字保留）');
  });
});

/** 补钉：global scope 写面（root=null 落全局 settings）；project 写 root=null → INVALID（agentWriteTarget 先例） */
test('global scope 写面：upsert/remove 落全局 settings；project 写 root=null → INVALID', () => {
  withHome((_fakeHome, proj) => {
    upsertProvider(null, 'global', 'g', { baseUrl: 'https://g/v1', models: [{ model: 'gm' }] });
    const gFile = loadGlobalSettings();
    assert.deepEqual(listProviders(null).providers.map((p) => p.name), ['g'], 'root=null 仅全局面装载可见');
    assert.throws(
      () => upsertProvider(null, 'project', 'p', { baseUrl: 'https://p/v1', models: [{ model: 'm' }] }),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'INVALID',
      'project 写 root=null → INVALID（绝不借道 cwd 凭空落盘）',
    );
    assert.equal(fs.existsSync(loadProjectSettings(proj)), false, 'project 拒写零盘上副作用');
    removeProvider(null, 'global', 'g');
    assert.deepEqual(listProviders(null).providers, [], '移除后全局面为空');
    assert.ok(fs.existsSync(gFile), '全局文件由写面原子创建');
  });
});
