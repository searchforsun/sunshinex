import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TeamStore } from './store';
import { applyBoardEvent, emptyBoard, TaskBoardState } from './model';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('append/load 往返:事件重放与内存 fold 一致;快照文件在', () => {
  const tmp = tmpdir('sunshinex-tb-store-');
  try {
    const store = new TeamStore(path.join(tmp, 'teams', 'main'));
    store.append({ t: 'task-created', taskId: 't1', title: 'A', spec: 'do A', dependsOn: [], ts: 1 });
    store.append({ t: 'task-created', taskId: 't2', title: 'B', spec: 'do B', dependsOn: ['t1'], ts: 2 });
    store.append({ t: 'status-changed', taskId: 't1', from: 'pending', to: 'claimed', ts: 3 });
    let expected = emptyBoard();
    for (const ev of [
      { t: 'task-created' as const, taskId: 't1', title: 'A', spec: 'do A', dependsOn: [] as string[], ts: 1 },
      { t: 'task-created' as const, taskId: 't2', title: 'B', spec: 'do B', dependsOn: ['t1'], ts: 2 },
      { t: 'status-changed' as const, taskId: 't1', from: 'pending' as const, to: 'claimed' as const, ts: 3 },
    ]) expected = applyBoardEvent(expected, ev);
    const loaded = store.load();
    assert.deepEqual(loaded, expected);
    store.writeSnapshot(loaded);
    assert.ok(fs.existsSync(path.join(tmp, 'teams', 'main', 'board.json')), '快照已写');
    assert.ok(!fs.existsSync(path.join(tmp, 'teams', 'main', 'board.json.' + process.pid)), '无 tmp 残留');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('load 容错:尾行截断跳过、中段损坏行跳过、缺文件空板', () => {
  const tmp = tmpdir('sunshinex-tb-store2-');
  try {
    const dir = path.join(tmp, 'teams', 'main');
    const store = new TeamStore(dir);
    assert.deepEqual(store.load(), emptyBoard(), '缺文件空板');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'events.jsonl');
    fs.writeFileSync(p, [
      JSON.stringify({ t: 'task-created', taskId: 't1', title: 'A', spec: 'do A', dependsOn: [], ts: 1 }),
      '{ "t": "task-cr', // 崩溃截断行(无换行)
      JSON.stringify({ t: 'task-created', taskId: 't2', title: 'B', spec: 'do B', dependsOn: [], ts: 2 }),
    ].join('\n'), 'utf8');
    const loaded = store.load();
    assert.equal(loaded.tasks['t1'] !== undefined && loaded.tasks['t2'] !== undefined, true, '完好两行生效');
    assert.equal(loaded.seq, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('load 后可继续 append(恢复写入路径畅通)', () => {
  const tmp = tmpdir('sunshinex-tb-store3-');
  try {
    const dir = path.join(tmp, 'teams', 'main');
    const store = new TeamStore(dir);
    store.append({ t: 'task-created', taskId: 't1', title: 'A', spec: 'do A', dependsOn: [], ts: 1 });
    const s1: TaskBoardState = store.load();
    assert.equal(s1.tasks['t1']!.status, 'pending');
    store.append({ t: 'status-changed', taskId: 't1', from: 'pending', to: 'claimed', ts: 2 });
    store.append({ t: 'status-changed', taskId: 't1', from: 'claimed', to: 'in-review', ts: 3 });
    store.append({ t: 'status-changed', taskId: 't1', from: 'in-review', to: 'done', ts: 4 });
    // 经合法链三步使 done 可达(pending→claimed→in-review→done 由 reducer 闭集约束,此处直接验证继续追加生效)
    const s2 = store.load();
    assert.notEqual(s2.tasks['t1']!.updatedAt, s1.tasks['t1']!.updatedAt, '追加已生效');
    assert.equal(s2.tasks['t1']!.status, 'done', '合法链后 done 可达');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
