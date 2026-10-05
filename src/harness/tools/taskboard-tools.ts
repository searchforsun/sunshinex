// TaskBoard lead 工具五件套(spec §5.8):主链模型操作任务板的唯一入口——create_task / set_dependency /
// assign / review_task / gate_task。category 'task';observation 尾附板摘要(summaryLines)供模型一眼
// 看板;create_task 即触发派发(drain 异步),等待经既有 task_wait(null)(Ruling 1)。
// lead-only 不变量:五件套随 deriveChildRegistry 扩剔(TASKBOARD_TOOL_NAMES),子代理工具面不可见。
import { CodedToolError, RegisteredTool } from '../tools';
import type { TaskBoard } from '../../taskboard/board';

export const TASKBOARD_TOOL_NAMES = ['create_task', 'set_dependency', 'assign', 'review_task', 'gate_task'] as const;

function boardTail(board: TaskBoard): string {
  const lines = board.summaryLines();
  return lines.length === 0 ? '(task board empty)' : ['board:', ...lines].join('\n');
}

export function makeTaskBoardTools(board: TaskBoard): RegisteredTool[] {
  const createTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'spec', 'dependsOn', 'assignee', 'gated', 'executor'],
      properties: {
        title: { type: ['string', 'null'], description: 'Short task title shown on the board.' },
        spec: { type: ['string', 'null'], description: 'Self-contained task description: the executing agent sees ONLY this (no main-chain context), so include everything needed.' },
        dependsOn: { type: ['array', 'null'], items: { type: 'string' }, description: 'Task ids this task depends on (e.g. ["t1"]); null/empty = no dependencies. A task dispatches only after all dependencies are done.' },
        assignee: { type: ['string', 'null'], description: 'Optional assignee label (bookkeeping; executor routing lands in P2).' },
        gated: { type: ['boolean', 'null'], description: 'Pass true to hold the task behind an approval gate from creation: dispatch skips it until review_task(approved=true).' },
        executor: { type: ['string', 'null'], enum: ['internal', 'external-cli', null], description: 'Execution routing hint: "internal" = subagent fork (default), "external-cli" = external CLI executor.' },
      },
    },
    name: 'create_task',
    description:
      'Create a task on the shared task board. Unblocked tasks (no unfinished dependencies, not gated) are dispatched automatically to a subagent; wait with task_wait (taskIds=null). The board persists across sessions. Pass gated=true to hold the task behind an approval gate from creation (dispatch skips it until review_task approves). Pass executor ("internal" or "external-cli") as the execution routing hint.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { title?: string | null; spec?: string | null; dependsOn?: string[] | null; assignee?: string | null; gated?: boolean | null; executor?: string | null };
      const executor = raw.executor === 'internal' || raw.executor === 'external-cli' ? raw.executor : undefined;
      const r = board.create({
        title: String(raw.title ?? ''),
        spec: String(raw.spec ?? ''),
        dependsOn: raw.dependsOn ?? undefined,
        assignee: raw.assignee ?? undefined,
        gated: raw.gated === true,
        executor,
      });
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: [`task ${r.value.taskId} created; dispatch is automatic for unblocked tasks — block with task_wait (taskIds=null)`, boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };
  const setDependency: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'dependsOn'],
      properties: {
        taskId: { type: ['string', 'null'], description: 'Task id that gains a dependency (e.g. "t2").' },
        dependsOn: { type: ['string', 'null'], description: 'Task id to depend on; rejected if it would create a cycle.' },
      },
    },
    name: 'set_dependency',
    description: 'Add a dependency edge to a board task. Fails fast on unknown ids or cycles.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskId?: string | null; dependsOn?: string | null };
      const r = board.setDependency(String(raw.taskId ?? ''), String(raw.dependsOn ?? ''));
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: ['dependency added', boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };
  const assign: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'assignee'],
      properties: {
        taskId: { type: ['string', 'null'], description: 'Task id.' },
        assignee: { type: ['string', 'null'], description: 'Assignee label (bookkeeping in P1).' },
      },
    },
    name: 'assign',
    description: 'Record an assignee on a board task (bookkeeping; executor routing lands in P2).',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskId?: string | null; assignee?: string | null };
      const r = board.assign(String(raw.taskId ?? ''), String(raw.assignee ?? ''));
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: ['assigned', boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };
  const reviewTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'approved', 'note'],
      properties: {
        taskId: { type: ['string', 'null'], description: 'Task id to review.' },
        approved: { type: ['boolean', 'null'], description: 'For an in-review task: true = done, false = failed. For a gated task: true = approve and resume dispatch, false = keep gated.' },
        note: { type: ['string', 'null'], description: 'Optional rationale recorded with the decision.' },
      },
    },
    name: 'review_task',
    description:
      'Lead ruling on a board task: close an in-review task (approved=true marks done and unblocks dependents; false marks failed, which blocks dependents) or resolve a gate (approved=true resumes dispatch).',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskId?: string | null; approved?: boolean | null; note?: string | null };
      const r = board.review(String(raw.taskId ?? ''), { approved: raw.approved === true, note: raw.note ?? undefined });
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: ['review recorded', boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };
  const gateTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'note'],
      properties: {
        taskId: { type: ['string', 'null'], description: 'Task id to gate (must not be mid-execution).' },
        note: { type: ['string', 'null'], description: 'Why human approval is needed; shown with the gate.' },
      },
    },
    name: 'gate_task',
    description: 'Put a task behind an approval gate: dispatch skips it until review_task(approved=true) resolves the gate. To gate a task from the start, pass gated=true at create time (create_task).',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskId?: string | null; note?: string | null };
      const r = board.gate(String(raw.taskId ?? ''), raw.note ?? undefined);
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: ['gate set — task will not dispatch until approved via review_task', boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };
  return [createTask, setDependency, assign, reviewTask, gateTask];
}
