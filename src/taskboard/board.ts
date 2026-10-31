import type { SessionEvent } from '../types';
import type { TaskRegistry } from '../harness/tasks';
import { fail, ok, Result } from '../result';
import { slugify } from '../slug';
import {
  applyBoardEvent, BoardEvent, BoardTask, dispatchable, emptyBoard, hasCycle,
  recoverOnLoad, TaskBoardState, TaskStatus, transitionError, transitionLegal,
} from './model';
import type { TeamStore } from './store';
import type { TeamRegistry } from './teammate';
import type { AgentTeamRegistry } from './team-registry';
import type { ExternalExecutorLike } from './executors/external-cli';

/** 派发登记/委派标签(台账方言单点):旧 tN 板 id(恢复档)补 task- 前缀保 resolveId 归一命中;
 *  新方言 id(task-<业务段>-<随机码>)自带类别段,原样透传防 task-task- 叠加。delegationId 同用本形态 */
export function dispatchTag(taskId: string): string {
  return /^t\d+$/.test(taskId) ? `task-${taskId}` : taskId;
}

const RESTART_RUNNING_NOTE = 'interrupted by restart (execution lost — recreate the task if needed)';
const RESTART_PENDING_NOTE = 'no live executors after restart — recreate the task if needed';

/** 执行回写:成功，或失败且可标明终态(缺省 failed;abort 路径传 cancelled) */
export type ExecutionReport =
  | { ok: true; by?: string; reply?: string; tokens?: number; durationMs?: number }
  | {
    ok: false;
    terminal?: 'failed' | 'cancelled';
    by?: string;
    reply?: string;
    tokens?: number;
    durationMs?: number;
    error?: { code?: string; message?: string };
  };

function statusTransitionError(taskId: string, from: TaskStatus, to: TaskStatus): string {
  return transitionError(from, to).replace('cannot transition from', `cannot transition ${taskId} from`);
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'success' || status === 'failed' || status === 'cancelled';
}

/** 用户中止、信号打断、ABORTED 归 cancelled；执行错误保持 failed */
export function isUserAbort(code?: string, message?: string): boolean {
  if (code === 'ABORTED') return true;
  return /\bABORTED\b/.test(code ?? '') || /\b(interrupted|aborted)\b/i.test(message ?? '');
}

/** TaskBoard 协调器:创建/依赖/指派/停止 + 事件发射 + event sourcing + 批量并行派发。
 *  内部任务只经 teammate 认领/指派执行(与临时 fork 解耦);external-cli 为独立执行体。
 *  派发 pending→running;回写 running→success|failed|cancelled。init 只恢复不 kick。 */
export interface TaskBoardDeps {
  store: TeamStore;
  registry: TaskRegistry;
  onEvent?: (e: SessionEvent) => void;
  now?: () => number;
  /** 单任务执行预算上限(ms),缺省 30 分钟 */
  taskTimeoutMs?: number;
  /** 未终态任务限流,缺省 64 */
  maxOpenTasks?: number;
  /** 容量退避重派间隔(ms):并发护栏拒绝后等多少再重派,缺省 1000(测试可注入短值) */
  retryDelayMs?: number;
  /** teammate 注册表:assignee 命中活 teammate → runTask;未指派 → 踢同队活成员 claim。
   *  无活成员时任务留 pending,绝不临时 fork。type-only 导入——teammate.ts 反向引 board 类型,双向值导入会成环 */
  team?: TeamRegistry;
  /** AgentTeam 注册表:create 拒绝未知 teamId。测试注入桩或 Memory 后端 */
  agentTeams?: AgentTeamRegistry;
  /** team 预算帽(缺省不设):整板累计 tokens 上限,超帽 drain/claim 双前置拦截——任务留 pending 不失败 */
  teamTokenCap?: number;
  /** external-cli 执行体:executorHint 'external-cli' 的任务路由至此;缺席则内部任务仍只走认领 */
  externalExecutor?: ExternalExecutorLike;
}

const DEFAULT_MAX_OPEN = 64;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 1000;

export class TaskBoard {
  private state: TaskBoardState = emptyBoard();
  private draining = false;
  /** 本轮 drain 有任务因并发护栏拒绝留在 pending:收兵改由退避定时器重派 */
  private capacityDeferred = false;
  /** 本轮 drain 有任务移交 teammate:收兵且不设定时器,由 finishExecution 尾 kick 重入 */
  private claimDeferred = false;
  private deferredKick?: ReturnType<typeof setTimeout>;
  /** team 预算帽累计用量:finishExecution 回写时累加;init 按 artifact.tokens 求和续接 */
  private teamTokensUsed = 0;
  /** 帽耗尽 notice 已发(板实例级 one-shot) */
  private capNoticeEmitted = false;
  private readonly closedLedgers = new Set<string>();
  private readonly now: () => number;
  private readonly maxOpen: number;
  private readonly taskTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly deps: TaskBoardDeps) {
    this.now = deps.now ?? Date.now;
    this.maxOpen = deps.maxOpenTasks ?? DEFAULT_MAX_OPEN;
    this.taskTimeoutMs = deps.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /** 载入恢复:重放后 pending 与 running 自愈为 cancelled(事件落流,from 为装载前态),不 kick */
  init(): void {
    const loaded = this.deps.store.load();
    const prior = new Map(Object.values(loaded.tasks).map((t) => [t.id, t.status]));
    const { state, recovered } = recoverOnLoad(loaded);
    this.state = state;
    this.teamTokensUsed = Object.values(this.state.tasks).reduce((sum, t) => sum + (t.artifact?.tokens ?? 0), 0);
    for (const id of recovered) {
      const from = prior.get(id);
      if (from !== 'pending' && from !== 'running') continue;
      const note = from === 'running' ? RESTART_RUNNING_NOTE : RESTART_PENDING_NOTE;
      this.deps.store.append({ t: 'status-changed', taskId: id, from, to: 'cancelled', ts: this.now(), note });
      this.emit('task-status-changed', { taskId: id, from, status: 'cancelled', note });
    }
    // 空板(无 tasks 且 seq=0)且无恢复时不落快照——未用过任务板的工作区零物化 teams/ 目录
    if (Object.keys(this.state.tasks).length === 0 && this.state.seq === 0 && recovered.length === 0) return;
    this.deps.store.writeSnapshot(this.state);
  }

  snapshot(): TaskBoardState {
    return this.state;
  }

  /** 轮询至无 pending 且无 running,或超时。钟走 Date.now(轮询节拍,不入事件流)。 */
  async settle(timeoutMs: number): Promise<TaskBoardState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const busy = Object.values(this.state.tasks).some((t) => t.status === 'pending' || t.status === 'running');
      if (!busy) return this.state;
      if (Date.now() >= deadline) return this.state;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 面板摘要行:`<id> [status] title (needs ...) team=<teamId> retryOf=<id>`（retryOf 仅在有值时出现） */
  summaryLines(): string[] {
    const lines = Object.values(this.state.tasks)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((t) => {
        const dep = t.dependsOn.length > 0 ? ` (needs ${t.dependsOn.join(',')})` : '';
        const retry = t.retryOf !== undefined && t.retryOf.length > 0 ? ` retryOf=${t.retryOf}` : '';
        return `${t.id} [${t.status}] ${t.title}${dep} team=${t.teamId}${retry}`;
      });
    if (this.deps.teamTokenCap !== undefined) {
      lines.push(this.teamTokensUsed >= this.deps.teamTokenCap
        ? `team budget exhausted (${this.teamTokensUsed}/${this.deps.teamTokenCap}) tokens`
        : `team budget ${this.teamTokensUsed}/${this.deps.teamTokenCap} tokens`);
    }
    return lines;
  }

  create(input: {
    teamId: string;
    title: string;
    spec: string;
    dependsOn?: string[];
    assignee?: string;
    executor?: 'internal' | 'external-cli';
    retryOf?: string;
  }): Result<{ taskId: string }> {
    if (typeof input.title !== 'string' || input.title.length === 0 || typeof input.spec !== 'string' || input.spec.length === 0) {
      return fail('INVALID_ARG', 'create requires non-empty title and spec');
    }
    if (typeof input.teamId !== 'string' || input.teamId.length === 0 || this.deps.agentTeams?.get(input.teamId) === undefined) {
      return fail('INVALID_ARG', `unknown teamId: ${String(input.teamId ?? '')}; create a team with create_team first`);
    }
    const deps = input.dependsOn ?? [];
    const unknown = deps.filter((d) => this.state.tasks[d] === undefined);
    if (unknown.length > 0) return fail('INVALID_ARG', `unknown dependency: ${unknown.join(', ')}`);
    const cross = deps.filter((d) => this.state.tasks[d]!.teamId !== input.teamId);
    if (cross.length > 0) return fail('INVALID_ARG', `dependsOn task ${cross.join(', ')} is not on team ${input.teamId}`);
    if (input.retryOf !== undefined) {
      const prev = this.state.tasks[input.retryOf];
      if (prev === undefined) return fail('INVALID_ARG', `retryOf task ${input.retryOf} is not on team ${input.teamId}`);
      if (prev.teamId !== input.teamId) return fail('INVALID_ARG', `retryOf task ${input.retryOf} does not belong to team ${input.teamId}`);
      if (!isTerminal(prev.status)) {
        return fail('INVALID_ARG', `retryOf task ${input.retryOf} is still ${prev.status}; stop it or wait for a terminal state first`);
      }
    }
    const open = Object.values(this.state.tasks).filter((t) => t.status === 'pending' || t.status === 'running').length;
    if (open >= this.maxOpen) return fail('INVALID_ARG', `task board open-task limit reached (${this.maxOpen}); stop existing tasks or wait for them to finish`);
    if (input.assignee !== undefined && input.assignee.length > 0 && this.deps.team !== undefined) {
      const mate = this.deps.team.get(input.assignee);
      if (mate === undefined || mate.stopped || mate.teamId !== input.teamId) {
        return fail(
          'INVALID_ARG',
          `unknown or inactive teammate "${input.assignee}" on team ${input.teamId}; create_teammate first, or pass assignee as JSON null for claim`,
        );
      }
    }
    const genId = (): string => `task-${slugify(input.title, { max: 16, fallback: 'board' })}-${Math.random().toString(36).slice(2, 6)}`;
    let taskId = genId();
    while (this.state.tasks[taskId] !== undefined) taskId = genId();
    const ev: BoardEvent = {
      t: 'task-created', taskId, title: input.title, spec: input.spec, dependsOn: deps, teamId: input.teamId, ts: this.now(),
      ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
      ...(input.executor !== undefined ? { executorHint: input.executor } : {}),
    };
    this.applyAndPersist(ev);
    if (input.assignee !== undefined && input.assignee.length > 0) {
      this.applyAndPersist({ t: 'assigned', taskId, assignee: input.assignee, ts: this.now() });
    }
    // teamName/teamCreatedAt：GUI 任务板卡头直播（teams 快照外的实时面）；缺注册表时省略，卡头回退 teamId
    const teamMeta = this.deps.agentTeams?.get(input.teamId);
    this.emit('task-created', {
      taskId, title: input.title, spec: input.spec, dependsOn: deps, teamId: input.teamId,
      ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
      ...(input.executor !== undefined ? { executorHint: input.executor } : {}),
      ...(teamMeta !== undefined ? { teamName: teamMeta.name, teamCreatedAt: teamMeta.createdAt } : {}),
    });
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
    if (this.state.tasks[dependsOn]!.teamId !== task.teamId) {
      return fail('INVALID_ARG', `dependsOn task ${dependsOn} is not on team ${task.teamId}`);
    }
    this.applyAndPersist({ t: 'dependency-added', taskId, dependsOn, ts: this.now() });
    this.emit('task-dep-added', { taskId, dependsOn });
    this.kick();
    return ok(undefined);
  }

  assign(taskId: string, assignee: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (typeof assignee !== 'string' || assignee.length === 0) return fail('INVALID_ARG', 'assignee must be non-empty');
    if (this.deps.team !== undefined) {
      const mate = this.deps.team.get(assignee);
      if (mate === undefined || mate.stopped || mate.teamId !== task.teamId) {
        return fail(
          'INVALID_ARG',
          `unknown or inactive teammate "${assignee}" on team ${task.teamId}; create_teammate first`,
        );
      }
    }
    this.applyAndPersist({ t: 'assigned', taskId, assignee, ts: this.now() });
    this.emit('task-assigned', { taskId, assignee });
    this.kick();
    return ok(undefined);
  }

  /** pending|running → cancelled。终态幂等成功,不重复 abort。 */
  stopTask(taskId: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (isTerminal(task.status)) return ok(undefined);
    if (!transitionLegal(task.status, 'cancelled')) {
      return fail('INVALID_STATE', statusTransitionError(taskId, task.status, 'cancelled'));
    }
    const from = task.status;
    this.applyAndPersist({ t: 'status-changed', taskId, from, to: 'cancelled', ts: this.now(), note: 'stopped' });
    this.emit('task-status-changed', { taskId, from, status: 'cancelled', note: 'stopped' });
    this.emitBlockedDownstream(taskId);
    if (from === 'running' && task.executedBy === 'external-cli') {
      this.deps.externalExecutor?.stop?.(taskId);
    } else if (from === 'running' && task.executedBy !== undefined) {
      this.deps.team?.get(task.executedBy)?.interruptCurrent();
    }
    return ok(undefined);
  }

  /** 与 stopTask 同语义 */
  cancel(taskId: string): Result<void> {
    return this.stopTask(taskId);
  }

  private applyAndPersist(ev: BoardEvent): void {
    this.state = applyBoardEvent(this.state, ev);
    this.deps.store.append(ev);
    this.deps.store.writeSnapshot(this.state);
  }

  private emit(type: SessionEvent['type'], payload: Record<string, unknown>, text?: string): void {
    this.deps.onEvent?.({ type, payload, ...(text !== undefined ? { text } : {}), ts: this.now() });
  }

  private finishLedger(ledgerId: string, status: 'done' | 'failed' | 'stopped', opts?: { marker?: string }): void {
    if (this.closedLedgers.has(ledgerId)) return;
    this.closedLedgers.add(ledgerId);
    this.deps.registry.finish(ledgerId, status, opts);
  }

  private enterRunning(taskId: string, by: string): boolean {
    const task = this.state.tasks[taskId];
    if (task === undefined || task.status !== 'pending') return false;
    this.applyAndPersist({ t: 'status-changed', taskId, from: 'pending', to: 'running', ts: this.now(), by });
    this.emit('task-status-changed', { taskId, from: 'pending', status: 'running', by });
    return true;
  }

  /** teammate 自取:原子取首个同队 dispatchable 未指派任务 pending→running。teamId 缺省时不按队过滤。 */
  claim(assignee: string, teamId?: string): BoardTask | undefined {
    if (this.deps.teamTokenCap !== undefined && this.teamTokensUsed >= this.deps.teamTokenCap) return undefined;
    const task = dispatchable(this.state).find((t) => t.assignee === undefined && (teamId === undefined || t.teamId === teamId));
    if (task === undefined) return undefined;
    if (!this.enterRunning(task.id, assignee)) return undefined;
    return this.state.tasks[task.id];
  }

  /** 指派路由认领:pending→running。已 running 幂等 true;其余非 pending 返回 false */
  markClaimed(taskId: string, by: string): boolean {
    const task = this.state.tasks[taskId];
    if (task === undefined) return false;
    if (task.status === 'running') return true;
    if (task.status !== 'pending') return false;
    return this.enterRunning(taskId, by);
  }

  /** 上游 failed 或 cancelled:直接下游 pending 者发 task-blocked */
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

  /** 批量并行派发:每轮取当前 dispatchable 全批并发,完成后续跑下一轮。
   *  并发护栏拒绝留在 pending,本轮收兵,退避定时器让出事件循环后再 kick。 */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.capacityDeferred = false;
    this.claimDeferred = false;
    let defer = false;
    try {
      while (true) {
        if (this.deps.teamTokenCap !== undefined && this.teamTokensUsed >= this.deps.teamTokenCap) {
          if (!this.capNoticeEmitted) {
            this.capNoticeEmitted = true;
            this.emit(
              'notice',
              { source: 'taskboard', used: this.teamTokensUsed, cap: this.deps.teamTokenCap },
              `team budget exhausted (${this.teamTokensUsed}/${this.deps.teamTokenCap}) tokens — new tasks stay pending until the cap is lifted`,
            );
          }
          break;
        }
        const batch = dispatchable(this.state);
        if (batch.length === 0) break;
        for (const t of batch) this.emit('task-unlocked', { taskId: t.id });
        await Promise.allSettled(batch.map((t) => this.executeOne(t)));
        if (this.capacityDeferred) {
          this.capacityDeferred = false;
          defer = true;
          break;
        }
        if (this.claimDeferred) {
          this.claimDeferred = false;
          break;
        }
      }
    } finally {
      this.draining = false;
      if (defer) {
        clearTimeout(this.deferredKick);
        this.deferredKick = setTimeout(() => { this.deferredKick = undefined; this.kick(); }, this.retryDelayMs);
        this.deferredKick.unref?.();
      }
    }
  }

  /** 内部任务只经 teammate 指派/认领;无活成员或指派未命中则留 pending(claimDeferred 防 drain 空转)。禁临时 fork。 */
  private async executeOne(task: BoardTask): Promise<void> {
    if (task.executorHint === 'external-cli' && this.deps.externalExecutor !== undefined) {
      await this.executeExternal(task, this.deps.externalExecutor);
      return;
    }
    const team = this.deps.team;
    if (team !== undefined) {
      const tm = task.assignee !== undefined ? team.get(task.assignee) : undefined;
      if (tm !== undefined && !tm.stopped && tm.teamId === task.teamId) {
        void tm.runTask(task).catch(() => { /* 单任务异常不倒灌派发;回写由执行体收口 */ });
        this.claimDeferred = true;
        return;
      }
      if (task.assignee === undefined) {
        for (const name of team.aliveNames()) {
          const mate = team.get(name);
          if (mate !== undefined && !mate.stopped && mate.teamId === task.teamId) {
            mate.kick();
          }
        }
      }
    }
    this.claimDeferred = true;
  }

  private async executeExternal(task: BoardTask, executor: ExternalExecutorLike): Promise<void> {
    if (!this.markClaimed(task.id, 'external-cli')) return;
    const delegationId = dispatchTag(task.id);
    this.emit('delegation-started', { delegationId, kind: 'external-cli', label: delegationId });
    const startedAt = this.now();
    let r: { ok: boolean; reply: string; tokens: number };
    try {
      r = await executor.run({ id: task.id, title: task.title, spec: task.spec }, { deadlineAt: Date.now() + this.taskTimeoutMs });
    } catch (e) {
      r = { ok: false, reply: e instanceof Error ? e.message : String(e), tokens: 0 };
    }
    const durationMs = this.now() - startedAt;
    if (this.state.tasks[task.id]?.status === 'cancelled') {
      this.emit('delegation-ended', { delegationId, kind: 'external-cli', status: 'skipped', tokens: r.tokens });
      return;
    }
    if (r.ok) {
      this.finishExecution(task.id, { ok: true, by: 'external-cli', reply: r.reply, tokens: r.tokens, durationMs });
    } else {
      this.finishExecution(task.id, { ok: false, by: 'external-cli', durationMs, error: { code: 'EXTERNAL', message: r.reply } });
    }
    this.emit('delegation-ended', { delegationId, kind: 'external-cli', status: r.ok ? 'done' : 'failed', tokens: r.tokens });
  }

  /** running → success|failed|cancelled。已是终态则幂等成功,不改状态、不重复记账。 */
  finishExecution(taskId: string, r: ExecutionReport, ledgerId?: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    const to: TaskStatus = r.ok ? 'success' : (r.terminal ?? 'failed');
    if (task.status !== 'running') {
      if (isTerminal(task.status)) {
        if (ledgerId !== undefined) {
          const ledgerStatus = task.status === 'success' ? 'done' : task.status === 'cancelled' ? 'stopped' : 'failed';
          this.finishLedger(ledgerId, ledgerStatus, task.status === 'success' ? { marker: `[conclusion] ${r.ok ? (r.reply ?? '') : ''}\n` } : undefined);
        }
        return ok(undefined);
      }
      return fail('INVALID_STATE', statusTransitionError(taskId, task.status, to));
    }
    if (!transitionLegal('running', to)) return fail('INVALID_STATE', statusTransitionError(taskId, 'running', to));
    this.teamTokensUsed += r.tokens ?? 0;
    const failNote = !r.ok ? `execution failed: ${r.error?.code ?? 'UNKNOWN'}: ${r.error?.message ?? 'no error detail'}` : undefined;
    const note = to === 'failed' ? failNote : to === 'cancelled' ? 'stopped' : undefined;
    this.applyAndPersist({
      t: 'status-changed', taskId, from: 'running', to, ts: this.now(),
      ...(r.by !== undefined ? { by: r.by } : {}),
      ...(to === 'success'
        ? { conclusion: r.reply ?? '', tokens: r.tokens ?? 0, ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) }
        : note !== undefined ? { note } : {}),
    });
    this.emit('task-status-changed', {
      taskId, from: 'running', status: to,
      ...(r.by !== undefined ? { by: r.by } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    if (ledgerId !== undefined) {
      if (to === 'success') this.finishLedger(ledgerId, 'done', { marker: `[conclusion] ${r.reply ?? ''}\n` });
      else if (to === 'cancelled') this.finishLedger(ledgerId, 'stopped');
      else this.finishLedger(ledgerId, 'failed');
    }
    if (to === 'failed' || to === 'cancelled') this.emitBlockedDownstream(taskId);
    this.kick();
    return ok(undefined);
  }
}
