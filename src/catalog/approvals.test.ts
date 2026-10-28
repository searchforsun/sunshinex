// src/catalog/approvals.test.ts —— catalog/approvals 项目 MCP 批准阀钉行为。
// 纪律：approvalState/approve/deny 读写「全局 settings」，HOME 一律 mkdtempSync(tmpdir()) 桩
// （userConfigDir→homeDir 尊重 $HOME，钉 HOME 即整体隔离），禁止直写真实 ~/.sunshinex；
// listMcpServers 的 mcp.json 面（globalDir/root）沿 mcp.test.ts 同款 tmp 桩。
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { approvalState, approveMcpServer, denyMcpServer } from './approvals';
import { listMcpServers } from './mcp';
import { projectSlug } from '../config/data-dir';
import { CatalogWriteError } from './io';

/** HOME+root 双桩夹具：HOME 钉 tmp（全局 settings 落 $HOME/.sunshinex），root 为独立项目 tmp */
function withHome(fn: (home: string, root: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'sunshinex-appr-home-'));
  const root = mkdtempSync(join(tmpdir(), 'sunshinex-appr-root-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fn(home, root);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

function settingsFile(home: string): string { return join(home, '.sunshinex', 'settings.json'); }
function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsFile(home), 'utf8')) as Record<string, unknown>;
}

test('approvalState: 缺文件/无记录/键形状非法 → pending（宁拦勿放）', () => {
  withHome((home, root) => {
    assert.equal(approvalState(root, 'fs'), 'pending'); // settings.json 缺失
    mkdirSync(join(home, '.sunshinex'), { recursive: true });
    writeFileSync(settingsFile(home), JSON.stringify({ version: 1 }));
    assert.equal(approvalState(root, 'fs'), 'pending'); // 文件在、无两键
    writeFileSync(settingsFile(home), JSON.stringify({ mcpApprovals: 'oops' }));
    assert.equal(approvalState(root, 'fs'), 'pending'); // 键非对象
    writeFileSync(settingsFile(home), JSON.stringify({ mcpApprovals: { [projectSlug(root)]: 'notarray' } }));
    assert.equal(approvalState(root, 'fs'), 'pending'); // slug 槽非数组
  });
});

test('approveMcpServer: 记入 mcpApprovals.<slug> 转 approved；新档补 version:1；幂等不重记录', () => {
  withHome((home, root) => {
    assert.equal(approvalState(root, 'fs'), 'pending');
    approveMcpServer(root, 'fs');
    assert.equal(approvalState(root, 'fs'), 'approved');
    const doc = readSettings(home);
    assert.equal(doc['version'], 1); // 新档补 version:1（daemon 结构化写同款口径）
    const slug = projectSlug(root);
    assert.deepEqual((doc['mcpApprovals'] as Record<string, unknown>)[slug], ['fs']);
    approveMcpServer(root, 'fs'); // 幂等：二次批准不重记录
    assert.deepEqual((readSettings(home)['mcpApprovals'] as Record<string, unknown>)[slug], ['fs']);
  });
});

test('denyMcpServer: 记入 mcpDenied.<slug> 转 denied；与批准互斥（deny 撤批准、approve 撤拒绝）', () => {
  withHome((home, root) => {
    approveMcpServer(root, 'fs');
    denyMcpServer(root, 'fs');
    assert.equal(approvalState(root, 'fs'), 'denied');
    const slug = projectSlug(root);
    const doc = readSettings(home);
    assert.deepEqual((doc['mcpDenied'] as Record<string, unknown>)[slug], ['fs']);
    assert.deepEqual((doc['mcpApprovals'] as Record<string, unknown>)[slug], []); // 批准侧已除名
    approveMcpServer(root, 'fs'); // 反向同口径：approve 撤拒绝
    assert.equal(approvalState(root, 'fs'), 'approved');
    const doc2 = readSettings(home);
    assert.deepEqual((doc2['mcpApprovals'] as Record<string, unknown>)[slug], ['fs']);
    assert.deepEqual((doc2['mcpDenied'] as Record<string, unknown>)[slug], []);
  });
});

test('写纪律：既有键逐字保留，2-space + 尾随换行（daemon 结构化写同款盘上形态）', () => {
  withHome((home, root) => {
    mkdirSync(join(home, '.sunshinex'), { recursive: true });
    writeFileSync(settingsFile(home), JSON.stringify({ version: 1, model: 'm1', plugins: { p: { enabled: true } } }, null, 2) + '\n');
    denyMcpServer(root, 'fs');
    const doc = readSettings(home);
    assert.equal(doc['model'], 'm1');
    assert.deepEqual(doc['plugins'], { p: { enabled: true } });
    assert.equal(doc['version'], 1); // 既有档 version 不动
    const raw = readFileSync(settingsFile(home), 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.ok(raw.includes('  "model": "m1"')); // 2-space 缩进形态
  });
});

test('写纪律：文件含 JSONC 注释 → CatalogWriteError(COMMENTS) 原文零改动；读面注释容忍照常判态', () => {
  withHome((home, root) => {
    mkdirSync(join(home, '.sunshinex'), { recursive: true });
    const raw = '{\n  // 手写注释\n  "version": 1\n}\n';
    writeFileSync(settingsFile(home), raw);
    assert.throws(() => approveMcpServer(root, 'fs'),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'COMMENTS');
    assert.throws(() => denyMcpServer(root, 'fs'),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'COMMENTS');
    assert.equal(readFileSync(settingsFile(home), 'utf8'), raw); // 零盘上副作用
    const slug = projectSlug(root);
    writeFileSync(settingsFile(home), `{\n  // 手写注释\n  "mcpApprovals": { "${slug}": ["fs"] }\n}\n`);
    assert.equal(approvalState(root, 'fs'), 'approved'); // 读面沿 parseSettingsFile 注释容忍口径
  });
});

test('写纪律：畸形 JSON / 根非对象 → CatalogWriteError(INVALID)，不整写覆盖既有内容', () => {
  withHome((home, root) => {
    mkdirSync(join(home, '.sunshinex'), { recursive: true });
    writeFileSync(settingsFile(home), '{ "version": 1, '); // 畸形 JSON
    assert.throws(() => approveMcpServer(root, 'fs'),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'INVALID');
    assert.equal(readFileSync(settingsFile(home), 'utf8'), '{ "version": 1, '); // 零盘上副作用
    writeFileSync(settingsFile(home), '[1,2]'); // 根非对象
    assert.throws(() => denyMcpServer(root, 'fs'),
      (e: unknown) => e instanceof CatalogWriteError && e.code === 'INVALID');
  });
});

test('approvalState: 两键同记（手改文件可及）以批准为先（approved > denied 判定序）', () => {
  withHome((home, root) => {
    mkdirSync(join(home, '.sunshinex'), { recursive: true });
    const slug = projectSlug(root);
    writeFileSync(settingsFile(home), JSON.stringify({ mcpApprovals: { [slug]: ['fs'] }, mcpDenied: { [slug]: ['fs'] } }));
    assert.equal(approvalState(root, 'fs'), 'approved');
  });
});

test('listMcpServers: 项目条目 approval 接 approvalState，全局条目恒 none（全局不过阀）', () => {
  withHome((_home, root) => {
    const g = mkdtempSync(join(tmpdir(), 'sunshinex-appr-g-'));
    mkdirSync(join(root, '.sunshinex'), { recursive: true });
    writeFileSync(join(root, '.sunshinex', 'mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'node' }, api: { url: 'https://x' } } }));
    writeFileSync(join(g, 'mcp.json'), JSON.stringify({ mcpServers: { g1: { command: 'x' } } }));
    const byKey = (e: { scope: string; name: string }): string => `${e.scope}:${e.name}`;
    // 未审：项目条目 pending，全局恒 none
    let r = listMcpServers(root, g);
    assert.deepEqual(r.entries.map(byKey), ['global:g1', 'project:api', 'project:fs']);
    assert.ok(r.entries.filter((e) => e.scope === 'project').every((e) => e.approval === 'pending'));
    assert.ok(r.entries.filter((e) => e.scope === 'global').every((e) => e.approval === 'none'));
    // 批准 fs；连全局同名形态也记了账（g1）——项目 fs → approved，全局 g1 仍恒 none
    approveMcpServer(root, 'fs');
    approveMcpServer(root, 'g1');
    r = listMcpServers(root, g);
    assert.equal(r.entries.find((e) => byKey(e) === 'project:fs')!.approval, 'approved');
    assert.equal(r.entries.find((e) => byKey(e) === 'project:api')!.approval, 'pending');
    assert.equal(r.entries.find((e) => byKey(e) === 'global:g1')!.approval, 'none');
    // 拒绝走 denied
    denyMcpServer(root, 'api');
    r = listMcpServers(root, g);
    assert.equal(r.entries.find((e) => byKey(e) === 'project:api')!.approval, 'denied');
  });
});
