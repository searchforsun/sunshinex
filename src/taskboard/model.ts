/** TaskBoard 域模型纯件(spec 2026-10-04 §4.1):状态机、依赖派生、环检测、事件 reducer。
 *  零 IO 零 harness 依赖——store 重放、TaskBoard 协调器、TUI 投影三方共用同一 reducer(单点防漂移)。
 *  blocked 为派生态不落存储(上游 failed/cancelled 的 pending 下游,不自动迁移——交互场景留人裁决,spec §4.1);
 *  cancelled 状态机合法但 P1 无工具入口(P2 看板操作)。 */

export type TaskStatus = 'pending' | 'claimed' | 'in-review' | 'done' | 'failed' | 'cancelled';

export interface BoardTask {
  id: string;
  title: string;
  /** 自包含任务描述:执行体不看主链也能干(spec §4.1,可替换性前提) */
  spec: string;
  status: TaskStatus;
  dependsOn: string[];
  assignee?: string;
  /** gate 挂起(spec Ruling 3):派发跳过,review_task(approved) 解锁 */
  gated?: boolean;
  /** 执行体路由提示(P2):internal=子代理 fork(缺省)/external-cli=外部 CLI 执行体;提示不改派发语义,消费面为 P2 派发路由 */
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
  | { t: 'task-created'; taskId: string; title: string; spec: string; dependsOn: string[]; executorHint?: 'internal' | 'external-cli'; ts: number }
  | { t: 'dependency-added'; taskId: string; dependsOn: string; ts: number }
  | { t: 'assigned'; taskId: string; assignee: string; ts: number }
  | { t: 'status-changed'; taskId: string; from: TaskStatus; to: TaskStatus; ts: number; note?: string; conclusion?: string; tokens?: number; durationMs?: number }
  | { t: 'gate-set'; taskId: string; note?: string; ts: number }
  | { t: 'gate-resolved'; taskId: string; approved: boolean; ts: number };

/** 合法迁移闭集:pending→claimed/cancelled;claimed→in-review/failed/pending(恢复回池 §7.4);
 *  in-review→done/failed(lead 裁决);终态无出边 */
const LEGAL: Record<TaskStatus, TaskStatus[]> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in-review', 'failed', 'pending'],
  'in-review': ['done', 'failed'],
  done: [],
  failed: [],
  cancelled: [],
};

export function transitionLegal(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL[from].includes(to);
}

export function emptyBoard(): TaskBoardState {
  return { tasks: {}, seq: 0 };
}

/** 事件 reducer(纯):事件流是协调状态的唯一真相源(spec §7.2);未知 taskId 原引用返回(零分配) */
export function applyBoardEvent(state: TaskBoardState, ev: BoardEvent): TaskBoardState {
  switch (ev.t) {
    case 'task-created': {
      if (state.tasks[ev.taskId] !== undefined) return state;
      const task: BoardTask = {
        id: ev.taskId, title: ev.title, spec: ev.spec, status: 'pending',
        dependsOn: [...ev.dependsOn], createdAt: ev.ts, updatedAt: ev.ts,
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
      return patch(state, ev.taskId, { status: ev.to, updatedAt: ev.ts, ...(artifact !== task.artifact ? { artifact } : {}) });
    }
    case 'gate-set': {
      const task = state.tasks[ev.taskId];
      if (task === undefined) return state;
      return patch(state, ev.taskId, { gated: true, updatedAt: ev.ts });
    }
    case 'gate-resolved': {
      const task = state.tasks[ev.taskId];
      if (task === undefined || ev.approved !== true) return state;
      return patch(state, ev.taskId, { gated: false, updatedAt: ev.ts });
    }
  }
}

function patch(state: TaskBoardState, id: string, fields: Partial<BoardTask>): TaskBoardState {
  const task = state.tasks[id]!;
  return { ...state, tasks: { ...state.tasks, [id]: { ...task, ...fields } } };
}

/** 派生 blocked(§4.1):pending 且任一依赖 failed/cancelled——不自动 skip,等 lead 裁决 */
export function derivedBlocked(state: TaskBoardState, taskId: string): boolean {
  const task = state.tasks[taskId];
  if (task === undefined || task.status !== 'pending') return false;
  return task.dependsOn.some((d) => {
    const dep = state.tasks[d];
    return dep !== undefined && (dep.status === 'failed' || dep.status === 'cancelled');
  });
}

/** 可派发集合:pending && !gated && 依赖全 done(创建序)——blocked/gated/依赖未满者自然出局 */
export function dispatchable(state: TaskBoardState): BoardTask[] {
  return Object.values(state.tasks)
    .filter((t) => t.status === 'pending' && t.gated !== true && t.dependsOn.every((d) => state.tasks[d]?.status === 'done'))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Kahn 环检测(spec §12.1 器官移植,自 graph/engine.ts:50-84 同构):返回环成员清单或 null */
export function hasCycle(tasks: Array<{ id: string; dependsOn: string[] }>): string[] | null {
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, 0);
    dependents.set(t.id, []);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!indeg.has(d)) continue; // 缺失依赖由调用方先校验,此处防御跳过
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

/** 恢复回池(§7.4):claimed 无终态记录 → pending;终态/其余不动。返回恢复清单供协调器 append 自愈事件 */
export function recoverOnLoad(state: TaskBoardState): { state: TaskBoardState; recovered: string[] } {
  const recovered = Object.values(state.tasks).filter((t) => t.status === 'claimed').map((t) => t.id);
  if (recovered.length === 0) return { state, recovered };
  let next = state;
  for (const id of recovered) {
    next = applyBoardEvent(next, { t: 'status-changed', taskId: id, from: 'claimed', to: 'pending', ts: Date.now(), note: 'recovered after restart' });
  }
  return { state: next, recovered };
}
