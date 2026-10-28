// src/catalog/mcp.test.ts —— catalog/mcp 读面（两级合并 + 遮蔽标注）钉行为。
// 纪律：globalDir/root 一律 mkdtempSync(tmpdir()) 桩，禁止直写真实 ~/.sunshinex。
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { mcpJsonPath, listMcpServers } from './mcp';

test('listMcpServers: 项目遮蔽全局同名，全局保留 shadowed 标注', () => {
  const g = mkdtempSync(join(tmpdir(), 'g')), p = mkdtempSync(join(tmpdir(), 'p'));
  writeFileSync(join(g, 'mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['a'] }, api: { url: 'https://x' } } }));
  mkdirSync(join(p, '.sunshinex'), { recursive: true });
  writeFileSync(join(p, '.sunshinex', 'mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'node', args: ['b'] } } }));
  const r = listMcpServers(p, g);
  // 排序钉死：全局先、项目后；各作用域内 name 字典序（api < fs）
  assert.deepEqual(r.entries.map((e) => `${e.scope}:${e.name}`), ['global:api', 'global:fs', 'project:fs']);
  // 项目条目胜出（就近遮蔽），本身不标 shadowed
  const fsEntry = r.entries.find((e) => e.name === 'fs' && e.scope === 'project')!;
  assert.equal(fsEntry.server.command, 'node'); assert.equal(fsEntry.shadowed, false);
  // 同名全局条目保留在列并标 shadowed（视图口径；装载面 Task 4 才真正丢弃）
  const gFs = r.entries.filter((e) => e.name === 'fs');
  assert.equal(gFs.length, 2); assert.ok(gFs.some((e) => e.scope === 'global' && e.shadowed));
  assert.equal(r.warnings.length, 0);
});
test('listMcpServers: 两级文件均缺 = 空表不报错；坏条目跳过进 warnings', () => {
  const g = mkdtempSync(join(tmpdir(), 'g')), p = mkdtempSync(join(tmpdir(), 'p'));
  const empty = listMcpServers(p, g);
  assert.deepEqual(empty.entries, []); assert.deepEqual(empty.warnings, []);
  // 坏条目：形状非法键被 parseMcpJsonFile 静默拒收，列举面对账后产告警（宁可少配不可错配、不抛错）
  writeFileSync(join(g, 'mcp.json'), JSON.stringify({ mcpServers: { good: { command: 'x' }, bad: 123, junk: { transport: 'bogus', command: 'y' } } }));
  const r = listMcpServers(p, g);
  assert.deepEqual(r.entries.map((e) => e.name), ['good']);
  assert.equal(r.entries[0].scope, 'global'); assert.equal(r.entries[0].approval, 'none');
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.some((w) => w.includes('bad'))); assert.ok(r.warnings.some((w) => w.includes('junk')));
});
test('enabled:false 条目仍在列（列表面标停用，加载面过滤是加载器职责）', () => {
  const g = mkdtempSync(join(tmpdir(), 'g')), p = mkdtempSync(join(tmpdir(), 'p'));
  writeFileSync(join(g, 'mcp.json'), JSON.stringify({ mcpServers: { off: { command: 'x', enabled: false }, on: { command: 'y' } } }));
  const r = listMcpServers(p, g);
  const off = r.entries.find((e) => e.name === 'off')!;
  assert.equal(off.server.enabled, false); assert.equal(off.shadowed, false);
  assert.deepEqual(r.entries.map((e) => e.name), ['off', 'on']); // 字典序：off < on
});
test('mcpJsonPath: global=<globalDir>/mcp.json；project=<root>/.sunshinex/mcp.json', () => {
  assert.equal(mcpJsonPath('global', null, '/g'), join('/g', 'mcp.json'));
  assert.equal(mcpJsonPath('project', '/r', '/g'), join('/r', '.sunshinex', 'mcp.json'));
});
