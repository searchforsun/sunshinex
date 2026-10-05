// P2 e2e 验收(spec 2026-10-04 多Agent编排 §5/§8/§13):三条用例零产品码——
// ① spec 验收:真 Harness(计数 fake 模型,三 teammate 共享)spawn×3(mode team)→ 7 任务
//   (t2/t3 依赖 t1)→ 直接轮询快照驱动(裁定:不经模型 task_wait,60s 上限 200ms 步;至 in-review
//   即 review(approved) 解锁下游)→ 全 done;delegation-started ×7 label 齐;按 payload.subagent
//   分组三 teammate 分担(三组非空,并集覆盖 7 任务,均分不强求);t2/t3 started 晚于 t1 ended(依赖序)。
// ② team 帽排队复证(T4 语义,裁定:不经 Harness 直构 TaskBoard——fake 模型无 usage 事件时 Reactor
//   done 路径 tokensUsed=0,经 Harness 帽永不触发):fake runner 每任务 tokens 10 + teamTokenCap 15
//   → 3 任务恰 2 执行 1 pending + summaryLines 含 exhausted;真 Teammate 注入后 kick,claim 前置
//   拦下空手而归(在场也不抢)。
// ③ 外部同现(spec §8「与内部无感同现」):真 TaskBoard + stub externalExecutor + 真 Teammate,
//   executorHint 'external-cli' 任务与普通 teammate 任务并行 create——delegation kind 'external-cli'
//   vs 'subagent' 两事件流共存一收集器,external 终态 in-review。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { TaskBoard } from '../taskboard/board';
import { TeamRegistry, Teammate } from '../taskboard/teammate';
import { TeamStore } from '../taskboard/store';
import type { BoardTask } from '../taskboard/model';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { ToolRegistry } from './tools';
import { FileStore } from '../storage/adapter';
import type { SubagentRunner } from './subagent';
import type { TaskRegistry } from './tasks';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult, SessionEvent } from '../types';
import type { ExternalExecutorLike } from '../taskboard/executors/external-cli';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 自增计数 fake ModelAdapter:每 chat() 一轮 stop 收束(done),reply `ok <n>`——计数跨 teammate 共享,
 * chat() 体内自增原子(JS 单线程),任务卡片消费天然串行 */
class CountingAdapter implements ModelAdapter {
  readonly provider = 'counting';
  n = 0;
  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.n += 1;
    return { finish: 'stop', content: `ok ${this.n}`, toolCalls: [] };
  }
}

/** 轮询等待谓词成立(缺省 60s 上限 200ms 步——task-8 裁定的快照驱动节拍) */
async function until(pred: () => boolean, ms = 60_000, step = 200): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

const drain = () => new Promise((r) => setImmediate(r));

const p = (e: SessionEvent): Record<string, unknown> => e.payload ?? {};

interface BoardRig {
  board: TaskBoard;
  team: TeamRegistry;
  events: SessionEvent[];
  forkCalls: string[];
  makeTeammate: (name: string) => Teammate;
}

/** 直构 TaskBoard 装配(用例②③):fake fork runner(tokens 10)+ fake 台账 + 真 TeamRegistry,
 * 可选 teamTokenCap / externalExecutor 注入;真 Teammate(计数 fake 模型)工厂同 teammate.test.ts 口径 */
function makeBoardRig(tmp: string, opts?: { teamTokenCap?: number; externalExecutor?: ExternalExecutorLike }): BoardRig {
  const events: SessionEvent[] = [];
  const forkCalls: string[] = [];
  const runner = {
    runSubagent: async (_input: unknown, o?: { taskLine?: string }) => {
      const line = o?.taskLine ?? '';
      forkCalls.push(line);
      return { ok: true as const, value: { reply: `fork ${line}`, tokens: 10 } };
    },
  } as unknown as SubagentRunner;
  const registry = { submit: () => ({ id: 'b1', stop: () => {} }), append: () => {}, finish: () => {}, list: () => [], get: () => undefined } as unknown as TaskRegistry;
  const team = new TeamRegistry();
  const board = new TaskBoard({
    store: new TeamStore(path.join(tmp, 'teams', 'main')),
    runner,
    registry,
    team,
    onEvent: (e) => events.push(e),
    now: (() => { let n = 1000; return () => ++n; })(),
    ...(opts?.teamTokenCap !== undefined ? { teamTokenCap: opts.teamTokenCap } : {}),
    ...(opts?.externalExecutor !== undefined ? { externalExecutor: opts.externalExecutor } : {}),
  });
  board.init();
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), tmp);
  const tools = new ToolRegistry();
  const makeTeammate = (name: string): Teammate =>
    new Teammate({
      name,
      framing: `framing of ${name}`,
      deps: {
        safety,
        model: new CountingAdapter(),
        registry: tools,
        root: tmp,
        store: new FileStore(path.join(tmp, 'ctx', name)),
        board,
        onEvent: (e: SessionEvent) => events.push(e),
      },
    });
  return { board, team, events, forkCalls, makeTeammate };
}

test('e2e spec 验收:3 teammate 消化 7 任务——claim 分担/依赖序/review 闭环全 done', async () => {
  const tmp = tmpdir('sunshinex-team-e2e-1-');
  let h: Harness | undefined;
  const events: SessionEvent[] = [];
  try {
    const model = new CountingAdapter();
    h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false, onEvent: (e) => events.push(e) });
    // spawn×3(mode 'team',label w1/w2/w3)——经真 spawn 工具执行面(与模型出牌同一条链)
    for (const w of ['w1', 'w2', 'w3']) {
      const r = await h.tools.execute('spawn', { prompt: `worker ${w}: claim board tasks and finish each`, label: w, mode: 'team' }, h.safety);
      assert.ok(r.ok && r.value.exitCode === 0, `spawn ${w} 应成功:${JSON.stringify(r)}`);
      assert.ok(r.value.stdout.includes(`teammate ${w} started`), `spawn 回执应含 teammate ${w} started`);
    }
    assert.deepEqual([...h.team.aliveNames()].sort(), ['w1', 'w2', 'w3'], '三 teammate 全活');
    // 7 任务:t2/t3 依赖 t1,其余独立;t7 不设 executorHint(内部一致)
    const specs: { title: string; spec: string; dependsOn?: string[] }[] = [
      { title: 'T1', spec: 'do 1' },
      { title: 'T2', spec: 'do 2', dependsOn: ['t1'] },
      { title: 'T3', spec: 'do 3', dependsOn: ['t1'] },
      { title: 'T4', spec: 'do 4' },
      { title: 'T5', spec: 'do 5' },
      { title: 'T6', spec: 'do 6' },
      { title: 'T7', spec: 'do 7' },
    ];
    for (const s of specs) {
      const r = h.taskboard.create(s);
      assert.ok(r.ok, `create ${s.title} 应成功`);
    }
    // 快照轮询驱动(裁定):至 in-review 即 review(approved)——t1 关单 done 后 t2/t3 才解锁派发
    const deadline = Date.now() + 60_000;
    const reviewed = new Set<string>();
    for (;;) {
      const tasks: BoardTask[] = Object.values(h.taskboard.snapshot().tasks);
      assert.equal(tasks.length, 7);
      for (const t of tasks) {
        if (t.status === 'in-review' && !reviewed.has(t.id)) {
          const r = await h.taskboard.review(t.id, { approved: true });
          assert.ok(r.ok, `review(${t.id}, approved) 应成功:${JSON.stringify(r)}`);
          reviewed.add(t.id);
        }
      }
      if (tasks.every((t) => t.status === 'done')) break;
      if (Date.now() > deadline) {
        assert.fail(`60s 内未收敛全 done:${tasks.map((t) => `${t.id}=${t.status}`).join(',')}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(reviewed.size, 7, '恰 review×7(approved)');
    const final = h.taskboard.snapshot().tasks;
    for (let i = 1; i <= 7; i++) assert.equal(final[`t${i}`]!.status, 'done', `t${i} 应 done`);
    // delegation-started ×7 且 label 集恰 task-t1..t7(kind 'subagent'——全内部 teammate 路径)
    const started = events.filter((e) => e.type === 'delegation-started' && p(e).kind === 'subagent');
    assert.equal(started.length, 7, 'delegation-started 恰 7 条');
    assert.deepEqual([...new Set(started.map((e) => p(e).label))].sort(), ['task-t1', 'task-t2', 'task-t3', 'task-t4', 'task-t5', 'task-t6', 'task-t7']);
    // 三 teammate 分担归属:delegation-started(task-tN) 后首个带 payload.subagent 的转录事件 = 执行者
    // (execute() 内 started 发射后 reactor.run 同步走到首个 await——首标事件必属本任务,并发交错不串组)
    const ownerOf = new Map<string, string>();
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.type !== 'delegation-started' || p(e).kind !== 'subagent') continue;
      const id = p(e).delegationId as string;
      for (let j = i + 1; j < events.length; j++) {
        const sub = p(events[j]!).subagent;
        if (typeof sub === 'string') {
          ownerOf.set(id, sub);
          break;
        }
      }
    }
    assert.equal(ownerOf.size, 7, '7 任务全部归属到执行 teammate');
    for (const w of ['w1', 'w2', 'w3']) {
      const owned = [...ownerOf.entries()].filter(([, name]) => name === w).map(([id]) => id);
      assert.ok(owned.length >= 1, `${w} 应分担至少 1 任务(实际归属:${JSON.stringify([...ownerOf])})`);
      assert.ok(owned.every((id) => /^task-t[1-7]$/.test(id)), `${w} 名下应只有板上任务`);
    }
    assert.ok([...ownerOf.values()].every((name) => name === 'w1' || name === 'w2' || name === 'w3'), '归属者必为三 teammate');
    // 依赖序:t2/t3 的 delegation-started 晚于 t1 的 delegation-ended(t1 须先经 review 关单 done 才解锁)
    const idxOf = (pred: (e: SessionEvent) => boolean): number => events.findIndex(pred);
    const t1Ended = idxOf((e) => e.type === 'delegation-ended' && p(e).delegationId === 'task-t1');
    const t2Started = idxOf((e) => e.type === 'delegation-started' && p(e).delegationId === 'task-t2');
    const t3Started = idxOf((e) => e.type === 'delegation-started' && p(e).delegationId === 'task-t3');
    assert.ok(t1Ended >= 0, 't1 应有 delegation-ended');
    assert.ok(t2Started > t1Ended && t3Started > t1Ended, `t2/t3 派发晚于 t1 终态(${t1Ended} < ${t2Started}/${t3Started})`);
    // 委派收口:7 条 delegation-ended 全 done
    const ended = events.filter((e) => e.type === 'delegation-ended' && p(e).kind === 'subagent');
    assert.equal(ended.length, 7);
    for (const e of ended) assert.equal(p(e).status, 'done');
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('e2e team 帽排队复证:cap 15 × 每任务 10 tokens——恰 2 执行 1 pending,exhausted 透出;真 teammate 在场不抢(claim 前置)', async () => {
  const tmp = tmpdir('sunshinex-team-e2e-2-');
  let rig: BoardRig | undefined;
  try {
    rig = makeBoardRig(tmp, { teamTokenCap: 15 });
    // fake runner 每任务 tokens 10,帽 15:t1(10<15)→ t2(20≥15)执行,t3 留 pending(T4 语义复证)
    assert.ok(rig.board.create({ title: 'A', spec: 'a' }).ok);
    const a1 = await until(() => rig!.board.snapshot().tasks['t1']?.status === 'in-review', 5_000, 50);
    assert.ok(a1, 't1 应执行回写 in-review');
    assert.ok(rig.board.summaryLines().includes('team budget 10/15 tokens'), `未达帽透出用量:${JSON.stringify(rig.board.summaryLines())}`);
    assert.ok(rig.board.create({ title: 'B', spec: 'b' }).ok);
    const a2 = await until(() => rig!.board.snapshot().tasks['t2']?.status === 'in-review', 5_000, 50);
    assert.ok(a2, 't2 应执行回写 in-review');
    assert.ok(rig.board.create({ title: 'C', spec: 'c' }).ok); // used 20 ≥ 15 → 不派发
    await drain();
    const s = rig.board.snapshot();
    assert.equal(s.tasks['t3']!.status, 'pending', '超帽留 pending 不失败(spec §5.6)');
    assert.deepEqual(rig.forkCalls, ['Task t1: A', 'Task t2: B'], '恰两任务执行');
    assert.ok(rig.board.summaryLines().includes('team budget exhausted (20/15) tokens'), `达帽尾行:${JSON.stringify(rig.board.summaryLines())}`);
    assert.ok(!rig.events.some((e) => e.type === 'task-blocked'), '超帽不是失败:不发 task-blocked');
    // 真 Teammate 注入(同一 team 注册表):kick 起 claim 循环——claim 前置(20≥15)空手而归,t3 不被抢
    const tm = rig.makeTeammate('w-cap');
    assert.ok(rig.team.register(tm).ok, 'teammate 注册应成功');
    assert.equal(rig.team.hasAlive(), true, 'teammate 在场(活)');
    tm.kick();
    await drain();
    await drain();
    assert.equal(tm.isBusy(), false, 'claim 空手而归:不进执行');
    const s2 = rig.board.snapshot();
    assert.equal(s2.tasks['t3']!.status, 'pending', 'teammate 在场也不抢:claim 前置拦下');
    assert.ok(
      !rig.events.some((e) => e.type === 'task-status-changed' && p(e).taskId === 't3' && p(e).status === 'claimed'),
      't3 无 claimed 事件',
    );
    assert.deepEqual(rig.forkCalls, ['Task t1: A', 'Task t2: B'], '执行数不变(帽前两批)');
    assert.ok(rig.board.summaryLines().includes('team budget exhausted (20/15) tokens'), '帽持续透出');
  } finally {
    rig?.team.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('e2e 外部同现:external-cli 任务与 teammate 任务并行——kind external-cli / subagent 两事件流共存一收集器', async () => {
  const tmp = tmpdir('sunshinex-team-e2e-3-');
  let rig: BoardRig | undefined;
  try {
    const externalCalls: string[] = [];
    const externalExecutor: ExternalExecutorLike = {
      run: async (task) => {
        externalCalls.push(task.id);
        return { ok: true, reply: `external ${task.id} conclusion`, tokens: 3 };
      },
    };
    rig = makeBoardRig(tmp, { externalExecutor });
    // 真 teammate 在场(注册即 kick,空板自然收兵):普通任务(无 executorHint)由其 claim 消化
    const tm = rig.makeTeammate('w-ext');
    assert.ok(rig.team.register(tm).ok);
    tm.kick();
    // 并行 create:external-cli 任务 + 普通 teammate 任务(spec §8「与内部无感同现」)
    const e1 = rig.board.create({ title: 'EXT', spec: 'external work via cli', executor: 'external-cli' });
    const i1 = rig.board.create({ title: 'INT', spec: 'internal work via teammate' });
    assert.ok(e1.ok && i1.ok, '两任务创建应成功');
    const done = await until(() => {
      const s = rig!.board.snapshot();
      return s.tasks['t1']?.status === 'in-review' && s.tasks['t2']?.status === 'in-review';
    }, 5_000, 50);
    assert.ok(done, '两任务均达 in-review');
    // external 执行体恰被 external 任务触达(executorHint 路由接管,teammate/fork 不碰)
    assert.deepEqual(externalCalls, ['t1'], 'external executor 恰执行 t1');
    assert.deepEqual(rig.forkCalls, [], 'fork 路径零调用(有活 teammate)')
    // delegation 口径:external 任务 kind 'external-cli',teammate 任务 kind 'subagent',共存一 events 收集器
    const extStarted = rig.events.find((e) => e.type === 'delegation-started' && p(e).delegationId === 'task-t1');
    const intStarted = rig.events.find((e) => e.type === 'delegation-started' && p(e).delegationId === 'task-t2');
    assert.ok(extStarted && intStarted, '两条 delegation-started 共存一收集器');
    assert.equal(p(extStarted!).kind, 'external-cli');
    assert.equal(p(extStarted!).label, 'task-t1');
    assert.equal(p(intStarted!).kind, 'subagent');
    assert.equal(p(intStarted!).label, 'task-t2');
    const extEnded = rig.events.find((e) => e.type === 'delegation-ended' && p(e).delegationId === 'task-t1');
    assert.ok(extEnded, 'external delegation-ended 在场');
    assert.equal(p(extEnded!).kind, 'external-cli');
    assert.equal(p(extEnded!).status, 'done');
    // 终态:external 任务 in-review(结论经 finishExecution 强制回写),teammate 任务同归 in-review
    const s = rig.board.snapshot();
    assert.equal(s.tasks['t1']!.status, 'in-review');
    assert.equal(s.tasks['t2']!.status, 'in-review');
    assert.equal(s.tasks['t1']!.artifact?.conclusion, 'external t1 conclusion', 'external 结论经强制回写并入 artifact');
    // teammate 转录事件打标(payload.subagent)与 external 生命周期事件同流共存
    assert.ok(rig.events.some((e) => typeof p(e).subagent === 'string' && p(e).subagent === 'w-ext'), 'teammate 转录标在场');
  } finally {
    rig?.team.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
