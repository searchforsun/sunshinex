import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamRegistry, Teammate } from './teammate';
import { TeamStore } from './store';
import { ChatRequest, ChatResult, SessionEvent } from '../types';
import { ProcessSandbox } from '../harness/security/sandbox';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { SafetyChain } from '../harness/security/chain';
import { ToolRegistry } from '../harness/tools';
import { FileStore } from '../storage/adapter';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';
import type { ModelAdapter } from '../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 自增计数 fake ModelAdapter:chat() 恒一轮 stop 收束(最小桩,现场对齐 ModelAdapter.chat 签名) */
class CountingAdapter implements ModelAdapter {
  readonly provider = 'counting';
  n = 0;
  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.n += 1;
    return { finish: 'stop', content: `done ${this.n}`, toolCalls: [] };
  }
}

interface Rig {
  board: TaskBoard;
  team: TeamRegistry;
  events: SessionEvent[];
  forkCalls: string[];
  /** 构造 Teammate(不注册);模型可注入以共享计数断言顺序 */
  makeTeammate(name: string, model?: CountingAdapter): Teammate;
  /** 构造并注册 */
  addTeammate(name: string, model?: CountingAdapter): Teammate;
}

/** 装配:真 TaskBoard(fake fork runner 计数,P1 路径探测器)+ 可选 team + 真 Teammate(fake model) */
function makeRig(tmp: string, withTeam: boolean): Rig {
  const events: SessionEvent[] = [];
  const forkCalls: string[] = [];
  const runner = {
    runSubagent: async (_input: unknown, o?: { taskLine?: string }) => {
      const line = o?.taskLine ?? '';
      forkCalls.push(line);
      return { ok: true as const, value: { reply: `fork ${line}`, tokens: 7 } };
    },
  } as unknown as SubagentRunner;
  const registry = { submit: () => ({ id: 'b1', stop: () => {} }), append: () => {}, finish: () => {}, list: () => [], get: () => undefined } as unknown as TaskRegistry;
  const team = new TeamRegistry();
  const board = new TaskBoard({
    store: new TeamStore(path.join(tmp, 'teams', 'main')),
    runner,
    registry,
    onEvent: (e) => events.push(e),
    now: (() => { let n = 1000; return () => ++n; })(),
    ...(withTeam ? { team } : {}),
  });
  board.init();
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), tmp);
  const tools = new ToolRegistry();
  const depsOf = (name: string, model: CountingAdapter) => ({
    safety,
    model,
    registry: tools,
    root: tmp,
    store: new FileStore(path.join(tmp, 'ctx', name)),
    board,
    onEvent: (e: SessionEvent) => events.push(e),
  });
  const makeTeammate = (name: string, model?: CountingAdapter): Teammate =>
    new Teammate({ name, framing: `framing of ${name}`, deps: depsOf(name, model ?? new CountingAdapter()) });
  return {
    board,
    team,
    events,
    forkCalls,
    makeTeammate,
    addTeammate: (name: string, model?: CountingAdapter) => {
      const tm = makeTeammate(name, model);
      const r = team.register(tm);
      assert.ok(r.ok, `register ${name} 应成功`);
      return tm;
    },
  };
}

const drain = () => new Promise((r) => setImmediate(r));

/** 轮询快照直至谓词成立(≤2s,50ms 步) */
async function until(pred: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

test('teammate 自主 claim:未指派任务串行消化至 in-review,fork 路径零调用,delegation 事件成对', async () => {
  const tmp = tmpdir('sunshinex-tm-claim-');
  try {
    const rig = makeRig(tmp, true);
    const model = new CountingAdapter();
    const w1 = rig.addTeammate('w1', model);
    assert.equal(rig.team.hasAlive(), true, '注册未停即活');
    assert.deepEqual(rig.team.aliveNames(), ['w1']);
    rig.board.create({ title: 'A', spec: 'do A' });
    rig.board.create({ title: 'B', spec: 'do B' });
    await drain();
    assert.equal(rig.forkCalls.length, 0, '活 teammate 在场:未指派任务不得走 P1 fork');
    assert.notEqual(rig.board.snapshot().tasks['t1']!.status, 'claimed', 'fork 路径不落 claimed');
    w1.kick(); // 显式踢点(派发路由已自动踢过,此处验证重入幂等)
    const done = await until(() => {
      const s = rig.board.snapshot();
      return s.tasks['t1']?.status === 'in-review' && s.tasks['t2']?.status === 'in-review';
    });
    assert.ok(done, '两任务均应回写 in-review');
    const s = rig.board.snapshot();
    // 单飞串行顺序:t1 先消化(模型计数 1),t2 后消化(计数 2)
    assert.equal(s.tasks['t1']!.artifact?.conclusion, 'done 1', 't1 先执行');
    assert.equal(s.tasks['t2']!.artifact?.conclusion, 'done 2', 't2 后执行');
    assert.equal(rig.forkCalls.length, 0, '全过程零 fork 调用');
    // delegation 生命周期事件:started/ended × 2,delegationId=task-tN,kind subagent
    const started = rig.events.filter((e) => e.type === 'delegation-started');
    const ended = rig.events.filter((e) => e.type === 'delegation-ended');
    assert.equal(started.length, 2, 'delegation-started × 2');
    assert.equal(ended.length, 2, 'delegation-ended × 2');
    const ids = [...started, ...ended].map((e) => e.payload?.delegationId).sort();
    assert.deepEqual(ids, ['task-t1', 'task-t1', 'task-t2', 'task-t2']);
    for (const e of [...started, ...ended]) {
      assert.equal(e.payload?.kind, 'subagent');
      assert.equal(e.payload?.label, e.payload?.delegationId, 'label 与 delegationId 同 task-tN');
      assert.equal(e.payload?.subagent, undefined, '生命周期事件不带转录标');
    }
    for (const e of ended) assert.equal(e.payload?.status, 'done');
    // teammate 转录事件打标(复用 ChildPanel 通道):reactor done 事件带 payload.subagent = name
    const transcript = rig.events.find((e) => e.type === 'done');
    assert.ok(transcript, 'reactor done 事件已透传');
    assert.equal(transcript.payload?.subagent, 'w1');
    assert.equal(w1.isBusy(), false, '消化完空闲');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('派发路由:assignee 命中活 teammate → runTask;无 team 注入 → P1 fork 退化', async () => {
  // ① 无 team 注入:create 未指派 → fake runner 被调(P1 退化)
  const tmpA = tmpdir('sunshinex-tm-route-a-');
  try {
    const rigA = makeRig(tmpA, false);
    rigA.board.create({ title: 'A', spec: 'a' });
    const okA = await until(() => rigA.board.snapshot().tasks['t1']?.status === 'in-review');
    assert.ok(okA, '无 team:P1 fork 路径原样回写');
    assert.equal(rigA.forkCalls.length, 1, 'fake runner 被调(P1 退化)');
  } finally {
    fs.rmSync(tmpA, { recursive: true, force: true });
  }
  // ② team 注册 w1:create assignee 'w1' → runTask 路径(fake runner 零调用)
  const tmpB = tmpdir('sunshinex-tm-route-b-');
  try {
    const rigB = makeRig(tmpB, true);
    rigB.addTeammate('w1');
    rigB.board.create({ title: 'B', spec: 'b', assignee: 'w1' });
    const okB = await until(() => rigB.board.snapshot().tasks['t1']?.status === 'in-review');
    assert.ok(okB, '指派路由:teammate 消化回写 in-review');
    assert.equal(rigB.forkCalls.length, 0, '指派命中 teammate:零 fork 调用');
    const ended = rigB.events.filter((e) => e.type === 'delegation-ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0]!.payload?.delegationId, 'task-t1');
    assert.equal(ended[0]!.payload?.status, 'done');
  } finally {
    fs.rmSync(tmpB, { recursive: true, force: true });
  }
});

test('帽与停:第 5 个 teammate 注册拒;停后 hasAlive=false,未指派任务回退 fork 路径', async () => {
  const tmp = tmpdir('sunshinex-tm-cap-');
  try {
    const rig = makeRig(tmp, true);
    for (let i = 1; i <= 4; i++) rig.addTeammate(`w${i}`);
    const r5 = rig.team.register(rig.makeTeammate('w5'));
    assert.ok(!r5.ok, '第 5 个注册应失败');
    assert.equal(r5.error.code, 'INVALID_ARG');
    assert.equal(r5.error.message, 'teammate limit reached (4)');
    // 停:stop 幂等,全停后 hasAlive false
    rig.team.stop('w1');
    rig.team.stop('w1'); // 幂等
    assert.equal(rig.team.get('w1')!.stopped, true);
    rig.team.stopAll();
    assert.equal(rig.team.hasAlive(), false, '全停后无存活');
    assert.deepEqual(rig.team.aliveNames(), []);
    // 停后未指派任务回退 P1 fork 路径(fake runner 被调)
    rig.board.create({ title: 'C', spec: 'c' });
    const done = await until(() => rig.board.snapshot().tasks['t1']?.status === 'in-review');
    assert.ok(done, '无活 teammate:回退 fork 路径完成回写');
    assert.equal(rig.forkCalls.length, 1, 'fake runner 被调(退化语义)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
