/** catalog/providers 读面钉（providers 两级装载视图，§15 providers 归一化数据基座）：
 *  两级整键遮蔽（项目键在场含空数组遮蔽全局）、tier 解析（对象形态合法进 ModelChoice.tier、
 *  非法 warning 忽略模型保留）、apiKeyPresent env 桩两态（不写真键）、choices 序 = providers 序 × models 序 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listProviders } from './providers';
import { parseProvidersSpec } from '../config/providers';

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
