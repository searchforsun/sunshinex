import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assembleBoardTasks, driveBoardPipeline } from './commands/run-pipeline';
import { templateToTaskSpecs } from '../graph/templates';
import { TaskBoard } from '../taskboard/board';
import { TeamStore } from '../taskboard/store';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

/** 宏测（P2/T6）：不拉真 CLI 入口——直测 runPipeline 的板路径装配与驱动序列。
 *  真 TaskBoard（tmpdir 持久化）+ fake runner（恒 ok）+ templateToTaskSpecs →
 *  两段装配（assembleBoardTasks，导出面）→ settle/关单/审批驱动 → 断言依赖边落板、执行序、gated 语义。 */

function makeBoard(tmp: string, calls: string[]): TaskBoard {
  const board = new TaskBoard({
    store: new TeamStore(path.join(tmp, 'teams', 'main')),
    runner: {
      runSubagent: async (_input: unknown, o?: { taskLine?: string }) => {
        const line = o?.taskLine ?? '';
        calls.push(line);
        return { ok: true as const, value: { reply: `reply of ${line}`, tokens: 10 } };
      },
    } as unknown as SubagentRunner,
    registry: { submit: () => ({ id: 'm1', stop: () => {} }), append: () => {}, finish: () => {}, list: () => [], get: () => undefined } as unknown as TaskRegistry,
    onEvent: () => {},
    now: (() => { let n = 1000; return () => ++n; })(),
  });
  board.init();
  return board;
}

test('宏测：两段装配落板（idMap/依赖边/gated）+ settle 关单驱动，五任务按模板序全终态', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-macro-pipeline-'));
  try {
    const calls: string[] = [];
    const board = makeBoard(tmp, calls);
    const goal = '实现 add 函数并保证测试正确（验收标准：c1=math.test.js 断言 add(1,2)===3）';
    const specs = templateToTaskSpecs(goal, { ruleCheckers: ['c1'] });
    const asm = assembleBoardTasks(board, specs);
    assert.ok(asm.ok, `装配应成功：${asm.ok ? '' : asm.error.message}`);
    const idMap = asm.value;
    // idMap：模板节点 id → 板 taskId（创建序 t1..t5）
    assert.deepEqual([...idMap.entries()], [
      ['planner', 't1'],
      ['developer', 't2'],
      ['test-verify', 't3'],
      ['reviewer', 't4'],
      ['delivery-gate', 't5'],
    ]);
    // 依赖边落板（板内 taskId 口径）+ gated 标记 + 任务 title/spec 承载模板映射
    const st0 = board.snapshot();
    assert.deepEqual(st0.tasks['t2']!.dependsOn, ['t1']);
    assert.deepEqual(st0.tasks['t3']!.dependsOn, ['t2']);
    assert.deepEqual(st0.tasks['t4']!.dependsOn, ['t3']);
    assert.deepEqual(st0.tasks['t5']!.dependsOn, ['t4']);
    assert.equal(st0.tasks['t5']!.gated, true, 'delivery-gate 落板为 gated 任务');
    assert.equal(st0.tasks['t1']!.title, 'planner');
    assert.ok(st0.tasks['t1']!.spec.startsWith('Role: '), 'role 任务的 spec 承载 Role 行');

    // 首个 settle：链头 planner 执行进 in-review，下游 pending（依赖未 done 不派发）
    let st = await board.settle(300);
    assert.equal(st.tasks['t1']!.status, 'in-review');
    assert.equal(st.tasks['t2']!.status, 'pending', '上游 in-review 未关单，下游不派发');

    // 真驱动循环（runPipeline 同款导出面）：rl 注入审批 'y' 走 confirmApprovals gate 分支；
    // warn 桩抛错 = review 失败守卫不静默（正常路径零 warn）
    const result = await driveBoardPipeline(board, idMap.values(), {
      rl: { question: async () => 'y' },
      settleSliceMs: 50,
      warn: (line) => { throw new Error(`unexpected warn: ${line}`); },
    });
    assert.equal(result.status, 'done');
    assert.deepEqual(result.tasks.map((t) => t.id), ['t1', 't2', 't3', 't4', 't5'], '回执恰为本管线五任务（数值序）');
    for (const t of result.tasks) assert.equal(t.status, 'done', `${t.id} 关单为 done`);
    st = board.snapshot();
    assert.equal(st.tasks['t5']!.status, 'done', 'gate 审批通过后执行并关单');
    assert.deepEqual(calls, ['Task t1: planner', 'Task t2: developer', 'Task t3: test-verify', 'Task t4: reviewer', 'Task t5: delivery-gate'], '全五任务按依赖序执行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('宏测：残留任务不越权——同板预置残留 failed 与交互 in-review，本轮只看管线任务集', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-macro-residual-'));
  try {
    const calls: string[] = [];
    const board = makeBoard(tmp, calls);
    // 残留 1：上轮失败任务（执行完 in-review 被 lead 拒绝关单 → failed）
    assert.ok(board.create({ title: 'residual-failed', spec: 'old run' }).ok); // t1
    await board.settle(300);
    assert.ok(board.review('t1', { approved: false }).ok);
    assert.equal(board.snapshot().tasks['t1']!.status, 'failed');
    // 残留 2：上轮交互 in-review 任务（等人裁决，不该被本轮越权关单）
    assert.ok(board.create({ title: 'residual-review', spec: 'old run' }).ok); // t2
    await board.settle(300);
    assert.equal(board.snapshot().tasks['t2']!.status, 'in-review');
    // 本轮管线：装配得 t3..t7（planner 无依赖建即派发）
    const asm = assembleBoardTasks(board, templateToTaskSpecs('目标（验收标准：c1=ok）'));
    assert.ok(asm.ok);
    assert.deepEqual([...asm.value.values()], ['t3', 't4', 't5', 't6', 't7'], '板 id 单调续接残留任务');
    const result = await driveBoardPipeline(board, asm.value.values(), { rl: { question: async () => 'y' }, settleSliceMs: 50 });
    // 残留 failed 不秒杀本轮：本轮五任务全 done，status done（整板视角会误判 failed）
    assert.equal(result.status, 'done', '残留 failed 任务不影响本轮判定');
    assert.deepEqual(result.tasks.map((t) => t.id), ['t3', 't4', 't5', 't6', 't7'], '回执只含本管线任务');
    for (const t of result.tasks) assert.equal(t.status, 'done');
    // 残留任务原态保持：交互 in-review 未被本轮关单，failed 维持
    const st = board.snapshot();
    assert.equal(st.tasks['t2']!.status, 'in-review', '残留交互 in-review 不被本轮越权关单');
    assert.equal(st.tasks['t1']!.status, 'failed', '残留 failed 维持原态');
    // 执行记录：残留任务各恰一次（装配期跑的），本轮零重派——runner 序 = 两残留 + 本轮五任务（依赖序）
    assert.deepEqual(calls, [
      'Task t1: residual-failed', 'Task t2: residual-review',
      'Task t3: planner', 'Task t4: developer', 'Task t5: test-verify', 'Task t6: reviewer', 'Task t7: delivery-gate',
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
