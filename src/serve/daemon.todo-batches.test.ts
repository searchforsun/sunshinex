import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionIn, attachSessionIn } from './session-lifecycle';
import type { SessionLifecycleIo } from './session-lifecycle';
import { SessionRuntime } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { SessionJournal } from '../tui/session-journal';

/** todo 批次权威投影（2026-10-31 用户裁定「任务历史持久化可见」）：journal 全量行派生（seedTodoBatches，
 *  attach 播种）+ live 增量（trackTodoEvent）+ 快照载荷直显——内核环窗/尾窗之外的老批次由此可见。
 *  io 装配照抄 daemon.ctx-snap.test.ts（daemon 六面直驱，不起 HTTP/WS 面） */

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function makeIo(model: ModelAdapter): SessionLifecycleIo {
  const sessions = new Map<string, SessionRuntime>();
  let seq = 0;
  let pid = 0;
  return {
    sessions,
    model,
    nextSeq: () => ++seq,
    mintPid: () => `p${++pid}`,
    broadcast: () => {},
    setActive: () => {},
    watchProject: () => {},
    unwatchProject: () => {},
  };
}

async function withIsoEnv(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-todo-batch-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  try {
    await fn(tmp);
  } finally {
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
  }
}

test('todo 批次权威投影:journal 全量派生→attach→快照直显;同签名保留最新', async () => {
  await withIsoEnv(async (tmp) => {
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(root, { recursive: true });
    const io = makeIo(new ScriptedAdapter(['{"done":true,"reply":"ok"}']));
    const birth = createSessionIn(io, root);
    if (!birth.ok) throw new Error(birth.error.message);
    const journal = new SessionJournal(resolveDataDirTmp(root));
    journal.start(3);
    // journal 全量行:user goal → todo_write 两批(同签名两份=进度推进,保留最新)+另一签名一批
    const rows = [
      { t: 'seg', kind: 'user', md: 'goal one', ts: 1, seq: 1 },
      { t: 'seg', kind: 'tool', md: '', name: 'todo_write', ts: 2, seq: 2, input: { todos: [{ text: 'A', status: 'pending' }, { text: 'B', status: 'pending' }] } },
      { t: 'seg', kind: 'tool', md: '', name: 'todo_write', ts: 3, seq: 3, input: { todos: [{ text: 'A', status: 'completed' }, { text: 'B', status: 'in_progress' }] } },
      { t: 'seg', kind: 'user', md: 'goal two', ts: 4, seq: 4 },
      { t: 'seg', kind: 'tool', md: '', name: 'todo_write', ts: 5, seq: 5, input: { todos: [{ text: 'C', status: 'pending' }] } },
    ];
    for (const row of rows) journal.log(row as never);
    const jid = journal.currentId!;
    const newS = createSessionIn(io, root);
    if (!newS.ok) throw new Error(newS.error.message);
    const attached = attachSessionIn(io, newS.value.sessionId, jid);
    if (!attached.ok) throw new Error(attached.error.message);
    const rt = io.sessions.get(newS.value.sessionId)!;
    await waitFor(() => rt.attachedJournalId === jid, 5000);
    const snap = rt.snapshotResponse();
    // 同签名(A/B)两批保留最新(ts=3,状态推进),另一签名(C)独立;goal 归属最近 user 行
    assert.equal(snap.todoBatches.length, 2);
    const ab = snap.todoBatches.find((b) => b.items.length === 2)!;
    assert.deepEqual(ab.items, [{ text: 'A', status: 'completed' }, { text: 'B', status: 'in_progress' }]);
    assert.equal(ab.goal, 'goal one');
    const c = snap.todoBatches.find((b) => b.items.length === 1)!;
    assert.deepEqual(c.items, [{ text: 'C', status: 'pending' }]);
    assert.equal(c.goal, 'goal two');
  });
});

function resolveDataDirTmp(root: string): string {
  // attach 侧 resolveDataDir(root) 的同构推导(测试直驱不走 daemon 装配);复用 config 单点
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveDataDir } = require('../config/data-dir') as typeof import('../config/data-dir');
  return resolveDataDir(root);
}
