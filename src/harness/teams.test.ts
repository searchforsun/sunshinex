import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { formatAgentCard, formatTeamCard, formatTeamsIndex, loadTeams, resolveTeam } from './teams';
import { listAgentDefs } from './subagent';

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-'));
  const write = (scope: 'project' | 'user', id: string, md: string) => {
    const dir = scope === 'project' ? path.join(root, '.sunshinex', 'teams', id) : path.join(root, 'uhome', 'teams', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'team.md'), md);
  };
  write('project', 'fullstack-delivery', '---\nname: 全栈交付小队\ndescription: 需求→实现→测试→评审\nmembers: planner developer tester reviewer\nlead: developer\n---\n接力交付章程正文');
  write('user', 'fullstack-delivery', '---\nname: 全局同名队\ndescription: 被项目遮蔽\nmembers: planner\n---\n全局章程');
  write('user', 'solo', '---\nname: 单人队\ndescription: 只有一个成员\nmembers: developer\nenabled: false\n---\n停用章程');
  return root;
}

test('loadTeams: 项目遮蔽全局、enabled:false 照载、missing 标注', () => {
  const root = fixture();
  const teams = loadTeams(root, new Set(['planner', 'developer']), path.join(root, 'uhome'));
  const full = teams.find((t) => t.id === 'fullstack-delivery')!;
  assert.equal(full.name, '全栈交付小队'); // 项目胜出
  assert.deepEqual(full.missing, ['tester', 'reviewer'].filter((m) => !['planner', 'developer'].includes(m)));
  const solo = teams.find((t) => t.id === 'solo')!;
  assert.equal(solo.enabled, false);
});

test('formatTeamsIndex: 确定性排序 + members 展示 + 空清单 null', () => {
  assert.equal(formatTeamsIndex([]), null);
  const root = fixture();
  const idx = formatTeamsIndex(loadTeams(root, new Set(['planner', 'developer']), path.join(root, 'uhome')));
  assert.ok(idx!.includes('(id: fullstack-delivery)'));
  assert.ok(idx!.includes('(members: planner, developer, tester, reviewer)')); // 索引行照载全 members（spec §2.1 行例；alive-only 属卡片面，brief 原断言 `(members: planner, developer)` 与其自身实现/规格行例相抵，此处随规格）
  assert.ok(idx!.includes('(disabled)')); // enabled:false 行显式标注
});

test('resolveTeam 三态', () => {
  const root = fixture();
  assert.equal(resolveTeam(root, 'fullstack-delivery', path.join(root, 'uhome')).ok, true);
  const disabled = resolveTeam(root, 'solo', path.join(root, 'uhome'));
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.error.code, 'TEAM_DISABLED');
  const missing = resolveTeam(root, 'nope', path.join(root, 'uhome'));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'TEAM_NOT_FOUND');
});

test('formatTeamCard: 领队星标 + missing 注记 + 章程原文', () => {
  const root = fixture();
  // brief 原文 `.value as never as import('../types').TeamManifest` 在 strict 下不过 tsc（判别联合直取 .value 即 TS2339，
  // 同 Task1 报告偏差③类）；assert.ok 收窄后 .value 本就携 TeamManifest 形，裸用即可
  const resolved = resolveTeam(root, 'fullstack-delivery', path.join(root, 'uhome'));
  assert.ok(resolved.ok);
  const m = resolved.value;
  const card = formatTeamCard(
    m,
    [
      { id: 'planner', name: 'Planner', description: 'requirement breakdown' },
      { id: 'developer', name: 'Dev', description: 'implementation' },
      { id: 'tester', name: '', description: '', missing: true },
    ],
    '接力交付章程正文',
  );
  assert.ok(card.startsWith('[team] fullstack-delivery — 全栈交付小队'));
  assert.ok(card.includes('- *developer — Dev: implementation')); // lead 星标
  assert.ok(card.includes('- planner — Planner: requirement breakdown'));
  assert.ok(card.includes('(not registered)'));
  assert.ok(card.includes('create_agent_team + create_agent_teammate'));
  assert.ok(card.includes('接力交付章程正文'));
});

test('formatAgentCard: 固定骨架 + spawn 指引', () => {
  const card = formatAgentCard({ id: 'developer', name: 'Dev', description: 'implementation', framing: 'write code' });
  assert.ok(card.startsWith('[agent] developer — Dev'));
  assert.ok(card.includes('role:\nwrite code'));
  assert.ok(card.includes('delegate via spawn (agent_id="developer"'));
});

test('listAgentDefs: 内建不可遮蔽 + 坏档跳过 + enabled:false 剔除', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdefs-'));
  const ghome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdefs-home-'));
  const write = (base: string, id: string, md: string) => {
    const dir = path.join(base, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.md'), md);
  };
  const project = path.join(root, '.sunshinex', 'agents');
  write(project, 'planner', '---\nname: 项目策划\ndescription: 冒名内建\n---\n项目框定'); // 撞内建 id：须被跳过（对齐 AgentRegistry.resolve 内建恒胜）
  write(project, 'deployer', '---\nname: Deployer\ndescription: ships builds\n---\nship and verify'); // 非内建目录条目照常收录
  write(project, 'broken', '---\ndescription: 缺 name\n---\n无框定'); // 坏档（缺 name）跳过不抛
  write(project, 'off', '---\nname: Off\ndescription: off\nenabled: false\n---\noff duty'); // 停用剔除
  const defs = listAgentDefs(root, ghome);
  const planner = defs.find((d) => d.id === 'planner')!;
  assert.equal(planner.name, 'Planner'); // 内建 label/framing 原样——目录撞名条目在索引/卡面不可见
  assert.equal(planner.framing, 'requirement breakdown, solution and plan');
  const deployer = defs.find((d) => d.id === 'deployer')!;
  assert.equal(deployer.framing, 'ship and verify');
  assert.ok(!defs.some((d) => d.id === 'broken')); // 坏档跳过不抛（宽容语义）
  assert.ok(!defs.some((d) => d.id === 'off')); // enabled:false 剔除
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ghome, { recursive: true, force: true });
});
