import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleSessionTasks } from './session-handlers';
import { TaskRegistry } from '../harness/tasks';

test('handleSessionTasks 过滤板任务派发登记(boardDispatch):GUI 后台任务面只剩 exec/后台 spawn(2026-11-03 用户裁定)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-tasks-'));
  try {
    const tasks = new TaskRegistry(path.join(root, 'data'));
    const execBg = tasks.submit({ kind: 'exec', label: 'npm run build' });
    const dispatch = tasks.submit({ kind: 'subagent', label: 'task-demo-ab12', boardDispatch: true });
    const spawnBg = tasks.submit({ kind: 'subagent', label: 'researcher' });
    let body: unknown;
    const io = {
      send: (_res: unknown, status: number, payload: object) => {
        assert.equal(status, 200);
        body = payload;
      },
      sessions: new Map([['s1', { runtime: { harness: { tasks } } }]]),
    } as never;
    handleSessionTasks(io, {} as never, 's1');
    const ids = (body as Array<{ id: string }>).map((r) => r.id);
    assert.ok(ids.includes(execBg.id) && ids.includes(spawnBg.id), 'exec 与后台 spawn 照常在列');
    assert.ok(!ids.includes(dispatch.id), '板任务派发登记不出现在后台任务面');
    assert.equal(tasks.list().length, 3, '账本全量不变(task_wait/agent_team_task_wait 等待面仍可见)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
