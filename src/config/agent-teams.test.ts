import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentTeamsEnabled } from './agent-teams';

/** 临时项目根 + HOME 重定向夹具：不触碰真实用户配置；测试后清 env 与盘 */
function withIsolatedRoot(run: (root: string) => void): void {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-proj-'));
  const prevHome = process.env.HOME;
  const prevSlot = process.env.SUNSHINEX_AGENT_TEAMS;
  process.env.HOME = fakeHome;
  delete process.env.SUNSHINEX_AGENT_TEAMS;
  try {
    run(root);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevSlot === undefined) delete process.env.SUNSHINEX_AGENT_TEAMS;
    else process.env.SUNSHINEX_AGENT_TEAMS = prevSlot;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('agentTeamsEnabled 缺省 true；显式 false 关闭', () => {
  withIsolatedRoot((root) => {
    assert.equal(agentTeamsEnabled(root), true, '空 settings → true');

    const dir = path.join(root, '.sunshinex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ agentTeams: false }));
    assert.equal(agentTeamsEnabled(root), false, '项目 settings.json { "agentTeams": false } → false');
  });
});
