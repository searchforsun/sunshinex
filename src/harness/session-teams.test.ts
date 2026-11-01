/** 会话隔离：团队/板按 journalId 落盘；两会话互不看见对方的队。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { sessionTeamsRoot, resolveDataDir } from '../config/data-dir';
import { AgentTeamRegistryStore, TeamStore } from '../taskboard/store';
import { AgentTeamRegistry } from '../taskboard/team-registry';

test('adoptSessionTeams:两 journal 各有独立注册表，互不串读', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-session-teams-'));
  try {
    const h1 = new Harness({ root: tmp, mode: 'full-access', learnSkills: false });
    h1.adoptSessionTeams('j-alpha');
    const a = h1.agentTeams.create('Alpha');
    assert.ok(a.ok);

    const h2 = new Harness({ root: tmp, mode: 'full-access', learnSkills: false });
    h2.adoptSessionTeams('j-beta');
    assert.equal(h2.agentTeams.list().length, 0, '新会话空注册表');
    const b = h2.agentTeams.create('Beta');
    assert.ok(b.ok);

    const dataDir = resolveDataDir(tmp);
    const alphaRoot = sessionTeamsRoot(dataDir, 'j-alpha');
    const betaRoot = sessionTeamsRoot(dataDir, 'j-beta');
    assert.ok(fs.existsSync(path.join(alphaRoot, 'registry.json')));
    assert.ok(fs.existsSync(path.join(betaRoot, 'registry.json')));

    const alphaReload = new AgentTeamRegistry(new AgentTeamRegistryStore(alphaRoot));
    const betaReload = new AgentTeamRegistry(new AgentTeamRegistryStore(betaRoot));
    assert.equal(alphaReload.list().length, 1);
    assert.equal(alphaReload.list()[0]!.name, 'Alpha');
    assert.equal(betaReload.list().length, 1);
    assert.equal(betaReload.list()[0]!.name, 'Beta');

    // 工作区旧根 teams/registry.json 不作为真相源（零兼容）
    assert.equal(fs.existsSync(path.join(dataDir, 'teams', 'registry.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('teamsSessionId 构造即绑盘；同键 adopt 幂等', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-session-teams-opt-'));
  try {
    const h = new Harness({ root: tmp, mode: 'full-access', learnSkills: false, teamsSessionId: 'j1' });
    const r = h.agentTeams.create('Ship');
    assert.ok(r.ok);
    h.adoptSessionTeams('j1');
    assert.equal(h.agentTeams.list().length, 1);
    assert.equal(h.agentTeams.list()[0]!.name, 'Ship');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('未绑定首绑回流：铸造前 create_team 写入目标 journal', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-session-teams-reflux-'));
  try {
    const h = new Harness({ root: tmp, mode: 'full-access', learnSkills: false });
    assert.ok(h.agentTeams.create('Early').ok);
    h.adoptSessionTeams('j-mint');
    assert.equal(h.agentTeams.list().length, 1);
    assert.equal(h.agentTeams.list()[0]!.name, 'Early');
    const dataDir = resolveDataDir(tmp);
    const reload = new AgentTeamRegistry(new AgentTeamRegistryStore(sessionTeamsRoot(dataDir, 'j-mint')));
    assert.equal(reload.list().length, 1);
    assert.equal(reload.list()[0]!.name, 'Early');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('已绑会话切换不回流：旧队留在原 journal，新 journal 空板', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-session-teams-switch-'));
  try {
    const h = new Harness({ root: tmp, mode: 'full-access', learnSkills: false });
    h.adoptSessionTeams('j-old');
    assert.ok(h.agentTeams.create('Keep').ok);
    assert.equal(h.agentTeams.list().length, 1);

    h.adoptSessionTeams('j-new');
    assert.equal(h.agentTeams.list().length, 0, '切换后内存为空板');
    assert.equal(Object.keys(h.taskboard.snapshot().tasks).length, 0);

    const dataDir = resolveDataDir(tmp);
    const oldReload = new AgentTeamRegistry(new AgentTeamRegistryStore(sessionTeamsRoot(dataDir, 'j-old')));
    const newReload = new AgentTeamRegistry(new AgentTeamRegistryStore(sessionTeamsRoot(dataDir, 'j-new')));
    assert.equal(oldReload.list().length, 1);
    assert.equal(oldReload.list()[0]!.name, 'Keep');
    assert.equal(newReload.list().length, 0);
    assert.equal(fs.existsSync(path.join(sessionTeamsRoot(dataDir, 'j-new'), 'registry.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal A 建队+任务后 adopt B：列表与板皆空，A 盘仍有队与任务', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-session-teams-ab-'));
  try {
    const h = new Harness({ root: tmp, mode: 'full-access', learnSkills: false });
    h.adoptSessionTeams('j-a');
    const created = h.agentTeams.create('Alpha');
    assert.ok(created.ok);
    const teamId = created.value.teamId;
    const task = h.taskboard.create({ teamId, title: 'Ship', spec: 'do it' });
    assert.ok(task.ok);
    const taskId = task.value.taskId;
    assert.equal(h.agentTeams.list().length, 1);
    assert.equal(Object.keys(h.taskboard.snapshot().tasks).length, 1);

    h.adoptSessionTeams('j-b');
    assert.equal(h.agentTeams.list().length, 0, 'B 空注册表');
    assert.equal(Object.keys(h.taskboard.snapshot().tasks).length, 0, 'B 空板');

    const dataDir = resolveDataDir(tmp);
    const aRoot = sessionTeamsRoot(dataDir, 'j-a');
    const aTeams = new AgentTeamRegistry(new AgentTeamRegistryStore(aRoot));
    assert.equal(aTeams.list().length, 1);
    assert.equal(aTeams.list()[0]!.teamId, teamId);
    const aBoard = new TeamStore(path.join(aRoot, 'main'));
    const snap = aBoard.load();
    assert.equal(Object.keys(snap.tasks).length, 1);
    assert.equal(snap.tasks[taskId]?.title, 'Ship');
    assert.equal(fs.existsSync(path.join(sessionTeamsRoot(dataDir, 'j-b'), 'registry.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
