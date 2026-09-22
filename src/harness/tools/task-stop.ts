// 后台任务线 T3：task_stop 内置工具——按 ID 停止后台任务（规格 D8，对标 CC TaskStop）。
// 语义：命中 running 触发账本登记的 stop 句柄并转终态 stopped；未命中 INVALID_ARG 列出现存任务
// id+label（照 CC TaskStop 报错形态）；命中已终态任务幂等回执当前终态、不重复触发 stop。
import { CodedToolError, RegisteredTool } from '../tools';
import type { TaskRegistry } from '../tasks';

export function makeTaskStopTool(tasks: TaskRegistry): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'Background task id to stop, e.g. b1 (unknown ids return the current task list in the error)' },
      },
    },
    name: 'task_stop',
    description:
      'Stop a running background task by id (background exec, timed-out-to-background exec, or background subagent). Already-finished tasks return an idempotent receipt of their terminal status. Unknown ids fail with the current task list attached.',
    category: 'task',
    executor: async (input) => {
      const taskId = String(input.taskId ?? '').trim();
      if (taskId === '') throw new CodedToolError('INVALID_ARG', 'taskId is required');
      const task = tasks.get(taskId);
      if (task === undefined) {
        const all = tasks
          .list()
          .map((t) => `${t.id} (${t.kind}, ${t.status}) ${t.label}`)
          .join('; ');
        throw new CodedToolError('INVALID_ARG', `Unknown task id: ${taskId}. Current tasks: ${all === '' ? '(none)' : all}`);
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
