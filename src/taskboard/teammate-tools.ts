// T3(P2 spec §5):teammate 只读板工具面——get_board / get_task。L1 注入目标:只进 teammate 派生面
// (deriveTeammateRegistry),主链面与 fork 子面均零注册(板面操作权归主链 lead,teammate 只读拉详情)。
// 文案恒英文单语(工具 description 直接进模型面)。
import { CodedToolError, RegisteredTool, ToolRegistry } from '../harness/tools';
import { SPAWN_TOOL_NAME } from '../harness/subagent';
import { TASKBOARD_TOOL_NAMES } from '../harness/tools/taskboard-tools';
import type { TaskBoard } from './board';

/** todo_write 工具名(harness/subagent.ts 同名私有常量的字面量对写——彼处不导出,导出面不值得
 *  为一个字面量扩 API;drift 由本文件与 deriveChildRegistry 两队剔除断言钉住) */
const TODO_TOOL_NAME = 'todo_write';

/** teammate 只读板工具对:get_board(无参,板摘要行)+ get_task({taskId},单任务全量) */
export function makeTeammateTools(board: TaskBoard): RegisteredTool[] {
  const getBoard: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {},
    },
    name: 'get_board',
    description:
      'Read the shared task board summary: one line per task in id order — id [status] [gated] title (needs deps). Read-only; use get_task for one task\'s full spec, assignee and execution artifact.',
    category: 'read',
    fullObservation: true,
    executor: async () => {
      const lines = board.summaryLines();
      return { exitCode: 0, stdout: lines.length === 0 ? '(task board empty)' : lines.join('\n'), stderr: '', timedOut: false };
    },
  };
  const getTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'Board task id (e.g. "t1").' },
      },
    },
    name: 'get_task',
    description:
      'Read one task from the shared task board in full: id, status (with gate state), title, self-contained spec, dependencies, assignee and execution artifact (conclusion, tokens, duration). Read-only.',
    category: 'read',
    fullObservation: true,
    executor: async (input) => {
      const taskId = String((input as { taskId?: unknown }).taskId ?? '').trim();
      const task = board.snapshot().tasks[taskId];
      if (task === undefined) throw new CodedToolError('INVALID_ARG', `unknown task: ${taskId === '' ? '(empty)' : taskId}`);
      const lines = [
        `id: ${task.id}`,
        `status: ${task.status}${task.gated === true ? ' (gated)' : ''}`,
        `title: ${task.title}`,
        `spec: ${task.spec}`,
        `dependsOn: ${task.dependsOn.length > 0 ? task.dependsOn.join(',') : '(none)'}`,
        `assignee: ${task.assignee ?? '(unassigned)'}`,
      ];
      if (task.artifact !== undefined) {
        lines.push(
          `artifact: conclusion=${task.artifact.conclusion ?? ''} tokens=${task.artifact.tokens ?? 0} durationMs=${task.artifact.durationMs ?? 0}`,
        );
      }
      return { exitCode: 0, stdout: lines.join('\n'), stderr: '', timedOut: false };
    },
  };
  return [getBoard, getTask];
}

/** teammate 派生工具面(L1 注入单点):base 克隆剔 spawn/todo_write/ask_question/worktree/taskboard 五件套
 *  (与 SubagentRunner.deriveChildRegistry 同剔除集——teammate 不得再生子代、不得碰板面写操作),
 *  再注册 get_board/get_task;messageTool 在场则追加注册 send_message(T2 双面裁定:send_message 不入
 *  TASKBOARD_TOOL_NAMES——teammate 面也要有,lead-only 剔除表不适用;排己白名单由装配点闭包注入)。
 *  team 接缝(P2 agent-message):teammate 面收件人活名单的数据源(harness registryFactory 消费)。
 *  原 registry 零突变;每次调用新面(装配期一次性,teammate.ts registryFactory 消费) */
export function deriveTeammateRegistry(
  base: ToolRegistry,
  board: TaskBoard,
  team?: { aliveNames(): string[] },
  messageTool?: RegisteredTool,
): ToolRegistry {
  const face = base.derive({ exclude: [SPAWN_TOOL_NAME, TODO_TOOL_NAME, 'ask_question', 'worktree', ...TASKBOARD_TOOL_NAMES] });
  for (const t of makeTeammateTools(board)) face.register(t);
  if (messageTool) face.register(messageTool);
  return face;
}
