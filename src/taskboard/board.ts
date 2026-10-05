import type { SessionEvent } from '../types';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';
import { reactorMaxStepsEnv, subagentTokenCapEnv } from '../config/termination-config';
import { fail, ok, Result } from '../result';
import {
  applyBoardEvent, BoardEvent, BoardTask, dispatchable, emptyBoard, hasCycle,
  recoverOnLoad, TaskBoardState, transitionLegal,
} from './model';
import type { TeamStore } from './store';

/** TaskBoard 协调器(spec §5/§7):操作面(创建/依赖/指派/裁决/门)+ 事件发射(task-* / gate-* 进
 *  SessionEvent 公共面)+ event sourcing 持久化 + 批量并行派发 drain。
 *  (注:brief 原文此处的 task 前缀与 gate 前缀连写含块注释收注序列,会提前截断注释爆 TS1109,
 *  改写为加空格形态,语义不变)
 *  派发(Ruling 1):dispatchable 批次经 registry.submit 登账本(task_wait(null) 可等待)后
 *  await runner.runSubagent(fork 顶替 teammate,§13 P1),完成即强制回写 claimed→in-review/failed
 *  (§5.4 harness 权威,不依赖模型自觉);失败对直接下游发 task-blocked(不自动 skip,§4.1)。
 *  init 只恢复不 kick(Ruling 2):旧任务不随会话启动自动执行。 */
export interface TaskBoardDeps {
  store: TeamStore;
  runner: SubagentRunner;
  registry: TaskRegistry;
  onEvent?: (e: SessionEvent) => void;
  now?: () => number;
  /** 单任务执行预算上限(ms),缺省 30 分钟 */
  taskTimeoutMs?: number;
  /** 未终态任务限流(spec §5.8),缺省 64 */
  maxOpenTasks?: number;
}

const DEFAULT_MAX_OPEN = 64;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export class TaskBoard {
  private state: TaskBoardState = emptyBoard();
  private draining = false;
  private readonly now: () => number;
  private readonly maxOpen: number;
  private readonly taskTimeoutMs: number;

  constructor(private readonly deps: TaskBoardDeps) {
    this.now = deps.now ?? Date.now;
    this.maxOpen = deps.maxOpenTasks ?? DEFAULT_MAX_OPEN;
    this.taskTimeoutMs = deps.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  }

  /** 载入恢复(§7.5):重放 → claimed 回池(自愈事件落流)→ 不 kick(Ruling 2) */
  init(): void {
    const loaded = this.deps.store.load();
    const { state, recovered } = recoverOnLoad(loaded);
    this.state = state;
    for (const id of recovered) {
      this.deps.store.append({ t: 'status-changed', taskId: id, from: 'claimed', to: 'pending', ts: this.now(), note: 'recovered after restart' });
      this.emit('task-status-changed', { taskId: id, from: 'claimed', status: 'pending', note: 'recovered after restart' });
    }
    // 惰性建档(Ruling 2「首写惰性建档」,2026-10-05 T4 评审裁定归 T3):init 接线进每个 Harness 构造后,
    // 空板(无 tasks 且 seq=0)且无恢复时不得落快照——未用过任务板的工作区零物化 teams/ 目录;有状态维持原行为。
    if (Object.keys(this.state.tasks).length === 0 && this.state.seq === 0 && recovered.length === 0) return;
    this.deps.store.writeSnapshot(this.state);
  }

  snapshot(): TaskBoardState {
    return this.state;
  }

  /** 面板摘要行(工具 observation 与 TUI 共用):`t1 [in-review] A (等 t2)` 形态 */
  summaryLines(): string[] {
    return Object.values(this.state.tasks)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((t) => {
        const dep = t.dependsOn.length > 0 ? ` (等 ${t.dependsOn.join(',')})` : '';
        const gate = t.gated === true ? ' [gated]' : '';
        return `${t.id} [${t.status}]${gate} ${t.title}${dep}`;
      });
  }

  create(input: { title: string; spec: string; dependsOn?: string[]; assignee?: string }): Result<{ taskId: string }> {
    if (typeof input.title !== 'string' || input.title.length === 0 || typeof input.spec !== 'string' || input.spec.length === 0) {
      return fail('INVALID_ARG', 'create requires non-empty title and spec');
    }
    const deps = input.dependsOn ?? [];
    const unknown = deps.filter((d) => this.state.tasks[d] === undefined);
    if (unknown.length > 0) return fail('INVALID_ARG', `unknown dependency: ${unknown.join(', ')}`);
    const open = Object.values(this.state.tasks).filter((t) => t.status !== 'done' && t.status !== 'failed' && t.status !== 'cancelled').length;
    if (open >= this.maxOpen) return fail('INVALID_ARG', `task board open-task limit reached (${this.maxOpen}); review or cancel existing tasks first`);
    const taskId = `t${this.state.seq + 1}`;
    const ev: BoardEvent = { t: 'task-created', taskId, title: input.title, spec: input.spec, dependsOn: deps, ts: this.now() };
    this.applyAndPersist(ev);
    if (input.assignee !== undefined && input.assignee.length > 0) {
      this.applyAndPersist({ t: 'assigned', taskId, assignee: input.assignee, ts: this.now() });
    }
    this.emit('task-created', { taskId, title: input.title, dependsOn: deps });
    this.kick();
    return ok({ taskId });
  }

  setDependency(taskId: string, dependsOn: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (this.state.tasks[dependsOn] === undefined) return fail('INVALID_ARG', `unknown dependency: ${dependsOn}`);
    if (task.dependsOn.includes(dependsOn)) return ok(undefined);
    const candidate = Object.values(this.state.tasks).map((t) =>
      t.id === taskId ? { id: t.id, dependsOn: [...t.dependsOn, dependsOn] } : { id: t.id, dependsOn: [...t.dependsOn] },
    );
    const cycle = hasCycle(candidate);
    if (cycle !== null) return fail('INVALID_ARG', `dependency would create a cycle: ${cycle.join(' -> ')}`);
    this.applyAndPersist({ t: 'dependency-added', taskId, dependsOn, ts: this.now() });
    this.kick();
    return ok(undefined);
  }

  assign(taskId: string, assignee: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (typeof assignee !== 'string' || assignee.length === 0) return fail('INVALID_ARG', 'assignee must be non-empty');
    this.applyAndPersist({ t: 'assigned', taskId, assignee, ts: this.now() });
    return ok(undefined);
  }

  /** lead 裁决双语义:gated → 审批(approved 解锁 / 拒绝维持);in-review → 关单(approved=done / 拒=failed) */
  review(taskId: string, opts: { approved: boolean; note?: string }): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (task.gated === true) {
      if (opts.approved) {
        this.applyAndPersist({ t: 'gate-resolved', taskId, approved: true, ts: this.now() });
        this.emit('gate-resolved', { taskId, approved: true });
        this.kick();
        return ok(undefined);
      }
      return ok(undefined); // 拒绝审批:维持 gated(lead 可改任务或再议)
    }
    if (task.status === 'in-review') {
      const to = opts.approved ? 'done' : 'failed';
      if (!transitionLegal('in-review', to)) return fail('INVALID_STATE', `illegal transition in-review -> ${to}`);
      this.applyAndPersist({ t: 'status-changed', taskId, from: 'in-review', to, ts: this.now(), ...(opts.note !== undefined ? { note: opts.note } : {}) });
      this.emit('task-status-changed', { taskId, from: 'in-review', status: to, ...(opts.note !== undefined ? { note: opts.note } : {}) });
      if (!opts.approved) this.emitBlockedDownstream(taskId);
      this.kick();
      return ok(undefined);
    }
    return fail('INVALID_ARG', `review expects a gated or in-review task, ${taskId} is ${task.status}`);
  }

  gate(taskId: string, note?: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (task.status === 'claimed') return fail('INVALID_ARG', 'cannot gate a task mid-execution');
    this.applyAndPersist({ t: 'gate-set', taskId, ts: this.now(), ...(note !== undefined ? { note } : {}) });
    this.emit('gate-waiting', { taskId, ...(note !== undefined ? { note } : {}) });
    return ok(undefined);
  }

  private applyAndPersist(ev: BoardEvent): void {
    this.state = applyBoardEvent(this.state, ev);
    this.deps.store.append(ev);
    this.deps.store.writeSnapshot(this.state);
  }

  private emit(type: SessionEvent['type'], payload: Record<string, unknown>): void {
    this.deps.onEvent?.({ type, payload, ts: this.now() });
  }

  /** 上游 failed:直接下游 pending 者发 task-blocked(§4.1 不自动 skip;blockedBy=其依赖中的失败者) */
  private emitBlockedDownstream(failedId: string): void {
    for (const t of Object.values(this.state.tasks)) {
      if (t.status === 'pending' && t.dependsOn.includes(failedId)) {
        const blockedBy = t.dependsOn.filter((d) => this.state.tasks[d]?.status === 'failed' || this.state.tasks[d]?.status === 'cancelled');
        this.emit('task-blocked', { taskId: t.id, blockedBy });
      }
    }
  }

  private kick(): void {
    void this.drain();
  }

  /** 批量并行派发(graph 层内 allSettled 先例):每轮取当前 dispatchable 全批并发,完成后续跑下一轮 */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const batch = dispatchable(this.state);
        if (batch.length === 0) break;
        for (const t of batch) this.emit('task-unlocked', { taskId: t.id });
        await Promise.allSettled(batch.map((t) => this.executeOne(t)));
      }
    } finally {
      this.draining = false;
    }
  }

  private async executeOne(task: BoardTask): Promise<void> {
    this.applyAndPersist({ t: 'status-changed', taskId: task.id, from: 'pending', to: 'claimed', ts: this.now() });
    this.emit('task-status-changed', { taskId: task.id, from: 'pending', status: 'claimed' });
    const ledger = this.deps.registry.submit({ kind: 'subagent', label: `task-${task.id}` });
    const abort = new AbortController();
    ledger.stop = () => abort.abort();
    this.deps.registry.append(ledger.id, `[taskboard] ${task.id}: ${task.title}\n`);
    const startedAt = this.now();
    let okRun = false;
    let reply = '';
    let tokens = 0;
    try {
      const tokenCap = subagentTokenCapEnv();
      const r = await this.deps.runner.runSubagent(
        { prompt: task.spec, label: `task-${task.id}` },
        {
          taskLine: `Task ${task.id}: ${task.title}`,
          signal: abort.signal,
          budget: {
            maxSteps: reactorMaxStepsEnv() ?? 400,
            ...(tokenCap !== undefined ? { tokenCap } : {}),
            deadlineAt: Date.now() + this.taskTimeoutMs,
          },
        },
      );
      if (r.ok) {
        okRun = true;
        reply = r.value.reply;
        tokens = r.value.tokens;
      }
    } catch {
      okRun = false;
    }
    const durationMs = this.now() - startedAt;
    // harness 强制回写(§5.4):claimed → in-review/failed,不依赖模型自觉标记
    this.applyAndPersist({
      t: 'status-changed', taskId: task.id, from: 'claimed', to: okRun ? 'in-review' : 'failed', ts: this.now(),
      ...(okRun ? { conclusion: reply, tokens, durationMs } : { note: 'execution failed' }),
    });
    this.emit('task-status-changed', { taskId: task.id, from: 'claimed', status: okRun ? 'in-review' : 'failed' });
    if (okRun) {
      this.deps.registry.finish(ledger.id, 'done', { marker: `[conclusion] ${reply}\n` });
    } else {
      this.deps.registry.finish(ledger.id, 'failed');
      this.emitBlockedDownstream(task.id);
    }
  }
}
