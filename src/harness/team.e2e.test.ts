// P2 e2e 验收(spec 2026-10-04 多Agent编排 §5/§8/§13):三条用例零产品码——
// ① spec 验收:真 Harness(计数 fake 模型,三 teammate 共享)spawn×3(mode team)→ 7 任务
//   (t2/t3 依赖 t1)→ 直接轮询快照驱动(裁定:不经模型 task_wait,60s 上限 200ms 步)→ 全 success;
//   delegation-started ×7 label 齐;按 payload.subagent
//   分组三 teammate 分担(三组非空,并集覆盖 7 任务,均分不强求);t2/t3 started 晚于 t1 ended(依赖序)。
// ② team 帽排队复证(T4 语义,裁定:不经 Harness 直构 TaskBoard——fake 模型无 usage 事件时 Reactor
//   done 路径 tokensUsed=0,经 Harness 帽永不触发):fake runner 每任务 tokens 10 + teamTokenCap 15
//   → 3 任务恰 2 执行 1 pending + summaryLines 含 exhausted;真 Teammate 注入后 kick,claim 前置
//   拦下空手而归(在场也不抢)。
// ③ 外部同现(spec §8「与内部无感同现」):真 TaskBoard + stub externalExecutor + 真 Teammate,
//   executorHint 'external-cli' 任务与普通 teammate 任务并行 create——delegation kind 'external-cli'
//   vs 'subagent' 两事件流共存一收集器,两任务终态 success。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { TaskBoard } from '../taskboard/board';
import { TeamRegistry, Teammate } from '../taskboard/teammate';
import { TeamStore } from '../taskboard/store';
import { AgentTeamRegistry, MemoryAgentTeamStore } from '../taskboard/team-registry';
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

// env scrub(终审 Item 1):用例①装配真 Harness,team 帽经 SUNSHINEX_TEAM_TOKEN_CAP 进环境即生效——
// 开发机若设此变量,7 任务会在两笔回写后被帽拦下,pending 悬置假失败。beforeEach 删、afterEach 恢复
// 原值(记录在场与否:在场回填原值,不在场维持删除),测试对宿主环境零耦合
const ENV_CAP = 'SUNSHINEX_TEAM_TOKEN_CAP';
let envCapSaved: { present: boolean; value?: string } = { present: false };
beforeEach(() => {
  envCapSaved = { present: ENV_CAP in process.env, value: process.env[ENV_CAP] };
  delete process.env[ENV_CAP];
});
afterEach(() => {
  if (envCapSaved.present) process.env[ENV_CAP] = envCapSaved.value;
  else delete process.env[ENV_CAP];
});

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
  teamId: string;
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
  const agentTeams = new AgentTeamRegistry(new MemoryAgentTeamStore());
  const createdTeam = agentTeams.create('alpha');
  if (!createdTeam.ok) throw new Error(createdTeam.error.message);
  const teamId = createdTeam.value.teamId;
  const board = new TaskBoard({
    store: new TeamStore(path.join(tmp, 'teams', 'main')),
    runner,
    registry,
    team,
    agentTeams,
    onEvent: (e) => events.push(e),
    now: (() => { let n = 1000; return () => ++n; })(),
    ...(opts?.teamTokenCap !== undefined ? { teamTokenCap: opts.teamTokenCap } : {}),
    ...(opts?.externalExecutor !== undefined ? { externalExecutor: opts.externalExecutor } : {}),
  });
  board.init();
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), tmp);
  const tools = new ToolRegistry();
  const makeTeammate = (name: string): Teammate =>
    new Teammate({
      name,
      framing: `framing of ${name}`,
      teamId,
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
  return { board, team, teamId, events, forkCalls, makeTeammate };
}

test('e2e spec 验收:3 teammate 消化 7 任务——claim 分担/依赖序/全 success', async () => {
  const tmp = tmpdir('sunshinex-team-e2e-1-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  let h: Harness | undefined;
  const events: SessionEvent[] = [];
  try {
    const model = new CountingAdapter();
    h = new Harness({ root: tmp, mode: 'full-access', model, learnSkills: false, onEvent: (e) => events.push(e) });
    const team = h.agentTeams.create('alpha');
    assert.ok(team.ok, `create team 应成功:${team.ok ? '' : team.error.message}`);
    const teamId = team.value.teamId;
    for (const w of ['w1', 'w2', 'w3']) {
      const r = await h.tools.execute('create_teammate', { teamId, name: w, prompt: `worker ${w}: claim board tasks and finish each` }, h.safety);
      assert.ok(r.ok && r.value.exitCode === 0, `spawn ${w} 应成功:${JSON.stringify(r)}`);
      assert.ok(r.value.stdout.includes(`teammate ${w} started`), `spawn 回执应含 teammate ${w} started`);
    }
    assert.deepEqual([...h.team.aliveNames()].sort(), ['w1', 'w2', 'w3'], '三 teammate 全活');
    // 7 任务:T2/T3 依赖 T1(板 id 不透明方言:T1 先建取 id,再装配依赖;捕获 id 供后续断言)
    const idByTitle = new Map<string, string>();
    const first = h.taskboard.create({ teamId, title: 'T1', spec: 'do 1' });
    assert.ok(first.ok, 'create T1 应成功');
    idByTitle.set('T1', first.value.taskId);
    const specs: { title: string; spec: string; dependsOn?: string[] }[] = [
      { title: 'T2', spec: 'do 2', dependsOn: [idByTitle.get('T1')!] },
      { title: 'T3', spec: 'do 3', dependsOn: [idByTitle.get('T1')!] },
      { title: 'T4', spec: 'do 4' },
      { title: 'T5', spec: 'do 5' },
      { title: 'T6', spec: 'do 6' },
      { title: 'T7', spec: 'do 7' },
    ];
    for (const s of specs) {
      const r = h.taskboard.create({ teamId, ...s });
      assert.ok(r.ok, `create ${s.title} 应成功`);
      idByTitle.set(s.title, r.value.taskId);
    }
    const converged = await until(() => {
      const tasks: BoardTask[] = Object.values(h!.taskboard.snapshot().tasks);
      return tasks.length === 7 && tasks.every((t) => t.status === 'success');
    });
    if (!converged) {
      const tasks: BoardTask[] = Object.values(h.taskboard.snapshot().tasks);
      assert.fail(`60s 内未收敛全 success:${tasks.map((t) => `${t.id}=${t.status}`).join(',')}`);
    }
    const final = h.taskboard.snapshot().tasks;
    assert.equal(final[idByTitle.get('T1')!]!.status, 'success', 'T1 应 success');
    for (const s of specs) assert.equal(final[idByTitle.get(s.title)!]!.status, 'success', `${s.title} 应 success`);
    // delegation-started ×7:delegationId 集 = dispatchTag(板 id) 集(新方言=板 id 本形);label = teammate 名(UI 执行体视角行名)
    const started = events.filter((e) => e.type === 'delegation-started' && p(e).kind === 'subagent');
    assert.equal(started.length, 7, 'delegation-started 恰 7 条');
    assert.deepEqual([...new Set(started.map((e) => p(e).delegationId))].sort(), [...idByTitle.values()].sort());
    assert.deepEqual([...new Set(started.map((e) => p(e).label))].sort(), ['w1', 'w2', 'w3'], 'label 集 = 三 teammate 名');
    // 每条委派带当前任务标题(Ctrl+B/面板「名 · 任务」后缀数据源)
    assert.ok(started.every((e) => typeof p(e).title === 'string' && (p(e).title as string).length > 0), 'delegation-started 带 title');
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
    const boardIds = new Set(idByTitle.values());
    for (const w of ['w1', 'w2', 'w3']) {
      const owned = [...ownerOf.entries()].filter(([, name]) => name === w).map(([id]) => id);
      assert.ok(owned.length >= 1, `${w} 应分担至少 1 任务(实际归属:${JSON.stringify([...ownerOf])})`);
      assert.ok(owned.every((id) => boardIds.has(id)), `${w} 名下应只有板上任务`);
    }
    assert.ok([...ownerOf.values()].every((name) => name === 'w1' || name === 'w2' || name === 'w3'), '归属者必为三 teammate');
    // 依赖序:T2/T3 的 delegation-started 晚于 T1 落 success(success 解锁下游;委派收口事件在其后发出)
    const idxOf = (pred: (e: SessionEvent) => boolean): number => events.findIndex(pred);
    const t1Success = idxOf((e) => e.type === 'task-status-changed' && p(e).taskId === idByTitle.get('T1') && p(e).status === 'success');
    const t2Started = idxOf((e) => e.type === 'delegation-started' && p(e).delegationId === idByTitle.get('T2'));
    const t3Started = idxOf((e) => e.type === 'delegation-started' && p(e).delegationId === idByTitle.get('T3'));
    assert.ok(t1Success >= 0, 'T1 应有 success 回写');
    assert.ok(t2Started > t1Success && t3Started > t1Success, `T2/T3 派发晚于 T1 success(${t1Success} < ${t2Started}/${t3Started})`);
    // 委派收口:7 条 delegation-ended 全 done
    const ended = events.filter((e) => e.type === 'delegation-ended' && p(e).kind === 'subagent');
    assert.equal(ended.length, 7);
    for (const e of ended) assert.equal(p(e).status, 'done');
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('e2e team 帽排队复证:cap 15 × 每任务 10 tokens——恰 2 执行 1 pending,exhausted 透出;真 teammate 在场不抢(claim 前置)', async () => {
  const tmp = tmpdir('sunshinex-team-e2e-2-');
  let rig: BoardRig | undefined;
  try {
    rig = makeBoardRig(tmp, { teamTokenCap: 15 });
    // fake runner 每任务 tokens 10,帽 15:A(10<15)→ B(20≥15)执行,C 留 pending(T4 语义复证)
    const capA = rig.board.create({ teamId: rig.teamId, title: 'A', spec: 'a' });
    assert.ok(capA.ok);
    const idA = capA.value.taskId;
    const a1 = await until(() => rig!.board.snapshot().tasks[idA]?.status === 'success', 5_000, 50);
    assert.ok(a1, 'A 应执行回写 success');
    assert.ok(rig.board.summaryLines().includes('team budget 10/15 tokens'), `未达帽透出用量:${JSON.stringify(rig.board.summaryLines())}`);
    const capB = rig.board.create({ teamId: rig.teamId, title: 'B', spec: 'b' });
    assert.ok(capB.ok);
    const idB = capB.value.taskId;
    const a2 = await until(() => rig!.board.snapshot().tasks[idB]?.status === 'success', 5_000, 50);
    assert.ok(a2, 'B 应执行回写 success');
    const capC = rig.board.create({ teamId: rig.teamId, title: 'C', spec: 'c' }); // used 20 ≥ 15 → 不派发
    assert.ok(capC.ok);
    const idC = capC.value.taskId;
    await drain();
    const s = rig.board.snapshot();
    assert.equal(s.tasks[idC]!.status, 'pending', '超帽留 pending 不失败(spec §5.6)');
    assert.deepEqual(rig.forkCalls, [`Task ${idA}: A`, `Task ${idB}: B`], '恰两任务执行');
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
    assert.equal(s2.tasks[idC]!.status, 'pending', 'teammate 在场也不抢:claim 前置拦下');
    assert.ok(
      !rig.events.some((e) => e.type === 'task-status-changed' && p(e).taskId === idC),
      'C 留 pending：无状态迁移事件',
    );
    assert.deepEqual(rig.forkCalls, [`Task ${idA}: A`, `Task ${idB}: B`], '执行数不变(帽前两批)');
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
    const e1 = rig.board.create({ teamId: rig.teamId, title: 'EXT', spec: 'external work via cli', executor: 'external-cli' });
    const i1 = rig.board.create({ teamId: rig.teamId, title: 'INT', spec: 'internal work via teammate' });
    assert.ok(e1.ok && i1.ok, '两任务创建应成功');
    const extId = e1.value.taskId;
    const intId = i1.value.taskId;
    const done = await until(() => {
      const s = rig!.board.snapshot();
      return s.tasks[extId]?.status === 'success' && s.tasks[intId]?.status === 'success';
    }, 5_000, 50);
    assert.ok(done, '两任务均达 success');
    // external 执行体恰被 external 任务触达(executorHint 路由接管,teammate/fork 不碰)
    assert.deepEqual(externalCalls, [extId], 'external executor 恰执行 EXT');
    assert.deepEqual(rig.forkCalls, [], 'fork 路径零调用(有活 teammate)')
    // delegation 口径:external 任务 kind 'external-cli',teammate 任务 kind 'subagent',共存一 events 收集器
    const extStarted = rig.events.find((e) => e.type === 'delegation-started' && p(e).delegationId === extId);
    const intStarted = rig.events.find((e) => e.type === 'delegation-started' && p(e).delegationId === intId);
    assert.ok(extStarted && intStarted, '两条 delegation-started 共存一收集器');
    assert.equal(p(extStarted!).kind, 'external-cli');
    assert.equal(p(extStarted!).label, extId);
    assert.equal(p(intStarted!).kind, 'subagent');
    assert.equal(p(intStarted!).label, 'w-ext', 'teammate 委派 label = 名字(Ctrl+B 执行体视角)');
    assert.equal(p(intStarted!).title, 'INT', '委派带当前任务标题(「名 · 任务」后缀数据源)');
    const extEnded = rig.events.find((e) => e.type === 'delegation-ended' && p(e).delegationId === extId);
    assert.ok(extEnded, 'external delegation-ended 在场');
    assert.equal(p(extEnded!).kind, 'external-cli');
    assert.equal(p(extEnded!).status, 'done');
    const s = rig.board.snapshot();
    assert.equal(s.tasks[extId]!.status, 'success');
    assert.equal(s.tasks[intId]!.status, 'success');
    assert.equal(s.tasks[extId]!.artifact?.conclusion, `external ${extId} conclusion`, 'external 结论经强制回写并入 artifact');
    // teammate 转录事件打标(payload.subagent)与 external 生命周期事件同流共存
    assert.ok(rig.events.some((e) => typeof p(e).subagent === 'string' && p(e).subagent === 'w-ext'), 'teammate 转录标在场');
  } finally {
    rig?.team.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
