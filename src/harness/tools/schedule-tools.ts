// schedule_wakeup / schedule_task（2026-11-15 sunx P2 Task 3）：sunx 编排主链的定时调度原语工具面。
// 二具同底座：timing 归一单点（delay_seconds/at_iso 二选一必填——双填/双缺 INVALID_ARG，at_iso 解析
// 失败 INVALID_ARG）+ arm 接缝（宿主 SessionRuntime TimerController——单活跃调度位替换语义，回执
// 承载 id/触发时刻/被替换者）。本文件零派发零定时：schedule_task 只把自包含简报随调度位落档
// （taskSpec 字段），到点 fork 派发由宿主 fire 回调统一执行（subagent.forkDispatch 同款路径）。
// 仅 sunx 会话注册（harness/index.ts kind 分叉）；接缝缺席（测试直构 Harness）= NOT_SUPPORTED 确定降级。
import { CodedToolError, RegisteredTool, jsonAbsent } from '../tools';

/** 定时调度 arm 接缝（宿主注入，harness/index.ts opts.schedule 透传）：id 铸造权在宿主
 *  （sched-<n> 会话内单调——账面寻址键），返回被替换旧调度 id 供回执说明替换语义 */
export interface ScheduleArmSeam {
  arm(rec: { fireAt: number; note: string; taskSpec?: string }): { id: string; replacedId?: string };
}

/** timing 归一单点（两工具共用）：二选一必填（双填/双缺 INVALID_ARG）；delay_seconds 须正数；
 *  at_iso 须可解析时刻（过去时刻=立即触发，R7 错过语义同源——模型自主裁定）。返回 fireAt epoch ms */
function parseScheduleFireAt(raw: { delay_seconds?: unknown; at_iso?: unknown }, nowMs: number): number {
  const hasDelay = raw.delay_seconds !== undefined && !jsonAbsent(raw.delay_seconds);
  const hasAt = raw.at_iso !== undefined && !jsonAbsent(raw.at_iso, true);
  if (hasDelay === hasAt) {
    throw new CodedToolError('INVALID_ARG', 'exactly one of delay_seconds or at_iso is required (pass the other as JSON null)');
  }
  if (hasDelay) {
    const d = raw.delay_seconds;
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) {
      throw new CodedToolError('INVALID_ARG', `delay_seconds must be a positive number of seconds, got: ${String(d)}`);
    }
    return nowMs + d * 1000;
  }
  const s = raw.at_iso;
  if (typeof s !== 'string' || s.trim() === '') {
    throw new CodedToolError('INVALID_ARG', `at_iso must be an ISO-8601 timestamp string, got: ${String(s)}`);
  }
  const at = Date.parse(s);
  if (Number.isNaN(at)) {
    throw new CodedToolError('INVALID_ARG', `at_iso is not a parseable ISO-8601 timestamp: ${s}`);
  }
  return at;
}

/** 回执串单点：`scheduled wakeup <id> at <iso> — <note>`（+被替换说明行）；schedule_task 同构换头 */
function scheduleReceipt(kind: 'wakeup' | 'task', id: string, fireAt: number, note: string, replacedId?: string): string {
  const lines = [`scheduled ${kind} ${id} at ${new Date(fireAt).toISOString()} — ${note}`];
  if (replacedId !== undefined) lines.push(`replaced previous schedule ${replacedId}`);
  return lines.join('\n');
}

/** 共用参数面（可空联合进 required——仓内 schema 约定，strict 端点缺省可选项发字面 null） */
function sharedParams(timingDesc: string, noteDesc: string) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['delay_seconds', 'at_iso'],
    properties: {
      delay_seconds: { type: ['number', 'null'], description: timingDesc },
      at_iso: { type: ['string', 'null'], description: 'Fire at an absolute ISO-8601 timestamp (e.g. "2026-11-15T09:30:00Z"); mutually exclusive with delay_seconds — pass exactly one, the other JSON null' },
      note: { type: 'string', description: noteDesc },
    },
  };
}

/** schedule_wakeup 工具工厂（P2 Task 3）：二选一 timing + note——到点=定时唤醒轮（submitWake 同管线：
 *  <schedule-wake> notice 携 schedule 标记、显示前缀「定时唤醒」、安静清单、计入连续唤醒上限）。
 *  重复 arm=替换（一会话一活跃调度位，MVP）——回执注明被替换者 */
export function makeScheduleWakeupTool(arm?: ScheduleArmSeam): RegisteredTool {
  return {
    parameters: sharedParams(
      'Fire after this many seconds; mutually exclusive with at_iso — pass exactly one, the other JSON null',
      'What this wake is for (shown to you verbatim in the wake notice); make it self-standing',
    ),
    name: 'schedule_wakeup',
    description:
      'Schedule one future wake-up for THIS session: after the delay (delay_seconds) or at the absolute time (at_iso — exactly one of the two, the other JSON null), the session is woken automatically with a scheduled-wake notice carrying your note verbatim; continue your outstanding goals then, or reply briefly if nothing remains. One active schedule per session: scheduling again replaces the previous one (the receipt names what was replaced). Notes must be self-standing (the wake notice is not a user message). Use it for time-based follow-ups (check a deploy in 10 minutes, revisit at 09:00); to run work at a future time use schedule_task instead.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      if (arm === undefined) throw new CodedToolError('NOT_SUPPORTED', 'scheduling requires the timer seam (not wired in this assembly)');
      const raw = input as { note?: unknown; delay_seconds?: unknown; at_iso?: unknown };
      const note = typeof raw.note === 'string' ? raw.note.trim() : '';
      if (note === '') throw new CodedToolError('INVALID_ARG', 'note is required (non-empty): it is shown verbatim in the wake notice');
      const fireAt = parseScheduleFireAt(raw, Date.now());
      const r = arm.arm({ fireAt, note });
      return { exitCode: 0, stdout: scheduleReceipt('wakeup', r.id, fireAt, note, r.replacedId), stderr: '', timedOut: false };
    },
  };
}

/** schedule_task 工具工厂（P2 Task 3）：timing + 自包含简报 spec（agent_id/label 命名面）——到点宿主
 *  先 fork 派发（dispatch_task fork 通道同款路径）再起定时唤醒轮（同一回调内完成）。note 缺省=
 *  label ?? spec 首行（通知文正文兼作派发台账任务名）；重复 arm=替换同上 */
export function makeScheduleTaskTool(arm?: ScheduleArmSeam): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['spec', 'agent_id', 'label', 'delay_seconds', 'at_iso'],
      properties: {
        spec: { type: 'string', description: 'Self-contained task brief for the dispatched executor: goal, key facts, paths, constraints, and ACCEPTANCE criteria (it cannot see this conversation)' },
        agent_id: { type: ['string', 'null'], description: 'Registered agent id or preset role for the future dispatch; JSON null = inline subagent' },
        label: { type: ['string', 'null'], description: 'Short name for the scheduled task (dispatch ledger label and wake-note title); JSON null defaults to the first line of spec' },
        delay_seconds: { type: ['number', 'null'], description: 'Dispatch after this many seconds; mutually exclusive with at_iso — pass exactly one, the other JSON null' },
        at_iso: { type: ['string', 'null'], description: 'Dispatch at an absolute ISO-8601 timestamp; mutually exclusive with delay_seconds — pass exactly one, the other JSON null' },
      },
    },
    name: 'schedule_task',
    description:
      'Schedule one work unit to be DISPATCHED automatically in the future: after the delay (delay_seconds) or at the absolute time (at_iso — exactly one of the two, the other JSON null) the session forks a background subagent with this spec (same path as dispatch_task fork channel; agent_id selects a registered agent or preset role, JSON null = inline) and then wakes you with a scheduled-wake notice, so the task runs even if the conversation went idle. The spec must be a self-contained brief (goal, key facts, paths, constraints, ACCEPTANCE criteria). label titles the future task; scheduling again replaces the previous schedule session-wide (receipt names what was replaced). One active schedule per session.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      if (arm === undefined) throw new CodedToolError('NOT_SUPPORTED', 'scheduling requires the timer seam (not wired in this assembly)');
      const raw = input as { spec?: unknown; agent_id?: unknown; label?: unknown; delay_seconds?: unknown; at_iso?: unknown };
      const spec = typeof raw.spec === 'string' ? raw.spec.trim() : '';
      if (spec === '') throw new CodedToolError('INVALID_ARG', 'spec is required: a self-contained brief for the future dispatch (the executor cannot see this conversation)');
      const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : undefined;
      const note = label ?? spec.split('\n')[0]!.trim();
      const fireAt = parseScheduleFireAt(raw, Date.now());
      const r = arm.arm({ fireAt, note, taskSpec: spec });
      return { exitCode: 0, stdout: scheduleReceipt('task', r.id, fireAt, note, r.replacedId), stderr: '', timedOut: false };
    },
  };
}
