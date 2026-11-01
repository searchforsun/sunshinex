// task_wait：仅等台账 exec / spawn(subagent) 后台任务到终态并内联回执（对标 CC TaskOutput）。
// agent_team_task_wait：仅等板任务（可含板派发台账 id）；板态轮询至 success/failed/cancelled。
// 分域拒识：task_wait 遇板 id → INVALID_ARG 点名 agent_team_task_wait；对称拒识 exec/spawn 纯后台 id。
// taskIds=null：task_wait 等当前 running 台账；agent_team_task_wait 等板上非终态任务。
// timeoutSeconds=0 非阻塞 peek；子面 kinds=['exec'] 防板派发台账自等。
import * as fs from 'fs';
import { CodedToolError, RegisteredTool } from '../tools';
import type { BackgroundTask, TaskRegistry } from '../tasks';
import type { TaskBoard } from '../../taskboard/board';
import { dispatchTag } from '../../taskboard/board';

const DEFAULT_TIMEOUT_SECONDS = 1800;
const RECEIPT_TAIL_LINES = 200;
/** 板任务终态：success 完成、failed 执行错误、cancelled 主动停止或重启自愈 */
const BOARD_TERMINAL = new Set(['success', 'failed', 'cancelled']);

export type TaskWaitKind = BackgroundTask['kind'];

export interface TaskWaitToolOpts {
  /** 可等待的台账 kind；缺省 exec+subagent。子面传 ['exec'] 排除板派发台账自等 */
  readonly kinds?: readonly TaskWaitKind[];
}

function readTail(filePath: string, lines: number): string {
  try {
    const all = fs.readFileSync(filePath, 'utf8').split('\n');
    while (all.length > 0 && all[all.length - 1] === '') all.pop();
    return all.slice(-lines).join('\n');
  } catch {
    return '(log unavailable)';
  }
}

function receiptBody(t: BackgroundTask, againTool: string): string {
  const code = t.exitCode !== undefined ? `, exit ${t.exitCode}` : '';
  const head = `${t.id} (${t.kind}) ${t.status}${code} — ${t.label}`;
  if (t.status === 'running') {
    return `${head} (still running; call ${againTool} again to continue waiting, or task_stop / agent_team_task_stop to cancel)`;
  }
  if (t.kind === 'subagent') {
    const log = fs.readFileSync(t.outputFilePath, 'utf8');
    const idx = log.indexOf('[conclusion] ');
    if (idx >= 0) return `${head}\n${log.slice(idx).trimEnd()}`;
  }
  return `${head}\n${readTail(t.outputFilePath, RECEIPT_TAIL_LINES)}`;
}

function boardKeyOf(boardTasks: Record<string, { id: string }>, rawId: string): string | undefined {
  if (boardTasks[rawId] !== undefined) return rawId;
  const m = /^task-(t\d+)$/.exec(rawId); // 旧档委派形态 task-tN → 板键 tN
  return m !== null && boardTasks[m[1]] !== undefined ? m[1] : undefined;
}

function parseTimeout(rawTimeout: number | null): number {
  const timeoutSeconds = rawTimeout === null ? DEFAULT_TIMEOUT_SECONDS : rawTimeout;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new CodedToolError(
      'INVALID_ARG',
      `timeoutSeconds must be a non-negative number (0 = non-blocking status peek), got: ${String(rawTimeout)}`,
    );
  }
  return timeoutSeconds;
}

async function waitMixed(
  tasks: TaskRegistry,
  ids: string[],
  board: TaskBoard | undefined,
  boardWaitIds: string[],
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<TaskRegistry['waitUntilSettled']>>> {
  const boardStatus = (id: string): string | undefined => board?.snapshot().tasks[id]?.status;
  const boardPending = (): string[] => boardWaitIds.filter((id) => !BOARD_TERMINAL.has(boardStatus(id) ?? ''));
  if (boardWaitIds.length === 0) {
    return tasks.waitUntilSettled(ids, timeoutSeconds * 1000, signal);
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    if (signal?.aborted) {
      return { settled: false, tasks: ids.map((id) => tasks.get(id)!).filter((t) => t !== undefined) };
    }
    const ledgerRunning = ids.filter((id) => tasks.get(id)?.status === 'running');
    if (ledgerRunning.length === 0 && boardPending().length === 0) {
      return { settled: true, tasks: ids.map((id) => tasks.get(id)!).filter((t) => t !== undefined) };
    }
    if (Date.now() >= deadline) {
      return { settled: false, tasks: ids.map((id) => tasks.get(id)!).filter((t) => t !== undefined) };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function formatReceipt(
  result: Awaited<ReturnType<TaskRegistry['waitUntilSettled']>>,
  board: TaskBoard | undefined,
  boardWaitIds: string[],
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
  againTool: string,
): { exitCode: number; stdout: string; stderr: string; timedOut: false } {
  const lines = result.tasks.map((t) => receiptBody(t, againTool));
  for (const id of boardWaitIds) {
    const bt = board?.snapshot().tasks[id];
    if (bt === undefined) continue;
    const hint =
      bt.status === 'failed' || bt.status === 'cancelled'
        ? ' — terminal; to redo this work, create a new task with create_agent_team_task'
        : '';
    lines.push(`${id} (board) ${bt.status} — ${bt.title}${hint}`);
  }
  const total = result.tasks.length + boardWaitIds.length;
  const head = result.settled
    ? `all target tasks finished (${total})`
    : signal?.aborted === true
      ? 'aborted by user; tasks still running are marked below'
      : timeoutSeconds === 0
        ? 'status peek (timeoutSeconds=0, non-blocking); tasks still running are marked below'
        : `timeout after ${timeoutSeconds}s; tasks still running are marked below`;
  return { exitCode: 0, stdout: [head, ...lines].join('\n'), stderr: '', timedOut: false };
}

function sharedParams(taskIdsDesc: string) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['taskIds', 'timeoutSeconds'],
    properties: {
      taskIds: {
        type: ['array', 'null'],
        items: { type: 'string' },
        description: taskIdsDesc,
      },
      timeoutSeconds: {
        type: ['number', 'null'],
        description: 'Block cap in seconds; JSON null = 1800; 0 = status peek without waiting.',
      },
    },
  };
}

/** 台账等待：exec / spawn(subagent)。板 id → INVALID_ARG 点名 agent_team_task_wait。board 仅供拒识。 */
export function makeTaskWaitTool(
  tasks: TaskRegistry,
  board?: TaskBoard,
  getRunSignal?: () => AbortSignal | undefined,
  opts?: TaskWaitToolOpts,
): RegisteredTool {
  const allowedKinds = new Set<TaskWaitKind>(opts?.kinds ?? ['exec', 'subagent']);
  const execOnly = allowedKinds.size === 1 && allowedKinds.has('exec');

  return {
    parameters: sharedParams(
      execOnly
        ? 'Exec background ids; JSON null = all currently running exec work. Board task ids belong to agent_team_task_wait.'
        : 'Background exec/spawn ledger ids only. JSON null = currently running ledger work. Board task ids → agent_team_task_wait.',
    ),
    name: 'task_wait',
    description: execOnly
      ? 'Wait for an auto-backgrounded exec command (receipt: id, status, exit, log tail). JSON null waits running exec only. Board task ids belong to agent_team_task_wait.'
      : 'Wait until listed exec/spawn background ledger tasks reach a terminal state; return id, kind, status, exit, and exec log tail or conclusion. Board task ids belong to agent_team_task_wait. taskIds=null waits currently running ledger work only. Default timeout 1800s.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskIds?: string[] | null; timeoutSeconds?: number | null };
      const rawTimeout = raw.timeoutSeconds ?? null;
      let ids: string[];
      const kindOk = (t: BackgroundTask): boolean => allowedKinds.has(t.kind);
      if (raw.taskIds === null || raw.taskIds === undefined) {
        ids = tasks.list().filter((t) => t.status === 'running' && kindOk(t)).map((t) => t.id);
        if (ids.length === 0) {
          return { exitCode: 0, stdout: 'no background tasks running', stderr: '', timedOut: false };
        }
      } else {
        if (!Array.isArray(raw.taskIds) || raw.taskIds.length === 0) {
          throw new CodedToolError('INVALID_ARG', 'taskIds must be a non-empty array of task ids, or null to wait for all running tasks');
        }
        ids = [];
        const boardTasks = board?.snapshot().tasks ?? {};
        const boardRejected: string[] = [];
        const unknown: string[] = [];
        const kindRejected: string[] = [];
        for (const rawId of raw.taskIds.map(String)) {
          const bKey = boardKeyOf(boardTasks, rawId);
          if (bKey !== undefined) {
            boardRejected.push(rawId);
            continue;
          }
          const rid = tasks.resolveId(rawId);
          const hit = tasks.get(rid);
          if (hit !== undefined) {
            if (!kindOk(hit)) {
              kindRejected.push(`${rawId} (${hit.kind})`);
              continue;
            }
            ids.push(rid);
            continue;
          }
          unknown.push(rawId);
        }
        if (boardRejected.length > 0) {
          throw new CodedToolError(
            'INVALID_ARG',
            `Board task ids belong to agent_team_task_wait, not task_wait: ${boardRejected.join(', ')}`,
          );
        }
        if (kindRejected.length > 0) {
          throw new CodedToolError(
            'INVALID_ARG',
            `task_wait on this face only accepts exec background work; not waitable: ${kindRejected.join(', ')}. Board/orchestration waits belong to agent_team_task_wait.`,
          );
        }
        if (unknown.length > 0) {
          const waitable = tasks
            .list()
            .filter(kindOk)
            .map((t) => `${t.id} (${t.kind}, ${t.status}) ${t.label}`)
            .join('; ');
          throw new CodedToolError(
            'INVALID_ARG',
            `Unknown task id: ${unknown.join(', ')}. Waitable now — tasks: ${waitable === '' ? '(none)' : waitable}. Board task ids use agent_team_task_wait.`,
          );
        }
      }
      const signal = getRunSignal?.();
      const timeoutSeconds = parseTimeout(rawTimeout);
      const result = await waitMixed(tasks, ids, undefined, [], timeoutSeconds, signal);
      return formatReceipt(result, undefined, [], timeoutSeconds, signal, 'task_wait');
    },
  };
}

/** 板任务等待（可含板派发台账 id）。exec/spawn 纯后台 id → INVALID_ARG 点名 task_wait。 */
export function makeAgentTeamTaskWaitTool(
  tasks: TaskRegistry,
  board: TaskBoard,
  getRunSignal?: () => AbortSignal | undefined,
): RegisteredTool {
  return {
    parameters: sharedParams(
      'Board task ids from create_agent_team_task/get_agent_team_board (e.g. ["task-build-parser-k3f2"]), and/or board-dispatch ledger ids. Prefer explicit board ids. JSON null = non-terminal board tasks. Finished ids return an immediate receipt. Exec/spawn-only ledger ids belong to task_wait.',
    ),
    name: 'agent_team_task_wait',
    description:
      'Wait until listed board tasks reach a terminal state; return board status (and dispatch ledger receipt when present). Board terminals: success / failed / cancelled (failed/cancelled are final — redo with create_agent_team_task + retryOf). Exec/spawn-only background ids belong to task_wait. taskIds=null waits non-terminal board tasks. Default timeout 1800s.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskIds?: string[] | null; timeoutSeconds?: number | null };
      const rawTimeout = raw.timeoutSeconds ?? null;
      let ids: string[] = [];
      let boardWaitIds: string[] = [];
      const boardTasks = board.snapshot().tasks;

      const correlateBoardFromLedger = (hit: BackgroundTask): string | undefined => {
        for (const bt of Object.values(boardTasks)) {
          if (hit.label === dispatchTag(bt.id) || hit.label === bt.id) return bt.id;
        }
        return undefined;
      };

      if (raw.taskIds === null || raw.taskIds === undefined) {
        boardWaitIds = Object.values(boardTasks)
          .filter((t) => !BOARD_TERMINAL.has(t.status))
          .map((t) => t.id);
        if (boardWaitIds.length === 0) {
          return { exitCode: 0, stdout: 'no board tasks pending', stderr: '', timedOut: false };
        }
      } else {
        if (!Array.isArray(raw.taskIds) || raw.taskIds.length === 0) {
          throw new CodedToolError('INVALID_ARG', 'taskIds must be a non-empty array of task ids, or null to wait for all non-terminal board tasks');
        }
        const ledgerRejected: string[] = [];
        const unknown: string[] = [];
        for (const rawId of raw.taskIds.map(String)) {
          const bKey = boardKeyOf(boardTasks, rawId);
          if (bKey !== undefined) {
            boardWaitIds.push(bKey);
            continue;
          }
          const rid = tasks.resolveId(rawId);
          const hit = tasks.get(rid);
          if (hit !== undefined) {
            const correlated = correlateBoardFromLedger(hit);
            if (correlated !== undefined) {
              boardWaitIds.push(correlated);
              ids.push(rid);
              continue;
            }
            ledgerRejected.push(`${rawId} (${hit.kind})`);
            continue;
          }
          unknown.push(rawId);
        }
        if (ledgerRejected.length > 0) {
          throw new CodedToolError(
            'INVALID_ARG',
            `agent_team_task_wait only accepts board task ids (and board-dispatch ledger ids); exec/spawn-only ids belong to task_wait: ${ledgerRejected.join(', ')}`,
          );
        }
        if (unknown.length > 0) {
          const boardList = Object.values(boardTasks)
            .map((t) => `${t.id} (board, ${t.status}) ${t.title}`)
            .join('; ');
          throw new CodedToolError(
            'INVALID_ARG',
            `Unknown task id: ${unknown.join(', ')}. Waitable now — board: ${boardList === '' ? '(none)' : boardList}`,
          );
        }
      }

      const signal = getRunSignal?.();
      const timeoutSeconds = parseTimeout(rawTimeout);
      // 去重板 id（派发台账归一可能与显式板 id 重复）
      boardWaitIds = [...new Set(boardWaitIds)];
      ids = [...new Set(ids)];
      const result = await waitMixed(tasks, ids, board, boardWaitIds, timeoutSeconds, signal);
      // 板回执权威；台账条目已在 result.tasks 时避免双计——formatReceipt 用 boardWaitIds 条数+台账条
      // 仅输出板行时不把「已关联台账」再算进 finished 总数之外的重复：若 ids 与 board 关联，仍保留台账回执行
      return formatReceipt(result, board, boardWaitIds, timeoutSeconds, signal, 'agent_team_task_wait');
    },
  };
}
