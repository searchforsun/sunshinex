// task_stop：仅停台账 exec/spawn（及超时转后台）后台条目。
// agent_team_task_stop：板任务取消（stopBoardTask）+ 按名打断存活成员（TeamRegistry）。
// 分域拒识：task_stop 遇板 id → INVALID_ARG 点名 agent_team_task_stop；对称拒识纯台账 id。
// 终态幂等回执当前态，不重复 abort。成员按名只打断当前任务，成员继续存活并领取后续板任务。
import { CodedToolError, RegisteredTool } from '../tools';
import type { BackgroundTask, TaskRegistry } from '../tasks';
import type { TeamRegistry } from '../../taskboard/teammate';
import { BOARD_TERMINAL } from '../../taskboard/model';
import { dispatchTag, type TaskBoard } from '../../taskboard/board';
import { fail, ok, type Result } from '../../result';

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

export interface BoardStopReceipt {
  taskId: string;
  status: string;
  title: string;
  alreadyFinished: boolean;
}

/** 板任务停：pending|running → cancelled；running 再 abort 台账。非板 id 返回 undefined，调用方走成员面或拒识。 */
export function stopBoardTask(board: TaskBoard, tasks: TaskRegistry, rawId: string): Result<BoardStopReceipt> | undefined {
  const boardKey = boardKeyOf(board, tasks, rawId);
  if (boardKey === undefined) return undefined;
  const before = board.snapshot().tasks[boardKey]!;
  if (BOARD_TERMINAL.has(before.status)) {
    return ok({ taskId: boardKey, status: before.status, title: before.title, alreadyFinished: true });
  }
  const ledger = before.status === 'running' ? ledgerForBoard(tasks, boardKey, rawId) : undefined;
  const stopped = board.stopTask(boardKey);
  if (!stopped.ok) return fail(stopped.error.code, stopped.error.message);
  if (before.status === 'running') abortLedger(tasks, ledger);
  return ok({ taskId: boardKey, status: 'cancelled', title: before.title, alreadyFinished: false });
}

/** 执行体中止并收口台账。stop 句柄由提交方挂载（fork/teammate=abort，external=强杀）；已终态的 finish 幂等 */
export function abortLedger(tasks: TaskRegistry, ledger: BackgroundTask | undefined): void {
  if (ledger === undefined) return;
  ledger.stop?.();
  const now = tasks.get(ledger.id);
  if (now !== undefined && now.status === 'running') {
    tasks.finish(ledger.id, 'stopped', { marker: '[stopped: task_stop]' });
  }
}

/** 台账停止：exec / spawn。板 id → INVALID_ARG 点名 agent_team_task_stop。board 仅供拒识。 */
export function makeTaskStopTool(tasks: TaskRegistry, board?: TaskBoard): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: {
          type: 'string',
          description:
            'Background exec/spawn ledger id only. Board task ids and living teammate names belong to agent_team_task_stop.',
        },
      },
    },
    name: 'task_stop',
    description:
      'Stop a background exec/spawn ledger task by id. Board task ids and living teammate names belong to agent_team_task_stop. Already-terminal ledger ids return an idempotent receipt. Unknown ids fail with the stoppable ledger list.',
    category: 'task',
    executor: async (input) => {
      const rawId = String(input.taskId ?? '').trim();
      if (rawId === '') throw new CodedToolError('INVALID_ARG', 'taskId is required');
      if (board !== undefined && boardKeyOf(board, tasks, rawId) !== undefined) {
        throw new CodedToolError(
          'INVALID_ARG',
          `Board task ids belong to agent_team_task_stop, not task_stop: ${rawId}`,
        );
      }
      const taskId = tasks.resolveId(rawId);
      const task = tasks.get(taskId);
      if (task === undefined) {
        const ledger = tasks
          .list()
          .map((t) => `${t.id} (${t.kind}, ${t.status}) ${t.label}`)
          .join('; ');
        throw new CodedToolError(
          'INVALID_ARG',
          `Unknown task id: ${rawId}. Stoppable now: ${ledger === '' ? '(none)' : ledger}. Board task ids and teammate names use agent_team_task_stop.`,
        );
      }
      if (task.status === 'running') {
        abortLedger(tasks, task);
        return receipt(`task ${taskId} stopped (${task.label})`);
      }
      return receipt(`task ${taskId} already finished with status ${task.status}`);
    },
  };
}

/** 板任务取消 + 按名打断成员。纯台账 exec/spawn id → INVALID_ARG 点名 task_stop。 */
export function makeAgentTeamTaskStopTool(tasks: TaskRegistry, team: TeamRegistry, board: TaskBoard): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: {
          type: 'string',
          description:
            'Board task id (cancel pending/running) or living teammate name (interrupt current task only). Exec/spawn-only ledger ids belong to task_stop.',
        },
      },
    },
    name: 'agent_team_task_stop',
    description:
      'Stop team work by id. Board pending/running → cancelled (running also aborts the executor); the teammate stays and can claim later tasks. A teammate name interrupts only that member\'s current task. Already-terminal board ids return an idempotent receipt. Exec/spawn-only ledger ids belong to task_stop.',
    category: 'task',
    executor: async (input) => {
      const rawId = String(input.taskId ?? '').trim();
      if (rawId === '') throw new CodedToolError('INVALID_ARG', 'taskId is required');
      const stopped = stopBoardTask(board, tasks, rawId);
      if (stopped !== undefined) {
        if (!stopped.ok) throw new CodedToolError(stopped.error.code, stopped.error.message);
        const { taskId, status, title, alreadyFinished } = stopped.value;
        return alreadyFinished
          ? receipt(`task ${taskId} already finished with status ${status}`)
          : receipt(`task ${taskId} cancelled (${title})`);
      }
      const tm = team.get(rawId);
      if (tm !== undefined) {
        const interrupted = tm.interruptCurrent();
        return receipt(
          interrupted
            ? `teammate ${rawId} current task interrupted (teammate persists and keeps claiming board tasks)`
            : `teammate ${rawId} is idle — no running task to interrupt`,
        );
      }
      const taskId = tasks.resolveId(rawId);
      const task = tasks.get(taskId);
      if (task !== undefined) {
        throw new CodedToolError(
          'INVALID_ARG',
          `agent_team_task_stop only accepts board task ids and living teammate names; exec/spawn-only ids belong to task_stop: ${rawId} (${task.kind})`,
        );
      }
      const mates = team.aliveNames().map((n) => `${n} (teammate, interrupt by name)`);
      const boardList = Object.values(board.snapshot().tasks)
        .map((t) => `${t.id} (board, ${t.status}) ${t.title}`)
        .join('; ');
      const surface = [...mates, boardList].filter((x) => x !== '').join('; ');
      throw new CodedToolError(
        'INVALID_ARG',
        `Unknown task id: ${rawId}. Stoppable now: ${surface === '' ? '(none)' : surface}`,
      );
    },
  };
}
