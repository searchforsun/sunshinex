/** providers 键装载钉（多源多模型清单，/model 数据面）：
 *  形状裁决（非法跳过不致命）、两级整键遮蔽、源密钥槽解析优先级、settings 解析面 providers 收留不告警 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseProvidersSpec, loadProviders, providerApiKeyEnv, resolveProviderApiKey } from './providers';
import { parseSettingsFile, flattenSettings } from './settings';
import { loadProjectSettings } from './settings';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('parseProvidersSpec：合法清单逐源展开为 源/模型 条目，同源同模型幂等去重', () => {
  const r = parseProvidersSpec([
    { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { name: 'bigmodel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.7', 'glm-4.7'] },
  ], 'test.json');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.choices.map((c) => c.id), ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner', 'bigmodel/glm-4.7']);
  assert.equal(r.choices[0]!.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(r.choices[0]!.apiKeyEnv, 'SUNSHINEX_API_KEY_DEEPSEEK');
  assert.equal(r.choices[2]!.apiKeyEnv, 'SUNSHINEX_API_KEY_BIGMODEL');
});

test('parseProvidersSpec：非数组/条目非对象/缺 name/缺 baseUrl/models 空或条目形态坏 → warning 跳过，不致命', () => {
  const r = parseProvidersSpec([
    'not-an-object',
    { baseUrl: 'https://x/v1', models: ['m'] }, // 缺 name
    { name: 'a' }, // 缺 baseUrl
    { name: 'b', baseUrl: 'https://b/v1' }, // 缺 models
    { name: 'c', baseUrl: 'https://c/v1', models: [] }, // models 空
    // 混合坏条目按条跳过（不再整源连坐）：好条目保留、坏条目各一条 warning
    { name: 'd', baseUrl: 'https://d/v1', models: ['m1', 42, { contextWindow: 1000 }] },
    { name: 'ok', baseUrl: 'https://ok/v1', models: ['m'] }, // 合法源保留
  ], 'test.json');
  assert.deepEqual(r.choices.map((c) => c.id), ['d/m1', 'ok/m'], '坏条目只跳自己，同源好条目保留');
  assert.equal(r.warnings.length, 7, '七条非法形态各一条 warning（含 d 源两条坏条目）');
  const nonArray = parseProvidersSpec({ name: 'x' }, 'test.json');
  assert.deepEqual(nonArray.choices, []);
  assert.equal(nonArray.warnings.length, 1, '根非数组整键忽略');
  assert.deepEqual(parseProvidersSpec(undefined, 'test.json'), { choices: [], warnings: [] }, '键缺席 = 空清单零告警');
});

test('parseProvidersSpec：每模型窗口——对象形态 contextWindow > 源级缺省 > 未配置；非法窗口告警忽略但模型保留', () => {
  const r = parseProvidersSpec([
    {
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      contextWindow: 64000, // 源级缺省
      models: [
        'deepseek-chat',                                        // 纯字符串：吃源级 64000
        { model: 'deepseek-reasoner', contextWindow: 128000 },   // 条目级覆盖源级
        { model: 'deepseek-bad', contextWindow: -1 },            // 非法条目窗口：告警忽略窗口、模型保留
      ],
    },
    { name: 'bigmodel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.7'] }, // 全链未配置
    { name: 'badsrc', baseUrl: 'https://bad/v1', contextWindow: 'big', models: ['m'] }, // 非法源级窗口
  ], 'test.json');
  assert.deepEqual(r.warnings, [
    'settings.json providers.deepseek models 条目 contextWindow 须为正数（test.json），该窗口已忽略',
    'settings.json providers.badsrc contextWindow 须为正数（test.json），已忽略',
  ]);
  const byId = new Map(r.choices.map((c) => [c.id, c]));
  assert.equal(byId.get('deepseek/deepseek-chat')!.contextWindow, 64000, '纯字符串条目回退源级缺省');
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
      providers: [{ name: 'global-src', baseUrl: 'https://g/v1', models: ['gm'] }],
    }), 'utf8');
    fs.mkdirSync(path.join(proj, '.sunshinex'), { recursive: true });

    const onlyGlobal = loadProviders(proj);
    assert.deepEqual(onlyGlobal.choices.map((c) => c.id), ['global-src/gm'], '项目缺键回落全局');

    fs.writeFileSync(loadProjectSettings(proj), JSON.stringify({
      version: 1,
      providers: [{ name: 'proj', baseUrl: 'https://p/v1', models: ['pm1', 'pm2'] }],
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

test('源密钥槽：专用槽 SUNSHINEX_API_KEY_<大写名> > 主槽 SUNSHINEX_API_KEY；槽名非字母数字段折叠', () => {
  assert.equal(providerApiKeyEnv('deepseek'), 'SUNSHINEX_API_KEY_DEEPSEEK');
  assert.equal(providerApiKeyEnv('my-provider'), 'SUNSHINEX_API_KEY_MY_PROVIDER');
  const prevSpecific = process.env.SUNSHINEX_API_KEY_MY_PROVIDER;
  const prevMain = process.env.SUNSHINEX_API_KEY;
  try {
    process.env.SUNSHINEX_API_KEY = 'main-key';
    process.env.SUNSHINEX_API_KEY_MY_PROVIDER = 'specific-key';
    assert.equal(resolveProviderApiKey('my-provider'), 'specific-key', '专用槽优先');
    delete process.env.SUNSHINEX_API_KEY_MY_PROVIDER;
    assert.equal(resolveProviderApiKey('my-provider'), 'main-key', '缺专用槽回退主槽');
    process.env.SUNSHINEX_API_KEY = '';
    assert.equal(resolveProviderApiKey('my-provider'), undefined, '主槽空串 = 未配置');
  } finally {
    if (prevSpecific === undefined) delete process.env.SUNSHINEX_API_KEY_MY_PROVIDER;
    else process.env.SUNSHINEX_API_KEY_MY_PROVIDER = prevSpecific;
    if (prevMain === undefined) delete process.env.SUNSHINEX_API_KEY;
    else process.env.SUNSHINEX_API_KEY = prevMain;
  }
});

test('settings 解析面：providers 收留为结构化键原值，flatten 不落未知键告警', () => {
  const tmp = tmpdir('sunshinex-prov-parse-');
  try {
    const file = path.join(tmp, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      model: 'm',
      providers: [{ name: 'x', baseUrl: 'https://x/v1', models: ['a'] }],
    }), 'utf8');
    const doc = parseSettingsFile(file)!;
    assert.ok(Array.isArray(doc.providers as unknown), 'providers 进结构化面');
    assert.equal(doc.semantic.providers, undefined, '不混入语义键面');
    const flat = flattenSettings(doc);
    assert.deepEqual(flat.warnings, [], '零未知键告警（结构化键不是拼错）');
    assert.equal(flat.slots.SUNSHINEX_MODEL, 'm');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
