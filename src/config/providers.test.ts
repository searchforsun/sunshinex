/** providers 键装载钉（多源多模型清单，/model 数据面）：
 *  形状裁决（非法跳过不致命）、两级整键遮蔽、源密钥槽解析优先级、settings 解析面 providers 收留不告警 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseProvidersSpec, loadProviders, loadProvidersFull, resolveProviderApiKey } from './providers';
import { parseSettingsFile, flattenSettings } from './settings';
import { loadProjectSettings } from './settings';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('parseProvidersSpec：合法清单逐源展开为 源/模型 条目，同源同模型幂等去重', () => {
  const r = parseProvidersSpec([
    { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', models: [{ model: 'deepseek-chat' }, { model: 'deepseek-reasoner' }] },
    { name: 'bigmodel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ model: 'glm-4.7' }, { model: 'glm-4.7' }] },
  ], 'test.json');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.choices.map((c) => c.id), ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner', 'bigmodel/glm-4.7']);
  assert.equal(r.choices[0]!.baseUrl, 'https://api.deepseek.com/v1');
    });

test('parseProvidersSpec：非数组/条目非对象/缺 name/缺 baseUrl/models 空或条目形态坏 → warning 跳过，不致命', () => {
  const r = parseProvidersSpec([
    'not-an-object',
    { baseUrl: 'https://x/v1', models: [{ model: 'm' }] }, // 缺 name
    { name: 'a' }, // 缺 baseUrl
    { name: 'b', baseUrl: 'https://b/v1' }, // 缺 models
    { name: 'c', baseUrl: 'https://c/v1', models: [] }, // models 空
    // 混合坏条目按条跳过（不再整源连坐）：好条目保留、坏条目各一条 warning；
    // 字符串简写已退役（2026-10-29 去兼容清理）——'m1' 与 42、缺 model 对象同样逐条告警跳过
    { name: 'd', baseUrl: 'https://d/v1', models: ['m1', 42, { contextWindow: 1000 }] },
    { name: 'ok', baseUrl: 'https://ok/v1', models: [{ model: 'm' }] }, // 合法源保留
  ], 'test.json');
  assert.deepEqual(r.choices.map((c) => c.id), ['ok/m'], '坏条目只跳自己（含字符串简写），同源好条目保留');
  // 2026-11-17 「空 models 允许保留(先建源后加模型)」:该形态不再告警 → 八条降七条
  assert.equal(r.warnings.length, 7, '非法形态各一条 warning（含 d 源字符串简写/非对象/缺 model 三条坏条目）');
  assert.ok(r.warnings.some((w) => w.includes('models 条目须为对象形态')), '字符串简写有专属指引文案（对象形态）');
  const nonArray = parseProvidersSpec({ name: 'x' }, 'test.json');
  assert.deepEqual(nonArray.choices, []);
  assert.equal(nonArray.warnings.length, 1, '根非数组整键忽略');
  assert.deepEqual(parseProvidersSpec(undefined, 'test.json'), { choices: [], warnings: [] }, '键缺席 = 空清单零告警');
});

test('parseProvidersSpec：每模型窗口——条目对象形态 contextWindow > 源级缺省 > 未配置；非法窗口告警忽略但模型保留', () => {
  const r = parseProvidersSpec([
    {
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      contextWindow: 64000, // 源级缺省
      models: [
        { model: 'deepseek-chat' },                              // 无条目级覆盖：吃源级 64000
        { model: 'deepseek-reasoner', contextWindow: 128000 },   // 条目级覆盖源级
        { model: 'deepseek-bad', contextWindow: -1 },            // 非法条目窗口：告警忽略窗口、模型保留
      ],
    },
    { name: 'bigmodel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ model: 'glm-4.7' }] }, // 全链未配置
    { name: 'badsrc', baseUrl: 'https://bad/v1', contextWindow: 'big', models: [{ model: 'm' }] }, // 非法源级窗口
  ], 'test.json');
  assert.deepEqual(r.warnings, [
    'settings.json providers.deepseek models 条目 contextWindow 须为正数（test.json），该窗口已忽略',
    'settings.json providers.badsrc contextWindow 须为正数（test.json），已忽略',
  ]);
  const byId = new Map(r.choices.map((c) => [c.id, c]));
  assert.equal(byId.get('deepseek/deepseek-chat')!.contextWindow, 64000, '条目未声明回退源级缺省');
  assert.equal(byId.get('deepseek/deepseek-reasoner')!.contextWindow, 128000, '条目级窗口覆盖源级');
  assert.equal(byId.get('deepseek/deepseek-bad')!.contextWindow, 64000, '条目窗口非法回退源级（模型保留）');
  assert.equal(byId.get('bigmodel/glm-4.7')!.contextWindow, undefined, '全链未配置 = undefined（回全局链）');
  assert.equal(byId.get('badsrc/m')!.contextWindow, undefined, '源级窗口非法忽略（模型保留）');
});

test('loadProviders：项目级 providers 键整键遮蔽全局；项目缺键回落全局；JSONC 注释容忍', () => {
  // HOME/USERPROFILE 双变量重定向临时家目录：测试不触碰真实用户家目录（win32 先例，与 settings.test 同款夹具）
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-proj-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const globalDir = path.join(fakeHome, '.sunshinex');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'settings.json'), JSON.stringify({
      version: 1,
      providers: [{ name: 'global-src', baseUrl: 'https://g/v1', models: [{ model: 'gm' }] }],
    }), 'utf8');
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });

    const onlyGlobal = loadProviders(proj);
    assert.deepEqual(onlyGlobal.choices.map((c) => c.id), ['global-src/gm'], '项目缺键回落全局');

    fs.writeFileSync(loadProjectSettings(proj), JSON.stringify({
      version: 1,
      providers: [{ name: 'proj', baseUrl: 'https://p/v1', models: [{ model: 'pm1' }, { model: 'pm2' }] }],
    }), 'utf8');
    const shadowed = loadProviders(proj);
    assert.deepEqual(shadowed.choices.map((c) => c.id), ['proj/pm1', 'proj/pm2'], '项目键在场整键遮蔽全局');

    fs.writeFileSync(loadProjectSettings(proj), JSON.stringify({ version: 1, providers: [] }), 'utf8');
    assert.deepEqual(loadProviders(proj).choices, [], '项目空数组同为「在场」：遮蔽全局而非回落');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('源密钥解析（2026-11-22 内联裁定,无 env 回退）：读全局档条目 apiKey——条目缺/值空 = 未配置', () => {
  // HOME 桩隔离：resolveProviderApiKey 条目内联查找走全局 settings 装载——须钉空家目录防真实全局档串入
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-key-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  const prevMain = process.env.SUNSHINEX_API_KEY;
  try {
    // env 槽直配(老形态)不再被解析——密钥只认条目内联字段
    process.env.SUNSHINEX_API_KEY = 'main-key';
    process.env.SUNSHINEX_API_KEY_MY_PROVIDER = 'specific-key';
    fs.mkdirSync(path.join(fakeHome, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.sunshinex', 'settings.json'), JSON.stringify({
      version: 1,
      providers: [{ name: 'my-provider', baseUrl: 'https://p/v1', apiKey: 'inline-key', models: [{ model: 'm' }] }],
    }), 'utf8');
    assert.equal(resolveProviderApiKey('my-provider'), 'inline-key', '条目内联密钥直达');
    // 条目值空串 = 未配置(env 槽在场也不回退)
    fs.writeFileSync(path.join(fakeHome, '.sunshinex', 'settings.json'), JSON.stringify({
      version: 1,
      providers: [{ name: 'my-provider', baseUrl: 'https://p/v1', apiKey: '', models: [{ model: 'm' }] }],
    }), 'utf8');
    assert.equal(resolveProviderApiKey('my-provider'), undefined, '条目空串 = 未配置(无 env 回退)');
    // 条目缺席 = 未配置
    fs.writeFileSync(path.join(fakeHome, '.sunshinex', 'settings.json'), JSON.stringify({ version: 1 }), 'utf8');
    assert.equal(resolveProviderApiKey('my-provider'), undefined, '条目缺席 = 未配置');
  } finally {
    if (prevMain === undefined) delete process.env.SUNSHINEX_API_KEY;
    else process.env.SUNSHINEX_API_KEY = prevMain;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// 密钥内联（2026-11-22 用户裁定：推翻 D6 env 分组口径——apiKey 进条目字段、可回显；env 槽降为回退兼容）
test('providers 条目 apiKey 内联解析：收口（trim/空串=缺席/非串·超 2000 warning 跳字段）+ entries/choices 随装载带出', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-inline-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const globalDir = path.join(fakeHome, '.sunshinex');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'settings.json'), JSON.stringify({
      version: 1,
      providers: [
        { name: 'inline', baseUrl: 'https://i/v1', apiKey: '  sk-inline-1  ', models: [{ model: 'm' }] },
        { name: 'empty', baseUrl: 'https://e/v1', apiKey: '   ', models: [{ model: 'm' }] },
        { name: 'absent', baseUrl: 'https://a/v1', models: [{ model: 'm' }] },
        { name: 'badtype', baseUrl: 'https://b/v1', apiKey: 42, models: [{ model: 'm' }] },
        { name: 'toolong', baseUrl: 'https://t/v1', apiKey: 'x'.repeat(2001), models: [{ model: 'm' }] },
        { name: 'maxlen', baseUrl: 'https://x/v1', apiKey: 'k'.repeat(2000), models: [{ model: 'm' }] },
      ],
    }), 'utf8');
    const full = loadProvidersFull(null);
    const byName = new Map(full.providers.map((p) => [p.name, p]));
    assert.equal(byName.get('inline')!.apiKey, 'sk-inline-1', 'trim 归一落字段');
    assert.equal(byName.get('empty')!.apiKey, undefined, '空串=缺席');
    assert.equal(byName.get('absent')!.apiKey, undefined);
    assert.equal(byName.get('badtype')!.apiKey, undefined, '非串 warning 跳字段');
    assert.equal(byName.get('toolong')!.apiKey, undefined, '超 2000 warning 跳字段');
    assert.equal(byName.get('maxlen')!.apiKey, 'k'.repeat(2000), '上限内原样收口');
    assert.equal(full.warnings.length, 2, '坏字段各一条 warning，条目不连坐');
    assert.ok(full.warnings.some((w) => w.includes('apiKey')));
    // choices 同源带出（运行面 choiceAdapterConfig 直取的回显/装配数据基座）
    const inline = full.choices.find((c) => c.id === 'inline/m')!;
    assert.equal(inline.apiKey, 'sk-inline-1');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('resolveProviderApiKey（2026-11-22 内联裁定，无 env 回退）：读全局档条目 apiKey——条目缺/值空 = 未配置', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-chain-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  const prevSpecific = process.env.SUNSHINEX_API_KEY_MY_PROVIDER;
  const prevMain = process.env.SUNSHINEX_API_KEY;
  try {
    const globalDir = path.join(fakeHome, '.sunshinex');
    fs.mkdirSync(globalDir, { recursive: true });
    const writeProviders = (providers: unknown): void => {
      fs.writeFileSync(path.join(globalDir, 'settings.json'), JSON.stringify({ version: 1, providers }), 'utf8');
    };
    const models = [{ model: 'm' }];
    // ① 条目 apiKey 在场：直达（env 槽在场也不回退——env 槽机制退役）
    writeProviders([{ name: 'my-provider', baseUrl: 'https://p/v1', apiKey: 'inline-key', models }]);
    process.env.SUNSHINEX_API_KEY_MY_PROVIDER = 'env-key';
    assert.equal(resolveProviderApiKey('my-provider'), 'inline-key', '条目 apiKey 直达,env 槽在场不盖');
    // ② 条目 apiKey 空串 = 未配置（env 槽在场也不回退）
    writeProviders([{ name: 'my-provider', baseUrl: 'https://p/v1', models }]);
    assert.equal(resolveProviderApiKey('my-provider'), undefined, '条目无 apiKey = 未配置（env 槽退役）');
    delete process.env.SUNSHINEX_API_KEY_MY_PROVIDER;
    delete process.env.SUNSHINEX_API_KEY;
    // ③ 条目缺席 = 未配置
    writeProviders([]);
    assert.equal(resolveProviderApiKey('my-provider'), undefined, '条目缺席 = 未配置');
  } finally {
    if (prevSpecific === undefined) delete process.env.SUNSHINEX_API_KEY_MY_PROVIDER;
    else process.env.SUNSHINEX_API_KEY_MY_PROVIDER = prevSpecific;
    if (prevMain === undefined) delete process.env.SUNSHINEX_API_KEY;
    else process.env.SUNSHINEX_API_KEY = prevMain;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('settings 解析面：providers 收留为结构化键原值，flatten 不落未知键告警', () => {
  const tmp = tmpdir('sunshinex-prov-parse-');
  try {
    const file = path.join(tmp, 'settings.json');
    // model 标量键已退役（2026-10-28 spec §15，2026-10-29 撤专属指引面——与未知键同判）：本钉只锁
    // 「providers 结构化键不是拼错」——用存活语义键 language 充当平凡语义键
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      language: 'zh',
      providers: [{ name: 'x', baseUrl: 'https://x/v1', models: [{ model: 'a' }] }],
    }), 'utf8');
    const doc = parseSettingsFile(file)!;
    assert.ok(Array.isArray(doc.providers as unknown), 'providers 进结构化面');
    assert.equal(doc.semantic.providers, undefined, '不混入语义键面');
    const flat = flattenSettings(doc);
    assert.deepEqual(flat.warnings, [], '零未知键告警（结构化键不是拼错）');
    assert.equal(flat.slots.SUNSHINEX_LANGUAGE, 'zh');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('每模型缺省思考强度：条目 reasoningEffort > 源级缺省 > 未配置；非法值告警忽略但模型保留', () => {
  const r = parseProvidersSpec([
    {
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      reasoningEffort: 'high', // 源级缺省
      models: [
        { model: 'deepseek-chat' },                                // 无条目级覆盖：吃源级 high
        { model: 'deepseek-flash', reasoningEffort: 'low' },       // 条目级覆盖源级
        { model: 'deepseek-bad', reasoningEffort: 'turbo' },       // 非法条目级：告警忽略强度、回退源级、模型保留
      ],
    },
    { name: 'bigmodel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', reasoningEffort: 42, models: [{ model: 'glm-5.3' }] }, // 源级非法类型
  ], 'test.json');
  assert.deepEqual(r.warnings, [
    'settings.json providers.deepseek models 条目 reasoningEffort 须为 none|minimal|low|medium|high|xhigh|max（test.json），该强度已忽略',
    'settings.json providers.bigmodel reasoningEffort 须为 none|minimal|low|medium|high|xhigh|max（test.json），已忽略',
  ]);
  const byId = new Map(r.choices.map((c) => [c.id, c]));
  assert.equal(byId.get('deepseek/deepseek-chat')!.reasoningEffort, 'high', '条目未声明回退源级缺省');
  assert.equal(byId.get('deepseek/deepseek-flash')!.reasoningEffort, 'low', '条目级强度覆盖源级');
  assert.equal(byId.get('deepseek/deepseek-bad')!.reasoningEffort, 'high', '条目级非法回退源级（模型保留）');
  assert.equal(byId.get('bigmodel/glm-5.3')!.reasoningEffort, undefined, '源级非法忽略 = 未配置（回全局链）');
});

test('每模型自定义请求参数：models[].params 原样进 choices 与 entries；协议保留键/坏值告警忽略、好键保留', () => {
  const r = parseProvidersSpec([
    {
      name: 'bigmodel',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      models: [
        { model: 'glm-5.3-flash', params: { prompt_cache_key: 'sess-a', enable_thinking: false, temperature: 0.6 } },
        { model: 'glm-5.3', params: { model: 'hijack', good: 1, bad: () => 1 } }, // 保留键+坏值逐条剔出
        { model: 'glm-noparams' },
      ],
    },
  ], 'test.json');
  const byId = new Map(r.choices.map((c) => [c.id, c]));
  assert.deepEqual(byId.get('bigmodel/glm-5.3-flash')!.params, { prompt_cache_key: 'sess-a', enable_thinking: false, temperature: 0.6 });
  assert.deepEqual(byId.get('bigmodel/glm-5.3')!.params, { good: 1 }, '保留键与坏值剔出、好键保留');
  assert.equal(byId.get('bigmodel/glm-noparams')!.params, undefined, '未声明=零穿参');
  assert.equal(r.warnings.length, 2, '保留键与坏值各一条告警');
  assert.ok(r.warnings[0]!.includes('params.model 是协议字段'));
  assert.ok(r.warnings[1]!.includes('params.bad'));
});
