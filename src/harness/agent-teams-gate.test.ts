/**
 * agentTeams 装配门禁（spec §2.2）：关则八个团队工具不注入；task_wait / task_stop 恒在。
 * settings / env 须在构造 Harness 前就绪（agentTeamsEnabled 装配期求值）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';

const TEAM_TOOLS = [
  'create_agent_team',
  'create_agent_teammate',
  'create_agent_team_task',
  'update_agent_team_task',
  'get_agent_team_board',
  'send_agent_team_message',
  'agent_team_task_wait',
  'agent_team_task_stop',
] as const;

/** 临时项目根 + HOME 重定向；清 SUNSHINEX_AGENT_TEAMS 以免宿主槽遮蔽 settings */
function withIsolatedHarnessRoot(run: (root: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-at-gate-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-at-gate-root-'));
  const prevHome = process.env.HOME;
  const prevSlot = process.env.SUNSHINEX_AGENT_TEAMS;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.HOME = home;
  delete process.env.SUNSHINEX_AGENT_TEAMS;
  process.env.SUNSHINEX_DATA_DIR = path.join(root, '.data-test');
  try {
    run(root);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevSlot === undefined) delete process.env.SUNSHINEX_AGENT_TEAMS;
    else process.env.SUNSHINEX_AGENT_TEAMS = prevSlot;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('agentTeams false（项目 settings）→ 八个团队工具缺失，task_wait/task_stop 仍在', () => {
  withIsolatedHarnessRoot((root) => {
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'settings.json'), JSON.stringify({ agentTeams: false }));
    const h = new Harness({ root, mode: 'full-access', learnSkills: false });
    for (const name of TEAM_TOOLS) {
      assert.equal(h.tools.get(name), undefined, `${name} must be absent when agentTeams is off`);
    }
    assert.ok(h.tools.get('task_wait'), 'task_wait stays registered');
    assert.ok(h.tools.get('task_stop'), 'task_stop stays registered');
  });
});

test('SUNSHINEX_AGENT_TEAMS=off → 团队工具不注入', () => {
  withIsolatedHarnessRoot((root) => {
    process.env.SUNSHINEX_AGENT_TEAMS = 'off';
    const h = new Harness({ root, mode: 'full-access', learnSkills: false });
    assert.equal(h.tools.get('create_agent_team'), undefined);
    assert.ok(h.tools.get('task_wait'));
  });
});

test('agentTeams 缺省 true → 八个团队工具齐全', () => {
  withIsolatedHarnessRoot((root) => {
    const h = new Harness({ root, mode: 'full-access', learnSkills: false });
    for (const name of TEAM_TOOLS) {
      assert.ok(h.tools.get(name), `${name} must register when agentTeams defaults on`);
    }
  });
});

test('agentTeams off：teams/agents 清单照注、team/agent 工具照注册、八件套不注入', () => {
  withIsolatedHarnessRoot((root) => {
    process.env.SUNSHINEX_AGENT_TEAMS = 'off';
    // 预置一个 team.md：断言「关开关只关八件套注入，不关清单观测面」（catalog 面与工具面解耦）
    const teamsDir = path.join(root, '.sunshinex', 'teams', 'fullstack-delivery');
    fs.mkdirSync(teamsDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamsDir, 'team.md'),
      '---\nname: 全栈交付小队\ndescription: 一站式交付\nmembers: planner developer\n---\n章程',
    );
    const h = new Harness({ root, mode: 'full-access', learnSkills: false });
    // 断言1: teams/agents 清单段照注（snapshot 面不随 agentTeams 收缩；agents 段恒在）
    const parts = h.context.snapshotPartsView();
    assert.equal(parts.teams.length, 1, 'teams index segment still injected with agentTeams off');
    assert.ok(parts.teams[0]!.content.includes('全栈交付小队'), 'preset team listed in teams segment');
    assert.ok(parts.teams[0]!.content.includes('#team-id'), 'team segment lead line declares soft reference');
    assert.equal(parts.agents.length, 1, 'agents index segment stays present (builtins keep it constant)');
    // 断言2: team/agent 工具照注册（接缝在场即注册，与开关无关；2026-11-05 用户裁定更名
    // team→load_agent_teams（命名准确不省略）、agent→load_subagent）
    assert.ok(h.tools.get('load_agent_teams'), 'load_agent_teams stays registered');
    assert.ok(h.tools.get('load_subagent'), 'load_subagent stays registered');
    // 断言3: 八件套（含 create_agent_team / create_agent_teammate）不注入
    for (const name of TEAM_TOOLS) {
      assert.equal(h.tools.get(name), undefined, `${name} must be absent when SUNSHINEX_AGENT_TEAMS=off`);
    }
  });
});
