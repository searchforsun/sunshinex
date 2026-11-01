// 后台任务线 T4：task_wait 内置工具——阻塞等待工作到终态并内联回执（对标 CC TaskOutput）。
// 等待面语义：等待目标=有生命周期的工作单元（exec/后台 fork/板任务），板任务是任务生命周期权威
// （未派发也可等，轮询板态至 success/failed/cancelled）；teammate 长驻执行体是声明不是任务，不进账本、
// 不在等待面（停止走 task_stop 按名）。taskIds=null 等当前全部 running；指定列表只等这些任务，已终态
// 幂等即回；timeoutSeconds=0 非阻塞 peek；未知 id INVALID_ARG 附等待面投影（账本工作单元+板任务清单）。
// 子面/队友：kinds=['exec']——可等自动转后台的 exec，不可等板任务/板派发台账(防自等死锁)。
import * as fs from 'fs';
import { CodedToolError, RegisteredTool } from '../tools';
import type { BackgroundTask, TaskRegistry } from '../tasks';
import type { TaskBoard } from '../../taskboard/board';

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

export function makeTaskWaitTool(
  tasks: TaskRegistry,
  board?: TaskBoard,
  getRunSignal?: () => AbortSignal | undefined,
  opts?: TaskWaitToolOpts,
): RegisteredTool {
  const allowedKinds = new Set<TaskWaitKind>(opts?.kinds ?? ['exec', 'subagent']);
  const allowBoard = board !== undefined && allowedKinds.has('subagent');
  const execOnly = allowedKinds.size === 1 && allowedKinds.has('exec');

  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskIds', 'timeoutSeconds'],
      properties: {
        taskIds: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: execOnly
            ? 'Exec background ids; JSON null = all currently running exec work. Board task ids are not waitable on this face.'
            : 'Board task ids from create_agent_team_task/get_agent_team_board (e.g. ["task-build-parser-k3f2"]), and/or background exec/spawn ledger ids. Prefer explicit board ids. JSON null = only work already running (pending board tasks are omitted — pass their ids). Finished ids return an immediate receipt.',
        },
        timeoutSeconds: {
          type: ['number', 'null'],
          description: 'Block cap in seconds; JSON null = 1800; 0 = status peek without waiting.',
        },
      },
    },
    name: 'task_wait',
    description: execOnly
      ? 'Wait for an auto-backgrounded exec command (receipt: id, status, exit, log tail). JSON null waits running exec only. Board/teammate work is not waitable here — finish your own board task; the lead waits on board ids.'
      : 'Wait until listed work reaches a terminal state; return id, kind, status, exit, and exec log tail or conclusion. Prefer board task ids from create_agent_team_task. Board terminals: success / failed / cancelled (failed/cancelled are final — redo with create_agent_team_task + retryOf). Teammates are executors, not wait targets — wait their board task ids. taskIds=null waits currently running work only. Default timeout 1800s.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskIds?: string[] | null; timeoutSeconds?: number | null };
      const rawTimeout = raw.timeoutSeconds ?? null;
      let ids: string[];
      let boardWaitIds: string[] = [];
      const kindOk = (t: BackgroundTask): boolean => allowedKinds.has(t.kind);
      if (raw.taskIds === null || raw.taskIds === undefined) {
        // 长驻 teammate 条目排除(2026-10-06 契约收敛):teammate 存活即 running,等它=等到 task_stop——
        // task_wait(null) 的语义是「等在跑的活收口」,可收口面=exec/后台 spawn/板任务(dispatchTag(板 id) 登记条目)
        // 子面 kinds=['exec']：null 只等 exec，排除板派发台账(自等)
        ids = tasks.list().filter((t) => t.status === 'running' && kindOk(t)).map((t) => t.id);
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
        const boardTasks = allowBoard ? (board?.snapshot().tasks ?? {}) : {};
        const boardKeyOf = (rawId: string): string | undefined => {
          if (boardTasks[rawId] !== undefined) return rawId;
          const m = /^task-(t\d+)$/.exec(rawId); // 旧档委派形态 task-tN → 板键 tN
          return m !== null && boardTasks[m[1]] !== undefined ? m[1] : undefined;
        };
        const unknown: string[] = [];
        const kindRejected: string[] = [];
        for (const rawId of raw.taskIds.map(String)) {
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
          const bKey = boardKeyOf(rawId);
          if (bKey !== undefined) {
            boardWaitIds.push(bKey);
            continue;
          }
          unknown.push(rawId);
        }
        if (kindRejected.length > 0) {
          throw new CodedToolError(
            'INVALID_ARG',
            `task_wait on this face only accepts exec background work; not waitable: ${kindRejected.join(', ')}. Board/orchestration waits belong to the lead.`,
          );
        }
        if (unknown.length > 0) {
          // 错误清单=等待面投影(账本工作单元+板任务),数据自解释;面内不写补丁式解释文案
          const waitable = tasks
            .list()
            .filter(kindOk)
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
        // failed=执行错误;cancelled=主动停止或重启自愈。两者都须 create_agent_team_task 重做;success 即完成
        const hint =
          bt.status === 'failed' || bt.status === 'cancelled'
            ? ' — terminal; to redo this work, create a new task with create_agent_team_task'
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
