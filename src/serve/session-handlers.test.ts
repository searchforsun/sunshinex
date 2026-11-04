import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleBranch, handleSessionTasks } from './session-handlers';
import { TaskRegistry } from '../harness/tasks';
import { SessionJournal, readSessionMeta, sessionsDir, writeSessionMeta } from '../tui/session-journal';
import { resolveDataDir } from '../config/data-dir';

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

test('handleBranch fork 写「Fork of 父显示题」子档题——meta 题优先,递归链名(2026-11-04 用户裁定)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-fork-'));
  try {
    const dataDir = resolveDataDir(root);
    const j = new SessionJournal(dataDir);
    j.start();
    j.log({ t: 'user', text: '第二问' });
    const srcId = j.currentId!;
    writeSessionMeta(dataDir, srcId, { title: 'Fork of 原始调研' });
    let newJid = '';
    const io = {
      readJson: async () => ({ ok: true, status: 200, body: { turn: 1 } }),
      send: (_res: unknown, status: number, _payload: object) => { assert.equal(status, 200); },
      sessions: new Map([['s1', { attachedJournalId: srcId, status: () => 'idle', root } as never]]),
      createSession: (_root: string) => ({ ok: true as const, value: { sessionId: 'child1' } }),
      attach: (_sid: string, jid: string) => { newJid = jid; return { ok: true as const, value: { sessionId: 'child1' } }; },
    } as never;
    await handleBranch(io, {} as never, {} as never, 's1', 'fork');
    assert.equal(newJid !== '', true, 'attach 收到子档 id');
    assert.equal(readSessionMeta(dataDir, newJid).title, 'Fork of Fork of 原始调研', '父 meta 题优先+前缀链接');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handleBranch fork 子档题兜底:父未题名取首条 user 摘要(与列表摘要同口径)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-fork2-'));
  try {
    const dataDir = resolveDataDir(root);
    const j = new SessionJournal(dataDir);
    j.start();
    j.log({ t: 'user', text: '调研认证模块的重构方案' });
    const srcId = j.currentId!;
    let newJid = '';
    const io = {
      readJson: async () => ({ ok: true, status: 200, body: { turn: 1 } }),
      send: (_res: unknown, status: number, _payload: object) => { assert.equal(status, 200); },
      sessions: new Map([['s1', { attachedJournalId: srcId, status: () => 'idle', root } as never]]),
      createSession: (_root: string) => ({ ok: true as const, value: { sessionId: 'child2' } }),
      attach: (_sid: string, jid: string) => { newJid = jid; return { ok: true as const, value: { sessionId: 'child2' } }; },
    } as never;
    await handleBranch(io, {} as never, {} as never, 's1', 'fork');
    assert.equal(readSessionMeta(dataDir, newJid).title, 'Fork of 调研认证模块的重构方案', '首条 user 兜底+截 60 字');
    assert.equal(readSessionMeta(dataDir, sessionsDir(dataDir)).title, undefined, '哨兵:目录级无 meta 不误读');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
