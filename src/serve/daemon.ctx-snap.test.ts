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
import { SessionJournal, parseJournalFile, sessionsDir, reduceJournal } from '../tui/session-journal';
import { resolveDataDir } from '../config/data-dir';
import type { CtxSnapshot } from '../harness/context/index';

/** ctx-snap serve 接线（2026-10-31 session-snapshot-freeze spec §2/§4）：出生写（createSessionIn
 *  即落 ctx-snap 行——惰性建档零文件不变式由 spec 显式废除）、attach 回种落档快照（不重读磁盘，
 *  磁盘 diff 留给首条提交追尾）、旧档无行/坏包回退磁盘现读+补出生写。io 装配形态照抄
 *  daemon.workspace.test.ts：直驱 createSessionIn/attachSessionIn（不起 HTTP/WS 面） */

/** 轮询等待（同 daemon.test.ts 惯例）：20ms 片轮询直至 pred 为真，超时抛错 */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** lifecycle io 装配（daemon 六面直驱形态）：注册表本地 Map，广播/激活/监听全 no-op——
 *  本域只验会话档与上下文面，网络面由 daemon.test 覆盖 */
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

/** 环境隔离样板（daemon.workspace.test.ts 同款）：钉 SUNSHINEX_PROJECTS_DIR 到本用例 tmp 并摘除
 *  SUNSHINEX_DATA_DIR（显式覆盖会让全部 root 共用一个 dataDir，工作区语义不成立）；focused 直跑
 *  不经 scripts/run-tests.js 预载，须自隔离 */
async function withIsoEnv(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ctx-snap-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  try {
    await fn(tmp);
  } finally {
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    if (prevData !== undefined) process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 工作区播种（SUNSHINE.md + 单技能）：漂移追尾断言的离场磁盘形态 */
function seedWorkspace(root: string, sunshine: string, skillId: string, skillDesc: string): void {
  fs.mkdirSync(path.join(root, '.sunshinex', 'skills', skillId), { recursive: true });
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), sunshine, 'utf8');
  fs.writeFileSync(
    path.join(root, '.sunshinex', 'skills', skillId, 'SKILL.md'),
    `---\nname: ${skillId}\ndescription: ${skillDesc}\n---\nbody\n`,
    'utf8',
  );
}

/** 读档 ctx-snap 行（parseJournalFile 归约面）：末条合法行为准 */
function snapOf(file: string): CtxSnapshot | undefined {
  return reduceJournal(parseJournalFile(file).events).snapshot;
}

test('出生会话落 ctx-snap 行；attach 回种旧快照不重读磁盘；离场变更首条提交追尾', { timeout: 60_000 }, async () => {
  await withIsoEnv(async (tmp) => {
    const root = path.join(tmp, 'ws');
    fs.mkdirSync(root, { recursive: true });
    seedWorkspace(root, 'v1 line\n', 'base-skill', 'base skill for birth');
    const io = makeIo(new ScriptedAdapter(['{"done":true,"reply":"第一轮完成"}', '{"done":true,"reply":"第二轮完成"}']));

    // 1) createSession → journal 已建档（出生写,spec §2）且含 ctx-snap 行（header+ctx-snap 形态）
    const c1 = createSessionIn(io, root);
    assert.ok(c1.ok, 'createSessionIn 受理');
    const s1 = io.sessions.get(c1.value.sessionId)!;
    const jid1 = s1.attachedJournalId;
    assert.ok(jid1, '出生写已铸造档 id（惰性零文件不变式由 spec §2 废除）');
    const file1 = path.join(sessionsDir(resolveDataDir(root)), `${jid1}.jsonl`);
    assert.ok(fs.existsSync(file1), '出生档 jsonl 在盘');
    const events1 = parseJournalFile(file1).events;
    assert.equal(events1[0]?.t, 'header', '档首 header');
    assert.equal((events1[0] as { v?: number }).v, 3, 'header v=3');
    const birthSnap = snapOf(file1);
    assert.ok(birthSnap, '出生档含 ctx-snap 行');
    const exported1 = s1.runtime.harness.context.snapshotExport();
    assert.deepEqual(birthSnap, exported1, '出生行与导出面逐位相等（items+sig 同源同拍）');

    // 2) 改磁盘：SUNSHINE.md 追加 + 新技能目录（离场变更——会话快照冻结,不应烘进 attach）
    fs.appendFileSync(path.join(root, 'SUNSHINE.md'), 'v2 line\n', 'utf8');
    seedWorkspace(root, '', 'new-skill', 'brand new skill');

    // 3) newSession + attach 旧 id → snapshotExport 与落档行逐位相等（不重读磁盘）
    const c2 = createSessionIn(io, root);
    assert.ok(c2.ok, '第二会话受理');
    const sid2 = c2.value.sessionId;
    const birthId2 = io.sessions.get(sid2)!.attachedJournalId;
    assert.ok(birthId2 && birthId2 !== jid1, '第二会话出生档独立铸造');
    const att = attachSessionIn(io, sid2, jid1);
    assert.ok(att.ok, `attach 受理（birth-only 出生档守卫放行）: ${att.ok ? '' : att.error.message}`);
    const s2 = io.sessions.get(sid2)!;
    assert.equal(s2.attachedJournalId, jid1, '挂上旧档');
    const exported2 = s2.runtime.harness.context.snapshotExport();
    assert.deepEqual(exported2, exported1, '回种后导出面与出生拍逐位相等（不重读磁盘）');
    assert.ok(!exported2.items.some((it) => it.content.includes('v2 line')), '磁盘 SUNSHINE.md 新内容未烘进快照');
    assert.ok(!exported2.items.some((it) => it.content.includes('brand new skill')), '磁盘新技能未烘进快照');

    // 4) 首条提交 → 链尾出 SUNSHINE.md changed 与 [skills] added notice 行（各一次——追尾语义）
    assert.equal(s2.submit('第一轮').ok, true, '首轮受理');
    await waitFor(() => s2.status() === 'idle', 30_000);
    const noticesOf = (): string[] =>
      s2.runtime.harness.context.chainView().filter((st) => st.action === 'notice').map((st) => st.observation);
    let notices = noticesOf();
    assert.equal(notices.filter((n) => n.startsWith('SUNSHINE.md changed')).length, 1, 'SUNSHINE.md changed 恰一次');
    assert.equal(notices.filter((n) => n.startsWith('[skills] added')).length, 1, '[skills] added 恰一次');

    // 5) 再提交一条 → 不再重复（基线已随首条比对前进）
    assert.equal(s2.submit('第二轮').ok, true, '次轮受理');
    await waitFor(() => s2.status() === 'idle', 30_000);
    notices = noticesOf();
    assert.equal(notices.filter((n) => n.startsWith('SUNSHINE.md changed')).length, 1, '基线前进后零重复（SUNSHINE.md）');
    assert.equal(notices.filter((n) => n.startsWith('[skills] added')).length, 1, '基线前进后零重复（skills）');
  });
});

test('旧档无 ctx-snap 行：attach 回退磁盘重读 + 出生写新行', { timeout: 30_000 }, async () => {
  await withIsoEnv(async (tmp) => {
    const root = path.join(tmp, 'ws-legacy');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'old content\n', 'utf8');
    // 手工造 v3 档：header+chain 行,无 ctx-snap（升级前旧档形态）
    const dataDir = resolveDataDir(root);
    const j = new SessionJournal(dataDir);
    j.start(3);
    const jid = j.currentId!;
    j.log({ t: 'chain', steps: [{ step: 1, action: 'task', observation: '旧任务' }] });
    const file = path.join(sessionsDir(dataDir), `${jid}.jsonl`);
    assert.equal(snapOf(file), undefined, '造档确认：无 ctx-snap 行');

    // 磁盘先行变更（attach 后磁盘现读应含）
    fs.appendFileSync(path.join(root, 'SUNSHINE.md'), 'new content\n', 'utf8');

    const io = makeIo(new ScriptedAdapter(['{"done":true,"reply":"ok"}']));
    const c = createSessionIn(io, root);
    assert.ok(c.ok, 'createSessionIn 受理');
    const sid = c.value.sessionId;
    const birthId = io.sessions.get(sid)!.attachedJournalId;
    assert.ok(birthId && birthId !== jid, '新会话出生档已铸（birth-only）');

    const att = attachSessionIn(io, sid, jid);
    assert.ok(att.ok, `attach 受理: ${att.ok ? '' : att.error.message}`);
    const s = io.sessions.get(sid)!;
    const exported = s.runtime.harness.context.snapshotExport();
    assert.ok(exported.items.some((it) => it.content.includes('new content')), '旧档无行 → 回退磁盘现读（新内容在快照）');
    const tail = parseJournalFile(file).events;
    assert.equal(tail[tail.length - 1]?.t, 'ctx-snap', 'journal 尾部补出生写 ctx-snap 行');
    assert.ok(snapOf(file) !== undefined, '补写行为合法行（归约面可读）');
    assert.ok(!fs.existsSync(path.join(sessionsDir(dataDir), `${birthId}.jsonl`)), 'birth-only 孤儿出生档已回收（不产幻影会话）');
  });
});

test('守卫边界：已落实质行（非 birth-only）的会话重复 attach → 409 双挂守卫不拦', { timeout: 60_000 }, async () => {
  await withIsoEnv(async (tmp) => {
    const root = path.join(tmp, 'ws-guard');
    fs.mkdirSync(root, { recursive: true });
    seedWorkspace(root, 'line\n', 'sk', 'skill');
    const io = makeIo(new ScriptedAdapter(['{"done":true,"reply":"ok"}']));
    const c = createSessionIn(io, root);
    assert.ok(c.ok, 'createSessionIn 受理');
    const s = io.sessions.get(c.value.sessionId)!;
    assert.equal(s.submit('跑一轮').ok, true, '首轮受理（出生档落实质行）');
    await waitFor(() => s.status() === 'idle', 30_000);
    const jid = s.attachedJournalId!;
    // 同会话重复 attach 实质档 → 双挂守卫（出生档已非 birth-only,守卫不得因出生写而松动）
    const att = attachSessionIn(io, c.value.sessionId, jid);
    assert.equal(att.ok, false, '实质档不可重复挂（INVALID_STATE）');
    assert.ok(!att.ok && att.error.code === 'INVALID_STATE', '错误码 INVALID_STATE');
  });
});
