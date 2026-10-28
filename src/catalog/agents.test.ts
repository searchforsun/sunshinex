// src/catalog/agents.test.ts —— catalog/agents 读面（两级新家 + 旧位置兼容 + 遮蔽/启用标注）钉行为。
// 纪律：globalDir/root 一律 mkdtempSync(tmpdir()) 桩 + HOME 钉桩，禁止直写真实 ~/.sunshinex（沿 mcp.test.ts withHome 先例）。
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { agentsDir, legacyAgentsDir, listAgents } from './agents';
import { parseAgentFrontmatter } from '../harness/subagent';

/** HOME 钉桩（沿 mcp.test.ts withHome 先例）：listAgents 全局级缺省落 userConfigDir()=homeDir()/.sunshinex，
 *  不钉则隐式依赖真实用户家可解析；桩保密闭全局面，绝不直写真实 ~/.sunshinex。 */
function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'sunshinex-agents-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

/** 合法 agent.md 组装器：frontmatter 键序 name 首位 + extra 追加行，body 缺省空 */
const agentMd = (name: string, extra = '', body = ''): string => `---\nname: ${name}\ndescription: d${extra !== '' ? `\n${extra}` : ''}\n---\n${body}`;

/** 写一个 agent 定义目录：<dir>/<id>/agent.md（md 原文直写，含畸形用例） */
function writeAgent(dir: string, id: string, md: string): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, 'agent.md'), md);
}

test('listAgents: 项目新家遮蔽全局同名 id，全局条目保留在列标 shadowed:true', () => {
  withHome(() => {
    const g = mkdtempSync(join(tmpdir(), 'g')), p = mkdtempSync(join(tmpdir(), 'p'));
    writeAgent(join(g, 'agents'), 'shared', agentMd('g-shared'));
    writeAgent(join(g, 'agents'), 'glob-only', agentMd('glob-only'));
    writeAgent(join(p, '.sunshinex', 'agents'), 'shared', agentMd('p-shared', '', 'P'.repeat(300)));
    writeAgent(join(p, '.sunshinex', 'agents'), 'proj-only', agentMd('proj-only'));
    const r = listAgents(p, g);
    // 排序钉死：全局先、新家次（各层内 id 字典序）；旧位置无条目
    assert.deepEqual(r.entries.map((e) => `${e.scope}:${e.id}`), ['global:glob-only', 'global:shared', 'project:proj-only', 'project:shared']);
    const gShared = r.entries.find((e) => e.id === 'shared' && e.scope === 'global')!;
    assert.equal(gShared.shadowed, true, '新家撞名 → 全局条 shadowed=true');
    assert.equal(gShared.oldLocation, false);
    assert.equal(gShared.meta.name, 'g-shared', '全局条目保留原内容（视图不删除）');
    const pShared = r.entries.find((e) => e.id === 'shared' && e.scope === 'project')!;
    assert.equal(pShared.shadowed, false, '新家条目（生效版）不标 shadowed');
    assert.equal(pShared.meta.name, 'p-shared');
    assert.equal(pShared.bodyPreview.length, 200, 'bodyPreview 取正文前 200 字符（沿 loadAgentsView 口径）');
    assert.equal(pShared.bodyPreview, 'P'.repeat(200));
    assert.equal(r.warnings.length, 0);
  });
});

test('listAgents: 旧位置条目 oldLocation:true；新家或全局有同 id 时不再列出', () => {
  withHome(() => {
    const g = mkdtempSync(join(tmpdir(), 'g')), p = mkdtempSync(join(tmpdir(), 'p'));
    writeAgent(join(g, 'agents'), 'in-global', agentMd('in-global'));
    writeAgent(join(p, '.sunshinex', 'agents'), 'in-new-home', agentMd('in-new-home'));
    // 旧位置三态：独占（列出）/ 撞新家（不列）/ 撞全局（不列）
    writeAgent(join(p, 'agents'), 'legacy-only', agentMd('legacy-only'));
    writeAgent(join(p, 'agents'), 'in-new-home', agentMd('legacy-dup-new'));
    writeAgent(join(p, 'agents'), 'in-global', agentMd('legacy-dup-global'));
    const r = listAgents(p, g);
    // 清单序钉死：全局 → 新家 → 旧位置
    assert.deepEqual(r.entries.map((e) => `${e.scope}:${e.id}`), ['global:in-global', 'project:in-new-home', 'project:legacy-only']);
    const legacy = r.entries.find((e) => e.id === 'legacy-only')!;
    assert.ok(legacy, '无碰撞旧位置条目在列');
    assert.equal(legacy.oldLocation, true, '旧位置标注 oldLocation:true');
    assert.equal(legacy.scope, 'project', '旧位置属项目作用域');
    assert.equal(legacy.shadowed, false, '旧位置仅无碰撞时列出，不标 shadowed');
    assert.equal(legacy.meta.name, 'legacy-only');
    assert.equal(r.entries.filter((e) => e.id === 'in-new-home').length, 1, '撞新家同 id 不再从旧位置列出');
    assert.equal(r.entries.find((e) => e.id === 'in-new-home')!.oldLocation, false, '在列的是新家版本');
    assert.equal(r.entries.filter((e) => e.id === 'in-global').length, 1, '撞全局同 id 亦不再从旧位置列出');
    assert.equal(r.entries.find((e) => e.id === 'in-global')!.scope, 'global', '在列的是全局版本');
  });
});

test('listAgents: enabled:false 条目照列且 meta.enabled===false（视图可再启用）', () => {
  withHome(() => {
    const g = mkdtempSync(join(tmpdir(), 'g')), p = mkdtempSync(join(tmpdir(), 'p'));
    writeAgent(join(g, 'agents'), 'off', agentMd('off', 'enabled: false'));
    writeAgent(join(g, 'agents'), 'on', agentMd('on'));
    const r = listAgents(p, g);
    assert.deepEqual(r.entries.map((e) => e.id), ['off', 'on']); // 字典序：off < on
    assert.equal(r.entries.find((e) => e.id === 'off')!.meta.enabled, false, '停用条目照列');
    assert.equal(r.entries.find((e) => e.id === 'on')!.meta.enabled, true);
  });
});

test('listAgents: 畸形 agent.md → warnings 非空，其余条目正常（宽容不抛）', () => {
  withHome(() => {
    const g = mkdtempSync(join(tmpdir(), 'g')), p = mkdtempSync(join(tmpdir(), 'p'));
    writeAgent(join(g, 'agents'), 'bad-nofm', '无 frontmatter 正文');
    writeAgent(join(g, 'agents'), 'bad-noname', '---\ndescription: d\n---\nbody');
    writeAgent(join(g, 'agents'), 'good', agentMd('good'));
    const r = listAgents(p, g);
    assert.deepEqual(r.entries.map((e) => e.id), ['good'], '畸形条目跳过、合法条目在列');
    assert.equal(r.warnings.length, 2, '两个畸形文件各产一条告警');
    for (const w of r.warnings) assert.ok(w.includes(join(g, 'agents')), '告警含文件路径');
  });
});

test('parseAgentFrontmatter: enabled 缺省 true，仅字面 false 为 false；throw 纪律零变', () => {
  assert.equal(parseAgentFrontmatter('---\nname: a\n---\nb').enabled, true, '缺省 true');
  assert.equal(parseAgentFrontmatter('---\nname: a\nenabled: false\n---\nb').enabled, false, '字面 false → false');
  assert.equal(parseAgentFrontmatter('---\nname: a\nenabled: true\n---\nb').enabled, true, '显式 true → true');
  assert.throws(() => parseAgentFrontmatter('no frontmatter'), /missing frontmatter/, '无 frontmatter 块仍 fail-fast');
  assert.throws(() => parseAgentFrontmatter('---\ndescription: d\n---\nb'), /missing name/, '缺 name 仍 fail-fast');
});

test('listAgents: root=null 只列全局（项目两级整体跳过，与 mcp 的 cwd 回退刻意不同）', () => {
  withHome(() => {
    const g = mkdtempSync(join(tmpdir(), 'g')), p = mkdtempSync(join(tmpdir(), 'p'));
    writeAgent(join(g, 'agents'), 'glob', agentMd('glob'));
    // 项目两级都有物料，root=null 时必须整体跳过（不回退 cwd 伪造条目）
    writeAgent(join(p, '.sunshinex', 'agents'), 'new-home', agentMd('new-home'));
    writeAgent(join(p, 'agents'), 'legacy', agentMd('legacy'));
    const r = listAgents(null, g);
    assert.deepEqual(r.entries.map((e) => `${e.scope}:${e.id}`), ['global:glob']);
    assert.equal(r.warnings.length, 0);
  });
});

test('agentsDir/legacyAgentsDir: global=<dir>/agents；project=<root>/.sunshinex/agents；legacy=<root>/agents', () => {
  assert.equal(agentsDir('global', null, '/g'), join('/g', 'agents'));
  assert.equal(agentsDir('project', '/r', '/g'), join('/r', '.sunshinex', 'agents'));
  assert.equal(legacyAgentsDir('/r'), join('/r', 'agents'));
});
