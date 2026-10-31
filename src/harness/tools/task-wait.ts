// 后台任务线 T4：task_wait 内置工具——阻塞等待工作到终态并内联回执（对标 CC TaskOutput）。
// 等待面语义：等待目标=有生命周期的工作单元（exec/后台 fork/板任务），板任务是任务生命周期权威
// （未派发也可等，轮询板态至 success/failed/cancelled）；teammate 长驻执行体是声明不是任务，不进账本、
// 不在等待面（停止走 task_stop 按名）。taskIds=null 等当前全部 running；指定列表只等这些任务，已终态
// 幂等即回；timeoutSeconds=0 非阻塞 peek；未知 id INVALID_ARG 附等待面投影（账本工作单元+板任务清单）。
import * as fs from 'fs';
import { CodedToolError, RegisteredTool } from '../tools';
import type { BackgroundTask, TaskRegistry } from '../tasks';
import type { TaskBoard } from '../../taskboard/board';

const DEFAULT_TIMEOUT_SECONDS = 1800;
const RECEIPT_TAIL_LINES = 200;
/** 板任务终态：success 完成、failed 执行错误、cancelled 主动停止或重启自愈 */
const BOARD_TERMINAL = new Set(['success', 'failed', 'cancelled']);

function readTail(filePath: string, lines: number): string {
  try {
    const all = fs.readFileSync(filePath, 'utf8').split('\n');
    while (all.length > 0 && all[all.length - 1] === '') all.pop();
    return all.slice(-lines).join('\n');
  } catch {
    return '(log unavailable)';
  }
}

function receiptBody(t: BackgroundTask): string {
  const code = t.exitCode !== undefined ? `, exit ${t.exitCode}` : '';
  const head = `${t.id} (${t.kind}) ${t.status}${code} — ${t.label}`;
  if (t.status === 'running') return `${head} (still running; call task_wait again to continue waiting, or task_stop to cancel)`;
  if (t.kind === 'subagent') {
    const log = fs.readFileSync(t.outputFilePath, 'utf8');
    const idx = log.indexOf('[conclusion] ');
    if (idx >= 0) return `${head}\n${log.slice(idx).trimEnd()}`;
  }
  return `${head}\n${readTail(t.outputFilePath, RECEIPT_TAIL_LINES)}`;
}

export function makeTaskWaitTool(tasks: TaskRegistry, board?: TaskBoard, getRunSignal?: () => AbortSignal | undefined): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskIds', 'timeoutSeconds'],
      properties: {
        taskIds: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description:
            'Task ids to wait for: background work ids (label-slug-UTCtimestamp-rand, e.g. ["subagent-20261003T064522Z-a7f3"]) or board task ids as create_task/the board summary shows them (["task-build-parser-k3f2"]; older journals use short "t5" ids — accepted too). Board tasks are the task lifecycle authority: pre-dispatch ones (pending, not yet running) are valid targets — the call blocks until their work reaches a terminal state (success, failed, or cancelled). null waits for all currently running work. Already-finished ids return an idempotent receipt immediately.',
        },
        timeoutSeconds: {
          type: ['number', 'null'],
          description:
            'Max seconds to block before returning the current status; null defaults to 1800; 0 is a non-blocking status peek (return the current snapshot immediately without waiting). After a timeout you can call task_wait again or task_stop.',
        },
      },
    },
    name: 'task_wait',
    description:
      'Block until work reaches a terminal state and return a receipt per task: id, kind, status, exit code, plus the exec log tail or the subagent conclusion. Board terminal states are success, failed, and cancelled. failed is an execution error and is never auto-rerun; cancelled is an explicit stop, or a task that was still pending or running when the app restarted. Any terminal state returns immediately; the wait never hangs on a finished task (default cap 1800s). Wait targets are background work (exec, subagent forks) and board tasks — board tasks are the task lifecycle authority, even before dispatch; long-lived teammates are executors, not tasks, and are never wait targets (wait their board task ids). taskIds=null waits all currently running work; on timeout the current status is returned so you can keep waiting or stop the task. A failed or cancelled board task is terminal: to redo the work, create a new task with create_task.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskIds?: string[] | null; timeoutSeconds?: number | null };
      const rawTimeout = raw.timeoutSeconds ?? null;
      let ids: string[];
      let boardWaitIds: string[] = [];
      if (raw.taskIds === null || raw.taskIds === undefined) {
        // 长驻 teammate 条目排除(2026-10-06 契约收敛):teammate 存活即 running,等它=等到 task_stop——
        // task_wait(null) 的语义是「等在跑的活收口」,可收口面=exec/后台 spawn/板任务(dispatchTag(板 id) 登记条目)
        ids = tasks.list().filter((t) => t.status === 'running').map((t) => t.id);
        if (ids.length === 0) {
          return { exitCode: 0, stdout: 'no background tasks running', stderr: '', timedOut: false };
        }
      } else {
        if (!Array.isArray(raw.taskIds) || raw.taskIds.length === 0) {
          throw new CodedToolError('INVALID_ARG', 'taskIds must be a non-empty array of task ids, or null to wait for all running tasks');
        }
        // id 分类:台账可解析(直接/resolveId 前缀)走台账等待;板上在册但台账无条目(pending、尚未 running)
        // 为合法等待对象,走板态轮询至 success/failed/cancelled;两者皆非才 INVALID_ARG
        ids = [];
        const boardTasks = board?.snapshot().tasks ?? {};
        const boardKeyOf = (rawId: string): string | undefined => {
          if (boardTasks[rawId] !== undefined) return rawId;
          const m = /^task-(t\d+)$/.exec(rawId); // 旧档委派形态 task-tN → 板键 tN
          return m !== null && boardTasks[m[1]] !== undefined ? m[1] : undefined;
        };
        const unknown: string[] = [];
        for (const rawId of raw.taskIds.map(String)) {
          const rid = tasks.resolveId(rawId);
          if (tasks.get(rid) !== undefined) {
            ids.push(rid);
            continue;
          }
          const bKey = boardKeyOf(rawId);
          if (bKey !== undefined) {
            boardWaitIds.push(bKey);
            continue;
          }
          unknown.push(rawId);
        }
        if (unknown.length > 0) {
          // 错误清单=等待面投影(账本工作单元+板任务),数据自解释;面内不写补丁式解释文案
          const waitable = tasks
            .list()
            .map((t) => `${t.id} (${t.kind}, ${t.status}) ${t.label}`)
            .join('; ');
          const boardList = Object.values(boardTasks)
            .map((t) => `${t.id} (board, ${t.status}) ${t.title}`)
            .join('; ');
          throw new CodedToolError(
            'INVALID_ARG',
            `Unknown task id: ${unknown.join(', ')}. Waitable now — tasks: ${waitable === '' ? '(none)' : waitable}${boardList !== '' ? `; board: ${boardList}` : ''}`,
          );
        }
      }
      // 2026-10-26 立即暂停:run 中止信号穿透阻塞等待——用户中断(Esc/停止钮/新轮次强停)时
      // task_wait 即刻返回当前快照(不再挂满 timeoutSeconds,前台轮次卡在「正在等待任务」是
      // pauseAndSend 409 的根因);后台任务本体不追杀(独立于 run 存活,既有裁定)
      const signal = getRunSignal?.();
      const timeoutSeconds = rawTimeout === null ? DEFAULT_TIMEOUT_SECONDS : rawTimeout;
      if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
        throw new CodedToolError('INVALID_ARG', `timeoutSeconds must be a non-negative number (0 = non-blocking status peek), got: ${String(rawTimeout)}`);
      }
      // 混合等待:纯台账走事件唤醒 waitUntilSettled;含板任务则统一轮询——台账 running 或板任务
      // 未达 success/failed/cancelled 即未收口
      const boardStatus = (id: string): string | undefined => board?.snapshot().tasks[id]?.status;
      const boardPending = (): string[] =>
        boardWaitIds.filter((id) => !BOARD_TERMINAL.has(boardStatus(id) ?? ''));
      let result: Awaited<ReturnType<TaskRegistry['waitUntilSettled']>>;
      if (boardWaitIds.length === 0) {
        result = await tasks.waitUntilSettled(ids, timeoutSeconds * 1000, signal);
      } else {
        const deadline = Date.now() + timeoutSeconds * 1000;
        for (;;) {
          if (signal?.aborted) {
            result = { settled: false, tasks: ids.map((id) => tasks.get(id)!).filter((t) => t !== undefined) };
            break;
          }
          const ledgerRunning = ids.filter((id) => tasks.get(id)?.status === 'running');
          if (ledgerRunning.length === 0 && boardPending().length === 0) {
            result = { settled: true, tasks: ids.map((id) => tasks.get(id)!).filter((t) => t !== undefined) };
            break;
          }
          if (Date.now() >= deadline) {
            result = { settled: false, tasks: ids.map((id) => tasks.get(id)!).filter((t) => t !== undefined) };
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      const lines = result.tasks.map(receiptBody);
      for (const id of boardWaitIds) {
        const bt = board?.snapshot().tasks[id];
        if (bt === undefined) continue;
        // failed=执行错误;cancelled=主动停止或重启自愈。两者都须 create_task 重做;success 即完成
        const hint =
          bt.status === 'failed' || bt.status === 'cancelled'
            ? ' — terminal; to redo this work, create a new task with create_task'
            : '';
        lines.push(`${id} (board) ${bt.status} — ${bt.title}${hint}`);
      }
      const head = result.settled
        ? `all target tasks finished (${ids.length + boardWaitIds.length})`
        : signal?.aborted === true
          ? 'aborted by user; tasks still running are marked below'
          : timeoutSeconds === 0
          ? 'status peek (timeoutSeconds=0, non-blocking); tasks still running are marked below'
          : `timeout after ${timeoutSeconds}s; tasks still running are marked below`;
      return { exitCode: 0, stdout: [head, ...lines].join('\n'), stderr: '', timedOut: false };
    },
  };
}
