// TaskBoard lead 工具面:create_team / create_task / update_task / get_board。
// update_task 只保留 assign|depend;取消走 task_stop。观察尾附板摘要(summaryLines);
// create_task 即触发派发(drain 异步),等待经既有 task_wait。
// lead-only 不变量:四件套随 deriveChildRegistry/deriveTeammateRegistry 扩剔(TASKBOARD_TOOL_NAMES
// ——两处 spread 自动随动,增名即扩剔),子智能体工具面不可见。
import { CodedToolError, RegisteredTool } from '../tools';
import { fail } from '../../result';
import type { TaskBoard } from '../../taskboard/board';
import type { AgentTeamRegistry } from '../../taskboard/team-registry';

export const TASKBOARD_TOOL_NAMES = ['create_team', 'create_task', 'update_task', 'get_board'] as const;

/** fork 子面剔除族单点:send_message(消息身份属 lead+具名 teammate,fork 子面不发)+
 *  lead-only 板工具(含 get_board:fork 不读板,读取权威在 lead 与成员面)。三处 fork-scope 派生点同源
 *  消费——subagent.ts deriveChildRegistry、loop/nodes.ts agentNode、graph/nodes.ts makeLoopNode;
 *  增名即扩剔,防漂移由 harness/fork-face.test.ts 钉测(常量即契约)。 */
export const FORK_EXCLUDED_TOOLS = ['send_message', ...TASKBOARD_TOOL_NAMES] as const;

/** 板摘要尾(观察行尾附):summaryLines 单点(与成员面 get_board 读面同源) */
function boardTail(board: TaskBoard): string {
  const lines = board.summaryLines();
  return lines.length === 0 ? '(task board empty)' : ['board:', ...lines].join('\n');
}

export function makeTaskBoardTools(board: TaskBoard, teams: AgentTeamRegistry): RegisteredTool[] {
  const createTeam: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Team name. The card title; the system assigns teamId.' },
      },
    },
    name: 'create_team',
    description:
      'Create an agent team and return its teamId. Tasks (create_task) and teammates (create_teammate) must bind to this id. Call this before creating tasks or teammates. A session may hold several teams; work and messages stay inside one team.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const name = String((input as { name?: unknown }).name ?? '');
      const r = teams.create(name);
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: `team ${r.value.teamId} created (${r.value.name})`, stderr: '', timedOut: false };
    },
  };

  const createTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['teamId', 'title', 'spec', 'dependsOn', 'assignee', 'executor', 'retryOf'],
      properties: {
        teamId: { type: 'string', description: 'Team id from create_team. The task is rejected if this team does not exist.' },
        title: { type: ['string', 'null'], description: 'Short task title shown on the board.' },
        spec: { type: ['string', 'null'], description: 'Self-contained task description: the executing agent sees ONLY this (no main-chain context), so include everything needed.' },
        dependsOn: { type: ['array', 'null'], items: { type: 'string' }, description: 'Task ids this task depends on (same team, e.g. ["task-build-parser-k3f2"]); null/empty = no dependencies. A task dispatches only after every dependency is success.' },
        assignee: { type: ['string', 'null'], description: 'Optional teammate name on this team. An active teammate picks the task up directly; null = any idle teammate on the team may claim it.' },
        executor: { type: ['string', 'null'], enum: ['internal', 'external-cli', null], description: 'Execution routing hint: "internal" = subagent fork (default), "external-cli" = external CLI executor.' },
        retryOf: { type: ['string', 'null'], description: 'Id of a terminal task on the same team that this task retries. Does not block dispatch. The predecessor must already be success, failed, or cancelled.' },
      },
    },
    name: 'create_task',
    description:
      'Create a task on one team\'s shared task board (teamId from create_team). Unblocked tasks (every dependency is success) dispatch automatically — to a subagent fork, or to a teammate on that team (assigned tasks go to that teammate). Block on completion with task_wait (taskIds=null waits on dispatched board tasks). The board persists across sessions. Terminal tasks (success/failed/cancelled) are final: a failed task is never auto-rerun, and a task still open at app restart is cancelled. To redo that work, create a NEW task here with the same teamId and retryOf set to the predecessor id (retryOf does not block dispatch); check get_board for which dependents were blocked and recreate them too if still wanted. Pass executor ("internal" or "external-cli") as the execution routing hint. For a single independent one-shot task, a plain background spawn is lighter than a board task.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as {
        title?: string | null;
        spec?: string | null;
        dependsOn?: string[] | null;
        assignee?: string | null;
        teamId?: string | null;
        executor?: string | null;
        retryOf?: string | null;
      };
      const executor = raw.executor === 'internal' || raw.executor === 'external-cli' ? raw.executor : undefined;
      const retryOf = typeof raw.retryOf === 'string' && raw.retryOf.length > 0 ? raw.retryOf : undefined;
      const r = board.create({
        teamId: String(raw.teamId ?? ''),
        title: String(raw.title ?? ''),
        spec: String(raw.spec ?? ''),
        dependsOn: raw.dependsOn ?? undefined,
        assignee: raw.assignee ?? undefined,
        executor,
        ...(retryOf !== undefined ? { retryOf } : {}),
      });
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: [`task ${r.value.taskId} created; dispatch is automatic for unblocked tasks — block with task_wait (taskIds=null)`, boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };

  const updateTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'action', 'assignee', 'dependsOn'],
      properties: {
        taskId: { type: 'string', description: 'Board task id (e.g. "task-build-parser-k3f2").' },
        action: { type: 'string', enum: ['assign', 'depend'], description: 'assign = route to a teammate on the same team (needs assignee); depend = add a dependency edge (needs dependsOn). Cancel with task_stop.' },
        assignee: { type: ['string', 'null'], description: 'Teammate name for action=assign.' },
        dependsOn: { type: ['string', 'null'], description: 'Dependency task id for action=depend; rejected if it would create a cycle or cross teams.' },
      },
    },
    name: 'update_task',
    description:
      'Update a board task after creation: re-assign it to a teammate (assign) or add a dependency edge (depend). Cancel a pending or running task with task_stop. Terminal tasks (success/failed/cancelled) cannot be updated — a failed task, or one cancelled by a stop or a restart, is dead: recreate the work as a new task with create_task and retryOf.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { taskId?: string | null; action?: string | null; assignee?: string | null; dependsOn?: string | null };
      const taskId = String(raw.taskId ?? '');
      const action = raw.action ?? '';
      const r =
        action === 'assign'
          ? board.assign(taskId, String(raw.assignee ?? ''))
          : action === 'depend'
            ? board.setDependency(taskId, String(raw.dependsOn ?? ''))
            : fail('INVALID_ARG', `unknown action: ${action} (assign|depend)`);
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      return { exitCode: 0, stdout: [`updated: ${taskId} ${action}`, boardTail(board)].join('\n'), stderr: '', timedOut: false };
    },
  };

  const getBoard = makeGetBoardTool(board);

  return [createTeam, createTask, updateTask, getBoard];
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
      'Read the shared task board: one summary line per task (id, status, title, dependencies, team id, retryOf when set) plus the team budget line. The task lifecycle authority for planning and task_wait targeting.',
    category: 'task',
    fullObservation: true,
    executor: async () => {
      const lines = board.summaryLines();
      return { exitCode: 0, stdout: lines.length === 0 ? '(task board empty)' : lines.join('\n'), stderr: '', timedOut: false };
    },
  };
}
