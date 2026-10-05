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
  /** 容量退避重派间隔(ms):CONCURRENCY_LIMIT 回池后等多少再重派,缺省 1000(测试可注入短值) */
  retryDelayMs?: number;
}

const DEFAULT_MAX_OPEN = 64;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 1000;

export class TaskBoard {
  private state: TaskBoardState = emptyBoard();
  private draining = false;
  /** 本轮 drain 有任务因 CONCURRENCY_LIMIT 回池:收兵改由退避定时器重派(2026-10-05 终审复审裁定) */
  private capacityDeferred = false;
  private deferredKick?: ReturnType<typeof setTimeout>;
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

  /** 面板摘要行(工具 observation 与 TUI 共用,P2 英文化):`t1 [in-review] A (needs t2)` 形态 */
  summaryLines(): string[] {
    return Object.values(this.state.tasks)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((t) => {
        const dep = t.dependsOn.length > 0 ? ` (needs ${t.dependsOn.join(',')})` : '';
        const gate = t.gated === true ? ' [gated]' : '';
        return `${t.id} [${t.status}]${gate} ${t.title}${dep}`;
      });
  }

  create(input: { title: string; spec: string; dependsOn?: string[]; assignee?: string; gated?: boolean; executor?: 'internal' | 'external-cli' }): Result<{ taskId: string }> {
    if (typeof input.title !== 'string' || input.title.length === 0 || typeof input.spec !== 'string' || input.spec.length === 0) {
      return fail('INVALID_ARG', 'create requires non-empty title and spec');
    }
    const deps = input.dependsOn ?? [];
    const unknown = deps.filter((d) => this.state.tasks[d] === undefined);
    if (unknown.length > 0) return fail('INVALID_ARG', `unknown dependency: ${unknown.join(', ')}`);
    const open = Object.values(this.state.tasks).filter((t) => t.status !== 'done' && t.status !== 'failed' && t.status !== 'cancelled').length;
    if (open >= this.maxOpen) return fail('INVALID_ARG', `task board open-task limit reached (${this.maxOpen}); review or cancel existing tasks first`);
    const taskId = `t${this.state.seq + 1}`;
    const ev: BoardEvent = { t: 'task-created', taskId, title: input.title, spec: input.spec, dependsOn: deps, ts: this.now(), ...(input.executor !== undefined ? { executorHint: input.executor } : {}) };
    this.applyAndPersist(ev);
    if (input.assignee !== undefined && input.assignee.length > 0) {
      this.applyAndPersist({ t: 'assigned', taskId, assignee: input.assignee, ts: this.now() });
    }
    // 建即 gated(P2):经既有 gate-set 事件表达,不引入新变体——task-created(及 assigned)落流后再挂门,
    // 发射序同构(task-created 先于 gate-waiting:投影侧按事件序归约,门先于建会丢单)
    if (input.gated === true) {
      this.applyAndPersist({ t: 'gate-set', taskId, ts: this.now() });
    }
    this.emit('task-created', { taskId, title: input.title, spec: input.spec, dependsOn: deps, ...(input.executor !== undefined ? { executorHint: input.executor } : {}) });
    if (input.gated === true) {
      this.emit('gate-waiting', { taskId });
    }
    this.kick(); // gated 任务自然不派发;依赖满足后 + 门经 review(approved) 解锁才会派发
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
    this.emit('task-dep-added', { taskId, dependsOn });
    this.kick();
    return ok(undefined);
  }

  assign(taskId: string, assignee: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (typeof assignee !== 'string' || assignee.length === 0) return fail('INVALID_ARG', 'assignee must be non-empty');
    this.applyAndPersist({ t: 'assigned', taskId, assignee, ts: this.now() });
    this.emit('task-assigned', { taskId, assignee });
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

  /** 批量并行派发(graph 层内 allSettled 先例):每轮取当前 dispatchable 全批并发,完成后续跑下一轮。
   *  容量退避(2026-10-05 终审复审裁定):CONCURRENCY_LIMIT 回池若仍在 while(true) 里立即重取,
   *  runSubagent 同步拒绝 → allSettled 微任务即 resolve → 纯微任务自旋(事件流无界增长 + 饿死才能
   *  释放容量的 macrotask 完成回调 = 潜在死锁)。故本轮收兵,退避定时器让出事件循环后再 kick 重派。 */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    let defer = false;
    try {
      while (true) {
        const batch = dispatchable(this.state);
        if (batch.length === 0) break;
        for (const t of batch) this.emit('task-unlocked', { taskId: t.id });
        await Promise.allSettled(batch.map((t) => this.executeOne(t)));
        if (this.capacityDeferred) {
          this.capacityDeferred = false;
          defer = true;
          break; // 容量被占:本轮收兵,定时器让出事件循环(macrotask 完成回调才有机会释放容量)
        }
      }
    } finally {
      this.draining = false;
      if (defer) {
        clearTimeout(this.deferredKick); // 未清不重入:clearTimeout 更稳
        this.deferredKick = setTimeout(() => { this.deferredKick = undefined; this.kick(); }, this.retryDelayMs);
        this.deferredKick.unref?.();
      }
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
    let errCode: string | undefined;
    let errMsg: string | undefined;
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
      } else {
        errCode = r.error.code;
        errMsg = r.error.message;
      }
    } catch (e) {
      okRun = false;
      errCode = 'THROWN';
      errMsg = e instanceof Error ? e.message : String(e);
    }
    const durationMs = this.now() - startedAt;
    // 并发护栏拒绝非任务过错:claimed→pending 回池待派(合法迁移,同 §7.4 恢复语义),台账收口 stopped;
    // 不写 failed、不发下游 blocked——置 capacityDeferred,drain 本轮收兵改由退避定时器重派
    // (2026-10-05 终审复审裁定:容量被外部占用时定时器让出事件循环,消除微任务自旋热循环)
    if (!okRun && errCode === 'CONCURRENCY_LIMIT') {
      this.applyAndPersist({ t: 'status-changed', taskId: task.id, from: 'claimed', to: 'pending', ts: this.now(), note: 'concurrency limit, deferred' });
      this.emit('task-status-changed', { taskId: task.id, from: 'claimed', status: 'pending', note: 'concurrency limit, deferred' });
      this.deps.registry.finish(ledger.id, 'stopped');
      this.capacityDeferred = true;
      return;
    }
    // harness 强制回写(§5.4):回写单点 finishExecution——executeOne 与 T2 teammate/外部执行体路径共用,
    // claimed→in-review/failed 口径单点(不依赖模型自觉标记)
    if (okRun) {
      this.finishExecution(task.id, { ok: true, reply, tokens, durationMs }, ledger.id);
    } else {
      this.finishExecution(task.id, { ok: false, error: { code: errCode, message: errMsg } }, ledger.id);
    }
  }

  /** 执行回写单点(P2 自 executeOne 抽取,T2 teammate/外部执行体路径复用):claimed→in-review/failed 强制迁移
   *  + task-status-changed 发射 + artifact 并入(conclusion/tokens/durationMs)+ 台账收口(ledgerId 缺省跳过)
   *  + 失败发直接下游 task-blocked(§4.1 不自动 skip)。失败 note 带 code+message(与台账 [failed] 行口径对称)。
   *  r.durationMs 由调用方计算传入(计时归执行路径,回写点不持钟);r.error 携带失败详情供 note 组装。 */
  finishExecution(taskId: string, r: { ok: boolean; reply?: string; tokens?: number; durationMs?: number; error?: { code?: string; message?: string } }, ledgerId?: string): void {
    const failNote = `execution failed: ${r.error?.code ?? 'UNKNOWN'}: ${r.error?.message ?? 'no error detail'}`;
    this.applyAndPersist({
      t: 'status-changed', taskId, from: 'claimed', to: r.ok ? 'in-review' : 'failed', ts: this.now(),
      ...(r.ok
        ? { conclusion: r.reply ?? '', tokens: r.tokens ?? 0, ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) }
        : { note: failNote }),
    });
    this.emit('task-status-changed', { taskId, from: 'claimed', status: r.ok ? 'in-review' : 'failed', ...(r.ok ? {} : { note: failNote }) });
    if (r.ok) {
      if (ledgerId !== undefined) this.deps.registry.finish(ledgerId, 'done', { marker: `[conclusion] ${r.reply ?? ''}\n` });
    } else {
      if (ledgerId !== undefined) this.deps.registry.finish(ledgerId, 'failed');
      this.emitBlockedDownstream(taskId);
    }
  }
}
