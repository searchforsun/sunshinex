import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRuntime } from './session';
import type { SessionRuntimeOpts } from './session';
import { createSessionIn, attachSessionIn, attachSunxIn } from './session-lifecycle';
import type { SessionLifecycleIo } from './session-lifecycle';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { DaemonFrame } from './daemon-wire';
import { reducePendingRows } from '../session/seglog';
import { SessionJournal, parseJournalFile, sessionsDir } from '../tui/session-journal';
import { resolveDataDir } from '../config/data-dir';

/** 挂起持久化（2026-11-15 sunx P2 Task 4）控制器级端到端（不起 HTTP——session.wake.test.ts 直构形态）：
 *  写面=suspend 三入口落 pending-open 行（journal 直落先于广播）、resolve/deny 出口落 pending-resolve 行
 *  （尽力而为落档纪律）;读面=reducePendingRows 行配对（未决留 open=恢复轮素材、已决入 resolved=仅审计）;
 *  attach 回放=真重启合同（进程 A 真挂起→弃壳不回填→fresh io attachSessionIn 重放链）——素材清单产出
 *  （pendingMaterial()）+ 裁定②不复活断言（挂起表空/零挂起帧重发）+ 裁定④ standard 同产。 */

/** 轮询等待（session.test.ts 惯例）：20ms 片轮询直至 pred 为真,超时抛错 */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const DONE = (reply: string): string => `{"done":true,"reply":"${reply}"}`;

/** 越信任域的 write 卡（acceptEdits 挂起链触发形态,daemon.pending.test.ts 同款）：目标=会话 root 外真文件 */
function writeCard(out: string, name: string, content: string): string {
  return JSON.stringify({ tool: 'write', input: { path: path.join(out, name), content } });
}

/** ask_question 卡（builtin schema 现场核：question/options/multiple/allowCustom 四必填） */
function askCard(question: string, labels: string[]): string {
  return JSON.stringify({
    tool: 'ask_question',
    input: { question, options: labels.map((l) => ({ label: l, description: null })), multiple: null, allowCustom: null },
  });
}

/** journal 行读口（挂档会话）：parseJournalFile → 原始行列（pending 机制行断言源;session.wake.test.ts 同款） */
function journalRows(session: SessionRuntime): Array<Record<string, unknown>> {
  const jid = session.attachedJournalId;
  if (jid === undefined) return [];
  const file = path.join(sessionsDir(session.dataDir), `${jid}.jsonl`); // 寻址随 dataDir 外窥（P3 Task 2 域绑定）
  if (!fs.existsSync(file)) return [];
  return parseJournalFile(file).events as unknown as Array<Record<string, unknown>>;
}

interface CtlCtx {
  session: SessionRuntime;
  frames: DaemonFrame[];
  tmp: string;
  out: string;
}

/** 控制器级装配样板（daemon.pending.test.ts withPendingDaemon 工厂形态）：模型经 (out) 工厂注入——
 *  write 卡挂起目标需会话外 out 目录,先建目录再装适配器;SUNSHINEX_DATA_DIR 钉 tmp;broadcast 收集帧。
 *  finally 兜 teardown——断言失败也不留悬挂 run/pending promise */
async function withCtl(makeModel: (out: string) => ModelAdapter, fn: (ctx: CtlCtx) => Promise<void>, extra?: Partial<SessionRuntimeOpts>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-pendingrow-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-pendingrow-out-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  let seq = 0;
  let pidSeq = 0;
  const frames: DaemonFrame[] = [];
  let session: SessionRuntime | undefined;
  try {
    session = new SessionRuntime({
      id: 's1',
      root: tmp,
      model: makeModel(out),
      nextSeq: () => {
        seq += 1;
        return seq;
      },
      broadcast: (f) => frames.push(f),
      mintPid: () => `pt${(pidSeq += 1)}`,
      ...(extra ?? {}),
    });
    await fn({ session, frames, tmp, out });
  } finally {
    await session?.teardown();
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    for (const dir of [tmp, out]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // win32：收口后偶发目录锁（watcher/句柄迟滞）,不挡断言
      }
    }
  }
}

/** 生命周期 io 装配（session.rewind-restore.test.ts 同形）：broadcast 收集帧（不复活断言的帧收集器） */
function makeIo(model: ModelAdapter, frames: DaemonFrame[]): SessionLifecycleIo {
  const sessions = new Map<string, SessionRuntime>();
  let seq = 0;
  let pid = 0;
  return {
    sessions,
    model,
    nextSeq: () => ++seq,
    mintPid: () => `p${++pid}`,
    broadcast: (f) => frames.push(f),
    setActive: () => {},
    watchProject: () => {},
    unwatchProject: () => {},
  };
}

/** 生命周期装配样板（rewind rig 环境形态）：SUNSHINEX_PROJECTS_DIR 钉 tmp、DATA_DIR 解除——
 *  真 createSessionIn/attachSessionIn 链（出生写/meta 旁车/birth-only 守卫全真） */
async function withProjectsRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-pendingrow-lc-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(root);
  try {
    await fn(root);
  } finally {
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // win32 目录锁迟滞不挡断言
    }
  }
}

test('写面 ask：suspendAsk 落 pending-open 行（pid/kind/req 原件）→ resolvePendingAsk 落 pending-resolve 行 → 行配对读面 resolved', { timeout: 30_000 }, async () => {
  await withCtl(() => new ScriptedAdapter([askCard('Pick one', ['postgres', 'sqlite']), DONE('asked')]), async (ctx) => {
    const ctl = ctx.session;
    ctl.attachJournal(new SessionJournal(resolveDataDir(ctx.tmp)));
    assert.equal(ctl.submit('问一下').ok, true);
    await waitFor(() => ctl.pendingSnapshot().some((r) => r.kind === 'ask'), 10_000);
    const pid = ctl.pendingSnapshot().find((r) => r.kind === 'ask')!.pid;
    // open 行：pid/kind/req 原件逐字段（question/options 直序列化——恢复轮素材源）
    const openRows = journalRows(ctl).filter((r) => r.t === 'pending-open');
    assert.equal(openRows.length, 1, '挂起即行落档（恰一行）');
    assert.equal(openRows[0]!.pid, pid);
    assert.equal(openRows[0]!.kind, 'ask');
    const req = openRows[0]!.req as { question: string; options: Array<{ label: string }> };
    assert.equal(req.question, 'Pick one');
    assert.deepEqual(req.options.map((o) => o.label), ['postgres', 'sqlite']);
    // 回执：resolve 行落档（摘要=selected 列）
    assert.equal(ctl.resolvePendingAsk(pid, { type: 'selected', labels: ['postgres'] }), true);
    await waitFor(() => ctl.status() === 'idle', 15_000);
    assert.deepEqual(journalRows(ctl).filter((r) => r.t === 'pending-resolve'), [{ t: 'pending-resolve', pid, outcome: 'selected: postgres' }]);
    // 行配对读面（Task 5 素材源单点）：已决入 resolved（material+outcome）,open 空
    const view = reducePendingRows(journalRows(ctl));
    assert.deepEqual(view.open, []);
    assert.deepEqual(view.resolved, [{ pid, kind: 'ask', title: 'Pick one', options: ['postgres', 'sqlite'], outcome: 'selected: postgres' }]);
  });
});

test('写面 approval：acceptEdits write 挂起落 open 行（req.subject）→ resolvePendingApproval deny 定论落 resolve 行', { timeout: 30_000 }, async () => {
  await withCtl(
    (out) => new ScriptedAdapter([writeCard(out, 'pending-row.txt', 'nope'), DONE('never')]),
    async (ctx) => {
      const ctl = ctx.session;
      ctl.attachJournal(new SessionJournal(resolveDataDir(ctx.tmp)));
      assert.equal(ctl.submit('写个文件').ok, true);
      await waitFor(() => ctl.pendingSnapshot().some((r) => r.kind === 'approval'), 10_000);
      const pid = ctl.pendingSnapshot().find((r) => r.kind === 'approval')!.pid;
      const openRow = journalRows(ctl).find((r) => r.t === 'pending-open') as { pid: string; kind: string; req: { kind: string; subject: string } };
      assert.equal(openRow.pid, pid);
      assert.equal(openRow.kind, 'approval');
      assert.equal(openRow.req.kind, 'write');
      assert.ok(openRow.req.subject.includes('pending-row.txt'));
      // deny 定论：resolve 行 outcome=裁决字面
      assert.equal(ctl.resolvePendingApproval(pid, 'deny'), true);
      await waitFor(() => ctl.status() === 'idle', 15_000);
      assert.deepEqual(journalRows(ctl).filter((r) => r.t === 'pending-resolve'), [{ t: 'pending-resolve', pid, outcome: 'deny' }]);
      assert.equal(fs.existsSync(path.join(ctx.out, 'pending-row.txt')), false, 'deny 下写被拒');
    },
    { mode: 'acceptEdits' },
  );
});

test('deny 回填路径：denyPending 落 resolve 行（approval=denied / ask=dismissed,与显式回执 deny 区分）——审计完整', { timeout: 30_000 }, async () => {
  await withCtl(
    (out) => new ScriptedAdapter([writeCard(out, 'pending-deny.txt', 'nope'), askCard('Again?', ['a', 'b']), DONE('done')]),
    async (ctx) => {
      const ctl = ctx.session;
      ctl.attachJournal(new SessionJournal(resolveDataDir(ctx.tmp)));
      assert.equal(ctl.submit('写完再问').ok, true);
      await waitFor(() => ctl.pendingSnapshot().some((r) => r.kind === 'approval'), 10_000);
      const pidAp = ctl.pendingSnapshot().find((r) => r.kind === 'approval')!.pid;
      ctl.denyPending(); // interrupt/reset 同款回填（daemon.denyPendingFor 薄委托的会话端点）
      await waitFor(() => ctl.pendingSnapshot().some((r) => r.kind === 'ask'), 10_000);
      const pidAsk = ctl.pendingSnapshot().find((r) => r.kind === 'ask')!.pid;
      ctl.denyPending();
      await waitFor(() => ctl.status() === 'idle', 15_000);
      // 两枚 resolve 行按序落档：approval=denied / ask=dismissed;文件不落盘
      assert.deepEqual(journalRows(ctl).filter((r) => r.t === 'pending-resolve'), [
        { t: 'pending-resolve', pid: pidAp, outcome: 'denied' },
        { t: 'pending-resolve', pid: pidAsk, outcome: 'dismissed' },
      ]);
      assert.equal(fs.existsSync(path.join(ctx.out, 'pending-deny.txt')), false, 'deny 回填下写被拒');
      assert.deepEqual(ctl.pendingSnapshot(), [], '回填后清表');
      // 行配对读面：两枚都已决（open 空）——重启后零素材（无未决残留）
      assert.deepEqual(reducePendingRows(journalRows(ctl)).open, []);
    },
    { mode: 'acceptEdits' },
  );
});

test('plan 卡写面：exit_plan 挂起落 open 行（name/doc）→ 修订回执落 rejected 摘要 → 放弃回填（interrupt）落 dismissed', { timeout: 30_000 }, async () => {
  await withCtl(
    () =>
      new ScriptedAdapter([
        { toolCalls: [{ name: 'exit_plan', args: { name: '计划一', doc: '# 计划一\n1. 步骤A' } }] }, // 交稿挂起
        { toolCalls: [{ name: 'exit_plan', args: { name: '计划二', doc: '# 计划二\n1. 步骤B' } }] }, // 修订轮再出牌
        DONE('done'),
      ]),
    async (ctx) => {
    const ctl = ctx.session;
    ctl.attachJournal(new SessionJournal(resolveDataDir(ctx.tmp)));
    assert.equal(await ctl.setMode('plan'), 'ok');
    assert.equal(ctl.submit('做件事').ok, true);
    await waitFor(() => ctl.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
    const pid1 = ctl.pendingSnapshot().find((r) => r.kind === 'plan-approval')!.pid;
    // 修订回执：resolve 行 outcome=rejected: 反馈摘要;修订轮再出牌（新 pid）
    assert.equal(ctl.resolvePendingPlanApproval(pid1, { approved: false, feedback: '改成X' }), true);
    await waitFor(() => ctl.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
    const pid2 = ctl.pendingSnapshot().find((r) => r.kind === 'plan-approval')!.pid;
    assert.notEqual(pid2, pid1, '修订轮新卡新票据');
    // 放弃回填（interrupt→denyPlanPendings 生产缝）：resolve 行 outcome=dismissed
    assert.equal(ctl.interrupt().ok, true);
    await waitFor(() => ctl.status() === 'idle', 15_000);
    const opens = journalRows(ctl).filter((r) => r.t === 'pending-open');
    assert.equal(opens.length, 2, '两枚 plan 卡均落 open 行');
    assert.equal((opens[0]!.req as { name: string }).name, '计划一');
    assert.equal((opens[1]!.req as { name: string }).name, '计划二');
    assert.deepEqual(journalRows(ctl).filter((r) => r.t === 'pending-resolve'), [
      { t: 'pending-resolve', pid: pid1, outcome: 'rejected: 改成X' },
      { t: 'pending-resolve', pid: pid2, outcome: 'dismissed' },
    ]);
  });
});

test('attach 回放（sunx 重启合同）：真挂起→弃壳不回填→fresh io attach（reCast 链）→未决转素材+恢复轮消费（R9）+不复活（表空/零挂起帧）', { timeout: 40_000 }, async () => {
  await withProjectsRoot(async (root) => {
    // 进程 A：真挂起面（kind:'sunx' 出生——meta.kind='sunx' 落档）
    const framesA: DaemonFrame[] = [];
    const ioA = makeIo(new ScriptedAdapter([askCard('重启后怎么继续？', ['继续', '放弃']), DONE('x')]), framesA);
    const cA = createSessionIn(ioA, root, { kind: 'sunx' });
    assert.ok(cA.ok, `createSessionIn: ${cA.ok ? '' : cA.error.message}`);
    const a = ioA.sessions.get(cA.value.sessionId)!;
    assert.equal(a.submit('问一件事').ok, true);
    await waitFor(() => a.pendingSnapshot().some((r) => r.kind === 'ask'), 10_000);
    const jid = a.attachedJournalId!;
    const openRows = journalRows(a).filter((r) => r.t === 'pending-open');
    assert.equal(openRows.length, 1, '挂起即行落档');
    // 弃壳不回填：A teardown（abort 收口——ask 挂起无 resolve 对位=daemon 重启蒸发原样）
    await a.teardown();
    // 进程 B（fresh io=真重启）：域重开链 attachSunxIn——壳出生即 sunx 形态（P3 Task 2 域绑定后,
    // 旧 standard 壳+attachSessionIn 链不达域档;重铸语义由构造期 sunx 形态承载,播种全在其后）
    const framesB: DaemonFrame[] = [];
    const ioB = makeIo(new ScriptedAdapter([DONE('y')]), framesB);
    const att = attachSunxIn(ioB, jid);
    assert.ok(att.ok, `attachSunxIn: ${att.ok ? '' : att.error.message}`);
    const b = ioB.sessions.get(att.value.sessionId)!;
    assert.equal(b.sessionKind, 'sunx', 'attachSunx 壳出生即 sunx 形态');
    // 素材清单产出（接口形态逐字段：问题原文+选项 label 列,主链直问 askedBy 缺席）→ **R9 恢复轮
    // 自动起跑即消费**（2026-11-15 sunx P2 Task 5——sunx attach 收尾起恢复轮,起跑成功 clear 本实例;
    // 素材内容面转入恢复轮 notice 正文,行推导幂等二次 attach 重产=预期）。素材产出形态的逐字段
    // 钉在 standard 同产用例（本套件末例——standard 零触发不消费,断言可驻）
    await waitFor(() => b.sessionKernel.replay().some((e) => e.kind === 'notice' && e.restored === true), 10_000);
    await waitFor(() => b.status() === 'idle', 15_000);
    const restoredMd = b.sessionKernel.replay().find((e) => e.kind === 'notice' && e.restored === true)!.md;
    assert.ok(restoredMd.includes('重启后怎么继续？'), '素材 title 入恢复轮 notice（裁定 5：呈现只取 title/askedBy）');
    assert.deepEqual(b.pendingMaterial(), [], '恢复轮起跑成功即消费（clear 本实例——裁定 3）');
    // 裁定②不复活：挂起表空（pendingSnapshot 无行）+ 零挂起帧重发（executor 已死,复活无消费者）
    assert.deepEqual(b.pendingSnapshot(), []);
    assert.equal(framesB.filter((f) => f.kind === 'approval' || f.kind === 'ask' || f.kind === 'plan-approval').length, 0);
    // 旧挂起的 open 行也不入转录投影（机制行非转录——b 转录里无 pending 行派生条目;恢复轮 notice
    // 的正文含 title 但整条 md 非恰等,不与本断言冲突）
    assert.equal(
      b.sessionKernel.replay().some((e) => e.md === '重启后怎么继续？'),
      false,
      '挂起机制行不进转录（不复活为界面卡/转录条）',
    );
    await b.teardown();
  });
});

test('attach 回放（standard 同产）：素材行面普适（裁定④）+ 幂等重产（整列替换非累加）+ clearPendingMaterial 消费清空', { timeout: 30_000 }, async () => {
  await withProjectsRoot(async (root) => {
    // 进程 A：standard 会话（无 kind）——第二实例写存档行（重启前旧进程既存行,wake rearm 测试同款写法）
    const ioA = makeIo(new ScriptedAdapter([DONE('x')]), []);
    const cA = createSessionIn(ioA, root);
    assert.ok(cA.ok);
    const a = ioA.sessions.get(cA.value.sessionId)!;
    a.ensureJournalMinted();
    const jid = a.attachedJournalId!;
    const seed = new SessionJournal(resolveDataDir(root));
    seed.attach(jid);
    seed.log({ t: 'pending-open', pid: 'p9', kind: 'ask', req: { question: 'solo?', options: [{ label: 'yes' }, { label: 'no' }] } });
    seed.log({ t: 'pending-open', pid: 'p10', kind: 'approval', req: { id: 'ap', kind: 'write', subject: 'f.txt' } });
    seed.log({ t: 'pending-resolve', pid: 'p10', outcome: 'allow' }); // 重启前已答:仅审计
    // 进程 B（fresh io=真重启）：standard 壳 attach 重放——素材同产（standard 无 reCast）
    const framesB: DaemonFrame[] = [];
    const ioB = makeIo(new ScriptedAdapter([DONE('y')]), framesB);
    const cB = createSessionIn(ioB, root);
    assert.ok(cB.ok);
    const att = attachSessionIn(ioB, cB.value.sessionId, jid);
    assert.ok(att.ok, `attachSessionIn: ${att.ok ? '' : att.error.message}`);
    const b = ioB.sessions.get(att.value.sessionId)!;
    assert.equal(b.sessionKind, undefined, 'standard 壳不重铸');
    // 未决 ask 入素材;已答 approval 仅审计（不入素材）
    assert.deepEqual(b.pendingMaterial(), [{ pid: 'p9', kind: 'ask', title: 'solo?', options: ['yes', 'no'] }]);
    const view = reducePendingRows(journalRows(b));
    assert.deepEqual(view.resolved, [{ pid: 'p10', kind: 'approval', title: 'f.txt', outcome: 'allow' }], '已决行审计面');
    // 不复活
    assert.deepEqual(b.pendingSnapshot(), []);
    assert.equal(framesB.filter((f) => f.kind === 'approval' || f.kind === 'ask' || f.kind === 'plan-approval').length, 0);
    // 幂等重产（裁定 3）：同行列再 seed=整列替换非累加
    b.seedPendingMaterials(journalRows(b));
    assert.equal(b.pendingMaterial().length, 1, '重复回产不累加');
    // 消费清空接口（Task 5 恢复轮消费后调用）
    b.clearPendingMaterial();
    assert.deepEqual(b.pendingMaterial(), []);
    await b.teardown();
    await a.teardown();
  });
});
