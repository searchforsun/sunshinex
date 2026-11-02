/** TaskBoard 域模型纯件: 五态状态机、依赖派生、环检测、事件 reducer。
 *  零 IO 零 harness 依赖——store 重放、TaskBoard 协调器、TUI 投影三方共用同一 reducer(单点防漂移)。
 *  blocked 为派生态不落存储(上游 failed/cancelled 的 pending 下游,不自动迁移——交互场景留人裁决);
 *  cancelled 为停止与重启自愈终态。 */

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/** 板终态集合单点（stop 拒识/wait 判等/board 流转三面共用，D63 收敛）：pending/running 可流转，三终态幂等 */
export const BOARD_TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['success', 'failed', 'cancelled']);

export interface BoardTask {
  id: string;
  title: string;
  /** 自包含任务描述:执行体不看主链也能干(可替换性前提) */
  spec: string;
  status: TaskStatus;
  teamId: string;
  dependsOn: string[];
  retryOf?: string;
  assignee?: string;
  /** 实际执行者:派发即落(status-changed by)、回写刷新;与 assignee(应派谁)正交 */
  executedBy?: string;
  /** 执行体路由提示(P2):internal=子智能体 fork(缺省)/external-cli=外部 CLI 执行体 */
  executorHint?: 'internal' | 'external-cli';
  createdAt: number;
  updatedAt: number;
  artifact?: { conclusion?: string; tokens?: number; durationMs?: number };
}

export interface TaskBoardState {
  tasks: Record<string, BoardTask>;
  /** 已发放任务计数(id 方言 t<seq> 的单调源) */
  seq: number;
}

export type BoardEvent =
  | { t: 'task-created'; taskId: string; title: string; spec: string; dependsOn: string[]; teamId: string; retryOf?: string; executorHint?: 'internal' | 'external-cli'; ts: number }
  | { t: 'dependency-added'; taskId: string; dependsOn: string; ts: number }
  | { t: 'assigned'; taskId: string; assignee: string; ts: number }
  | { t: 'status-changed'; taskId: string; from: TaskStatus; to: TaskStatus; ts: number; note?: string; conclusion?: string; tokens?: number; durationMs?: number; by?: string };

const LEGAL: Record<TaskStatus, TaskStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['success', 'failed', 'cancelled'],
  success: [],
  failed: [],
  cancelled: [],
};

/** 五态表外的起点（重放旧档时出现）没有出边 */
function outbound(from: string): readonly TaskStatus[] | undefined {
  return (LEGAL as Record<string, readonly TaskStatus[] | undefined>)[from];
}

export function transitionLegal(from: TaskStatus, to: TaskStatus): boolean {
  return outbound(from)?.includes(to) ?? false;
}

export function transitionError(from: TaskStatus, to: TaskStatus): string {
  const allowed = outbound(from) ?? [];
  const allowedText = allowed.length === 0 ? 'none' : allowed.join(', ');
  if (allowed.length === 0) {
    return `cannot transition from ${from} to ${to}; terminal state has no outbound edges (allowed: ${allowedText})`;
  }
  return `cannot transition from ${from} to ${to}; allowed: ${allowedText}`;
}

export function emptyBoard(): TaskBoardState {
  return { tasks: {}, seq: 0 };
}

/** 事件 reducer(纯):事件流是协调状态的唯一真相源;未知 taskId、未知事件类型、非法迁移均原引用返回(零分配) */
export function applyBoardEvent(state: TaskBoardState, ev: BoardEvent): TaskBoardState {
  switch (ev.t) {
    case 'task-created': {
      if (state.tasks[ev.taskId] !== undefined) return state;
      const task: BoardTask = {
        id: ev.taskId, title: ev.title, spec: ev.spec, status: 'pending', teamId: ev.teamId,
        dependsOn: [...ev.dependsOn], createdAt: ev.ts, updatedAt: ev.ts,
        ...(ev.retryOf !== undefined ? { retryOf: ev.retryOf } : {}),
        ...(ev.executorHint !== undefined ? { executorHint: ev.executorHint } : {}),
      };
      return { tasks: { ...state.tasks, [ev.taskId]: task }, seq: Math.max(state.seq, Number(ev.taskId.slice(1)) || 0) };
    }
    case 'dependency-added': {
      const task = state.tasks[ev.taskId];
      if (task === undefined || task.dependsOn.includes(ev.dependsOn)) return state;
      return patch(state, ev.taskId, { dependsOn: [...task.dependsOn, ev.dependsOn], updatedAt: ev.ts });
    }
    case 'assigned': {
      const task = state.tasks[ev.taskId];
      if (task === undefined) return state;
      return patch(state, ev.taskId, { assignee: ev.assignee, updatedAt: ev.ts });
    }
    case 'status-changed': {
      const task = state.tasks[ev.taskId];
      if (task === undefined || !transitionLegal(ev.from, ev.to)) return state;
      const artifact = ev.conclusion !== undefined || ev.tokens !== undefined || ev.durationMs !== undefined
        ? { ...task.artifact, ...(ev.conclusion !== undefined ? { conclusion: ev.conclusion } : {}), ...(ev.tokens !== undefined ? { tokens: ev.tokens } : {}), ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}) }
        : task.artifact;
      return patch(state, ev.taskId, { status: ev.to, updatedAt: ev.ts, ...(artifact !== task.artifact ? { artifact } : {}), ...(ev.by !== undefined ? { executedBy: ev.by } : {}) });
    }
    default:
      return state;
  }
}

function patch(state: TaskBoardState, id: string, fields: Partial<BoardTask>): TaskBoardState {
  const task = state.tasks[id]!;
  return { ...state, tasks: { ...state.tasks, [id]: { ...task, ...fields } } };
}

/** 派生 blocked:pending 且任一依赖 failed/cancelled——不自动 skip,等 lead 裁决 */
export function derivedBlocked(state: TaskBoardState, taskId: string): boolean {
  const task = state.tasks[taskId];
  if (task === undefined || task.status !== 'pending') return false;
  return task.dependsOn.some((d) => {
    const dep = state.tasks[d];
    return dep !== undefined && (dep.status === 'failed' || dep.status === 'cancelled');
  });
}

/** 可派发集合:pending 且依赖全 success(retryOf 不参与阻塞;创建序) */
export function dispatchable(state: TaskBoardState): BoardTask[] {
  return Object.values(state.tasks)
    .filter((t) => t.status === 'pending' && t.dependsOn.every((d) => state.tasks[d]?.status === 'success'))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Kahn 环检测:返回环成员清单或 null */
export function hasCycle(tasks: Array<{ id: string; dependsOn: string[] }>): string[] | null {
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, 0);
    dependents.set(t.id, []);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!indeg.has(d)) continue;
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
      dependents.get(d)!.push(t.id);
    }
  }
  let frontier = [...indeg.keys()].filter((id) => indeg.get(id) === 0);
  let placed = 0;
  while (frontier.length > 0) {
    placed += frontier.length;
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id)!) {
        indeg.set(dep, (indeg.get(dep) ?? 1) - 1);
        if (indeg.get(dep) === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  if (placed < indeg.size) {
    return [...indeg.keys()].filter((id) => (indeg.get(id) ?? 0) > 0);
  }
  return null;
}

/** 重启自愈:pending 与 running → cancelled;终态不动 */
export function recoverOnLoad(state: TaskBoardState): { state: TaskBoardState; recovered: string[] } {
  const recovered = Object.values(state.tasks)
    .filter((t) => t.status === 'pending' || t.status === 'running')
    .map((t) => t.id);
  if (recovered.length === 0) return { state, recovered };
  let next = state;
  const ts = Date.now();
  for (const id of recovered) {
    const from = next.tasks[id]!.status as 'pending' | 'running';
    next = applyBoardEvent(next, {
      t: 'status-changed', taskId: id, from, to: 'cancelled', ts,
      note: from === 'running'
        ? 'interrupted by restart (execution lost — recreate the task if needed)'
        : 'no live executors after restart — recreate the task if needed',
    });
  }
  return { state: next, recovered };
}
