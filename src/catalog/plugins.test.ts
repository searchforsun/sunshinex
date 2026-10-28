// src/catalog/plugins.test.ts —— catalog/plugins 插件清单视图 + 开关/配置结构化写钉行为。
// 纪律：全局 settings 与用户插件根全落 HOME 桩（withHome，沿 approvals.test 先例：userConfigDir→homeDir
// 尊重 $HOME，钉 HOME 即整体隔离），禁止直写真实 ~/.sunshinex；项目面用独立 root tmp。
// 路径断言一律走 loadGlobalSettings/loadProjectSettings 单点（写落位 = 装载读位，同源自证）。
// 注：内置根（仓内 plugins/browser-use、computer-use）随 listPlugins 真实装载，断言一律按 id 定位不按清单全长。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPlugins, setPluginEnabled, setPluginConfig } from './plugins';
import { loadGlobalSettings, loadProjectSettings } from '../config/settings';
import { CatalogWriteError } from './io';

/** HOME+root 双桩夹具：HOME 钉 tmp（全局 settings 与用户插件根落 $HOME/.sunshinex），root 为独立项目 tmp */
function withHome(fn: (home: string, root: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'sunshinex-plug-home-'));
  const root = mkdtempSync(join(tmpdir(), 'sunshinex-plug-root-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fn(home, root);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

/** 在 HOME 用户插件根造一个最小合法插件（目录名 = id，规避 id ≠ 目录名告警） */
function mkUserPlugin(home: string, id: string): void {
  const dir = join(home, '.sunshinex', 'plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ manifestVersion: 1, id, name: id, version: '0.1.0', description: 'd' }));
}

function writeJson(file: string, doc: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function findPlugin(root: string | null, id: string): { enabled: boolean } {
  const hit = listPlugins(root).plugins.find((p) => p.manifest.id === id);
  assert.ok(hit, `plugin ${id} 应在两级清单中`);
  return hit;
}

// ---- brief 用例 ①②③：listPlugins 两级 per-id 合并（2026-10-28 裁定反转复活的项目级语义）----

test('两级启用态：全局 enabled true + 项目 enabled false → 项目胜（listPlugins enabled===false）', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    writeJson(loadGlobalSettings(), { version: 1, plugins: { demo: { enabled: true } } });
    writeJson(loadProjectSettings(root), { version: 1, plugins: { demo: { enabled: false } } });
    assert.equal(findPlugin(root, 'demo').enabled, false, '项目关覆盖全局开（per-id 遮蔽）');
  });
});

test('两级回退：项目无该 id 记录（仅他 id 记录在场）→ 回全局 enabled', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    writeJson(loadGlobalSettings(), { version: 1, plugins: { demo: { enabled: true } } });
    writeJson(loadProjectSettings(root), { version: 1, plugins: { unrelated: { enabled: false } } });
    assert.equal(findPlugin(root, 'demo').enabled, true, '项目记录缺该 id → 全局值生效');
  });
});

test('项目 plugins:{} 空对象 → 不遮蔽任何 id（per-id 合并非整键替换）', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    mkUserPlugin(home, 'other');
    writeJson(loadGlobalSettings(), { version: 1, plugins: { demo: { enabled: true }, other: { enabled: false } } });
    writeJson(loadProjectSettings(root), { version: 1, plugins: {} });
    assert.equal(findPlugin(root, 'demo').enabled, true, '空对象不遮蔽：全局开保持');
    assert.equal(findPlugin(root, 'other').enabled, false, '空对象不遮蔽：全局关保持');
  });
});

// ---- brief 用例 ④：写面——记录内另一字段保留（开关写保 config）----

test('setPluginEnabled 写项目 scope：plugins.<id>.enabled 落盘且既有 config 保留', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    const projFile = loadProjectSettings(root);
    writeJson(projFile, { version: 1, plugins: { demo: { enabled: true, config: { k: 'v' } } } });
    setPluginEnabled(root, 'project', 'demo', false);
    assert.deepEqual(readJson(projFile)['plugins'], { demo: { enabled: false, config: { k: 'v' } } }, 'enabled 翻转、config 原样保留');
    assert.equal(findPlugin(root, 'demo').enabled, false, '写后装载口径立即可见');
  });
});

// ---- brief 用例 ⑤⑥：写拒面（COMMENTS / 未知 id INVALID）----

test('写纪律：目标 settings 含 JSONC 注释 → CatalogWriteError(COMMENTS)，原文零改动（两写函数同口径）', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    const projFile = loadProjectSettings(root);
    mkdirSync(join(projFile, '..'), { recursive: true });
    const raw = '{\n  // 手写注释\n  "version": 1,\n  "plugins": { "demo": { "enabled": true } }\n}\n';
    writeFileSync(projFile, raw);
    assert.throws(() => setPluginEnabled(root, 'project', 'demo', false),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'COMMENTS');
    assert.throws(() => setPluginConfig(root, 'project', 'demo', {}),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'COMMENTS');
    assert.equal(readFileSync(projFile, 'utf8'), raw, '零盘上副作用');
  });
});

test('未知 id → CatalogWriteError(INVALID)（listPlugins 定位在先，无装载态的 id 无从写语义键）', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    assert.throws(() => setPluginEnabled(root, 'project', 'ghost', true),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'INVALID' && e.message.includes('ghost'));
    assert.throws(() => setPluginConfig(root, 'project', 'ghost', { k: 'v' }),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'INVALID');
    assert.equal(existsSync(loadProjectSettings(root)), false, '拒写零盘上副作用（目标文件不因拒写而创建）');
  });
});

// ---- 补钉：global scope 写面 / config 写保 enabled / 盘上形态与拒写纪律（沿 approvals.test 先例）----

test('setPluginConfig 写 global scope（root=null）：既有 enabled 保留；listPlugins(null) 仅全局面（项目 settings 不参与）', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    writeJson(loadGlobalSettings(), { version: 1, plugins: { demo: { enabled: true } } });
    writeJson(loadProjectSettings(root), { version: 1, plugins: { demo: { enabled: false } } });
    setPluginConfig(null, 'global', 'demo', { worker: 'pwsh' });
    const g = readJson(loadGlobalSettings());
    assert.deepEqual((g['plugins'] as Record<string, unknown>)['demo'], { enabled: true, config: { worker: 'pwsh' } }, 'config 写保留 enabled');
    assert.equal(findPlugin(null, 'demo').enabled, true, 'root=null 仅全局面：项目 false 不参与合并');
    assert.equal(findPlugin(root, 'demo').enabled, false, '两级口径不受影响（对照）');
  });
});

test('新档创建：目标 settings 缺失 → 原子创建并补 version:1（daemon 结构化写同款口径）', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    setPluginEnabled(root, 'project', 'demo', true);
    const projFile = loadProjectSettings(root);
    const doc = readJson(projFile);
    assert.equal(doc['version'], 1);
    assert.deepEqual(doc['plugins'], { demo: { enabled: true } });
    assert.ok(readFileSync(projFile, 'utf8').endsWith('\n'), '尾随换行');
  });
});

test('写纪律：畸形 JSON / 根非对象 → CatalogWriteError(INVALID)，不整写覆盖既有内容', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    const projFile = loadProjectSettings(root);
    mkdirSync(join(projFile, '..'), { recursive: true });
    writeFileSync(projFile, '{ "version": 1, ');
    assert.throws(() => setPluginEnabled(root, 'project', 'demo', true),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'INVALID');
    assert.equal(readFileSync(projFile, 'utf8'), '{ "version": 1, ', '零盘上副作用');
    writeFileSync(projFile, '[1,2]');
    assert.throws(() => setPluginConfig(root, 'project', 'demo', {}),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'INVALID');
  });
});

test('写纪律：既有根级键/其他插件记录逐字保留；盘上形态 2-space + 尾随换行', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    mkUserPlugin(home, 'other');
    const projFile = loadProjectSettings(root);
    writeJson(projFile, { version: 1, model: 'm1', plugins: { other: { enabled: true } } });
    setPluginEnabled(root, 'project', 'demo', false);
    const doc = readJson(projFile);
    assert.equal(doc['model'], 'm1', '无关根级键不动');
    assert.deepEqual(doc['plugins'], { other: { enabled: true }, demo: { enabled: false } }, '其他插件记录不动');
    const raw = readFileSync(projFile, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.ok(raw.includes('  "model": "m1"'), '2-space 缩进形态');
  });
});

test('零变化不落盘：同值重写原文逐字节不动（无盘上副作用）', () => {
  withHome((home, root) => {
    mkUserPlugin(home, 'demo');
    const projFile = loadProjectSettings(root);
    writeJson(projFile, { version: 1, plugins: { demo: { enabled: false } } });
    const before = readFileSync(projFile, 'utf8');
    setPluginEnabled(root, 'project', 'demo', false);
    assert.equal(readFileSync(projFile, 'utf8'), before, '同值重写零字节变化');
  });
});
