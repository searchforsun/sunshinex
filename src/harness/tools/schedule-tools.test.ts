// schedule_wakeup / schedule_task 工具面单测（2026-11-15 sunx P2 Task 3）：timing 归一单点四钉
// （双填/双缺 INVALID_ARG、delay_seconds 非正数 INVALID_ARG、at_iso 解析失败 INVALID_ARG、合法时刻
// 透传）、arm 接缝三钉（回执方言逐字节、被替换者透传回执、taskSpec 随载荷落缝）、接缝缺席
// NOT_SUPPORTED 确定降级（dispatch team 缝先例）、schedule_task note 缺省=label ?? spec 首行。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeScheduleWakeupTool, makeScheduleTaskTool } from './schedule-tools';
import { CodedToolError } from '../tools';

/** arm 缝桩：记录载荷、返回可编程被替换者 */
function armStub(replacedId?: string) {
  const calls: Array<{ fireAt: number; note: string; taskSpec?: string }> = [];
  return {
    calls,
    seam: {
      arm: (rec: { fireAt: number; note: string; taskSpec?: string }) => {
        calls.push(rec);
        return { id: 'sched-9', ...(replacedId !== undefined ? { replacedId } : {}) };
      },
    },
  };
}

const executorOf = (tool: ReturnType<typeof makeScheduleWakeupTool>): ((input: unknown) => Promise<{ exitCode: number; stdout: string }>) =>
  tool.executor as (input: unknown) => Promise<{ exitCode: number; stdout: string }>;

describe('schedule_wakeup', () => {
  test('timing 四钉：双填/双缺 INVALID_ARG；delay 非正数 INVALID_ARG；at_iso 解析失败 INVALID_ARG', async () => {
    const { seam } = armStub();
    const tool = makeScheduleWakeupTool(seam);
    const exec = executorOf(tool);
    const bad = async (input: Record<string, unknown>, why: string): Promise<void> => {
      await assert.rejects(() => exec({ note: 'n', ...input }), (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG', why);
    };
    await bad({ delay_seconds: 5, at_iso: '2026-01-01T00:00:00Z' }, '双填拒');
    await bad({ delay_seconds: null, at_iso: null }, '双缺拒');
    await bad({ delay_seconds: 0 }, 'delay 0 拒（须正数）');
    await bad({ delay_seconds: -3 }, '负 delay 拒');
    await bad({ at_iso: 'not-a-timestamp' }, 'at_iso 解析失败拒');
    await assert.rejects(() => exec({ note: '', delay_seconds: 5 }), (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG', '空 note 拒');
  });

  test('合法 arm：回执方言逐字节 + note 透传 + 被替换者回执说明', async () => {
    const { seam, calls } = armStub('sched-1');
    const exec = executorOf(makeScheduleWakeupTool(seam));
    const r = await exec({ note: 'check the oven', delay_seconds: 120, at_iso: null });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /^scheduled wakeup sched-9 at /, '回执方言：scheduled wakeup <id> at <iso>');
    assert.match(r.stdout, /— check the oven\n/, 'note 在回执首行');
    assert.match(r.stdout, /replaced previous schedule sched-1$/, '被替换者回执说明');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.note, 'check the oven');
    assert.ok(calls[0]!.fireAt > Date.now() + 100_000, 'fireAt=now+delay');
    assert.equal(calls[0]!.taskSpec, undefined, '纯唤醒零 taskSpec');
    // at_iso 通道：解析时刻原样透传
    await exec({ note: 'at noon', delay_seconds: null, at_iso: '2027-01-01T12:00:00Z' });
    assert.equal(calls[1]!.fireAt, Date.parse('2027-01-01T12:00:00Z'));
  });

  test('接缝缺席=NOT_SUPPORTED 确定降级（测试直构 Harness 形态）', async () => {
    const exec = executorOf(makeScheduleWakeupTool());
    await assert.rejects(() => exec({ note: 'n', delay_seconds: 5 }), (e: unknown) => e instanceof CodedToolError && e.code === 'NOT_SUPPORTED');
  });
});

describe('schedule_task', () => {
  test('spec 必填拒；note 缺省=label ?? spec 首行；taskSpec 随载荷落缝', async () => {
    const { seam, calls } = armStub();
    const exec = executorOf(makeScheduleTaskTool(seam));
    await assert.rejects(() => exec({ spec: '', label: null, agent_id: null, delay_seconds: 5, at_iso: null }), (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG', '空 spec 拒');
    await exec({ spec: 'Fix the login flow.\nAcceptance: login works', label: null, agent_id: null, delay_seconds: null, at_iso: '2027-06-01T00:00:00Z' });
    assert.equal(calls[0]!.note, 'Fix the login flow.', 'note 缺省=spec 首行');
    assert.equal(calls[0]!.taskSpec, 'Fix the login flow.\nAcceptance: login works', '自包含简报随调度位');
    await exec({ spec: 'Do the thing', label: 'thing-doer', agent_id: null, delay_seconds: 30, at_iso: null });
    assert.equal(calls[1]!.note, 'thing-doer', 'label 优先为 note');
    const r = await exec({ spec: 'Do it again', label: null, agent_id: null, delay_seconds: 30, at_iso: null });
    assert.match(r.stdout, /^scheduled task sched-9 at /, '回执方言：scheduled task <id> at <iso>');
  });

  test('timing 归一同底座：双缺 INVALID_ARG；接缝缺席 NOT_SUPPORTED', async () => {
    const { seam } = armStub();
    const exec = executorOf(makeScheduleTaskTool(seam));
    await assert.rejects(() => exec({ spec: 's', delay_seconds: null, at_iso: null }), (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG');
    const bare = executorOf(makeScheduleTaskTool());
    await assert.rejects(() => bare({ spec: 's', delay_seconds: 5, at_iso: null }), (e: unknown) => e instanceof CodedToolError && e.code === 'NOT_SUPPORTED');
  });
});
