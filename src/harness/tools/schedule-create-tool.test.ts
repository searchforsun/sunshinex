// create_scheduled_task 工具面单测（2026-11-20）：入参归一/默认值（root=当前会话、effort=medium、
// mode=full-access、start_at=now）/ISO 解析/宿主接缝 Result 错误转译/NOT_SUPPORTED 确定降级/回执方言。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeCreateScheduledTaskTool } from './schedule-create-tool';
import type { ScheduleCreateDraft, ScheduleCreateSeam } from './schedule-create-tool';
import { CodedToolError } from '../tools';

type Exec = (input: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

function seamStub(): { calls: ScheduleCreateDraft[]; seam: ScheduleCreateSeam } {
  const calls: ScheduleCreateDraft[] = [];
  return {
    calls,
    seam: {
      create: (draft) => {
        calls.push(draft);
        return { ok: true, value: { id: 'sch-abc', name: draft.name, nextRunAt: 1_800_000_000_000, enabled: true } };
      },
    },
  };
}

const execOf = (tool: ReturnType<typeof makeCreateScheduledTaskTool>): Exec => tool.executor as Exec;

function input(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '晨间巡检',
    prompt: '总结昨天以来的提交并给出风险提示',
    recurrence: { unit: 'day', every: 1, at: '09:00', weekdays: null, day_of_month: null, month: null, day: null },
    start_at: null,
    until: null,
    root: null,
    effort: null,
    mode: null,
    ...over,
  };
}

describe('create_scheduled_task', () => {
  test('缺省值单点：root=当前会话、effort=medium、mode=full-access、start_at=now；回执含 id/下次/周期', async () => {
    const { seam, calls } = seamStub();
    const now = 1_700_000_000_000;
    const exec = execOf(makeCreateScheduledTaskTool(seam, '/w/session-root', () => now));
    const r = await exec(input());
    assert.equal(r.exitCode, 0);
    assert.equal(calls.length, 1);
    const d = calls[0]!;
    assert.equal(d.name, '晨间巡检');
    assert.equal(d.prompt, '总结昨天以来的提交并给出风险提示');
    assert.equal(d.root, '/w/session-root');
    assert.equal(d.effort, 'medium');
    assert.equal(d.mode, 'full-access');
    assert.equal(d.startAt, now);
    assert.equal(d.until, undefined);
    assert.deepEqual(d.recurrence, { unit: 'day', every: 1, at: '09:00' });
    assert.match(r.stdout, /^created scheduled task "晨间巡检" \(sch-abc\)\n/);
    assert.match(r.stdout, /next run: /);
    assert.match(r.stdout, /workspace: \/w\/session-root/);
    assert.match(r.stdout, /cadence: every 1 day\(s\) at 09:00/);
  });

  test('显式参数：绝对 root/effort/mode/ISO start_at/until/weekdays 原样落草稿', async () => {
    const { seam, calls } = seamStub();
    const exec = execOf(makeCreateScheduledTaskTool(seam, '/ignored', () => 0));
    const start = '2026-11-21T10:30:00+08:00';
    const until = '2026-12-01T00:00:00+08:00';
    const r = await exec(
      input({
        recurrence: { unit: 'week', every: 1, at: '10:30', weekdays: [1, 3, 5], day_of_month: null, month: null, day: null },
        start_at: start,
        until,
        root: '/w/other',
        effort: 'high',
        mode: 'acceptEdits',
      }),
    );
    assert.equal(r.exitCode, 0);
    const d = calls[0]!;
    assert.equal(d.startAt, Date.parse(start));
    assert.equal(d.until, Date.parse(until));
    assert.equal(d.root, '/w/other');
    assert.equal(d.effort, 'high');
    assert.equal(d.mode, 'acceptEdits');
    assert.deepEqual(d.recurrence.weekdays, [1, 3, 5]);
    assert.match(r.stdout, /cadence: every 1 week\(s\) on days 1,3,5/);
  });

  test('month/year 字段映射：day_of_month→dayOfMonth、month/day', async () => {
    const { seam, calls } = seamStub();
    const exec = execOf(makeCreateScheduledTaskTool(seam, '/w', () => 0));
    await exec(input({ recurrence: { unit: 'month', every: 1, at: '08:00', weekdays: null, day_of_month: 1, month: null, day: null } }));
    await exec(input({ recurrence: { unit: 'year', every: 1, at: '08:00', weekdays: null, day_of_month: null, month: 3, day: 5 } }));
    assert.equal(calls[0]!.recurrence.dayOfMonth, 1);
    assert.equal(calls[1]!.recurrence.month, 3);
    assert.equal(calls[1]!.recurrence.day, 5);
  });

  test('执行边界剥 null 键后（undefined 缺席）仍按缺省处理', async () => {
    const { seam, calls } = seamStub();
    const now = 1_700_000_000_000;
    const exec = execOf(makeCreateScheduledTaskTool(seam, '/w/session-root', () => now));
    // stripNullInputArgs 的真实形态：可选项整键消失（不是 null）
    const r = await exec({
      name: '晨间巡检',
      prompt: '总结昨天以来的提交',
      recurrence: { unit: 'day', every: 1, at: '09:00' },
    });
    assert.equal(r.exitCode, 0);
    const d = calls[0]!;
    assert.equal(d.startAt, now);
    assert.equal(d.root, '/w/session-root');
    assert.equal(d.effort, 'medium');
    assert.equal(d.mode, 'full-access');
    assert.deepEqual(d.recurrence, { unit: 'day', every: 1, at: '09:00' });
  });

  test('入参拒绝：空 name/prompt、缺 recurrence、坏 ISO、until<=start_at', async () => {
    const { seam } = seamStub();
    const exec = execOf(makeCreateScheduledTaskTool(seam, '/w', () => 1_700_000_000_000));
    const bad = async (over: Record<string, unknown>, why: string): Promise<void> => {
      await assert.rejects(() => exec(input(over)), (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG', why);
    };
    await bad({ name: '' }, '空 name 拒');
    await bad({ prompt: '   ' }, '空 prompt 拒');
    await bad({ recurrence: null }, 'recurrence 缺失拒');
    await bad({ start_at: 'not-a-time' }, '坏 start_at 拒');
    await bad({ until: 'not-a-time' }, '坏 until 拒');
    await bad({ until: '2026-01-01T00:00:00Z', start_at: '2026-06-01T00:00:00Z' }, 'until 早于 start_at 拒');
  });

  test('宿主校验失败 → 同码 CodedToolError；接缝缺席 → NOT_SUPPORTED', async () => {
    const errSeam: ScheduleCreateSeam = { create: () => ({ ok: false, code: 'INVALID_ARG', message: 'recurrence.at must be HH:mm' }) };
    const exec = execOf(makeCreateScheduledTaskTool(errSeam, '/w'));
    await assert.rejects(
      () => exec(input()),
      (e: unknown) => e instanceof CodedToolError && e.code === 'INVALID_ARG' && /HH:mm/.test(e.message),
    );
    const missing = execOf(makeCreateScheduledTaskTool(undefined, '/w'));
    await assert.rejects(() => missing(input()), (e: unknown) => e instanceof CodedToolError && e.code === 'NOT_SUPPORTED');
  });
});
