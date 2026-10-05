import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assembleBoardTasks } from './commands/run-pipeline';
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

    // 驱动循环（同 runPipeline 口径）：settle → lead 自动关单 in-review → 重入，直至仅剩 gated pending
    for (let guard = 0; guard < 12; guard++) {
      const inReview = Object.values(board.snapshot().tasks).filter((t) => t.status === 'in-review');
      if (inReview.length === 0) break;
      for (const t of inReview) assert.ok(board.review(t.id, { approved: true }).ok);
      await board.settle(200); // gated 尾任务顶住收敛时耗满短片即回，不虚等
    }
    st = board.snapshot();
    for (const id of ['t1', 't2', 't3', 't4']) assert.equal(st.tasks[id]!.status, 'done', `${id} 关单为 done`);
    assert.equal(st.tasks['t5']!.status, 'pending', 'gated 任务保持 pending（审批前不派发）');
    assert.deepEqual(calls, ['Task t1: planner', 'Task t2: developer', 'Task t3: test-verify', 'Task t4: reviewer'], '执行序 = 模板依赖序（gate 未跑）');

    // 审批映射：gated pending → review(approved) → settle → gate 任务执行进 in-review（完成待审）
    assert.ok(board.review('t5', { approved: true }).ok, 'gate 解锁');
    st = await board.settle(1000);
    assert.equal(st.tasks['t5']!.status, 'in-review', 'gate 解锁后派发执行，终态 in-review（完成待审）');
    assert.deepEqual(calls, ['Task t1: planner', 'Task t2: developer', 'Task t3: test-verify', 'Task t4: reviewer', 'Task t5: delivery-gate'], '全五任务按依赖序执行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
