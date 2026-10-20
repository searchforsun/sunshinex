// 后台任务线 T4：task_wait 内置工具——阻塞等待后台任务到终态并内联回执（对标 CC TaskOutput）。
// 语义：taskIds=null 等当前全部 running 任务（调用时快照）；指定列表只等这些任务，已终态幂等即回；
// timeoutSeconds=0 非阻塞状态快照（peek，即时回执不等待）；回执逐任务 id/kind/status/exitCode，
// exec 附任务日志末 200 行、subagent 附 [conclusion] 结论全文；
// 超时回执当前状态与续等指引，续等/先做别的/task_stop 由模型自判；未知 id INVALID_ARG 附现存清单（照 task_stop 形态）。
import * as fs from 'fs';
import { CodedToolError, RegisteredTool } from '../tools';
import type { BackgroundTask, TaskRegistry } from '../tasks';
import type { TaskBoard } from '../../taskboard/board';

const DEFAULT_TIMEOUT_SECONDS = 1800;
const RECEIPT_TAIL_LINES = 200;

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

export function makeTaskWaitTool(tasks: TaskRegistry, board?: TaskBoard): RegisteredTool {
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
            'Background task ids to wait for. Accepted forms: ledger ids (label-slug-UTCtimestamp-rand, e.g. ["subagent-20261003T064522Z-a7f3"]) or board task ids exactly as create_task/the board summary shows them (["task-build-parser-k3f2"]; legacy restored boards use the "t5" form — both resolve). Pre-dispatch board tasks (pending/gated/not yet claimed) are valid targets too: the call blocks until their work finishes (in-review/done/failed). null waits for all currently running tasks. Already-finished ids return an idempotent receipt immediately.',
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
      'Block until background tasks reach a terminal state (background exec, timed-out-to-background exec, background subagent, or board tasks — including the ones claimed by teammates) and return a receipt per task: id, kind, status, exit code, plus the exec log tail or the subagent conclusion. taskIds accepts board ids in their native form (["task-build-parser-k3f2"], exactly as create_task/the board summary shows them) as well as ledger ids; taskIds=null waits for all currently running tasks EXCEPT long-lived teammates (they run until task_stop); on timeout the current status is returned so you can keep waiting or stop the task.',
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
        ids = tasks.list().filter((t) => t.status === 'running' && t.kind !== 'teammate').map((t) => t.id);
        if (ids.length === 0) {
          return { exitCode: 0, stdout: 'no background tasks running', stderr: '', timedOut: false };
        }
      } else {
        if (!Array.isArray(raw.taskIds) || raw.taskIds.length === 0) {
          throw new CodedToolError('INVALID_ARG', 'taskIds must be a non-empty array of task ids, or null to wait for all running tasks');
        }
        // id 分类(2026-10-19「未派发板任务等不到」真机修复):台账可解析(直接/resolveId 前缀)走台账等待;
        // 板上在册但台账无条目(pending/gated/未 claim——派发登记发生在 claim 时刻)为合法等待对象,
        // 走板态轮询至 in-review/done/failed/cancelled(工作完成,claim 后其台账条目自动接力);
        // 两者皆非才 INVALID_ARG(真机 GUI 首呼:teammates 刚 spawn 未 claim,板 id 全量报错即此缺口)
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
          // 错误清单语义纠偏(2026-10-20 用户裁决「有生命周期的是任务,子代理只是声明」):teammate
          // 长驻条目归拢标注(它们永远 running,混列即诱导「等 teammates」死路),等待目标指向板任务
          const all = tasks.list();
          const runnable = all
            .filter((t) => t.kind !== 'teammate')
            .map((t) => `${t.id} (${t.kind}, ${t.status}) ${t.label}`)
            .join('; ');
          const mates = all.filter((t) => t.kind === 'teammate');
          const mateNote =
            mates.length > 0
              ? `; ${mates.length} long-lived teammate(s) (${mates.map((m) => m.label).join(', ')}) run until task_stop and are not wait targets — wait their board task ids instead`
              : '';
          const boardNote =
            board !== undefined && boardWaitIds.length === 0 && unknown.some((u) => /^task-/.test(u))
              ? '. Board task ids are accepted and wait on board state, including tasks not yet dispatched'
              : '';
          throw new CodedToolError(
            'INVALID_ARG',
            `Unknown task id: ${unknown.join(', ')}. Current tasks: ${runnable === '' ? '(none)' : runnable}${mateNote}${boardNote}`,
          );
        }
      }
      const timeoutSeconds = rawTimeout === null ? DEFAULT_TIMEOUT_SECONDS : rawTimeout;
      if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
        throw new CodedToolError('INVALID_ARG', `timeoutSeconds must be a non-negative number (0 = non-blocking status peek), got: ${String(rawTimeout)}`);
      }
      // 混合等待:纯台账走事件唤醒 waitUntilSettled(既有精度);含板任务则统一轮询——台账 running/
      // 板任务未达工作终态(in-review/done/failed/cancelled)即未收口;claim 后板任务转台账口径续等
      const boardStatus = (id: string): string | undefined => board?.snapshot().tasks[id]?.status;
      const boardPending = (): string[] =>
        boardWaitIds.filter((id) => !['in-review', 'done', 'failed', 'cancelled'].includes(boardStatus(id) ?? ''));
      let result: Awaited<ReturnType<TaskRegistry['waitUntilSettled']>>;
      if (boardWaitIds.length === 0) {
        result = await tasks.waitUntilSettled(ids, timeoutSeconds * 1000);
      } else {
        const deadline = Date.now() + timeoutSeconds * 1000;
        for (;;) {
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
        lines.push(`${id} (board) ${bt.status} — ${bt.title}${bt.status === 'in-review' ? ' (work finished, awaiting review)' : ''}`);
      }
      const head = result.settled
        ? `all target tasks finished (${ids.length + boardWaitIds.length})`
        : timeoutSeconds === 0
          ? 'status peek (timeoutSeconds=0, non-blocking); tasks still running are marked below'
          : `timeout after ${timeoutSeconds}s; tasks still running are marked below`;
      return { exitCode: 0, stdout: [head, ...lines].join('\n'), stderr: '', timedOut: false };
    },
  };
}
