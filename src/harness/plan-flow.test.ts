import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanFlow, parseNumberedSteps, PLAN_TASK_LABEL, PLAN_MAX_ROUNDS } from './plan-flow';
import type { PlanStep, PlanFlowEvent, PlanFlowSeams } from './plan-flow';

/** 全 mock 接缝帮手：默认规划产出 '# 计划\n1. A\n2. B'、todos 空、批准;over 逐缝覆写。
 *  readonlyOn()/chainCalls() 为状态检视口——前者断言「exit 后覆盖应已解除」，后者是 chainAppendPlan spy 计数。 */
interface MockSeams extends PlanFlowSeams {
  events: string[];
  readonlyOn(): boolean;
  chainCalls(): number;
}

function mockSeams(over: Partial<PlanFlowSeams> = {}): MockSeams {
  const events: string[] = [];
  let readonlyNow = false;
  let chainCalls = 0;
  const base: MockSeams = {
    events,
    readonlyOn: () => readonlyNow,
    chainCalls: () => chainCalls,
    runPlanningTask: async () => ({ done: true, reply: '# 计划\n1. A\n2. B' }),
    enterReadOnly: () => { readonlyNow = true; },
    exitReadOnly: () => { readonlyNow = false; },
    todosSnapshot: (): PlanStep[] => [],
    chainAppendPlan: () => { chainCalls++; },
    emit: (e: PlanFlowEvent) => { events.push(e.type); },
    awaitApproval: async () => ({ approved: true }),
  };
  return Object.assign(base, over);
}

test('主路径：规划→批准→返回产物,read-only 覆盖成对进出', async () => {
  const s = mockSeams();
  const r = await runPlanFlow('做一件事', s);
  assert.deepEqual(r, { doc: '# 计划\n1. A\n2. B', items: ['A', 'B'] });
  assert.deepEqual(s.events, ['planning', 'awaiting-approval', 'approved']);
  assert.ok(s.readonlyOn() === false, 'exit 后覆盖应已解除');
});

test('判别力锚：规划轮进入 read-only 覆盖（漏掉 enter 即红）', async () => {
  let entered = false;
  const s = mockSeams({ enterReadOnly: () => { entered = true; } });
  await runPlanFlow('g', s);
  assert.ok(entered, '规划轮必须 enter read-only');
});

test('todos 权威：todo_write 步骤优先于正文解析', async () => {
  const s = mockSeams({ todosSnapshot: () => [{ text: 'T1', status: 'pending' }, { text: 'T2', status: 'pending' }] });
  const r = await runPlanFlow('g', s);
  assert.deepEqual(r?.items, ['T1', 'T2'], 'items 应来自 todos 而非正文编号行');
});

test('todos 空 → 正文编号行兜底；正文也无步骤 → aborted empty', async () => {
  const s1 = mockSeams();
  assert.deepEqual((await runPlanFlow('g', s1))?.items, ['A', 'B']);
  const s2 = mockSeams({ runPlanningTask: async () => ({ done: true, reply: '没有步骤' }) });
  assert.equal(await runPlanFlow('g', s2), null);
  assert.ok(s2.events.includes('aborted'));
});

test('拒绝+反馈 → revising 重入;3 轮超限 → aborted exhausted 不自动执行', async () => {
  let n = 0;
  const s = mockSeams({ awaitApproval: async () => ({ approved: false, feedback: `fb${++n}` }) });
  assert.equal(await runPlanFlow('g', s), null);
  assert.equal(n, 3, '含首轮共 3 份计划书');
  assert.ok(s.events.filter((e) => e === 'revising').length === 2 && s.events.at(-1) === 'aborted');
});

test('规划段中断 → aborted interrupted;批准走 chainAppendPlan', async () => {
  const s1 = mockSeams({ runPlanningTask: async () => ({ done: false, stopReason: 'interrupted' }) });
  assert.equal(await runPlanFlow('g', s1), null);
  assert.ok(s1.events.at(-1) === 'aborted');
  const s2 = mockSeams();
  await runPlanFlow('g', s2);
  assert.equal(s2.chainCalls(), 1, '批准路径必须调用 chainAppendPlan 恰一次（spy 计数 called===1）');
});

test('parseNumberedSteps 逐字迁移锚（session.ts 现实现语义等价勿加戏）：split→trim→去编号前缀→滤空', () => {
  assert.deepEqual(
    parseNumberedSteps('# 计划\n1. A\n2. B\n\n3、C  \n尾巴'),
    ['# 计划', 'A', 'B', 'C', '尾巴'],
    '非编号行原样透传、去编号前缀、滤空——迁移前后行为等价',
  );
});

test('单源常量锚：PLAN_TASK_LABEL 迁 harness（D10 单源,tui re-export 同值）+ PLAN_MAX_ROUNDS=3', () => {
  assert.equal(PLAN_TASK_LABEL, 'Produce an investigation-backed plan document');
  assert.equal(PLAN_MAX_ROUNDS, 3);
});
