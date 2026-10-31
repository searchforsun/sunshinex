import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTeamRegistryStore } from './store';
import { AgentTeamRegistry, MemoryAgentTeamStore } from './team-registry';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('create:生成 teamId 并可读；空名拒绝', () => {
  const reg = new AgentTeamRegistry(new MemoryAgentTeamStore());
  const r = reg.create('Alpha');
  assert.ok(r.ok);
  assert.match(r.value.teamId, /^team-/);
  assert.equal(reg.get(r.value.teamId)?.name, 'Alpha');
  const bad = reg.create('');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'INVALID_ARG');
});

test('list 返回已创建队；get 未知 id 为 undefined', () => {
  const reg = new AgentTeamRegistry(new MemoryAgentTeamStore());
  reg.create('A');
  reg.create('B');
  assert.equal(reg.list().length, 2);
  assert.equal(reg.get('team-missing-xxxx'), undefined);
});

test('File store: create 落盘后可新实例读回', () => {
  const tmp = tmpdir('sunshinex-agent-team-');
  try {
    const teamsRoot = path.join(tmp, 'teams');
    const reg = new AgentTeamRegistry(new AgentTeamRegistryStore(teamsRoot));
    const r = reg.create('Ship');
    assert.ok(r.ok);
    assert.match(r.value.teamId, /^team-ship-/);
    assert.ok(fs.existsSync(path.join(teamsRoot, 'registry.json')));
    const reg2 = new AgentTeamRegistry(new AgentTeamRegistryStore(teamsRoot));
    assert.equal(reg2.get(r.value.teamId)?.name, 'Ship');
    assert.equal(reg2.list().length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
