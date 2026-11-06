import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attachSessionIn, createSessionIn } from './session-lifecycle';
import type { SessionLifecycleIo } from './session-lifecycle';
import { SessionRuntime } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { handleBranch, handleRestorePlan } from './session-handlers';
import type { RewindTarget } from './session-handlers';
import { listSessions, parseJournalFile, readSessionMeta, sessionsDir, writeSessionMeta } from '../tui/session-journal';
import { resolveDataDir } from '../config/data-dir';

/** 真 SessionRuntime + 真 attach(不桩):rewind 的失败面全在 attach 与内存投影上,桩掉就测不到 */
interface Rig {
  root: string;
  dataDir: string;
  sessions: Map<string, SessionRuntime>;
  lio: SessionLifecycleIo;
  sid: string;
  session: SessionRuntime;
  submit(text: string): Promise<void>;
  call(body: object, id?: string): Promise<{ status: number; payload: Record<string, unknown> }>;
  plan(target: RewindTarget): { status: number; payload: Record<string, unknown> };
}

async function withRig(replies: string[], fn: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-rewind-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(root);
  const sessions = new Map<string, SessionRuntime>();
  let seq = 0;
  let pid = 0;
  const lio: SessionLifecycleIo = {
    sessions,
    model: new ScriptedAdapter(replies),
    nextSeq: () => ++seq,
    mintPid: () => `p${++pid}`,
    broadcast: () => {},
    setActive: () => {},
    watchProject: () => {},
    unwatchProject: () => {},
  };
  const c = createSessionIn(lio, root);
  if (!c.ok) throw new Error(c.error.message);
  const session = sessions.get(c.value.sessionId)!;
  const handlerIo = (body: object, out: { status: number; payload: Record<string, unknown> }): never => ({
    readJson: async () => ({ ok: true, body }),
    send: (_res: unknown, status: number, payload: object) => {
      out.status = status;
      out.payload = payload as Record<string, unknown>;
    },
    sessions,
    createSession: (r: string) => createSessionIn(lio, r),
    attach: (id: string, jid: string) => attachSessionIn(lio, id, jid),
  } as never);
  const rig: Rig = {
    root,
    dataDir: resolveDataDir(root),
    sessions,
    lio,
    sid: c.value.sessionId,
    session,
    async submit(text) {
      session.submit(text);
      await new Promise((r) => setTimeout(r, 30));
      for (let i = 0; i < 400 && session.status() !== 'idle'; i++) await new Promise((r) => setTimeout(r, 20));
    },
    async call(body, id) {
      const out = { status: 0, payload: {} as Record<string, unknown> };
      await handleBranch(handlerIo(body, out), {} as never, {} as never, id ?? c.value.sessionId, 'rewind');
      return out;
    },
    plan(target) {
      const out = { status: 0, payload: {} as Record<string, unknown> };
      handleRestorePlan(handlerIo({}, out), {} as never, c.value.sessionId, target);
      return out;
    },
  };
  try {
    await fn(rig);
  } finally {
    for (const s of sessions.values()) await s.dispose().catch(() => undefined);
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const DONE = (r: string): string => `{"done":true,"reply":"${r}"}`;
const WRITE = (p: string, content: string): string => `{"phase":"act","tool":"write","input":{"path":"${p}","content":"${content}"}}`;

function userTexts(rig: Rig, sid: string): string[] {
  const snap = rig.sessions.get(sid)!.snapshotResponse() as { messages: Array<{ kind: string; md: string }> };
  return snap.messages.filter((m) => m.kind === 'user').map((m) => m.md);
}

test('rewind 真链路:新会话对象挂截短档,被回退消息及其后全部消失,源档零改动且移出列表', async () => {
  await withRig([DONE('一'), DONE('二'), DONE('三')], async (rig) => {
    await rig.submit('问一');
    await rig.submit('问二');
    const srcId = rig.session.attachedJournalId!;
    const srcBefore = fs.readFileSync(path.join(sessionsDir(rig.dataDir), `${srcId}.jsonl`), 'utf8');

    const { status, payload } = await rig.call({ userFromEnd: 0 });
    assert.equal(status, 200, JSON.stringify(payload));
    const newSid = payload.sessionId as string;
    assert.notEqual(newSid, rig.sid);
    assert.deepEqual(userTexts(rig, newSid), ['问一']);
    assert.equal(payload.text, '问二');
    assert.equal(typeof payload.atTs, 'number');

    const newJid = payload.journalId as string;
    assert.equal(rig.sessions.get(newSid)!.attachedJournalId, newJid);
    assert.equal(fs.readFileSync(path.join(sessionsDir(rig.dataDir), `${srcId}.jsonl`), 'utf8'), srcBefore);
    assert.deepEqual(listSessions(rig.dataDir).map((m) => m.id).filter((id) => id === srcId || id === newJid), [newJid]);

    // 回退后的会话可继续跑,新轮落新档;模型上下文也已截短
    const next = rig.sessions.get(newSid)!;
    next.submit('改后的问二');
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 400 && next.status() !== 'idle'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(userTexts(rig, newSid), ['问一', '改后的问二']);
    const chain = parseJournalFile(path.join(sessionsDir(rig.dataDir), `${newJid}.jsonl`)).events
      .flatMap((e) => (e.t === 'chain' ? e.steps : []))
      .filter((st) => st.action === 'task')
      .map((st) => st.observation);
    assert.deepEqual(chain, ['问一', '改后的问二']);
  });
});

test('rewind 随迁旁车:题名/权限档/辅助档 sideOf 跟到新档,首条被回退时不沿用旧题', async () => {
  await withRig([DONE('一'), DONE('二')], async (rig) => {
    await rig.submit('问一');
    await rig.submit('问二');
    const srcId = rig.session.attachedJournalId!;
    writeSessionMeta(rig.dataDir, srcId, { mode: 'read-only' });
    fs.writeFileSync(path.join(sessionsDir(rig.dataDir), 'side1.jsonl'), '{"t":"header","v":3,"id":"side1","createdAt":"x"}\n', 'utf8');
    writeSessionMeta(rig.dataDir, 'side1', { side: true, sideOf: srcId });
    const guiDir = path.join(path.dirname(rig.dataDir), 'gui', 'sessions');
    fs.mkdirSync(guiDir, { recursive: true });
    fs.writeFileSync(path.join(guiDir, `${srcId}.json`), '{"v":1,"tabs":[]}', 'utf8');

    const r = await rig.call({ userFromEnd: 0 });
    const newJid = r.payload.journalId as string;
    assert.equal(readSessionMeta(rig.dataDir, newJid).mode, 'read-only');
    assert.equal(readSessionMeta(rig.dataDir, newJid).title, '问一');
    assert.equal(readSessionMeta(rig.dataDir, 'side1').sideOf, newJid);
    assert.equal(fs.existsSync(path.join(guiDir, `${newJid}.json`)), true);
    assert.equal(readSessionMeta(rig.dataDir, srcId).rewoundTo, newJid);
  });
});

test('回退文件:逐轮落 snapshots,只回退被丢弃轮的改动,清单与实际一致', async () => {
  await withRig([WRITE('a.txt', 'v1'), DONE('一'), WRITE('a.txt', 'v2'), WRITE('b.txt', 'new'), DONE('二')], async (rig) => {
    fs.writeFileSync(path.join(rig.root, 'a.txt'), 'v0', 'utf8');
    await rig.submit('问一');
    await rig.submit('问二');
    assert.equal(fs.readFileSync(path.join(rig.root, 'a.txt'), 'utf8'), 'v2');

    assert.deepEqual(rig.plan({ userFromEnd: 0 }).payload.files, [
      { path: 'a.txt', deleted: false },
      { path: 'b.txt', deleted: true },
    ]);

    const r = await rig.call({ userFromEnd: 0, restoreFiles: true });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.deepEqual(r.payload.restore, { restored: ['a.txt'], removed: ['b.txt'], skipped: [] });
    assert.equal(fs.readFileSync(path.join(rig.root, 'a.txt'), 'utf8'), 'v1', '回到问二开始前,不是会话起点');
    assert.equal(fs.existsSync(path.join(rig.root, 'b.txt')), false);
    const snap = rig.sessions.get(r.payload.sessionId as string)!.snapshotResponse() as { messages: Array<{ kind: string; md: string }> };
    assert.equal(snap.messages.some((m) => m.kind === 'notice' && m.md.includes('Files rewound')), true);
  });
});

test('不选回退文件:工作区零动', async () => {
  await withRig([WRITE('a.txt', 'v1'), DONE('一')], async (rig) => {
    await rig.submit('问一');
    const r = await rig.call({ userFromEnd: 0 });
    assert.equal(r.status, 200);
    assert.equal('restore' in r.payload, false);
    assert.equal(fs.readFileSync(path.join(rig.root, 'a.txt'), 'utf8'), 'v1');
  });
});

test('编辑首条消息:全部清空,旧题不沿用', async () => {
  await withRig([DONE('一'), DONE('二')], async (rig) => {
    await rig.submit('问一');
    const r = await rig.call({ userFromEnd: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    const sid = r.payload.sessionId as string;
    assert.deepEqual(userTexts(rig, sid), []);
    assert.equal(readSessionMeta(rig.dataDir, r.payload.journalId as string).title, undefined);
  });
});

test('严格回退:回退点后提交的后台任务被停掉且不进新账本,起点前任务保留', async () => {
    const rig0: Rig | undefined = undefined;
    await withRig([DONE('一'), '{"tool":"exec","input":{"command":"ping -n 30 127.0.0.1","background":true}}', DONE('二')], async (rig) => {
      await rig.submit('问一');
      await rig.submit('问二');
      void rig0;
      const tasks = rig.session.runtime.harness.tasks.list();
      const bg = tasks.find((x) => x.kind === 'exec');
      assert.notEqual(bg, undefined, '后台任务已入账');
      const { status, payload } = await rig.call({ userFromEnd: 0 });
      assert.equal(status, 200, JSON.stringify(payload));
      const newLedger = fs.readFileSync(path.join(rig.dataDir, 'tasks', `ledger-${payload.journalId as string}.jsonl`), 'utf8');
      assert.equal(newLedger.includes(bg!.id), false, '回退点后的任务不进新账本');
      const done = new Promise<void>((resolve) => {
        const poll = (): void => {
          const row = rig.session.runtime.harness.tasks.get(bg!.id);
          if (row === undefined || row.status !== 'running') resolve();
          else setTimeout(poll, 50);
        };
        poll();
      });
      await Promise.race([done, new Promise((r) => setTimeout(r, 5_000))]);
      assert.notEqual(rig.session.runtime.harness.tasks.get(bg!.id)!.status, 'running', '回退点后启动的任务已停');
    });
  });

test('turn 寻址(回到此轮菜单)与越界拒绝', async () => {
  await withRig([DONE('一'), DONE('二')], async (rig) => {
    await rig.submit('问一');
    await rig.submit('问二');
    assert.equal((await rig.call({ userFromEnd: 9 })).status, 400);
    assert.equal((await rig.call({})).status, 400);
    assert.equal(rig.plan({ turn: 9 }).status, 400);
    const r = await rig.call({ turn: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.text, '问二');
    assert.deepEqual(userTexts(rig, r.payload.sessionId as string), ['问一']);
  });
});
