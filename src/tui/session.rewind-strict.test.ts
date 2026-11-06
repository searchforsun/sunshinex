import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rewindSessionStores } from '../tui/session-journal';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('rewindSessionStores 严格裁剪:起点后提交的任务/板任务/成员/收件箱消息整链丢弃,起点前实体保留', () => {
  const dataDir = tmpdir('rewind-strict-a-');
  try {
    const CUT = 5_000;
    // 账本:t1 起点前(保留),t2 起点后(裁),t3 起点前但 finish 在起点后(保留完整生命周期)
    mkdirSync(path.join(dataDir, 'tasks'), { recursive: true });
    writeFileSync(path.join(dataDir, 'tasks', 'ledger-src.jsonl'), [
      JSON.stringify({ op: 'submit', pid: 1, task: { id: 't1', kind: 'exec', label: 'a', status: 'running', outputFilePath: '', startedAt: 1_000 } }),
      JSON.stringify({ op: 'submit', pid: 1, task: { id: 't2', kind: 'exec', label: 'b', status: 'running', outputFilePath: '', startedAt: 9_000 } }),
      JSON.stringify({ op: 'submit', pid: 1, task: { id: 't3', kind: 'exec', label: 'c', status: 'running', outputFilePath: '', startedAt: 2_000 } }),
      JSON.stringify({ op: 'finish', id: 't1', status: 'done', endedAt: 3_000 }),
      JSON.stringify({ op: 'finish', id: 't3', status: 'stopped', endedAt: 9_500 }),
    ].join('\n') + '\n', 'utf8');
    // 团队面:team1 起点前(保留),team2 起点后(裁);板任务 bt1 起点前,bt2 起点后;inbox 消息跨起点
    const teams = path.join(dataDir, 'teams', 'src');
    mkdirSync(path.join(teams, 'main', 'inbox'), { recursive: true });
    writeFileSync(path.join(teams, 'registry.json'), JSON.stringify([
      { teamId: 'team1', name: '旧团队', createdAt: 1_000 },
      { teamId: 'team2', name: '新团队', createdAt: 9_000 },
    ]), 'utf8');
    writeFileSync(path.join(teams, 'teammates.json'), JSON.stringify([
      { name: '老成员', teamId: 'team1', framing: '', createdAt: 2_000 },
      { name: '新成员', teamId: 'team2', framing: '', createdAt: 9_100 },
    ]), 'utf8');
    writeFileSync(path.join(teams, 'main', 'events.jsonl'), [
      JSON.stringify({ t: 'task-created', taskId: 'bt1', title: '旧任务', spec: '', dependsOn: [], teamId: 'team1', ts: 1_500 }),
      JSON.stringify({ t: 'status-changed', taskId: 'bt1', from: 'pending', to: 'running', ts: 1_600 }),
      JSON.stringify({ t: 'task-created', taskId: 'bt2', title: '新任务', spec: '', dependsOn: [], teamId: 'team1', ts: 9_200 }),
      JSON.stringify({ t: 'dependency-added', taskId: 'bt1', dependsOn: 'bt2', ts: 9_300 }),
    ].join('\n') + '\n', 'utf8');
    writeFileSync(path.join(teams, 'main', 'inbox', '老成员.jsonl'), [
      JSON.stringify({ id: 'm1', to: '老成员', from: 'x', text: '起点前', ts: 1_700 }),
      JSON.stringify({ id: 'm2', to: '老成员', from: 'x', text: '起点后', ts: 9_400 }),
    ].join('\n') + '\n', 'utf8');
    writeFileSync(path.join(teams, 'inbox-cursors.json'), JSON.stringify({ 老成员: 9_400 }), 'utf8');
    writeFileSync(path.join(teams, 'main', 'board.json'), '{"stale":true}', 'utf8');

    rewindSessionStores(dataDir, 'src', 'dst', CUT);

    const ledger = readFileSync(path.join(dataDir, 'tasks', 'ledger-dst.jsonl'), 'utf8');
    assert.equal(ledger.includes('"id":"t2"'), false, '起点后提交的任务裁掉');
    assert.equal(ledger.includes('"id":"t1"'), true);
    assert.equal(ledger.includes('"id":"t3"'), true, '起点前任务保留完整生命周期');
    assert.equal(ledger.includes('"id":"t3","status":"stopped"') || ledger.includes('"status":"stopped"'), true);

    const reg = JSON.parse(readFileSync(path.join(dataDir, 'teams', 'dst', 'registry.json'), 'utf8')) as Array<{ teamId: string }>;
    assert.deepEqual(reg.map((r) => r.teamId), ['team1']);
    const roster = JSON.parse(readFileSync(path.join(dataDir, 'teams', 'dst', 'teammates.json'), 'utf8')) as Array<{ name: string }>;
    assert.deepEqual(roster.map((r) => r.name), ['老成员']);
    const events = readFileSync(path.join(dataDir, 'teams', 'dst', 'main', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; taskId?: string });
    assert.equal(events.some((e) => e.taskId === 'bt2'), false, '起点后的板任务整链裁掉');
    assert.equal(events.filter((e) => e.taskId === 'bt1' && e.t === 'dependency-added').length, 0, '依赖对端被裁,依赖事件也裁');
    assert.equal(events.some((e) => e.taskId === 'bt1' && e.t === 'status-changed'), true, '起点前板任务事件保留');
    assert.equal(fs.existsSync(path.join(dataDir, 'teams', 'dst', 'main', 'board.json')), false, '快照缓存删除,载入走重放');

    const inbox = readFileSync(path.join(dataDir, 'teams', 'dst', 'main', 'inbox', '老成员.jsonl'), 'utf8');
    assert.equal(inbox.includes('起点后'), false);
    assert.equal(inbox.includes('起点前'), true);
    const cursors = JSON.parse(readFileSync(path.join(dataDir, 'teams', 'dst', 'inbox-cursors.json'), 'utf8')) as Record<string, number>;
    assert.equal(cursors['老成员'], 1_700, '位点钳回被保留的最大 ts');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
