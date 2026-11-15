// T3(P2 spec §5):teammate 只读板工具面——get_agent_team_board / get_task。L1 注入目标:只进 teammate 派生面
// (deriveTeammateRegistry),主链面与 fork 子面均零注册(板面操作权归主链 lead,teammate 只读拉详情)。
// 文案恒英文单语(工具 description 直接进模型面)。
import { CodedToolError, RegisteredTool, ToolRegistry } from '../harness/tools';
import { SPAWN_TOOL_NAME } from '../harness/subagent';
import { makeGetBoardTool, TASKBOARD_TOOL_NAMES } from '../harness/tools/taskboard-tools';
import { makeAskQuestionTool } from '../harness/tools/builtin';
import { makeTaskWaitTool } from '../harness/tools/task-wait';
import type { TaskRegistry } from '../harness/tasks';
import type { AskUserSeam } from '../types';
import type { TaskBoard } from './board';

/** todo_write 工具名(harness/subagent.ts 同名私有常量的字面量对写——彼处不导出,导出面不值得
 *  为一个字面量扩 API;drift 由本文件与 deriveChildRegistry 两队剔除断言钉住) */
const TODO_TOOL_NAME = 'todo_write';

/** teammate 只读板工具对:get_agent_team_board(共享工厂,成员面描述)+ get_task({taskId},单任务全量) */
export function makeTeammateTools(board: TaskBoard): RegisteredTool[] {
  const getBoard = makeGetBoardTool(
    board,
    'Read-only board summary (id [status] title deps teamId [retryOf]). Use get_task for full spec/assignee/artifact of one task.',
  );
  const getTask: RegisteredTool = {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'Board task id (e.g. "task-build-parser-k3f2").' },
      },
    },
    name: 'get_task',
    description:
      'Read one board task in full (id, status, title, teamId, spec, dependsOn, assignee, retryOf, artifact). Read-only.',
    category: 'read',
    fullObservation: true,
    executor: async (input) => {
      const taskId = String((input as { taskId?: unknown }).taskId ?? '').trim();
      const task = board.snapshot().tasks[taskId];
      if (task === undefined) throw new CodedToolError('INVALID_ARG', `unknown task: ${taskId === '' ? '(empty)' : taskId}`);
      const lines = [
        `id: ${task.id}`,
        `status: ${task.status}`,
        `title: ${task.title}`,
        `teamId: ${task.teamId}`,
        `spec: ${task.spec}`,
        `dependsOn: ${task.dependsOn.length > 0 ? task.dependsOn.join(',') : '(none)'}`,
        `assignee: ${task.assignee ?? '(unassigned)'}`,
      ];
      if (task.retryOf !== undefined && task.retryOf.length > 0) lines.push(`retryOf: ${task.retryOf}`);
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

/** 派生可注入面（2026-11-15 sunx P2 Task 2 收敛：Task 1 移交义务——原 6 位置参收敛为 opts 对象，
 *  接缝错位由编译期失配兜底；行为逐字节等价，既有 teammate-face/teammate/message 三套锚保持绿） */
export interface TeammateRegistryOpts {
  /** teammate 面 send_agent_team_message 注入器（缺席=面无消息件） */
  messageTool?: RegisteredTool;
  /** 账本（task_wait 换装 exec-only——可等自动转后台命令不可等板任务；缺席=卸下 lead 版 task_wait） */
  tasks?: TaskRegistry;
  /** 路由 ask 接缝（缺席=headless 装配 → 剔除旧制：成员不中途发问，结论回写即应答） */
  ask?: AskUserSeam;
  /** 逐任务归因（ask+askedBy 双在场才注册路由版 ask_question；taskId=板任务 id 由 teammate.execute 带上） */
  askedBy?: { label: string; taskId?: string };
}

/** teammate 派生工具面(L1 注入单点):base 克隆剔 spawn/todo_write/worktree/
 *  create_agent_teammate+板四件套(成员不得建队/建成员/写板;与 fork 面 lead-only 同口径,但 send_agent_team_message
 *  保留——T2 双面裁定:send_agent_team_message 不入 TASKBOARD_TOOL_NAMES,teammate 面要有),
 *  再注册 get_agent_team_board/get_task;opts.messageTool 在场则追加注册 send_agent_team_message;
 *  task_wait 换装 kinds=['exec'](可等自动转后台的命令,不可等板任务——防自等死锁);
 *  排己白名单由装配点闭包注入。原 registry 零突变;每次调用新面(装配期一次性,teammate.ts registryFactory 消费)。
 *
 *  路由 ask(2026-11-15 sunx P2 Task 1,形态对齐 fork deriveChildRegistry):ask 接缝+归因在场 → 注册路由版
 *  ask_question(askedBy={label:成员名, taskId:板任务 id} 归因直通主对话挂起卡;taskId 参数位由 Task 2 板通道
 *  「成员执行板任务时带板任务 id」直接复用);ask 缺席(headless 装配)维持剔除旧制(结论回写即应答)。
 *  实现与 fork 同构:先无条件摘除,接缝+归因双在场才回注册路由版——「移除 ask_question 无条件剔除」。 */
export function deriveTeammateRegistry(base: ToolRegistry, board: TaskBoard, opts?: TeammateRegistryOpts): ToolRegistry {
  const { messageTool, tasks, ask, askedBy } = opts ?? {};
  const face = base.derive({
    exclude: [SPAWN_TOOL_NAME, TODO_TOOL_NAME, 'worktree', 'create_agent_teammate', 'agent_team_task_wait', ...TASKBOARD_TOOL_NAMES],
  });
  // 路由版 ask(fork routeAsk 同构):无条件摘除后按接缝+归因双在场回注册——旧制锚由 teammate-face.test 钉住
  face.unregister('ask_question');
  if (ask !== undefined && askedBy !== undefined) {
    face.register(makeAskQuestionTool((req) => ask({ ...req, askedBy })));
  }
  for (const t of makeTeammateTools(board)) face.register(t);
  if (messageTool) face.register(messageTool);
  if (face.get('task_wait') !== undefined) {
    face.unregister('task_wait');
    if (tasks !== undefined) face.register(makeTaskWaitTool(tasks, undefined, undefined, { kinds: ['exec'] }));
  }
  return face;
}
