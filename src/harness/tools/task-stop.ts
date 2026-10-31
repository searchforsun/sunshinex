// task_stop：按 id 停止工作。
// 板任务是生命周期权威：pending|running → board.stopTask 落 cancelled；running 再调台账 stop，执行体中止、台账终态 stopped。
// 纯台账任务（后台 exec / 非板子智能体）保持 stopped。
// 终态幂等回执当前态，不重复 abort。teammate 按名只打断当前任务，成员继续存活并领取后续板任务。
import { CodedToolError, RegisteredTool } from '../tools';
import type { BackgroundTask, TaskRegistry } from '../tasks';
import type { TeamRegistry } from '../../taskboard/teammate';
import { dispatchTag, type TaskBoard } from '../../taskboard/board';

const BOARD_TERMINAL = new Set(['success', 'failed', 'cancelled']);

function receipt(stdout: string): { exitCode: number; stdout: string; stderr: string; timedOut: boolean } {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

/** 板键：原生 id、旧档 task-tN、或台账 label（dispatchTag）反查 */
function boardKeyOf(board: TaskBoard, tasks: TaskRegistry, rawId: string): string | undefined {
  const snap = board.snapshot().tasks;
  if (snap[rawId] !== undefined) return rawId;
  const legacy = /^task-(t\d+)$/.exec(rawId);
  if (legacy !== null && snap[legacy[1]] !== undefined) return legacy[1];
  const ledger = tasks.get(tasks.resolveId(rawId));
  if (ledger === undefined) return undefined;
  if (snap[ledger.label] !== undefined) return ledger.label;
  const fromTag = /^task-(t\d+)$/.exec(ledger.label);
  if (fromTag !== null && snap[fromTag[1]] !== undefined) return fromTag[1];
  return undefined;
}

/** 板任务对应的台账条目：resolveId(板 id / dispatchTag) 优先，external-cli 标签兜底 */
function ledgerForBoard(tasks: TaskRegistry, boardKey: string, rawId: string): BackgroundTask | undefined {
  const tag = dispatchTag(boardKey);
  for (const id of [rawId, boardKey, tag]) {
    const hit = tasks.get(tasks.resolveId(id));
    if (hit !== undefined) return hit;
  }
  const labels = new Set([tag, `external-${boardKey}`]);
  const hits = tasks.list().filter((t) => labels.has(t.label));
  if (hits.length === 0) return undefined;
  return hits.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
}

/** 执行体中止并收口台账。stop 句柄由提交方挂载（fork/teammate=abort，external=强杀）；已终态的 finish 幂等 */
function abortLedger(tasks: TaskRegistry, ledger: BackgroundTask | undefined): void {
  if (ledger === undefined) return;
  ledger.stop?.();
  const now = tasks.get(ledger.id);
  if (now !== undefined && (now.status === 'running' || now.status === 'paused')) {
    tasks.finish(ledger.id, 'stopped', { marker: '[stopped: task_stop]' });
  }
}

export function makeTaskStopTool(tasks: TaskRegistry, team?: TeamRegistry, board?: TaskBoard): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: {
          type: 'string',
          description:
            'Id to stop. A board task id as create_task or the board summary shows it (e.g. "task-build-parser-k3f2"; legacy restored boards use "t5") stops a pending or running task as cancelled. A ledger id (label-slug-UTCtimestamp-rand, e.g. exec-20261003T064522Z-a7f3) stops background exec or a non-board subagent as stopped. A live teammate name interrupts its current task. Unknown ids return the current stoppable list in the error.',
        },
      },
    },
    name: 'task_stop',
    description:
      'Stop work by id. Pending and running board tasks become cancelled; a running board task also aborts its executor and its ledger entry finishes stopped, while the teammate that was running it stays alive and keeps claiming later tasks. Background exec, timed-out-to-background exec, and background subagent entries that are not board tasks finish as stopped. Already-finished work returns an idempotent receipt of its terminal status (board: success, failed, or cancelled; ledger: done, failed, or stopped) and is not aborted again. A live teammate name interrupts only that teammate\'s current task. Unknown ids fail with the current stoppable list attached.',
    category: 'task',
    executor: async (input) => {
      const rawId = String(input.taskId ?? '').trim();
      if (rawId === '') throw new CodedToolError('INVALID_ARG', 'taskId is required');
      const boardKey = board !== undefined ? boardKeyOf(board, tasks, rawId) : undefined;
      if (boardKey !== undefined && board !== undefined) {
        const before = board.snapshot().tasks[boardKey]!;
        if (BOARD_TERMINAL.has(before.status)) {
          return receipt(`task ${boardKey} already finished with status ${before.status}`);
        }
        const ledger = before.status === 'running' ? ledgerForBoard(tasks, boardKey, rawId) : undefined;
        const stopped = board.stopTask(boardKey);
        if (!stopped.ok) throw new CodedToolError(stopped.error.code, stopped.error.message);
        if (before.status === 'running') abortLedger(tasks, ledger);
        return receipt(`task ${boardKey} cancelled (${before.title})`);
      }
      const taskId = tasks.resolveId(rawId);
      const task = tasks.get(taskId);
      if (task === undefined) {
        // 控制面(与等待面分立):teammate 按名打断其当前任务——成员=上下文承载体(无生命周期,不消亡),
        // 任务才有生命周期;打断后成员存活继续 claim 后续板任务
        const tm = team?.get(rawId);
        if (tm !== undefined) {
          const interrupted = tm.interruptCurrent();
          return receipt(interrupted
            ? `teammate ${rawId} current task interrupted (teammate persists and keeps claiming board tasks)`
            : `teammate ${rawId} is idle — no running task to interrupt`);
        }
        const ledger = tasks
          .list()
          .map((t) => `${t.id} (${t.kind}, ${t.status}) ${t.label}`)
          .join('; ');
        const mates = team?.aliveNames().map((n) => `${n} (teammate, interrupt by name)`) ?? [];
        const boardList = Object.values(board?.snapshot().tasks ?? {})
          .map((t) => `${t.id} (board, ${t.status}) ${t.title}`)
          .join('; ');
        const surface = [...mates, ledger, boardList].filter((x) => x !== '').join('; ');
        throw new CodedToolError('INVALID_ARG', `Unknown task id: ${rawId}. Stoppable now: ${surface === '' ? '(none)' : surface}`);
      }
      if (task.status === 'running') {
        abortLedger(tasks, task);
        return receipt(`task ${taskId} stopped (${task.label})`);
      }
      return receipt(`task ${taskId} already finished with status ${task.status}`);
    },
  };
}
