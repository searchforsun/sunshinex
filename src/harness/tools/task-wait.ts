// task_wait：仅等台账 exec / spawn(subagent) 后台任务到终态并内联回执（对标 CC TaskOutput）。
// agent_team_task_wait：仅等板任务（可含板派发台账 id）；事件等待——任一板任务状态偏离入口快照即回
// （2026-11-02 用户裁定：不是等全部，leader 每次变更都要能即时反应），全部终态 success/failed/cancelled 仍收口。
// 分域拒识：task_wait 遇板 id → INVALID_ARG 点名 agent_team_task_wait；对称拒识 exec/spawn 纯后台 id。
// taskIds=null：task_wait 等当前 running 台账；agent_team_task_wait 等板上非终态任务。
// timeoutSeconds=0 非阻塞 peek；子面 kinds=['exec'] 防板派发台账自等。
import * as fs from 'fs';
import { CodedToolError, RegisteredTool } from '../tools';
import type { BackgroundTask, TaskRegistry } from '../tasks';
import type { TaskBoard } from '../../taskboard/board';
import { BOARD_TERMINAL, type TaskStatus } from '../../taskboard/model';
import { dispatchTag } from '../../taskboard/board';

/** 等待阻塞范围(2026-11-13 用户裁定「task_wait 给一个时间范围 1-30 分钟,模型按具体情况设置」):
 *  模型声明的 timeoutSeconds 钳进 [60, 1800]——防 30 分钟死等不加节制,也防误传 1s 使等待形同虚设;
 *  0 保留为非阻塞状态窥视(语义=不等待,不进范围) */
const WAIT_CLAMP_MIN_SECONDS = 60;
const WAIT_CLAMP_MAX_SECONDS = 1800;
const RECEIPT_TAIL_LINES = 200;
/** 板任务终态：success 完成、failed 执行错误、cancelled 主动停止或重启自愈 */

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

function parseTimeout(rawTimeout: number): number {
  const timeoutSeconds = rawTimeout;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new CodedToolError(
      'INVALID_ARG',
      `timeoutSeconds must be a non-negative number (0 = non-blocking status peek), got: ${String(rawTimeout)}`,
    );
  }
  if (timeoutSeconds === 0) return 0; // 窥视态不进范围
  // 钳进 1–30 分钟窗口(2026-11-13 用户裁定):低于 1 分钟抬高到 1 分钟(短抖动等待无意义),
  // 高于 30 分钟压回 30 分钟(防死等;模型可到期回执后再等一轮)
  return Math.min(Math.max(timeoutSeconds, WAIT_CLAMP_MIN_SECONDS), WAIT_CLAMP_MAX_SECONDS);
}

/** 板任务等待钳制(2026-11-13 用户裁定「智能体的等待给 5-30 分钟窗口」):封顶 1800 秒,
 *  下不限——该工具是**事件等待**(任一状态变更即回),短窗口正是核心设计且永不死等;
 *  30 分钟上限防「无事件 blind block」。schema 描述里 5-30 分钟为模型推荐窗口 */
function parseTeamTimeout(rawTimeout: number): number {
  // 不复用 parseTimeout(其 60s 下限会破事件等待的短窗口);独立校验+仅封顶
  const timeoutSeconds = rawTimeout;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new CodedToolError(
      'INVALID_ARG',
      `timeoutSeconds must be a non-negative number (0 = non-blocking status peek), got: ${String(rawTimeout)}`,
    );
  }
  if (timeoutSeconds === 0) return 0;
  return Math.min(timeoutSeconds, 1800);
}

/** 板态变化（任一即醒）：from=本次调用入口快照，to=醒时板态 */
interface BoardChange {
  readonly id: string;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
}

interface WaitResult {
  settled: boolean;
  tasks: BackgroundTask[];
  /** 本次等待期间观察到的板态变化；台账路径恒空 */
  changes: BoardChange[];
}

/** 等待面：台账 ids 等到 settled；板 ids 以调用入口板态为基线，任一板任务状态偏离基线即醒
 *  （不是等全部——任一 pending→running / running→终态都算事件，lead 据此即时反应后再续等），
 *  全部终态仍以 settled 收口。未知 id 按 pending 处理（保守：宁多等不早放） */
async function waitMixed(
  tasks: TaskRegistry,
  ids: string[],
  board: TaskBoard | undefined,
  boardWaitIds: string[],
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
): Promise<WaitResult> {
  const boardStatus = (id: string): TaskStatus => board?.snapshot().tasks[id]?.status ?? 'pending';
  const boardPending = (): string[] => boardWaitIds.filter((id) => !BOARD_TERMINAL.has(boardStatus(id)));
  if (boardWaitIds.length === 0) {
    return { ...(await tasks.waitUntilSettled(ids, timeoutSeconds * 1000, signal)), changes: [] };
  }
  const baseline = new Map(boardWaitIds.map((id) => [id, boardStatus(id)] as const));
  const changesNow = (): BoardChange[] => {
    const out: BoardChange[] = [];
    for (const [id, from] of baseline) {
      const to = boardStatus(id);
      if (to !== from) out.push({ id, from, to });
    }
    return out;
  };
  const collect = (): BackgroundTask[] => ids.map((id) => tasks.get(id)!).filter((t) => t !== undefined);
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    if (signal?.aborted) {
      return { settled: false, tasks: collect(), changes: [] };
    }
    const ledgerRunning = ids.filter((id) => tasks.get(id)?.status === 'running');
    if (ledgerRunning.length === 0 && boardPending().length === 0) {
      return { settled: true, tasks: collect(), changes: changesNow() };
    }
    const changes = changesNow();
    if (changes.length > 0) {
      return { settled: false, tasks: collect(), changes };
    }
    if (Date.now() >= deadline) {
      return { settled: false, tasks: collect(), changes: [] };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function formatReceipt(
  result: WaitResult,
  board: TaskBoard | undefined,
  boardWaitIds: string[],
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
  againTool: string,
): { exitCode: number; stdout: string; stderr: string; timedOut: false } {
  const lines = result.tasks.map((t) => receiptBody(t, againTool));
  let unfinishedBoard = 0;
  for (const id of boardWaitIds) {
    const bt = board?.snapshot().tasks[id];
    if (bt === undefined) continue;
    if (!BOARD_TERMINAL.has(bt.status)) unfinishedBoard += 1;
    const hint =
      bt.status === 'failed' || bt.status === 'cancelled'
        ? ' — terminal; to redo this work, create a new task with create_agent_team_task'
        : '';
    lines.push(`${id} (board) ${bt.status} — ${bt.title}${hint}`);
  }
  const total = result.tasks.length + boardWaitIds.length;
  const head = result.settled
    ? `all target tasks finished (${total})`
    : result.changes.length > 0
      ? `status changed: ${result.changes.map((c) => `${c.id} ${c.from} → ${c.to}`).join(', ')}; ${unfinishedBoard} of ${boardWaitIds.length} board task(s) still unfinished — call ${againTool} again to keep waiting`
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
        type: 'number',
        description: 'Block cap in seconds (required, always pass an explicit value); capped at 1800. Recommended window — task_wait: 60-1800 (1-30 min); agent_team_task_wait: 300-1800 (5-30 min, shorter event windows allowed). Prefer shorter windows and re-wait in a loop on each receipt instead of one long blind block. 0 = status peek without waiting.',
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
      : 'Wait until listed exec/spawn background ledger tasks reach a terminal state; return id, kind, status, exit, and exec log tail or conclusion. Board task ids belong to agent_team_task_wait. taskIds=null waits currently running ledger work only. Blocking window: timeoutSeconds clamped to 1-30 minutes — pick a short window (1-5 min) for quick checks and re-wait in a loop on the receipt instead of one long blind block.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskIds?: string[] | null; timeoutSeconds: number };
      const rawTimeout = raw.timeoutSeconds;
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
      'Board task ids from create_agent_team_task/get_agent_team_board (e.g. ["task-build-parser-k3f2"]), and/or board-dispatch ledger ids. Prefer explicit board ids. JSON null = non-terminal board tasks. Already-terminal ids never block (all-terminal returns an immediate receipt). Exec/spawn-only ledger ids belong to task_wait.',
    ),
    name: 'agent_team_task_wait',
    description:
      'Wait on board tasks and return as soon as ANY listed task changes status (pending → running, running → success/failed/cancelled) or all are terminal — it is an event wait, not wait-for-all. The receipt names the change(s) and how many are still unfinished; react (assign, retry, message) and call again to keep waiting. Returns board status per task (and dispatch ledger receipt when present). Board terminals: success / failed / cancelled (failed/cancelled are final — redo with create_agent_team_task + retryOf). Exec/spawn-only background ids belong to task_wait. taskIds=null waits non-terminal board tasks.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskIds?: string[] | null; timeoutSeconds: number };
      const rawTimeout = raw.timeoutSeconds;
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
      const timeoutSeconds = parseTeamTimeout(rawTimeout); // 封顶 1800;短窗口(事件等待)不设下限
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
