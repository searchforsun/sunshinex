import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePlanName, parseNumberedSteps, PLAN_MODE_NOTE } from './plan-flow';

/** plan 模式支撑纯件单测（2026-11-03 无感化收敛）：计划名派生/Steps 解析/提示 note。
 *  挂起协议与落档语义的行为锚在 serve plan-flow.e2e（真挂起表+真裁决路径）。 */

test('derivePlanName：压缩空白/截断/空 goal 兜底', () => {
  assert.equal(derivePlanName('  做   一件事  '), '做 一件事');
  assert.equal(derivePlanName('一句话超过二十四个字符的目标需要被截断处理才行哦真长'), '一句话超过二十四个字符的目标需要被截断处理才行哦…');
  assert.equal(derivePlanName(''), 'Plan');
});

test('parseNumberedSteps：编号行→步骤,非编号行滤除(计划书 Steps 解析权威)', () => {
  assert.deepEqual(
    parseNumberedSteps('# 计划\n1. A\n2. B\n\n说明段\n3、C  \n'),
    ['A', 'B', 'C'],
    '编号行去前缀,散文/标题/空行滤除',
  );
  assert.deepEqual(parseNumberedSteps('没有编号'), [], '零编号=空(交稿无步骤→宿主拒绝面)');
});

test('PLAN_MODE_NOTE：armed 提交注入链的提示面(只读约束+exit_plan 协议+批准后 todo 自管)', () => {
  assert.match(PLAN_MODE_NOTE, /exit_plan/);
  assert.match(PLAN_MODE_NOTE, /read-only/i);
  assert.match(PLAN_MODE_NOTE, /todo_write/);
});
