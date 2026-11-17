// sunx 板任务通道（2026-11-15 sunx P2 Task 2）：dispatch target='team'——R6 能力自举（无团队 → 建队 +
// 按 agent_id 经 teamAdapter.spawn 实例化 teammate，缺省 developer 预设）+ 板语义（depends_on 存在性/
// 环校验、指派路由、无活成员留 pending）+ 回执方言 `board task <id> created (team <teamId>)<wakeHintSuffix>`。
// fork 通道（缺省）行为逐字节不变（spawn 家族同缝既有锚 subagent.spawn.test.ts）；standard 会话零变化
// （dispatch_task 仅 sunx 注册——sunx-face.test.ts 基线锚）。faces：get_agent_team_board 随板通道进面
// （SUNX_FACE_TOOLS 白名单成员）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness, SUNX_FACE_TOOLS } from './index';
import { CodedToolError } from './tools';
import { makeDispatchTool } from './subagent';
import type { SubagentRunner } from './subagent';
import type { ModelAdapter } from '../model/adapter';
import { WAKE_HINT } from './tasks';
import type { SessionEvent } from '../types';
import type { BoardEvent } from '../taskboard/model';
import type { TeamStoreBackend } from '../taskboard/store';

const mktmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** 成员 Reactor 共用模型：每任务一拍 stop 收口（taskboard.e2e 先例——不经模型驱动编排） */
const memberStopModel = {
  provider: 'openai',
  capabilities: { chat: true },
  chat: async () => ({ finish: 'stop' as const, content: 'member done', toolCalls: [] }),
} as unknown as ModelAdapter;

async function until(pred: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return pred();
}

/** dispatch_task 出牌基线（schema 全键形态）：target 缺省派发按 team 通道 */
const dispatchArgs = (over: Record<string, unknown>): Record<string, unknown> => ({
  spec: 'do the board thing',
  label: 'impl',
  agent_id: null,
  tier: null,
  isolation: null,
  target: 'team',
  depends_on: null,
  ...over,
});

const boardIdOf = (stdout: string): string => {
  const m = /^board task (task-\S+) created \(team team-\S+\)/.exec(stdout);
  assert.ok(m, `回执应为板通道方言（board task <id> created (team <teamId>)）:${stdout.slice(0, 160)}`);
  return m[1]!;
};

interface WithOpts {
  wake?: boolean;
  onEvent?: (e: SessionEvent) => void;
}

async function withHarness(model: ModelAdapter, fn: (h: Harness) => Promise<void>, extra?: WithOpts): Promise<void> {
  const tmp = mktmp('sunshinex-sunxteam-');
  let h: Harness | undefined;
  try {
    h = new Harness({
      root: tmp,
      mode: 'full-access',
      kind: 'sunx',
      model,
      learnSkills: false,
      ...(extra?.wake ? { wake: { onFinished: () => {}, hint: true } } : {}),
      ...(extra?.onEvent ? { onEvent: extra.onEvent } : {}),
    });
    await fn(h);
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('team 分支自举（R6）：无团队 → 建队+developer 成员实例化；任务被成员消化；台账 boardDispatch 行终态；team-created/teammate-created 既有事件形随行', async () => {
  const events: SessionEvent[] = [];
  await withHarness(memberStopModel, async (h) => {
    const r = await h.tools.execute('dispatch_task', dispatchArgs({}), h.safety);
    assert.ok(r.ok && r.value.exitCode === 0, `dispatch 应成功:${r.ok ? r.value.stdout : r.error.message}`);
    if (!r.ok) return;
    assert.match(
      r.value.stdout,
      /^board task task-\S+ created \(team team-\S+\)$/,
      `回执=板通道方言（无备注行）:${r.value.stdout.slice(0, 200)}`,
    );
    assert.equal(h.agentTeams.list().length, 1, 'R6 自举恰建一队');
    const teamId = h.agentTeams.list()[0]!.teamId;
    assert.match(r.value.stdout, new RegExp(`\\(team ${teamId}\\)$`), '回执 teamId=自举队');
    assert.ok(h.team.aliveNames(teamId).includes('developer'), 'agent_id 缺省 → developer 预设成员实例化');
    const taskId = boardIdOf(r.value.stdout);
    // 成员消化：板任务 success（claim 路径——assignee 留空，executedBy=developer）
    assert.ok(
      await until(() => h.taskboard.snapshot().tasks[taskId]?.status === 'success'),
      `成员应消化板任务:${JSON.stringify(h.taskboard.snapshot().tasks[taskId])}`,
    );
    const task = h.taskboard.snapshot().tasks[taskId]!;
    assert.equal(task.assignee, undefined, '缺省不指派留给 claim');
    assert.equal(task.executedBy, 'developer', '认领执行者=developer');
    assert.deepEqual(task.dependsOn, [], '缺省零依赖');
    // 台账 boardDispatch 行（bg-wake 唤醒源，P1 钉的唤醒汇——零改动消费）：label=板任务 id，终态 done
    const row = h.tasks.list().find((t) => t.boardDispatch === true && t.label === taskId);
    assert.ok(row !== undefined, '板任务台账行（boardDispatch 标）在册');
    assert.equal(row!.status, 'done', '台账行已终态');
    // 事件复用既有形（裁定 5：不为 team 分支另发事件；GUI 队卡/成员栏直播同源）
    assert.ok(events.some((e) => e.type === 'team-created' && (e.payload as Record<string, unknown>).teamId === teamId), 'team-created 事件（既有形）');
    assert.ok(events.some((e) => e.type === 'teammate-created' && (e.payload as Record<string, unknown>).name === 'developer'), 'teammate-created 事件（既有形）');
  }, { onEvent: (e) => events.push(e) });
});

test('team 复用 + 指派路由：显式 agent_id → 同名成员实例化并指派（assignee=agent_id）；二派复用同队同成员（不重复建队/建成员）', async () => {
  await withHarness(memberStopModel, async (h) => {
    const r1 = await h.tools.execute('dispatch_task', dispatchArgs({ spec: 'first brief', label: 'a', agent_id: 'tester' }), h.safety);
    assert.ok(r1.ok && r1.value.exitCode === 0, `第一派应成功:${r1.ok ? '' : r1.error.message}`);
    const id1 = boardIdOf(r1.ok ? r1.value.stdout : '');
    assert.ok(await until(() => h.taskboard.snapshot().tasks[id1]?.status === 'success'), '第一任务应被消化');
    assert.ok(h.team.aliveNames().includes('tester'), 'tester 成员实例化');
    const r2 = await h.tools.execute('dispatch_task', dispatchArgs({ spec: 'second brief', label: 'b', agent_id: 'tester' }), h.safety);
    assert.ok(r2.ok && r2.value.exitCode === 0, `第二派应成功:${r2.ok ? '' : r2.error.message}`);
    const id2 = boardIdOf(r2.ok ? r2.value.stdout : '');
    assert.ok(await until(() => h.taskboard.snapshot().tasks[id2]?.status === 'success'), '第二任务应被消化');
    assert.equal(h.agentTeams.list().length, 1, '有团队 → 复用（不另建队）');
    assert.deepEqual(h.team.aliveNames(), ['tester'], '同名成员复用（不重复实例化）');
    // 指派路由：assignee=agent_id 匹配的存活成员（claim 后 assignee 字段保留，executedBy 同名）
    assert.equal(h.taskboard.snapshot().tasks[id1]!.assignee, 'tester', '任务指派给 agent_id 匹配成员');
    assert.equal(h.taskboard.snapshot().tasks[id2]!.assignee, 'tester', '第二任务同路指派');
  });
});

test('depends_on 校验：未知引用 INVALID_ARG 且零建队副作用；合法依赖落板并按序消化；环（直注损坏档）INVALID_ARG', async () => {
  await withHarness(memberStopModel, async (h) => {
    // 未知引用（校验先于自举——失败零副作用）
    const bad = await h.tools.execute('dispatch_task', dispatchArgs({ depends_on: ['task-nope-0000'] }), h.safety);
    assert.ok(!bad.ok && bad.error.code === 'INVALID_ARG', `未知依赖应 INVALID_ARG:${JSON.stringify(bad)}`);
    assert.match(bad.error.message, /unknown dependency/);
    assert.equal(h.agentTeams.list().length, 0, '校验先于自举（失败零建队副作用）');
    // 合法依赖链：seed 先消化 → 依赖任务引用 seed id 建单成功并消化
    const seed = await h.tools.execute('dispatch_task', dispatchArgs({ spec: 'seed brief', label: 'seed' }), h.safety);
    assert.ok(seed.ok && seed.value.exitCode === 0, `seed 派应成功:${seed.ok ? '' : seed.error.message}`);
    const seedId = boardIdOf(seed.ok ? seed.value.stdout : '');
    assert.ok(await until(() => h.taskboard.snapshot().tasks[seedId]?.status === 'success'));
    const dep = await h.tools.execute('dispatch_task', dispatchArgs({ spec: 'dep brief', label: 'dep', depends_on: [seedId] }), h.safety);
    assert.ok(dep.ok && dep.value.exitCode === 0, `合法依赖应建单成功:${dep.ok ? '' : dep.error.message}`);
    const depId = boardIdOf(dep.ok ? dep.value.stdout : '');
    assert.deepEqual(h.taskboard.snapshot().tasks[depId]!.dependsOn, [seedId], 'depends_on 落板');
    assert.ok(await until(() => h.taskboard.snapshot().tasks[depId]?.status === 'success'), '依赖任务应在上游 success 后被消化');
    // 环（破坏注入置尾——create 路径数学上不可成环，预检为防御守卫）：直接事件注入损坏档后，
    // 任一带 depends_on 的派发确定性拒绝（同源 model.hasCycle，环=INVALID_ARG）
    const store = (h.taskboard as unknown as { deps: { store: TeamStoreBackend } }).deps.store;
    const mk = (id: string, other: string): BoardEvent => ({ t: 'task-created', taskId: id, title: id, spec: id, dependsOn: [other], teamId: 'team-x-0001', ts: 1 });
    store.append(mk('task-a-0001', 'task-b-0002'));
    store.append(mk('task-b-0002', 'task-a-0001'));
    h.taskboard.init();
    const cyc = await h.tools.execute('dispatch_task', dispatchArgs({ depends_on: [seedId] }), h.safety);
    assert.ok(!cyc.ok && cyc.error.code === 'INVALID_ARG', `环应 INVALID_ARG:${JSON.stringify(cyc)}`);
    assert.match(cyc.error.message, /cycle/);
  });
});

test('实例化失败=任务留 pending+回执说明无活成员（板语义既有）：未知 agent_id', async () => {
  await withHarness(memberStopModel, async (h) => {
    const r = await h.tools.execute('dispatch_task', dispatchArgs({ agent_id: 'ghost' }), h.safety);
    assert.ok(r.ok && r.value.exitCode === 0, `回执应成功（不炸派发）:${r.ok ? '' : r.error.message}`);
    assert.match(r.value.stdout, /no living teammate.*Subagent not found: ghost[\s\S]*stays pending/, '回执说明无活成员+原因');
    const taskId = boardIdOf(r.value.stdout);
    assert.equal(h.taskboard.snapshot().tasks[taskId]!.status, 'pending', '任务留 pending');
    assert.deepEqual(h.team.aliveNames(), [], '零成员登记');
  });
});

test('回执唤醒提示（宿主闸①×②单点合成）：wake.hint 装配 + 主链归属 → 板回执尾追 WAKE_HINT；缺省装配零提示', async () => {
  await withHarness(memberStopModel, async (h) => {
    const r = await h.tools.execute('dispatch_task', dispatchArgs({}), h.safety);
    assert.ok(r.ok);
    assert.ok(r.value.stdout.includes(WAKE_HINT), '板回执尾追 WAKE_HINT（wakeHintSuffix 既有单点）');
  }, { wake: true });
  await withHarness(memberStopModel, async (h) => {
    const r = await h.tools.execute('dispatch_task', dispatchArgs({}), h.safety);
    assert.ok(r.ok);
    assert.ok(!r.value.stdout.includes(WAKE_HINT), '缺省装配零唤醒提示');
  });
});

test('fork 通道锚：无板缝 target=team → NOT_SUPPORTED；fork+depends_on 非空 → INVALID_ARG；非法 target → INVALID_ARG；fork+depends_on=null 缺省回执逐字节原样', async () => {
  // 工厂级（无板缝装配）：target='team' 确定性 NOT_SUPPORTED（生产仅 sunx 装配注入板缝——standard 无 dispatch_task）
  const stub = {
    validateSpawnInput: (): void => {},
    spawnBackground: () => ({ taskId: 'task-x-ts01-ab12', name: 'x', outputFilePath: path.join('tmp', 'x.log') }),
  } as unknown as SubagentRunner;
  const tool = makeDispatchTool(stub);
  await assert.rejects(
    tool.executor({ spec: 'x', target: 'team', depends_on: null }),
    (e: unknown) => e instanceof CodedToolError && e.code === 'NOT_SUPPORTED',
    '无板缝 target=team 应 NOT_SUPPORTED',
  );
  await assert.rejects(
    tool.executor({ spec: 'x', target: 'fork', depends_on: ['task-a-0001'] }),
    (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG',
    'fork 通道传 depends_on 应 INVALID_ARG（板通道专用参）',
  );
  await assert.rejects(
    tool.executor({ spec: 'x', target: 'squad' }),
    (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG',
    '非法 target 字面应 INVALID_ARG（闭合枚举外 fail-fast）',
  );
  // fork 缺省 + depends_on:null → spawnBackground 同缝回执逐字节原样（裁定 3）
  const r = await tool.executor({ spec: 'x', depends_on: null });
  assert.match(r.stdout, /^task-x-ts01-ab12 started in background — x \(output: /, 'fork 缺省回执裸 id 起头+携任务名（2026-11-17 根治）');
});

test('sunx face 含板监视面：get_agent_team_board 随板通道进面（白名单单点成员）', () => {
  const tmp = mktmp('sunshinex-sunxteam-face-');
  let h: Harness | undefined;
  try {
    h = new Harness({ root: tmp, mode: 'full-access', kind: 'sunx', model: memberStopModel, learnSkills: false });
    assert.ok(h.tools.has('get_agent_team_board'), 'sunx 装配持板监视面');
    assert.ok(SUNX_FACE_TOOLS.includes('get_agent_team_board'), '白名单含板监视面（单点常量）');
    const face = h.tools.derive({ only: [...SUNX_FACE_TOOLS] });
    assert.notEqual(face.get('get_agent_team_board'), undefined, '白名单派生面含板监视面');
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
