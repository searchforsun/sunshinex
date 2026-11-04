import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { formatTeamsIndex, loadTeams, resolveTeam } from './teams';

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
