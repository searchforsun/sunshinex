import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import { SessionEvent } from '../types';
import { teamTokenCapEnv } from '../config/termination-config';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Harness {
  board: TaskBoard;
  events: SessionEvent[];
  calls: string[]; // runner 收到的 taskLine 序(执行顺序断言)
}

function makeBoard(tmp: string, opts?: { failReplies?: string[]; teamTokenCap?: number }): Harness {
  const events: SessionEvent[] = [];
  const calls: string[] = [];
  const failReplies = opts?.failReplies ?? [];
  const runner = {
    runSubagent: async (_input: unknown, o?: { taskLine?: string }) => {
      const line = o?.taskLine ?? '';
      calls.push(line);
      if (failReplies.includes(line)) return { ok: false as const, error: { code: 'INCOMPLETE', message: 'no finish' } };
      return { ok: true as const, value: { reply: `reply of ${line}`, tokens: 10 } };
    },
  } as unknown as SubagentRunner;
  const registry = { submit: () => ({ id: 'b1', stop: () => {} }), append: () => {}, finish: () => {}, list: () => [], get: () => undefined } as unknown as TaskRegistry;
  const board = new TaskBoard({
    store: new TeamStore(path.join(tmp, 'teams', 'main')),
    runner,
    registry,
    onEvent: (e) => events.push(e),
    now: (() => { let n = 1000; return () => ++n; })(),
    ...(opts?.teamTokenCap !== undefined ? { teamTokenCap: opts.teamTokenCap } : {}),
  });
  board.init();
  return { board, events, calls };
}

const drain = () => new Promise((r) => setImmediate(r));

test('依赖顺序执行 + harness 强制回写 + 终态事件序', async () => {
  const tmp = tmpdir('sunshinex-tb-board-');
  try {
    const h = makeBoard(tmp);
    const a = h.board.create({ title: 'A', spec: 'do A' });
    const b = h.board.create({ title: 'B', spec: 'do B', dependsOn: ['t1'] });
    assert.ok(a.ok && b.ok);
    await drain();
    assert.deepEqual(h.calls, ['Task t1: A'], 't2 阻塞未派发');
    const s1 = h.board.snapshot();
    assert.equal(s1.tasks['t1']!.status, 'in-review', '强制回写 claimed→in-review(不依赖模型自觉)');
    assert.equal(s1.tasks['t2']!.status, 'pending');
    await h.board.review('t1', { approved: true });
    await drain();
    assert.deepEqual(h.calls, ['Task t1: A', 'Task t2: B'], '上游 done 解锁下游派发');
    await h.board.review('t2', { approved: true });
    const s2 = h.board.snapshot();
    assert.equal(s2.tasks['t1']!.status, 'done');
    assert.equal(s2.tasks['t2']!.status, 'done');
    const seq = h.events.map((e) => e.type).join(',');
    assert.ok(seq.includes('task-created') && seq.includes('task-unlocked') && seq.includes('task-status-changed'), `事件齐备:${seq}`);
    assert.ok(h.events.filter((e) => e.type === 'task-unlocked').length >= 2, '解锁事件至少 t1 与 t2 各一');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('执行失败:强制回写 failed + 下游 task-blocked 不自动 skip', async () => {
  const tmp = tmpdir('sunshinex-tb-board2-');
  try {
    const h = makeBoard(tmp, { failReplies: ['Task t1: A'] });
    h.board.create({ title: 'A', spec: 'do A' });
    h.board.create({ title: 'B', spec: 'do B', dependsOn: ['t1'] });
    await drain();
    const s = h.board.snapshot();
    assert.equal(s.tasks['t1']!.status, 'failed');
    assert.equal(s.tasks['t2']!.status, 'pending', '下游不被自动 skip(§4.1 收紧)');
    const blocked = h.events.find((e) => e.type === 'task-blocked');
    assert.ok(blocked, 'task-blocked 事件已发');
    assert.deepEqual((blocked!.payload as Record<string, unknown>)?.blockedBy, ['t1']);
    // 失败 note 对称:回写事件带 code+message(与台账 [failed] 行同口径)
    const raw = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8');
    assert.ok(raw.includes('"note":"execution failed: INCOMPLETE: no finish"'), `失败 note 含 code:message,实际:${raw}`);
    // lead 裁决:review(t1, approved=false 已是 failed)——对 failed 任务 review 应报错;改判路径走 in-review
    const r = await h.board.review('t1', { approved: true });
    assert.equal(r.ok, false, 'failed 任务不可 review');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CONCURRENCY_LIMIT 回池待派:一次拒绝后重派成功,终局 in-review 而非永久 failed', async () => {
  const tmp = tmpdir('sunshinex-tb-board6-');
  try {
    const events: SessionEvent[] = [];
    let refused = false;
    const runner = {
      runSubagent: async () => {
        if (!refused) {
          refused = true;
          return { ok: false as const, error: { code: 'CONCURRENCY_LIMIT', message: 'Subagent concurrency limit reached (8)' } };
        }
        return { ok: true as const, value: { reply: 'ok after retry', tokens: 5 } };
      },
    } as unknown as SubagentRunner;
    const registry = { submit: () => ({ id: 'b6', stop: () => {} }), append: () => {}, finish: () => {}, list: () => [], get: () => undefined } as unknown as TaskRegistry;
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner,
      registry,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
      retryDelayMs: 10,
    });
    board.init();
    const r = board.create({ title: 'A', spec: 'a' });
    assert.ok(r.ok);
    await drain();
    // 回池后不再微任务自旋重派,由退避定时器(10ms)让出事件循环后重派成功(2026-10-05 终审复审裁定)
    await new Promise((res) => setTimeout(res, 40));
    const s = board.snapshot();
    assert.equal(s.tasks['t1']!.status, 'in-review', '回池重派后终局 in-review(不永久失败)');
    assert.ok(!events.some((e) => e.type === 'task-blocked'), '并发拒绝不发下游 blocked');
    const idx = (pred: (e: SessionEvent) => boolean): number => events.findIndex(pred);
    const iPend = idx((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.status === 'pending');
    const iReview = idx((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.status === 'in-review');
    assert.ok(iPend >= 0, '回池 pending 事件已发');
    const pend = events[iPend]!.payload as Record<string, unknown>;
    assert.equal(pend.from, 'claimed');
    assert.equal(pend.note, 'concurrency limit, deferred');
    assert.ok(iReview > iPend, `pending 回池事件先于最终 in-review(${iPend} < ${iReview})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CONCURRENCY_LIMIT 持续占用:退避定时器有界重试,无微任务自旋热循环', async () => {
  const tmp = tmpdir('sunshinex-tb-board7-');
  try {
    const events: SessionEvent[] = [];
    // 假 runner 永远拒绝:容量被非任务板 subagent(main-chain spawn)持满的极端场景
    const runner = {
      runSubagent: async () => ({ ok: false as const, error: { code: 'CONCURRENCY_LIMIT', message: 'limit' } }),
    } as unknown as SubagentRunner;
    const registry = { submit: () => ({ id: 'b7', stop: () => {} }), append: () => {}, finish: () => {}, list: () => [], get: () => undefined } as unknown as TaskRegistry;
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner,
      registry,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
      retryDelayMs: 50,
    });
    board.init();
    const r = board.create({ title: 'A', spec: 'a' });
    assert.ok(r.ok);
    await new Promise((res) => setTimeout(res, 500)); // 500ms 观察窗 / 50ms 退避 → 至多 ~10 轮(自旋热循环会是数百轮)
    const claimed = events.filter((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.status === 'claimed').length;
    assert.ok(claimed >= 2, `退避定时器重派确有发生(实际 ${claimed} 轮)`);
    assert.ok(claimed <= 10, `无热循环:500ms 窗口 / 50ms 退避至多 ~10 轮(实际 ${claimed};微任务自旋热循环会是数百轮)`);
    const lines = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0).length;
    assert.ok(lines <= 40, `事件流有界增长(实际 ${lines} 行;热循环下无界)`);
    assert.equal(board.snapshot().tasks['t1']!.status, 'pending', '持续占用下任务保持回池等待,不 failed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('set_dependency 环检测 fail-fast;gate 挂起与解锁;限流;id 单调', async () => {
  const tmp = tmpdir('sunshinex-tb-board3-');
  try {
    const h = makeBoard(tmp);
    h.board.create({ title: 'A', spec: 'a' });
    h.board.create({ title: 'B', spec: 'b' });
    await drain(); // 两者执行完进 in-review
    const r = h.board.setDependency('t1', 't2');
    assert.ok(r.ok); // t2 尚未 done,加边合法(t1 已 in-review,环视角仍无环)
    const cyc = h.board.setDependency('t2', 't1');
    // t1→t2 与 t2→t1 成环:拒绝
    assert.equal(cyc.ok, false);
    assert.ok(String(cyc.error.message).includes('cycle'), `报错含环提示:${String(cyc.error.message)}`);
    // gate:新任务挂起不派发,approved 解锁
    const g = h.board.create({ title: 'C', spec: 'c' });
    await drain();
    assert.equal(h.board.snapshot().tasks['t3']!.status, 'in-review');
    h.board.review('t3', { approved: true });
    // brief 原文 t4 无依赖且 create 后立刻 gate——但 create 内 kick 的 drain 同步前缀已把无依赖任务
    // 置 claimed,gate() 对 claimed 报 "cannot gate a task mid-execution",gate-waiting 永不发射。
    // 测试意图不变(gated 不派发/审批解锁),改走:t4 依赖 in-review 的 t1 保持 pending 再 gate;
    // 审批 t1 为 done 亦补齐下文限流注释的口径前提「t1/t3 已 done, open=t2+t4=2」。
    const c = h.board.create({ title: 'D', spec: 'd', dependsOn: ['t1'] });
    assert.ok(c.ok && c.value.taskId === 't4', 'id 单调');
    h.board.gate('t4', 'need human check');
    await drain();
    assert.equal(h.board.snapshot().tasks['t4']!.status, 'pending', 'gated 不派发');
    assert.ok(h.events.some((e) => e.type === 'gate-waiting'));
    await h.board.review('t1', { approved: true });
    await drain();
    assert.equal(h.board.snapshot().tasks['t4']!.status, 'pending', '依赖满足仍 gated 不派发');
    await h.board.review('t4', { approved: true });
    assert.ok(h.events.some((e) => e.type === 'gate-resolved'));
    await drain();
    assert.equal(h.board.snapshot().tasks['t4']!.status, 'in-review', '解锁后派发');
    // 限流:maxOpenTasks 默认 64——此时 open = t2(in-review)+t4(in-review)=2,t1/t3 已 done;
    // bulk 62 个后 open=64,'over' 拒建
    for (let i = 0; i < 62; i++) h.board.create({ title: `bulk${i}`, spec: 'x', dependsOn: ['t4'] });
    const over = h.board.create({ title: 'over', spec: 'x', dependsOn: ['t4'] });
    assert.equal(over.ok, false, '超过 64 未终态任务拒建');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create gated:true 建即挂起:task-created→gate-set 落流、gate-waiting 发射,任务不派发(P2)', async () => {
  const tmp = tmpdir('sunshinex-tb-gated-');
  try {
    const h = makeBoard(tmp);
    const r = h.board.create({ title: 'A', spec: 'a', gated: true });
    assert.ok(r.ok);
    await drain();
    assert.deepEqual(h.calls, [], 'gated 任务不派发(runner 零调用)');
    const s = h.board.snapshot();
    assert.equal(s.tasks['t1']!.status, 'pending', 'gated 保持 pending');
    assert.equal(s.tasks['t1']!.gated, true);
    const types = h.events.map((e) => e.type);
    const iCreated = types.indexOf('task-created');
    const iGate = types.indexOf('gate-waiting');
    assert.ok(iCreated >= 0 && iGate > iCreated, `发射序 task-created 先于 gate-waiting:${types.join(',')}`);
    assert.equal((h.events[iGate]!.payload as Record<string, unknown>).taskId, 't1');
    const raw = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as { t: string });
    assert.deepEqual(raw.map((e) => e.t), ['task-created', 'gate-set'], '持久化事件序:task-created 后随 gate-set');
    // review(approved) 解锁:依赖满足(无依赖)+ 门已解 → 派发
    await h.board.review('t1', { approved: true });
    await drain();
    assert.equal(h.board.snapshot().tasks['t1']!.status, 'in-review', '解锁后派发');
    assert.deepEqual(h.calls, ['Task t1: A']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('create executor 提示入板:快照与 task-created 事件均带 executorHint(P2)', async () => {
  const tmp = tmpdir('sunshinex-tb-exec-');
  try {
    const h = makeBoard(tmp);
    const r = h.board.create({ title: 'A', spec: 'a', executor: 'external-cli' });
    assert.ok(r.ok);
    assert.equal(h.board.snapshot().tasks['t1']!.executorHint, 'external-cli', '快照 executorHint 设置');
    const ev = h.events.find((e) => e.type === 'task-created');
    assert.ok(ev, 'task-created 事件已发');
    assert.equal((ev!.payload as Record<string, unknown>).executorHint, 'external-cli', '事件载荷带 executorHint');
    await drain(); // P1/P2 提示不改变派发行为:内部 runner 照常收口
    assert.equal(h.board.snapshot().tasks['t1']!.status, 'in-review');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cancel:pending/gated/blocked 派生 → cancelled(容量回收),claimed 拒(须先 stop),终态/未知拒(终审 Item 2)', async () => {
  const tmp = tmpdir('sunshinex-tb-cancel-');
  try {
    const h = makeBoard(tmp);
    h.board.create({ title: 'A', spec: 'a', gated: true }); // t1:gated 停 pending
    h.board.create({ title: 'B', spec: 'b', dependsOn: ['t1'] }); // t2:依赖未满停 pending
    await drain();
    assert.equal(h.board.snapshot().tasks['t1']!.status, 'pending', 'gated 保持 pending');
    // gated pending 可取消:cancelled 终态即出 open 计数(板容量回收)
    assert.ok(h.board.cancel('t1').ok, 'gated pending 可取消');
    assert.equal(h.board.snapshot().tasks['t1']!.status, 'cancelled');
    const ev = h.events.find((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.status === 'cancelled');
    assert.ok(ev, 'task-status-changed(cancelled) 已发');
    assert.equal((ev!.payload as Record<string, unknown>).from, 'pending');
    assert.equal((ev!.payload as Record<string, unknown>).note, 'cancelled by lead');
    // blocked 派生(t2 依赖已 cancelled 的 t1)仍 pending → 可取消
    assert.ok(h.board.cancel('t2').ok, 'blocked 派生 pending 可取消');
    assert.equal(h.board.snapshot().tasks['t2']!.status, 'cancelled');
    // 终态拒 + 未知 id 拒
    assert.equal(h.board.cancel('t1').ok, false, '终态任务不可再取消');
    assert.equal(h.board.cancel('tX').ok, false, '未知任务拒');
    // 取消以事件落盘(note 同口径)
    const raw = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8');
    assert.ok(raw.includes('"note":"cancelled by lead"'), `取消事件带 note 落盘,实际:${raw}`);

    // claimed 拒:悬置 runner 下任务停 claimed——cancel 不得越权改写(回写单点保证终态迁移)
    const events2: SessionEvent[] = [];
    let release: () => void = () => {};
    const hang = new Promise<void>((res) => { release = res; });
    const board2 = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'aux')),
      runner: {
        runSubagent: async () => {
          await hang;
          return { ok: true as const, value: { reply: 'late', tokens: 1 } };
        },
      } as unknown as SubagentRunner,
      registry: { submit: () => ({ id: 'cx1', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry,
      onEvent: (e) => events2.push(e),
    });
    board2.init();
    assert.ok(board2.create({ title: 'C', spec: 'c' }).ok);
    await drain();
    assert.equal(board2.snapshot().tasks['t1']!.status, 'claimed', '悬置 runner:t1 停 claimed');
    const r = board2.cancel('t1');
    assert.equal(r.ok, false, 'claimed 在飞不可直接取消');
    assert.ok(String(r.error.message).includes('stop it first'), `报错引导先 stop:${String(r.error.message)}`);
    assert.equal(board2.snapshot().tasks['t1']!.status, 'claimed', 'claimed 不被取消改写');
    release(); // 卫生:放行悬置 runner,drain 收口
    await drain();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('set_dependency/assign 成功路径发 task-dep-added/task-assigned(载荷核字段,P2)', async () => {
  const tmp = tmpdir('sunshinex-tb-depev-');
  try {
    const h = makeBoard(tmp);
    h.board.create({ title: 'A', spec: 'a' }); // t1 → 派发 in-review
    h.board.create({ title: 'B', spec: 'b' }); // t2 → 派发 in-review
    await drain();
    assert.ok(h.board.setDependency('t2', 't1').ok);
    const dep = h.events.find((e) => e.type === 'task-dep-added');
    assert.ok(dep, 'task-dep-added 已发');
    assert.deepEqual(dep!.payload, { taskId: 't2', dependsOn: 't1' }, '载荷恰为 taskId+dependsOn');
    assert.ok(h.board.setDependency('t2', 't1').ok, '重复加边 no-op 成功');
    assert.equal(h.events.filter((e) => e.type === 'task-dep-added').length, 1, 'no-op 不重复发射(变更即发射口径)');
    assert.ok(h.board.assign('t1', 'alice').ok);
    const asg = h.events.find((e) => e.type === 'task-assigned');
    assert.ok(asg, 'task-assigned 已发');
    assert.deepEqual(asg!.payload, { taskId: 't1', assignee: 'alice' }, '载荷恰为 taskId+assignee');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('summaryLines 英文化:needs/[gated] 标记,无中文字符(P2)', async () => {
  const tmp = tmpdir('sunshinex-tb-en-');
  try {
    const h = makeBoard(tmp);
    h.board.create({ title: 'A', spec: 'a', gated: true });       // t1 pending [gated]
    h.board.create({ title: 'B', spec: 'b', dependsOn: ['t1'] });  // t2 pending (needs t1)
    await drain();
    const lines = h.board.summaryLines();
    assert.ok(lines.includes('t1 [pending] [gated] A'), `gated 行形态:${JSON.stringify(lines)}`);
    assert.ok(lines.includes('t2 [pending] B (needs t1)'), `needs 行形态:${JSON.stringify(lines)}`);
    assert.ok(lines.every((l) => !/[\u4e00-\u9fff]/.test(l)), `无中文:${JSON.stringify(lines)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('finishExecution 直调:claimed 回写单点(in-review+artifact+台账收口+状态事件,P2 抽取)', async () => {
  const tmp = tmpdir('sunshinex-tb-finish-');
  try {
    const events: SessionEvent[] = [];
    const finishes: unknown[][] = [];
    let release: () => void = () => {};
    const hang = new Promise<void>((res) => { release = res; });
    // runner 悬置:claim 后不回,回写由直调 finishExecution 驱动(模拟 T2 外部执行体收口路径)
    const runner = {
      runSubagent: async () => {
        await hang;
        return { ok: true as const, value: { reply: 'late', tokens: 1 } };
      },
    } as unknown as SubagentRunner;
    const registry = {
      submit: () => ({ id: 'fx1', stop: () => {} }),
      append: () => {},
      finish: (...args: unknown[]) => { finishes.push(args); },
    } as unknown as TaskRegistry;
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner,
      registry,
      onEvent: (e) => events.push(e),
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    board.init();
    assert.ok(board.create({ title: 'A', spec: 'a' }).ok);
    await drain();
    assert.equal(board.snapshot().tasks['t1']!.status, 'claimed', 'runner 悬置,t1 停在 claimed');
    board.finishExecution('t1', { ok: true, reply: 'r', tokens: 5 }, 'fx1');
    const t1 = board.snapshot().tasks['t1']!;
    assert.equal(t1.status, 'in-review');
    assert.equal(t1.artifact?.conclusion, 'r');
    assert.equal(t1.artifact?.tokens, 5);
    assert.equal(finishes.length, 1, '台账 finish 恰一次');
    assert.equal(finishes[0]![0], 'fx1');
    assert.equal(finishes[0]![1], 'done');
    const st = events.find((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.status === 'in-review');
    assert.ok(st, 'task-status-changed(in-review) 已发');
    // 卫生:放行悬置 runner,drain 收口(迟到的二次回写不改已断言终局)
    release();
    await drain();
    assert.equal(board.snapshot().tasks['t1']!.status, 'in-review');

    // 无 ledgerId 路径:状态照回写,台账收口跳过(独立小板,悬置 runner 同法)
    const finishes2: unknown[][] = [];
    let release2: () => void = () => {};
    const hang2 = new Promise<void>((res) => { release2 = res; });
    const board2 = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'aux')),
      runner: {
        runSubagent: async () => {
          await hang2;
          return { ok: true as const, value: { reply: 'late', tokens: 1 } };
        },
      } as unknown as SubagentRunner,
      registry: {
        submit: () => ({ id: 'ax1', stop: () => {} }),
        append: () => {},
        finish: (...args: unknown[]) => { finishes2.push(args); },
      } as unknown as TaskRegistry,
      onEvent: () => {},
    });
    board2.init();
    assert.ok(board2.create({ title: 'B', spec: 'b' }).ok);
    await drain();
    assert.equal(board2.snapshot().tasks['t1']!.status, 'claimed');
    board2.finishExecution('t1', { ok: true, reply: 'r2', tokens: 2 });
    assert.equal(board2.snapshot().tasks['t1']!.status, 'in-review', '无台账路径仍回写状态');
    assert.equal(finishes2.length, 0, '无 ledgerId 跳过 registry.finish');
    release2();
    await drain();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('init 惰性建档:空板零物化 team 目录,首写才建(events.jsonl+board.json)', async () => {
  const tmp = tmpdir('sunshinex-tb-board5-');
  try {
    const h = makeBoard(tmp);
    const teamDir = path.join(tmp, 'teams', 'main');
    assert.equal(fs.existsSync(teamDir), false, '空板 init 不物化 teams 目录(Ruling 2)');
    const r = h.board.create({ title: 'A', spec: 'a' });
    assert.ok(r.ok);
    await drain();
    assert.ok(fs.existsSync(path.join(teamDir, 'events.jsonl')), '首写后事件文件已建');
    assert.ok(fs.existsSync(path.join(teamDir, 'board.json')), '首写后快照已建');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('持久化往返:重启 init 恢复板,claimed 无终态回池(自愈事件)', async () => {
  const tmp = tmpdir('sunshinex-tb-board4-');
  try {
    const h1 = makeBoard(tmp);
    h1.board.create({ title: 'A', spec: 'do A' });
    await drain();
    assert.equal(h1.board.snapshot().tasks['t1']!.status, 'in-review');
    // 新协调器同目录:load 恢复(此处无 claimed;另测 claimed 回池走 board 内部——直接构造事件)
    const store2 = new TeamStore(path.join(tmp, 'teams', 'main'));
    store2.append({ t: 'task-created', taskId: 't9', title: 'X', spec: 'x', dependsOn: [], ts: 1 });
    store2.append({ t: 'status-changed', taskId: 't9', from: 'pending', to: 'claimed', ts: 2 });
    const events2: SessionEvent[] = [];
    const board2 = new TaskBoard({
      store: store2,
      runner: { runSubagent: async () => ({ ok: true as const, value: { reply: 'r', tokens: 1 } }) } as unknown as SubagentRunner,
      registry: { submit: () => ({ id: 'b2', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry,
      onEvent: (e) => events2.push(e),
    });
    board2.init();
    const s = board2.snapshot();
    assert.equal(s.tasks['t9']!.status, 'pending', 'claimed 回池(§7.4)');
    assert.equal(s.tasks['t1']!.status, 'in-review', '前板的 in-review 存续');
    // 自愈事件已入流:再次裸 load(不 init)重放后 t9 应仍 pending(事件流自洽)
    const raw = fs.readFileSync(path.join(tmp, 'teams', 'main', 'events.jsonl'), 'utf8');
    assert.ok(raw.includes('"note":"recovered after restart"'), '回池以事件落盘');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('teamTokenCapEnv:未设/空=undefined,合法正整数生效,非法 fail-fast 带槽名(T4)', () => {
  assert.equal(teamTokenCapEnv({}), undefined);
  assert.equal(teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '' }), undefined);
  assert.equal(teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '  ' }), undefined);
  assert.equal(teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '1000000' }), 1_000_000);
  assert.throws(() => teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '-5' }), /SUNSHINEX_TEAM_TOKEN_CAP/);
  assert.throws(() => teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '0' }), /SUNSHINEX_TEAM_TOKEN_CAP/);
  assert.throws(() => teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: '2.5' }), /SUNSHINEX_TEAM_TOKEN_CAP/);
  assert.throws(() => teamTokenCapEnv({ SUNSHINEX_TEAM_TOKEN_CAP: 'abc' }), /SUNSHINEX_TEAM_TOKEN_CAP/);
});

test('team 预算帽:drain 前置检查超帽留 pending 不失败,摘要透出用量,kick 重入仍不派发(T4)', async () => {
  const tmp = tmpdir('sunshinex-tb-teamcap-');
  try {
    // fake runner 每任务 tokens 10,帽 15:t1(10<15)→ t2(20≥15)→ t3 留 pending
    const h = makeBoard(tmp, { teamTokenCap: 15 });
    h.board.create({ title: 'A', spec: 'a' }); // t1
    await drain();
    assert.equal(h.board.snapshot().tasks['t1']!.status, 'in-review');
    assert.ok(h.board.summaryLines().includes('team budget 10/15 tokens'), `未达帽透出用量:${JSON.stringify(h.board.summaryLines())}`);
    h.board.create({ title: 'B', spec: 'b' }); // t2:used 10 < 15 → 派发
    await drain();
    assert.equal(h.board.snapshot().tasks['t2']!.status, 'in-review');
    h.board.create({ title: 'C', spec: 'c' }); // t3:used 20 ≥ 15 → 不派发
    await drain();
    const s = h.board.snapshot();
    assert.equal(s.tasks['t3']!.status, 'pending', '超帽留 pending 不失败(spec §5.6)');
    assert.deepEqual(h.calls, ['Task t1: A', 'Task t2: B'], '恰两任务执行,第三个零派发');
    const lines = h.board.summaryLines();
    assert.ok(lines.includes('team budget exhausted (20/15) tokens'), `达帽尾行:${JSON.stringify(lines)}`);
    assert.ok(!h.events.some((e) => e.type === 'task-blocked'), '超帽不是失败:不发 task-blocked');
    // 帽耗尽 one-shot notice(终审 Item 3):首个帽 break 恰发一次——既有 notice 事件型,text 载荷与
    // summaryLines 尾行同口径,payload 带 source/used/cap;TUI 渲染 system 行零新增协议词汇
    const notices = h.events.filter((e) => e.type === 'notice');
    assert.equal(notices.length, 1, `帽 break 时 notice 恰一次(实际 ${notices.length})`);
    assert.equal(
      notices[0]!.text,
      'team budget exhausted (20/15) tokens — new tasks stay pending until the cap is lifted',
      'notice 文案与摘要尾行同口径',
    );
    assert.deepEqual(notices[0]!.payload, { source: 'taskboard', used: 20, cap: 15 }, 'payload 带 source/used/cap');
    // 帽持续:review 关单 kick 与新 create kick 均重入 drain 但仍被前置检查拦下(notice 不重发)
    await h.board.review('t1', { approved: true });
    await drain();
    assert.equal(h.board.snapshot().tasks['t3']!.status, 'pending', 'review kick 后仍不派发(帽未拆)');
    h.board.create({ title: 'D', spec: 'd' }); // t4
    await drain();
    const s2 = h.board.snapshot();
    assert.equal(s2.tasks['t3']!.status, 'pending');
    assert.equal(s2.tasks['t4']!.status, 'pending', 'create kick 后仍不派发');
    assert.equal(h.events.filter((e) => e.type === 'notice').length, 1, 'kick 重入不重发(one-shot)');

    // 跨重启重放恢复:新协调器同 store 载入,teamTokensUsed 经 artifact.tokens 求和回 20——
    // 若不重放(计数清零),used=0 < 15 会误派发;断言新任务仍被拦
    const board2 = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      runner: {
        runSubagent: async (_i: unknown, o?: { taskLine?: string }) => ({ ok: true as const, value: { reply: `r2 ${o?.taskLine ?? ''}`, tokens: 10 } }),
      } as unknown as SubagentRunner,
      registry: { submit: () => ({ id: 'r2', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry,
      onEvent: () => {},
      teamTokenCap: 15,
    });
    board2.init();
    board2.create({ title: 'E', spec: 'e' }); // t5
    await drain();
    const s3 = board2.snapshot();
    assert.equal(s3.tasks['t5']!.status, 'pending', '重启后帽用量经 artifact.tokens 重放恢复,新任务仍不派发');
    assert.equal(s3.tasks['t3']!.status, 'pending', '存续 pending 任务保持');
    assert.ok(board2.summaryLines().includes('team budget exhausted (20/15) tokens'), `重启后摘要仍透出重放用量:${JSON.stringify(board2.summaryLines())}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('team 预算帽:超帽 claim 前置返回 undefined,teammate 空手而归任务留 pending(T4)', async () => {
  const tmp = tmpdir('sunshinex-tb-teamcap-claim-');
  try {
    // 帽 15 / 每任务 10:t1、t2 执行后 used=20 达帽;t3 留 pending,claim 不得放行
    const h = makeBoard(tmp, { teamTokenCap: 15 });
    h.board.create({ title: 'A', spec: 'a' });
    await drain();
    h.board.create({ title: 'B', spec: 'b' });
    await drain();
    h.board.create({ title: 'C', spec: 'c' }); // 超帽:drain 不派发
    await drain();
    assert.equal(h.board.snapshot().tasks['t3']!.status, 'pending');
    const claimed = h.board.claim('w1');
    assert.equal(claimed, undefined, '超帽 claim 返回 undefined(teammate 空手而归)');
    assert.equal(h.board.snapshot().tasks['t3']!.status, 'pending', 'claim 拦下后任务仍 pending,零执行');
    assert.ok(!h.events.some((e) => e.type === 'task-status-changed' && (e.payload as Record<string, unknown>)?.taskId === 't3' && (e.payload as Record<string, unknown>)?.status === 'claimed'), 't3 无 claimed 事件');
    assert.deepEqual(h.calls, ['Task t1: A', 'Task t2: B'], '执行数不变(帽前两批)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settle:快 runner 任务完成后早退——快照全终态,不耗满超时(P2/T6)', async () => {
  const tmp = tmpdir('sunshinex-tb-settle-fast-');
  try {
    const h = makeBoard(tmp);
    assert.ok(h.board.create({ title: 'A', spec: 'a' }).ok);
    const t0 = Date.now();
    const st = await h.board.settle(1000);
    const waited = Date.now() - t0;
    assert.equal(st.tasks['t1']!.status, 'in-review', '快 runner:claim→执行→回写后 settle 收敛早退');
    assert.ok(Object.values(st.tasks).every((t) => t.status !== 'pending' && t.status !== 'claimed'), '快照全终态');
    assert.ok(waited < 1000, `早退不耗满超时(实际 ${waited}ms < 1000ms)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settle:慢 runner 超时返回当前态——claimed 悬置不判失败(P2/T6)', async () => {
  const tmp = tmpdir('sunshinex-tb-settle-slow-');
  try {
    let release: () => void = () => {};
    const hang = new Promise<void>((res) => { release = res; });
    const board = new TaskBoard({
      store: new TeamStore(path.join(tmp, 'teams', 'main')),
      // 假 runner 悬置不回:任务停在 claimed,settle 超时应返回该当前态
      runner: {
        runSubagent: async () => {
          await hang;
          return { ok: true as const, value: { reply: 'late', tokens: 1 } };
        },
      } as unknown as SubagentRunner,
      registry: { submit: () => ({ id: 'sx1', stop: () => {} }), append: () => {}, finish: () => {}, list: () => [], get: () => undefined } as unknown as TaskRegistry,
      onEvent: () => {},
      now: (() => { let n = 1000; return () => ++n; })(),
    });
    board.init();
    assert.ok(board.create({ title: 'S', spec: 's' }).ok);
    const st = await board.settle(150);
    assert.equal(st.tasks['t1']!.status, 'claimed', '超时返回当前态(claimed 悬置,不虚构终态)');
    // 卫生:放行悬置 runner,drain 收口
    release();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(board.snapshot().tasks['t1']!.status, 'in-review');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
