// TaskBoard lead 工具面(2026-10-20 收束版):四件套——create_task / update_task / review_task /
// get_board。update_task 归并旧 set_dependency/assign/gate_task/cancel_task 四个薄工具(action
// 枚举单点);get_board 自成员面收编进 lead 面(补 lead 无板读取工具的缺口)。观察尾附板摘要
// (summaryLines)供模型一眼看板;create_task 即触发派发(drain 异步),等待经既有 task_wait。
// lead-only 不变量:四件套随 deriveChildRegistry/deriveTeammateRegistry 扩剔(TASKBOARD_TOOL_NAMES
// ——两处 spread 自动随动,增名即扩剔),子智能体工具面不可见。
import { CodedToolError, RegisteredTool } from '../tools';
import { fail } from '../../result';
import type { TaskBoard } from '../../taskboard/board';

export const TASKBOARD_TOOL_NAMES = ['create_task', 'update_task', 'review_task', 'get_board'] as const;

/** fork 子面剔除族单点(L2 终审 Important):send_message(消息身份属 lead+具名 teammate,fork 子面不发)+
 *  lead-only 板工具(含 get_board:fork 不读板,读取权威在 lead 与成员面)。三处 fork-scope 派生点同源
 *  消费——subagent.ts deriveChildRegistry、loop/nodes.ts agentNode、graph/nodes.ts makeLoopNode;
 *  增名即扩剔,防漂移由 harness/fork-face.test.ts 钉测(常量即契约)。 */
export const FORK_EXCLUDED_TOOLS = ['send_message', ...TASKBOARD_TOOL_NAMES] as const;

/** 板摘要尾(观察行尾附):summaryLines 单点(与成员面 get_board 读面同源) */
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
        dependsOn: { type: ['array', 'null'], items: { type: 'string' }, description: 'Task ids this task depends on (e.g. ["task-build-parser-k3f2"]); null/empty = no dependencies. A task dispatches only after all dependencies are done.' },
        assignee: { type: ['string', 'null'], description: 'Optional teammate name to route this task to (an active teammate picks it up directly; unset = any idle teammate may claim it).' },
        gated: { type: ['boolean', 'null'], description: 'Pass true to hold the task behind an approval gate from creation (dispatch skips it until review_task approves).' },
        executor: { type: ['string', 'null'], enum: ['internal', 'external-cli', null], description: 'Execution routing hint: "internal" = subagent fork (default), "external-cli" = external CLI executor.' },
      },
    },
    name: 'create_task',
    description:
      'Create a task on the shared task board (任务板=智能体团队的协作面) — the coordination surface for multi-role interdependent work (dependency ordering, approval gates, per-role assignment, review closes). Unblocked tasks (no unfinished dependencies, not gated) are dispatched automatically — to a subagent fork, or claimed by a registered teammate (assigned tasks go to that teammate). Block on completion with task_wait (taskIds=null waits on dispatched board tasks). The board persists across sessions. Pass gated=true to hold the task behind an approval gate from creation (dispatch skips it until review_task approves). Pass executor ("internal" or "external-cli") as the execution routing hint. For a single independent one-shot task, a plain background spawn is lighter than a board task.',
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

  // update_task:存量任务的全部后创建变更归一(assign/gate/cancel/depend 四动作——旧四个薄工具的收束形;
  // 依赖/分配的合理性是 lead 的规划职责,不再拆成逐个出牌的模型工具)
  const updateTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'action'],
      properties: {
        taskId: { type: 'string', description: 'Board task id (e.g. "task-build-parser-k3f2").' },
        action: { type: 'string', enum: ['assign', 'gate', 'cancel', 'depend'], description: 'assign = route to a teammate (needs assignee); gate = hold behind an approval gate (needs note); cancel = cancel a pending/gated/blocked task; depend = add a dependency edge (needs dependsOn)' },
        assignee: { type: ['string', 'null'], description: 'Teammate name for action=assign.' },
        note: { type: ['string', 'null'], description: 'Gate reason for action=gate.' },
        dependsOn: { type: ['string', 'null'], description: 'Dependency task id for action=depend; rejected if it would create a cycle.' },
      },
    },
    name: 'update_task',
    description:
      'Update a board task after creation: re-assign it to a teammate (assign), hold it behind an approval gate (gate), cancel it (cancel), or add a dependency edge (depend). Terminal tasks (done/failed/cancelled) cannot be updated; claimed tasks must be stopped before cancel.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskId?: string | null; action?: string | null; assignee?: string | null; note?: string | null; dependsOn?: string | null };
      const taskId = String(raw.taskId ?? '');
      const action = raw.action ?? '';
      const r =
        action === 'assign'
          ? board.assign(taskId, String(raw.assignee ?? ''))
          : action === 'gate'
            ? board.gate(taskId, raw.note ?? undefined)
            : action === 'cancel'
              ? board.cancel(taskId)
              : action === 'depend'
                ? board.setDependency(taskId, String(raw.dependsOn ?? ''))
                : fail('INVALID_ARG', `unknown action: ${action} (assign|gate|cancel|depend)`);
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: [`updated: ${taskId} ${action}`, boardTail(board)].join('\n'), stderr: '', timedOut: false };
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

  // get_board 收编进 lead 面(2026-10-20:此前只在成员面——lead 无板读取工具的缺口补齐)
  const getBoard = makeGetBoardTool(board);

  return [createTask, updateTask, reviewTask, getBoard];
}

/** get_board 工具工厂(lead 面与成员面共享单点,消双实现):executor 同源 board.summaryLines;
 *  description 按面注入(lead 面带规划定位,成员面带 get_task 指引) */
export function makeGetBoardTool(board: TaskBoard, description?: string): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {},
    },
    name: 'get_board',
    description:
      description ??
      'Read the shared task board: one summary line per task (id, status symbol, gated ⚠ marker, title, dependencies, assignee/executedBy) plus the team budget line. The task lifecycle authority for planning and task_wait targeting.',
    category: 'task',
    fullObservation: true,
    executor: async () => {
      const lines = board.summaryLines();
      return { exitCode: 0, stdout: lines.length === 0 ? '(task board empty)' : lines.join('\n'), stderr: '', timedOut: false };
    },
  };
}
