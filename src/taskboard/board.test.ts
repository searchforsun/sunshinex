import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import { SessionEvent } from '../types';
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

function makeBoard(tmp: string, opts?: { failReplies?: string[] }): Harness {
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
    });
    board.init();
    const r = board.create({ title: 'A', spec: 'a' });
    assert.ok(r.ok);
    await drain();
    await drain(); // 回池重派第二轮(allSettled 后 drain 重取)
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
