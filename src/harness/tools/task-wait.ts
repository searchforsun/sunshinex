// 后台任务线 T4：task_wait 内置工具——阻塞等待后台任务到终态并内联回执（对标 CC TaskOutput）。
// 语义：taskIds=null 等当前全部 running 任务（调用时快照）；指定列表只等这些任务，已终态幂等即回；
// timeoutSeconds=0 非阻塞状态快照（peek，即时回执不等待）；回执逐任务 id/kind/status/exitCode，
// exec 附任务日志末 200 行、subagent 附 [conclusion] 结论全文；
// 超时回执当前状态与续等指引，续等/先做别的/task_stop 由模型自判；未知 id INVALID_ARG 附现存清单（照 task_stop 形态）。
import * as fs from 'fs';
import { CodedToolError, RegisteredTool } from '../tools';
import type { BackgroundTask, TaskRegistry } from '../tasks';

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

export function makeTaskWaitTool(tasks: TaskRegistry): RegisteredTool {
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
            'Background task ids to wait for, e.g. ["b1","b2"]; null waits for all currently running tasks. Already-finished ids return an idempotent receipt immediately.',
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
      'Block until background tasks reach a terminal state (background exec, timed-out-to-background exec, or background subagent) and return a receipt per task: id, kind, status, exit code, plus the exec log tail or the subagent conclusion. taskIds=null waits for all currently running tasks; on timeout the current status is returned so you can keep waiting or stop the task.',
    category: 'task',
    executor: async (input) => {
      const raw = input as { taskIds?: string[] | null; timeoutSeconds?: number | null };
      const rawTimeout = raw.timeoutSeconds ?? null;
      let ids: string[];
      if (raw.taskIds === null || raw.taskIds === undefined) {
        ids = tasks.list().filter((t) => t.status === 'running').map((t) => t.id);
        if (ids.length === 0) {
          return { exitCode: 0, stdout: 'no background tasks running', stderr: '', timedOut: false };
        }
      } else {
        if (!Array.isArray(raw.taskIds) || raw.taskIds.length === 0) {
          throw new CodedToolError('INVALID_ARG', 'taskIds must be a non-empty array of task ids, or null to wait for all running tasks');
        }
        ids = raw.taskIds.map(String);
        const unknown = ids.filter((id) => tasks.get(id) === undefined);
        if (unknown.length > 0) {
          const all = tasks.list().map((t) => `${t.id} (${t.kind}, ${t.status}) ${t.label}`).join('; ');
          throw new CodedToolError('INVALID_ARG', `Unknown task id: ${unknown.join(', ')}. Current tasks: ${all === '' ? '(none)' : all}`);
        }
      }
      const timeoutSeconds = rawTimeout === null ? DEFAULT_TIMEOUT_SECONDS : rawTimeout;
      if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
        throw new CodedToolError('INVALID_ARG', `timeoutSeconds must be a non-negative number (0 = non-blocking status peek), got: ${String(rawTimeout)}`);
      }
      const result = await tasks.waitUntilSettled(ids, timeoutSeconds * 1000);
      const lines = result.tasks.map(receiptBody);
      const head = result.settled
        ? `all target tasks finished (${ids.length})`
        : timeoutSeconds === 0
          ? 'status peek (timeoutSeconds=0, non-blocking); tasks still running are marked below'
          : `timeout after ${timeoutSeconds}s; tasks still running are marked below`;
      return { exitCode: 0, stdout: [head, ...lines].join('\n'), stderr: '', timedOut: false };
    },
  };
}
