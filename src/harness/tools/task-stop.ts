// 后台任务线 T3：task_stop 内置工具——按 ID 停止后台任务（规格 D8，对标 CC TaskStop）。
// 语义：命中 running 触发账本登记的 stop 句柄并转终态 stopped；未命中 INVALID_ARG 列出现存任务
// id+label（照 CC TaskStop 报错形态）；命中已终态任务幂等回执当前终态、不重复触发 stop。
import { CodedToolError, RegisteredTool } from '../tools';
import type { TaskRegistry } from '../tasks';
import type { TeamRegistry } from '../../taskboard/teammate';

export function makeTaskStopTool(tasks: TaskRegistry, team?: TeamRegistry): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'Background task id to stop. Accepted forms: ledger id (label-slug-UTCtimestamp-rand, e.g. exec-20261003T064522Z-a7f3) or board task id as create_task/the board summary shows it (e.g. "task-build-parser-k3f2"; legacy restored boards use the "t5" form — both resolve to the dispatched ledger entry); unknown ids return the current task list in the error' },
      },
    },
    name: 'task_stop',
    description:
      'Stop a running background task by id (background exec, timed-out-to-background exec, background subagent, or a board task currently executing on a teammate). Already-finished tasks return an idempotent receipt of their terminal status. Unknown ids fail with the current task list attached.',
    category: 'task',
    executor: async (input) => {
      const taskId = tasks.resolveId(String(input.taskId ?? '').trim());
      if (taskId === '') throw new CodedToolError('INVALID_ARG', 'taskId is required');
      const task = tasks.get(taskId);
      if (task === undefined) {
        // 控制面(与等待面分立):teammate 长驻执行体按名寻址停止(它们不是任务,但可停)
        const tm = team?.get(taskId);
        if (tm !== undefined) {
          tm.stop();
          return { exitCode: 0, stdout: `teammate ${taskId} stopped`, stderr: '', timedOut: false };
        }
        const ledger = tasks
          .list()
          .map((t) => `${t.id} (${t.kind}, ${t.status}) ${t.label}`)
          .join('; ');
        const mates = team?.aliveNames().map((n) => `${n} (teammate)`) ?? [];
        const surface = [...mates, ledger].filter((x) => x !== '').join('; ');
        throw new CodedToolError('INVALID_ARG', `Unknown task id: ${taskId}. Stoppable now: ${surface === '' ? '(none)' : surface}`);
      }
      if (task.status === 'running') {
        task.stop?.();
        if (tasks.get(taskId)?.status === 'running') tasks.finish(taskId, 'stopped', { marker: '[stopped: task_stop]' });
        return { exitCode: 0, stdout: `task ${taskId} stopped (${task.label})`, stderr: '', timedOut: false };
      }
      return { exitCode: 0, stdout: `task ${taskId} already finished with status ${task.status}`, stderr: '', timedOut: false };
    },
  };
}
