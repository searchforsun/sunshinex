// src/catalog/agents.test.ts —— catalog/agents 读面（两级新家 + 旧位置兼容 + 遮蔽/启用标注）与写面
// （upsert/remove/setEnabled/migrate，Task 6）钉行为。
// 纪律：globalDir/root 一律 mkdtempSync(tmpdir()) 桩 + HOME 钉桩，禁止直写真实 ~/.sunshinex（沿 mcp.test.ts withHome 先例）。
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { agentsDir, legacyAgentsDir, listAgents, migrateAgent, removeAgent, setAgentEnabled, upsertAgent } from './agents';
import { CatalogWriteError } from './io';
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

// ---------- 写面（Task 6）：upsert / remove / setEnabled / migrate ----------

/** 写面 INVALID 断言器：CatalogWriteError 且 code==='INVALID'（错误类+码双钉，防裸 Error 误绿） */
function invalid(fn: () => void): void {
  assert.throws(fn, (e: unknown) => e instanceof CatalogWriteError && e.code === 'INVALID');
}

test('upsertAgent: 写出文件 reparse 字段全对（enabled 缺省 true）+ 键序 name 首位字节级钉死；global 落 HOME 桩；零 tmp 残片', () => {
  withHome((home) => {
    const p = mkdtempSync(join(tmpdir(), 'p'));
    upsertAgent(p, 'project', 'alpha', { name: 'Alpha', description: 'do things', memory: true, isolation: 'worktree', executor: 'internal-team', body: 'BODY' });
    const file = join(agentsDir('project', p), 'alpha', 'agent.md');
    const md = readFileSync(file, 'utf8');
    // 字节级钉死：renderAgentMd 迁移契约——键序 name→description→memory→isolation→executor，enabled 缺省不落行
    assert.equal(md, '---\nname: Alpha\ndescription: do things\nmemory: true\nisolation: worktree\nexecutor: internal-team\n---\nBODY');
    const meta = parseAgentFrontmatter(md);
    assert.equal(meta.name, 'Alpha');
    assert.equal(meta.description, 'do things');
    assert.equal(meta.memory, true);
    assert.equal(meta.isolation, 'worktree');
    assert.equal(meta.executor, 'internal-team');
    assert.equal(meta.enabled, true, 'enabled 缺省 true（解析面缺省语义，文件无该行）');
    assert.equal(meta.body, 'BODY');
    assert.deepEqual(readdirSync(join(agentsDir('project', p), 'alpha')), ['agent.md'], '原子写零 tmp 残片');
    // global 作用域写 HOME 桩（绝不触真实 ~/.sunshinex）
    upsertAgent(null, 'global', 'glob', { name: 'G' });
    assert.equal(existsSync(join(home, '.sunshinex', 'agents', 'glob', 'agent.md')), true, 'global 写落 <userConfigDir>/agents');
    assert.equal(parseAgentFrontmatter(readFileSync(join(home, '.sunshinex', 'agents', 'glob', 'agent.md'), 'utf8')).name, 'G');
  });
});

test('setAgentEnabled false → enabled 行保序插入 description 后，listAgents meta.enabled===false；global 同口径', () => {
  withHome((home) => {
    const p = mkdtempSync(join(tmpdir(), 'p'));
    upsertAgent(p, 'project', 'beta', { name: 'B', description: 'd' });
    setAgentEnabled(p, 'project', 'beta', false);
    const md = readFileSync(join(agentsDir('project', p), 'beta', 'agent.md'), 'utf8');
    // 字节级钉死：插入位置 = description 行后，其余键行序零扰动（非整块重写）
    assert.equal(md, '---\nname: B\ndescription: d\nenabled: false\n---\n');
    assert.equal(listAgents(p).entries.find((e) => e.id === 'beta')!.meta.enabled, false, '视图面读回 false');
    // global 作用域开关走 HOME 桩（withHome 各用例独立桩——本用例先自建 global 条目再开关）
    upsertAgent(null, 'global', 'glob', { name: 'G' });
    setAgentEnabled(null, 'global', 'glob', false);
    assert.equal(readFileSync(join(home, '.sunshinex', 'agents', 'glob', 'agent.md'), 'utf8'), '---\nname: G\nenabled: false\n---\n', '无 description 行 → 插在 name 后');
  });
});

test('setAgentEnabled true 再启 → 既有行原位更新非重复新增（含手写文件 enabled 行位置保持）', () => {
  withHome(() => {
    const p = mkdtempSync(join(tmpdir(), 'p'));
    upsertAgent(p, 'project', 'beta', { name: 'B', description: 'd' });
    setAgentEnabled(p, 'project', 'beta', false);
    setAgentEnabled(p, 'project', 'beta', true);
    const md = readFileSync(join(agentsDir('project', p), 'beta', 'agent.md'), 'utf8');
    assert.equal(md, '---\nname: B\ndescription: d\nenabled: true\n---\n', '原位更新：行数不增、位置不变');
    assert.equal([...md.matchAll(/^enabled:/gm)].length, 1, '无重复 enabled 行');
    assert.equal(listAgents(p).entries.find((e) => e.id === 'beta')!.meta.enabled, true);
    // 手写文件（enabled 行在 description 前）：原位替换不挪位
    writeAgent(join(p, '.sunshinex', 'agents'), 'pos', '---\nname: C\nenabled: false\ndescription: d\n---\n');
    setAgentEnabled(p, 'project', 'pos', true);
    assert.equal(readFileSync(join(agentsDir('project', p), 'pos', 'agent.md'), 'utf8'), '---\nname: C\nenabled: true\ndescription: d\n---\n', '替换原位、其他键行序不动');
  });
});

test('removeAgent: 目录整体移除（含同级私有文件），listAgents 不再含；再删同 id → INVALID', () => {
  withHome(() => {
    const p = mkdtempSync(join(tmpdir(), 'p'));
    upsertAgent(p, 'project', 'gone', { name: 'G', body: 'x' });
    writeFileSync(join(agentsDir('project', p), 'gone', 'private.txt'), 'side');
    removeAgent(p, 'project', 'gone');
    assert.equal(existsSync(join(agentsDir('project', p), 'gone')), false, '整目录移除');
    assert.equal(listAgents(p).entries.some((e) => e.id === 'gone'), false, '视图不再含');
    // 再删同 id：不存在 → INVALID（catalog 写面严格语义，幂等收口属 serve 面）
    invalid(() => removeAgent(p, 'project', 'gone'));
  });
});

test('migrateAgent: 旧位置整目录递归拷入新家（含同级私有文件），旧目录保留；listAgents 改报新家条目', () => {
  withHome(() => {
    const p = mkdtempSync(join(tmpdir(), 'p'));
    writeAgent(join(p, 'agents'), 'legacy', agentMd('legacy', 'memory: true', 'OLD'));
    writeFileSync(join(p, 'agents', 'legacy', 'notes.txt'), 'side');
    migrateAgent(p, 'legacy');
    const newFile = join(agentsDir('project', p), 'legacy', 'agent.md');
    assert.equal(existsSync(newFile), true, '新家文件在场');
    assert.equal(readFileSync(newFile, 'utf8'), readFileSync(join(p, 'agents', 'legacy', 'agent.md'), 'utf8'), '同内容');
    assert.equal(readFileSync(join(agentsDir('project', p), 'legacy', 'notes.txt'), 'utf8'), 'side', '递归拷贝含非 agent.md 同级文件');
    assert.equal(existsSync(join(legacyAgentsDir(p), 'legacy', 'agent.md')), true, '旧目录保留不删');
    const rows = listAgents(p).entries.filter((e) => e.id === 'legacy');
    assert.equal(rows.length, 1, '旧位置有同 id 碰撞 → 不再从旧位置列出');
    assert.equal(rows[0]!.oldLocation, false, '在列的是新家条目');
    assert.equal(rows[0]!.dir, join(agentsDir('project', p), 'legacy'));
    assert.equal(rows[0]!.meta.memory, true, '内容随迁（memory 标注读回）');
  });
});

test('写面 INVALID 族：非法 id 四函数同拒；remove/setEnabled 未存在 id、migrate 缺源/撞目标、project 缺 root、畸形 agent.md → INVALID', () => {
  withHome(() => {
    const p = mkdtempSync(join(tmpdir(), 'p'));
    invalid(() => upsertAgent(p, 'project', '../evil', { name: 'x' }));
    // AGENT_ID_RE 拒点号等（id 直接拼目录名——路径分隔/穿越/点开头一律拒）
    invalid(() => upsertAgent(p, 'project', 'has.dot', { name: 'x' }));
    invalid(() => removeAgent(p, 'project', '../evil'));
    invalid(() => setAgentEnabled(p, 'project', '../evil', false));
    invalid(() => migrateAgent(p, '../evil'));
    invalid(() => removeAgent(p, 'project', 'nope')); // 未存在 id
    invalid(() => setAgentEnabled(p, 'project', 'nope', true)); // 未存在 id
    invalid(() => migrateAgent(p, 'nope')); // 缺源
    writeAgent(join(p, '.sunshinex', 'agents'), 'dup', agentMd('dup'));
    writeAgent(join(p, 'agents'), 'dup', agentMd('dup'));
    invalid(() => migrateAgent(p, 'dup')); // 撞目标（新家已存在）
    invalid(() => upsertAgent(null, 'project', 'ok', { name: 'x' })); // project 缺 root（写面不借道 agentsDir 的 cwd 回退）
    mkdirSync(join(agentsDir('project', p), 'bad'), { recursive: true });
    writeFileSync(join(agentsDir('project', p), 'bad', 'agent.md'), 'no frontmatter');
    invalid(() => setAgentEnabled(p, 'project', 'bad', true)); // 畸形 agent.md 开关拒改（回环校验收口）
  });
});
