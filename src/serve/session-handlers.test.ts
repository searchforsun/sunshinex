import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleBranch, handleSessionRename, handleSessionTasks } from './session-handlers';
import { TaskRegistry } from '../harness/tasks';
import { SessionJournal, copySessionStores, readSessionMeta, sessionsDir, writeSessionMeta } from '../session/journal';
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
      sessions: new Map([['s1', { attachedJournalId: srcId, status: () => 'idle', root, dataDir } as never]]), // dataDir:域绑定外窥面(P3 Task 3 寻址单点,真 runtime 恒有——stub 对齐)
      createSession: (_root: string) => ({ ok: true as const, value: { sessionId: 'child1', root: '' } }),
      attach: (_sid: string, jid: string) => { newJid = jid; return { ok: true as const, value: { sessionId: 'child1', root: '' } }; },
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
      sessions: new Map([['s1', { attachedJournalId: srcId, status: () => 'idle', root, dataDir } as never]]), // dataDir:域绑定外窥面(P3 Task 3 寻址单点,真 runtime 恒有——stub 对齐)
      createSession: (_root: string) => ({ ok: true as const, value: { sessionId: 'child2', root: '' } }),
      attach: (_sid: string, jid: string) => { newJid = jid; return { ok: true as const, value: { sessionId: 'child2', root: '' } }; },
    } as never;
    await handleBranch(io, {} as never, {} as never, 's1', 'fork');
    assert.equal(readSessionMeta(dataDir, newJid).title, 'Fork of 调研认证模块的重构方案', '首条 user 兜底+截 60 字');
    assert.equal(readSessionMeta(dataDir, sessionsDir(dataDir)).title, undefined, '哨兵:目录级无 meta 不误读');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('copySessionStores:账本/团队面/辅助档随 fork 克隆,sideOf 改指子档(2026-11-04 静态内容复制裁定)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-cp-'));
  try {
    const dataDir = resolveDataDir(root);
    const j = new SessionJournal(dataDir);
    j.start();
    j.log({ t: 'user', text: '主问' });
    const srcId = j.currentId!;
    fs.mkdirSync(path.join(dataDir, 'tasks'), { recursive: true });
    const ledgerRow = '{"kind":"exec"}\n';
    fs.writeFileSync(path.join(dataDir, 'tasks', `ledger-${srcId}.jsonl`), ledgerRow, 'utf8');
    fs.mkdirSync(path.join(dataDir, 'teams', srcId, 'main'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'teams', srcId, 'main', 'board.json'), '{}', 'utf8');
    const side = new SessionJournal(dataDir);
    side.start();
    side.log({ t: 'user', text: '旁问' });
    const sideJid = side.currentId!;
    writeSessionMeta(dataDir, sideJid, { side: true, title: '辅助对话 1', sideOf: srcId });

    copySessionStores(dataDir, srcId, 'child-jid');

    assert.equal(fs.readFileSync(path.join(dataDir, 'tasks', 'ledger-child-jid.jsonl'), 'utf8'), ledgerRow, '账本克隆');
    assert.equal(fs.existsSync(path.join(dataDir, 'teams', 'child-jid', 'main', 'board.json')), true, '团队面递归克隆');
    const dir = sessionsDir(dataDir);
    const cloned = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length))
      .map((jid) => ({ jid, meta: readSessionMeta(dataDir, jid) }))
      .find((r) => r.meta.side === true && r.meta.sideOf === 'child-jid');
    assert.ok(cloned !== undefined, '辅助档克隆且 sideOf 改指子档');
    assert.equal(cloned.meta.title, '辅助对话 1', '辅助档题沿带');
    assert.equal(fs.existsSync(path.join(dir, `${cloned.jid}.jsonl`)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handleSessionRename 的 [rename] 链注入只属手建 Sunx——通道会话(会话名只是显示标签)不注入(2026-11-25 用户报障「飞书发『任务状态』被当成改名指令」)根修锚', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-rename-'));
  try {
    const dataDir = resolveDataDir(root);
    const mk = (channelMeta?: { platform: string; chatId: string }) => {
      const j = new SessionJournal(dataDir);
      j.start();
      j.log({ t: 'user', text: '开场' });
      const notes: string[] = [];
      const session = {
        dataDir,
        sessionKind: 'sunx' as const,
        channelMeta,
        attachedJournalId: j.currentId,
        ensureJournalMinted: () => {},
        runtime: { harness: { context: { appendChain: (rows: Array<{ observation: string }>) => notes.push(rows[0]!.observation) } } },
      };
      return { session, notes };
    };
    const run = async (session: ReturnType<typeof mk>['session'], title: string): Promise<void> => {
      const io = { readJson: async () => ({ ok: true, body: { title } }), sessions: new Map([['s1', session]]), send: () => {} } as never;
      await handleSessionRename(io, {} as never, {} as never, 's1');
    };
    // 手建 Sunx(无 channelMeta):改名=身份变更,注入同步行
    const own = mk(undefined);
    await run(own.session, '新名字');
    assert.equal(own.notes.length, 1);
    assert.ok(own.notes[0]!.includes('renamed you to "新名字"'));
    // 通道会话(channelMeta 在场):rename 只落显示名,链零注入——GUI 首条消息总结派生名不得变成
    // 模型眼里的「用户把我改名」(否则模型自称/记忆被改写)
    const chan = mk({ platform: 'feishu', chatId: 'oc_x' });
    await run(chan.session, '任务状态');
    assert.equal(chan.notes.length, 0, '通道会话 rename 不注入 [rename] 链行');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
