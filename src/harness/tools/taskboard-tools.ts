// TaskBoard lead 工具面:create_team / create_task / update_task / get_board。
// update_task 只保留 assign|depend;取消走 task_stop。观察尾附板摘要(summaryLines)。
// lead-only:板四件套 + create_teammate 经 FORK_EXCLUDED_TOOLS 剔出子面。
import { CodedToolError, RegisteredTool } from '../tools';
import { fail } from '../../result';
import type { SessionEvent } from '../../types';
import type { TaskBoard } from '../../taskboard/board';
import type { AgentTeamRegistry } from '../../taskboard/team-registry';

export const TASKBOARD_TOOL_NAMES = ['create_team', 'create_task', 'update_task', 'get_board'] as const;

/** 子智能体派生面剔除族:send_message + create_teammate + 板四件套(建队/建任务/建成员属 lead)。
 *  三处 fork-scope 派生点同源;增名即扩剔(harness/fork-face.test.ts)。 */
export const FORK_EXCLUDED_TOOLS = ['send_message', 'create_teammate', ...TASKBOARD_TOOL_NAMES] as const;

/** JSON null / 字面 "null" / 空串 → 缺席(与 spawn/create_teammate 同病单点) */
function nullish(v: unknown): boolean {
  return v === null || v === 'null' || v === 'undefined' || v === '';
}

function boardTail(board: TaskBoard): string {
  const lines = board.summaryLines();
  return lines.length === 0 ? '(task board empty)' : ['board:', ...lines].join('\n');
}

export function makeTaskBoardTools(
  board: TaskBoard,
  teams: AgentTeamRegistry,
  onEvent?: (e: SessionEvent) => void,
): RegisteredTool[] {
  const createTeam: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Display name for the team card; the system assigns teamId.' },
      },
    },
    name: 'create_team',
    description:
      'Create a team and return teamId. Typical order: create_team → create_teammate (one or more) → create_task. Board tasks are work items claimed by teammates on this teamId; without living teammates they stay pending. Several teams may exist in one session; tasks and messages stay inside one team.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const name = String((input as { name?: unknown }).name ?? '');
      const r = teams.create(name);
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      onEvent?.({
        type: 'team-created',
        payload: { teamId: r.value.teamId, name: r.value.name, createdAt: r.value.createdAt },
        ts: Date.now(),
      });
      return {
        exitCode: 0,
        stdout: `team "${r.value.name}" created — teamId=${r.value.teamId} (bind create_teammate / create_task to this teamId)`,
        stderr: '',
        timedOut: false,
      };
    },
  };

  const createTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['teamId', 'title', 'spec', 'dependsOn', 'assignee', 'executor', 'retryOf'],
      properties: {
        teamId: { type: 'string', description: 'teamId from create_team.' },
        title: { type: ['string', 'null'], description: 'Short title on the board.' },
        spec: {
          type: ['string', 'null'],
          description: 'Self-contained instructions for the teammate (they see only this — include paths, inputs, outputs, acceptance).',
        },
        dependsOn: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Same-team task ids that must be success before this task is claimable; JSON null = none.',
        },
        assignee: {
          type: ['string', 'null'],
          description: 'Living teammate name on this team, or JSON null so any idle teammate may claim it.',
        },
        executor: {
          type: ['string', 'null'],
          enum: ['internal', 'external-cli', null],
          description: '"internal" (default) = teammates claim/assign; "external-cli" = external CLI. JSON null = internal.',
        },
        retryOf: {
          type: ['string', 'null'],
          description: 'JSON null normally; set to a terminal same-team task id only when recreating that work.',
        },
      },
    },
    name: 'create_task',
    description:
      'Add a work item to a team board (teamId from create_team). Call create_teammate on that team first — tasks run only when a living teammate claims or is assigned them; they stay pending otherwise. After dependencies are all success the task becomes claimable. Wait with task_wait on the board task id(s) from the receipt (prefer explicit ids; taskIds=null only covers work already running). Terminal states (success/failed/cancelled) are final — redo via a new create_task with retryOf. For a single one-shot subtask outside the board, use spawn. Unused optional fields: JSON null (not the string "null").',
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
      const retryOf = typeof raw.retryOf === 'string' && !nullish(raw.retryOf) ? raw.retryOf.trim() : undefined;
      const assignee = typeof raw.assignee === 'string' && !nullish(raw.assignee) ? raw.assignee.trim() : undefined;
      const dependsOn = Array.isArray(raw.dependsOn)
        ? raw.dependsOn.map(String).filter((d) => d !== '' && !nullish(d))
        : undefined;
      const r = board.create({
        teamId: String(raw.teamId ?? ''),
        title: String(raw.title ?? ''),
        spec: String(raw.spec ?? ''),
        dependsOn,
        assignee,
        executor,
        ...(retryOf !== undefined ? { retryOf } : {}),
      });
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error.message);
      const title = String(raw.title ?? '').trim();
      const titleBit = title !== '' ? `"${title}"` : r.value.taskId;
      return {
        exitCode: 0,
        stdout: [
          `task ${titleBit} created (id=${r.value.taskId}); wait with task_wait taskIds=["${r.value.taskId}"] (or other board ids)`,
          boardTail(board),
        ].join('\n'),
        stderr: '',
        timedOut: false,
      };
    },
  };

  const updateTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'action', 'assignee', 'dependsOn'],
      properties: {
        taskId: { type: 'string', description: 'Board task id (e.g. "task-build-parser-k3f2").' },
        action: {
          type: 'string',
          enum: ['assign', 'depend'],
          description: 'assign = set living teammate (needs assignee); depend = add dependency (needs dependsOn). Stop with task_stop.',
        },
        assignee: { type: ['string', 'null'], description: 'Living teammate name when action=assign; JSON null otherwise.' },
        dependsOn: { type: ['string', 'null'], description: 'Dependency task id when action=depend; JSON null otherwise.' },
      },
    },
    name: 'update_task',
    description:
      'Change a non-terminal board task: assign routes it to a living teammate on the same team (triggers claim); depend adds a same-team dependency edge. Terminal tasks cannot be updated — recreate with create_task and retryOf. Cancel with task_stop.',
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

  return [createTeam, createTask, updateTask, makeGetBoardTool(board)];
}

/** get_board 工厂(lead / teammate 面共享);description 可按面覆盖 */
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
      'Read board task lines: id [status] title (needs deps) team=<teamId> [retryOf=…], plus budget line when capped. Does not list teammates — use names from create_teammate receipts. Authority for planning and task_wait board ids.',
    category: 'task',
    fullObservation: true,
    executor: async () => {
      const lines = board.summaryLines();
      return { exitCode: 0, stdout: lines.length === 0 ? '(task board empty)' : lines.join('\n'), stderr: '', timedOut: false };
    },
  };
}
