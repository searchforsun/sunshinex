import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { parsePluginManifest } from './plugins';

function tmpPlugin(manifest: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'plug-'));
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  return dir;
}

test('合法 manifest 解析通过', () => {
  const dir = tmpPlugin({ manifestVersion: 1, id: 'demo', name: 'Demo', version: '0.1.0', description: 'd' });
  const r = parsePluginManifest(dir);
  assert.equal(r.errors.length, 0);
  assert.equal(r.manifest!.id, 'demo');
});
test('必填缺失 → errors 非空且 manifest null', () => {
  const r = parsePluginManifest(tmpPlugin({ manifestVersion: 1, id: 'demo' }));
  assert.ok(r.errors.length > 0);
  assert.equal(r.manifest, null);
});
test('未知顶层字段 → 告警忽略；保留键 commands/hooks/agents/tools → 告警已忽略', () => {
  const r = parsePluginManifest(tmpPlugin({ manifestVersion: 1, id: 'demo', name: 'D', version: '0.1.0', description: 'd', futureThing: 1, hooks: [] }));
  assert.notEqual(r.manifest, null); // manifest 仍在（派发裁定：brief 草稿恒真断言为笔误）
  assert.ok(r.warnings.some((w) => w.includes('futureThing')));
  assert.ok(r.warnings.some((w) => w.includes('hooks')));
});
test('manifestVersion 未知 major 拒载；id 与目录名不符告警', () => {
  const bad = parsePluginManifest(tmpPlugin({ manifestVersion: 2, id: 'demo', name: 'D', version: '0.1.0', description: 'd' }));
  assert.ok(bad.errors.length > 0 && bad.manifest === null);
  const dir = mkdtempSync(path.join(tmpdir(), 'plug-'));
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'other', name: 'D', version: '0.1.0', description: 'd' }));
  const r = parsePluginManifest(dir);
  assert.ok(r.warnings.some((w) => w.includes('目录名')));
});
test('JSON 非法/文件缺失 → errors 非空不抛', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plug-'));
  writeFileSync(path.join(dir, 'plugin.json'), '{oops');
  assert.ok(parsePluginManifest(dir).errors.length > 0);
  assert.ok(parsePluginManifest(path.join(dir, 'nope')).errors.length > 0);
});

// ---- 边界补钉（brief 五例之外的裁定面）----

test('id 非规范（大写/下划线）→ errors 且 manifest null', () => {
  const r = parsePluginManifest(tmpPlugin({ manifestVersion: 1, id: 'Bad_Id', name: 'D', version: '0.1.0', description: 'd' }));
  assert.ok(r.errors.some((e) => e.includes('id 非规范')));
  assert.equal(r.manifest, null);
});
test('version 空字符串 → errors（仅非空字符串口径，不做严格 semver）', () => {
  const r = parsePluginManifest(tmpPlugin({ manifestVersion: 1, id: 'demo', name: 'D', version: '', description: 'd' }));
  assert.ok(r.errors.some((e) => e.includes('version')));
  assert.equal(r.manifest, null);
});
test('保留键/未知字段不进解析产物（重建剔除，非原样透传）', () => {
  const r = parsePluginManifest(tmpPlugin({ manifestVersion: 1, id: 'demo', name: 'D', version: '0.1.0', description: 'd', hooks: [], commands: {}, zz: 1 }));
  assert.notEqual(r.manifest, null);
  const m = r.manifest as unknown as Record<string, unknown>;
  assert.equal(m.hooks, undefined);
  assert.equal(m.commands, undefined);
  assert.equal(m.zz, undefined);
});
test('mcpServers 合法条目全字段解析（safety/configArgs/configEnv/configDefaults/cwd/transport）', () => {
  const dir = tmpPlugin({
    manifestVersion: 1, id: 'demo', name: 'Demo', version: '0.1.0', description: 'd',
    mcpServers: {
      srv: {
        command: 'node', args: ['s.js'], env: { FOO: '1' }, transport: 'stdio', cwd: '.',
        safety: { act: ['a'], confirm: ['b'], observe: ['c'] },
        configArgs: { headless: ['--headless'] }, configEnv: { CU_WORKER: 'worker' }, configDefaults: { worker: 'pwsh' },
      },
    },
  });
  const r = parsePluginManifest(dir);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.manifest!.mcpServers!.srv, {
    command: 'node', args: ['s.js'], env: { FOO: '1' }, transport: 'stdio', cwd: '.',
    safety: { act: ['a'], confirm: ['b'], observe: ['c'] },
    configArgs: { headless: ['--headless'] }, configEnv: { CU_WORKER: 'worker' }, configDefaults: { worker: 'pwsh' },
  });
});
test('mcpServers 坏条目（缺 command/远程 transport/safety 矛盾）逐条跳过+告警，不整插件拒', () => {
  const r = parsePluginManifest(tmpPlugin({
    manifestVersion: 1, id: 'demo', name: 'Demo', version: '0.1.0', description: 'd',
    mcpServers: {
      nocommand: { args: ['x'] },
      remote: { command: 'npx', transport: 'http' },
      badsafety: { command: 'node', safety: { act: 'click' } },
      good: { command: 'node' },
    },
  }));
  assert.equal(r.errors.length, 0);
  assert.notEqual(r.manifest, null);
  assert.deepEqual(Object.keys(r.manifest!.mcpServers!), ['good']);
  assert.ok(r.warnings.some((w) => w.includes('nocommand')));
  assert.ok(r.warnings.some((w) => w.includes('remote')));
  assert.ok(r.warnings.some((w) => w.includes('badsafety')));
});
test('mcpServers 可选字段坏值：该键告警忽略，条目保留', () => {
  const r = parsePluginManifest(tmpPlugin({
    manifestVersion: 1, id: 'demo', name: 'Demo', version: '0.1.0', description: 'd',
    mcpServers: { s: { command: 'node', args: 'bad', configArgs: { k: 'bad' }, configEnv: { E: 1 }, configDefaults: 3, cwd: 9 } },
  }));
  assert.equal(r.errors.length, 0);
  const s = r.manifest!.mcpServers!.s;
  assert.deepEqual(s, { command: 'node' });
  assert.ok(r.warnings.some((w) => w.includes('mcpServers.s.args')));
  assert.ok(r.warnings.some((w) => w.includes('mcpServers.s.configArgs')));
  assert.ok(r.warnings.some((w) => w.includes('mcpServers.s.configEnv')));
  assert.ok(r.warnings.some((w) => w.includes('mcpServers.s.configDefaults')));
  assert.ok(r.warnings.some((w) => w.includes('mcpServers.s.cwd')));
});
test('顶层可选字段坏值（platforms/skills/defaultEnabled/config/configSchema）逐键告警忽略，manifest 仍在', () => {
  const r = parsePluginManifest(tmpPlugin({
    manifestVersion: 1, id: 'demo', name: 'Demo', version: '0.1.0', description: 'd',
    platforms: ['win32', 42], skills: 'skills', defaultEnabled: 'yes', config: 'nope', configSchema: [],
  }));
  assert.equal(r.errors.length, 0);
  assert.notEqual(r.manifest, null);
  assert.equal(r.manifest!.platforms, undefined);
  assert.equal(r.manifest!.skills, undefined);
  assert.equal(r.manifest!.defaultEnabled, undefined);
  assert.equal(r.manifest!.config, undefined);
  assert.equal(r.manifest!.configSchema, undefined);
  assert.ok(r.warnings.some((w) => w.includes('platforms')));
  assert.ok(r.warnings.some((w) => w.includes('skills')));
  assert.ok(r.warnings.some((w) => w.includes('defaultEnabled')));
  assert.ok(r.warnings.some((w) => w.includes('config')));
});
test('platforms 合法值（元素均字符串）原样保留，值合法性不校验枚举', () => {
  const r = parsePluginManifest(tmpPlugin({ manifestVersion: 1, id: 'demo', name: 'Demo', version: '0.1.0', description: 'd', platforms: ['win32', 'darwin'] }));
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.manifest!.platforms, ['win32', 'darwin']);
});
