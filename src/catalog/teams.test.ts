// src/catalog/teams.test.ts —— catalog/teams 读面（两级视图 + 遮蔽标注 + missing 现算）与写面
// （upsert/remove/setEnabled）钉行为。
// 纪律：HOME 一律 mkdtempSync(tmpdir()) 桩钉——upsertTeam 全局写经 teamsDir('global') 落
// userTeamsDir()=HOME/.sunshinex/teams，不钉则直写真实 ~/.sunshinex（沿 agents.test.ts withHome
// 先例：桩保密闭全局面，绝不触真实用户配置目录）；agents 全局目录以 agentsGlobalDir 显式传参
// 重定向到 <root>/uhome/agents，零隐式 HOME 依赖。
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listTeams, upsertTeam, removeTeam, setTeamEnabled } from './teams';
import { agentsDir } from './agents';
import { CatalogWriteError } from './io';
import { parseTeamFrontmatter } from '../harness/teams';

/** HOME 钉桩 + 夹具：<root>/uhome 充 userConfigDir（HOME=<root>/uhome → userTeamsDir()=
 *  <uhome>/.sunshinex/teams 与写面同物理目录）；<uhome>/agents 经 agentsDir 显式传参预建
 *  （placeholder 占位）；收尾还原 HOME，跨用例零状态泄漏。 */
function withFixture(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-teams-'));
  const uhome = path.join(root, 'uhome');
  const prev = process.env.HOME;
  process.env.HOME = uhome;
  fs.mkdirSync(agentsDir('global', root, uhome), { recursive: true });
  fs.writeFileSync(path.join(agentsDir('global', root, uhome), 'placeholder'), '');
  try {
    fn(root);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

/** 全局 agents 目录写一个目录注册条目（agentsGlobalDir 重定向口对应位） */
function writeGlobalAgent(root: string, id: string, md: string): void {
  const gdir = path.join(root, 'uhome', 'agents', id);
  fs.mkdirSync(gdir, { recursive: true });
  fs.writeFileSync(path.join(gdir, 'agent.md'), md);
}

test('listTeams: 两级列出 + missing 解析（members 引用 agents；内建四角色并入口径、视图不造内建行）', () => {
  withFixture((root) => {
    writeGlobalAgent(root, 'planner', '---\nname: Planner\ndescription: breakdown\n---\nframe');
    upsertTeam(root, 'global', 'solo', { name: '单人队', description: '单成员', members: ['planner', 'ghost'], body: '章程' });
    upsertTeam(root, 'global', 'builtin-only', { name: '内建队', description: '纯内建成员', members: ['reviewer'] });
    const listing = listTeams(root, { agentsGlobalDir: path.join(root, 'uhome', 'agents') });
    const solo = listing.entries.find((e) => e.id === 'solo')!;
    assert.equal(solo.source, 'global');
    assert.deepEqual(solo.missing, ['ghost']);
    assert.ok(solo.body.includes('章程'));
    // 内建四角色（ROLE_PRESETS 键）并入 missing 解析集：reviewer 无目录条目也不标 missing
    const builtinOnly = listing.entries.find((e) => e.id === 'builtin-only')!;
    assert.deepEqual(builtinOnly.missing, []);
    // 内建不是文件：视图只列目录条目，不造内建行
    assert.equal(listing.entries.some((e) => e.id === 'reviewer'), false);
  });
});

test('listTeams: agentsGlobalDir/userDir 双测试口透传（missing 对该目录现算，不触真 HOME）', () => {
  withFixture((root) => {
    writeGlobalAgent(root, 'planner', '---\nname: Planner\ndescription: breakdown\n---\nframe');
    upsertTeam(root, 'global', 'solo', { name: '单人队', description: '单成员', members: ['planner', 'ghost'], body: '章程' });
    // userDir = teams 全目录重定向口（teamsDir global 分支 userDir ?? userTeamsDir()）——显式指到
    // 与写面（HOME 钉桩下的 userTeamsDir()）同一物理目录；agentsGlobalDir 透传 listAgents
    const solo = listTeams(root, { userDir: path.join(root, 'uhome', '.sunshinex', 'teams'), agentsGlobalDir: path.join(root, 'uhome', 'agents') }).entries.find((e) => e.id === 'solo')!;
    assert.deepEqual(solo.missing, ['ghost']);
  });
});

test('upsert 校验拒：lead 不在 members / 换行注入 / 非法 id', () => {
  withFixture((root) => {
    assert.throws(() => upsertTeam(root, 'global', 't1', { name: 'x', description: 'y', members: ['a'], lead: 'b' }));
    assert.throws(() => upsertTeam(root, 'global', 't1', { name: 'x', description: 'a\nb', members: ['a'] }));
    assert.throws(() => upsertTeam(root, 'global', 'Bad_Id', { name: 'x', description: 'y', members: ['a'] }));
  });
});

test('remove 缺失抛 INVALID；setTeamEnabled 保序手术 + enabled 行 round-trip', () => {
  withFixture((root) => {
    assert.throws(() => removeTeam(root, 'global', 'nope'));
    upsertTeam(root, 'global', 'solo', { name: '单人队', description: 'd', members: ['planner'] });
    setTeamEnabled(root, 'global', 'solo', false);
    const t = listTeams(root).entries.find((e) => e.id === 'solo')!;
    assert.equal(t.enabled, false);
  });
});

// ---------- 写面自防御（Task 1）：id 词法 + version 单行校验 + round-trip 补比 version ----------
// 对照 upsertAgent 写面纪律：坏输入 CatalogWriteError('INVALID') 拒写，校验先于任何落盘动作——
// 盘上零目录（零部分写）。

/** 写面 INVALID 断言器：CatalogWriteError 且 code==='INVALID'（镜像 agents.test.ts invalid 单点，防裸 Error 误绿） */
function invalid(fn: () => void): void {
  assert.throws(fn, (e: unknown) => e instanceof CatalogWriteError && e.code === 'INVALID');
}

test('upsert 自防御: id 词法拒写（../evil、a/b、空串 → INVALID；消息镜像 upsertAgent）+ 合法 fullstack-delivery 落盘', () => {
  withFixture((root) => {
    invalid(() => upsertTeam(root, 'global', '../evil', { name: 'x', members: ['planner'] }));
    invalid(() => upsertTeam(root, 'global', 'a/b', { name: 'x', members: ['planner'] }));
    invalid(() => upsertTeam(root, 'global', '', { name: 'x', members: ['planner'] }));
    // 消息钉死：镜像 upsertAgent 入口错误风格（词法同款 AGENT_ID_RE，前缀 team id invalid；
    // (must match ...) 尾注含 AGENT_ID_RE.source 原文锚点，与 agents 写面逐字同构）
    assert.throws(
      () => upsertTeam(root, 'global', '../evil', { name: 'x', members: ['planner'] }),
      (e: unknown) => e instanceof CatalogWriteError && e.message === 'team id invalid: "../evil" (must match ^[A-Za-z0-9][A-Za-z0-9_-]*$)',
    );
    upsertTeam(root, 'global', 'fullstack-delivery', { name: '全栈交付', members: ['planner'] });
    assert.equal(fs.existsSync(path.join(root, 'uhome', '.sunshinex', 'teams', 'fullstack-delivery', 'team.md')), true, '合法 id 正常落盘');
  });
});

test('upsert 自防御: 多行 version 拒写 INVALID 且盘上零目录；非串 version 拒写', () => {
  withFixture((root) => {
    invalid(() => upsertTeam(root, 'global', 't1', { name: 'x', members: ['planner'], version: '2.0\n.0' }));
    invalid(() => upsertTeam(root, 'global', 't1', { name: 'x', members: ['planner'], version: '2.0\r.0' }));
    assert.equal(fs.existsSync(path.join(root, 'uhome', '.sunshinex', 'teams', 't1')), false, '拒写零部分写：目录不存在');
    invalid(() => upsertTeam(root, 'global', 't1', { name: 'x', members: ['planner'], version: 2 as unknown as string }));
    invalid(() => upsertTeam(root, 'global', 't1', { name: 'x', members: ['planner'], version: null as unknown as string }));
    assert.equal(fs.existsSync(path.join(root, 'uhome', '.sunshinex', 'teams', 't1')), false);
    // 消息钉死（brief 逐字）
    assert.throws(
      () => upsertTeam(root, 'global', 't1', { name: 'x', members: ['planner'], version: 'a\nb' }),
      (e: unknown) => e instanceof CatalogWriteError && e.message === 'team version must be a single-line string',
    );
  });
});

test('upsert: version round-trip——显式 2.0.0 读回 2.0.0；省略缺省 0.1.0（parseTeamFrontmatter 回填闭环）', () => {
  withFixture((root) => {
    upsertTeam(root, 'global', 'v2', { name: 'v2队', members: ['planner'], version: '2.0.0' });
    const v2 = parseTeamFrontmatter(fs.readFileSync(path.join(root, 'uhome', '.sunshinex', 'teams', 'v2', 'team.md'), 'utf8'));
    assert.equal(v2.version, '2.0.0');
    upsertTeam(root, 'global', 'v0', { name: 'v0队', members: ['planner'] });
    const v0 = parseTeamFrontmatter(fs.readFileSync(path.join(root, 'uhome', '.sunshinex', 'teams', 'v0', 'team.md'), 'utf8'));
    assert.equal(v0.version, '0.1.0');
  });
});
