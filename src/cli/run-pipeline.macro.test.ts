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
 *  两段装配（assembleBoardTasks，导出面）→ settle/关单/审批驱动 → 断言依赖边落板、执行序、gated 语义。
 *  板 id 为不透明方言（2026-10-19 起 task-<业务段>-<随机码>），断言一律捕获返回 id,不写 id 字面量。 */

const TASK_LINE = (id: string, title: string): string => `Task ${id}: ${title}`;

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
    // idMap：模板节点 id → 板 taskId（创建序=模板序;板 id 为不透明方言,只断键序与值互异）
    assert.deepEqual([...idMap.keys()], ['planner', 'developer', 'test-verify', 'reviewer', 'delivery-gate']);
    const ids = [...idMap.values()];
    assert.equal(new Set(ids).size, 5, '五任务 id 互异');
    for (const id of ids) assert.match(id, /^task-[a-z0-9][a-z0-9-]*-[a-z0-9]{4}$/, `板 id 新方言: ${id}`);
    // 依赖边落板（板内 taskId 口径）+ gated 标记 + 任务 title/spec 承载模板映射
    const id = (name: string): string => idMap.get(name)!;
    const st0 = board.snapshot();
    assert.deepEqual(st0.tasks[id('developer')]!.dependsOn, [id('planner')]);
    assert.deepEqual(st0.tasks[id('test-verify')]!.dependsOn, [id('developer')]);
    assert.deepEqual(st0.tasks[id('reviewer')]!.dependsOn, [id('test-verify')]);
    assert.deepEqual(st0.tasks[id('delivery-gate')]!.dependsOn, [id('reviewer')]);
    assert.equal(st0.tasks[id('delivery-gate')]!.gated, true, 'delivery-gate 落板为 gated 任务');
    assert.equal(st0.tasks[id('planner')]!.title, 'planner');
    assert.ok(st0.tasks[id('planner')]!.spec.startsWith('Role: '), 'role 任务的 spec 承载 Role 行');

    // 首个 settle：链头 planner 执行进 in-review，下游 pending（依赖未 done 不派发）
    let st = await board.settle(300);
    assert.equal(st.tasks[id('planner')]!.status, 'in-review');
    assert.equal(st.tasks[id('developer')]!.status, 'pending', '上游 in-review 未关单，下游不派发');

    // 真驱动循环（runPipeline 同款导出面）：rl 注入审批 'y' 走 confirmApprovals gate 分支；
    // warn 桩抛错 = review 失败守卫不静默（正常路径零 warn）
    const result = await driveBoardPipeline(board, idMap.values(), {
      rl: { question: async () => 'y' },
      settleSliceMs: 50,
      warn: (line) => { throw new Error(`unexpected warn: ${line}`); },
    });
    assert.equal(result.status, 'done');
    // 回执按 id 字母序稳定排序(旧 tN 序恰等创建序掩盖了这一点)——集合相等断言,执行序由 calls 钉
    assert.deepEqual(result.tasks.map((t) => t.id).sort(), [...ids].sort(), '回执恰为本管线五任务');
    for (const t of result.tasks) assert.equal(t.status, 'done', `${t.id} 关单为 done`);
    st = board.snapshot();
    assert.equal(st.tasks[id('delivery-gate')]!.status, 'done', 'gate 审批通过后执行并关单');
    assert.deepEqual(
      calls,
      ids.map((id, i) => TASK_LINE(id, ['planner', 'developer', 'test-verify', 'reviewer', 'delivery-gate'][i]!)),
      '全五任务按依赖序执行',
    );
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
    const residualFailed = board.create({ title: 'residual-failed', spec: 'old run' });
    assert.ok(residualFailed.ok);
    const failedId = residualFailed.value.taskId;
    await board.settle(300);
    assert.ok(board.review(failedId, { approved: false }).ok);
    assert.equal(board.snapshot().tasks[failedId]!.status, 'failed');
    // 残留 2：上轮交互 in-review 任务（等人裁决，不该被本轮越权关单）
    const residualReview = board.create({ title: 'residual-review', spec: 'old run' });
    assert.ok(residualReview.ok);
    const reviewId = residualReview.value.taskId;
    await board.settle(300);
    assert.equal(board.snapshot().tasks[reviewId]!.status, 'in-review');
    // 本轮管线：装配五任务（planner 无依赖建即派发）;id 与残留任务互异、互不越权
    const asm = assembleBoardTasks(board, templateToTaskSpecs('目标（验收标准：c1=ok）'));
    assert.ok(asm.ok);
    const ids = [...asm.value.values()];
    assert.equal(ids.length, 5, '本轮五任务');
    assert.equal(new Set([...ids, failedId, reviewId]).size, 7, '本轮 id 与残留任务互异');
    const result = await driveBoardPipeline(board, asm.value.values(), { rl: { question: async () => 'y' }, settleSliceMs: 50 });
    // 残留 failed 不秒杀本轮：本轮五任务全 done，status done（整板视角会误判 failed）
    assert.equal(result.status, 'done', '残留 failed 任务不影响本轮判定');
    assert.deepEqual(result.tasks.map((t) => t.id).sort(), [...ids].sort(), '回执只含本管线任务');
    for (const t of result.tasks) assert.equal(t.status, 'done');
    // 残留任务原态保持：交互 in-review 未被本轮关单，failed 维持
    const st = board.snapshot();
    assert.equal(st.tasks[reviewId]!.status, 'in-review', '残留交互 in-review 不被本轮越权关单');
    assert.equal(st.tasks[failedId]!.status, 'failed', '残留 failed 维持原态');
    // 执行记录：残留任务各恰一次（装配期跑的），本轮零重派——runner 序 = 两残留 + 本轮五任务（依赖序）
    assert.deepEqual(calls, [
      TASK_LINE(failedId, 'residual-failed'), TASK_LINE(reviewId, 'residual-review'),
      ...ids.map((id, i) => TASK_LINE(id, ['planner', 'developer', 'test-verify', 'reviewer', 'delivery-gate'][i]!)),
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
