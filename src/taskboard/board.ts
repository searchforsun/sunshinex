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
import type { TeamRegistry } from './teammate';
import type { ExternalExecutorLike } from './executors/external-cli';

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
  /** teammate 注册表(M2 派发路由):assignee 命中活 teammate → runTask;未指派且有活 teammate → 留给 claim;
   *  缺省/全停 = P1 fork 路径原样(退化语义)。type-only 导入——teammate.ts 反向引 board 类型,双向值导入会成环 */
  team?: TeamRegistry;
  /** team 预算帽(spec §5.6,缺省不设):整板累计 tokens 上限,超帽 drain/claim 双前置拦截——任务留
   *  pending 不失败;装配处经 teamTokenCapEnv() 注入(src/harness/index.ts) */
  teamTokenCap?: number;
  /** external-cli 执行体注入(P2 spec §5):executorHint 'external-cli' 的任务路由至此;缺席 = 提示仅
   *  记录不改变派发行为(P1 内部路径原样)。分层口径:board 只依赖最小 ExternalExecutorLike 接口
   *  (type-only 导入防环),真 ExternalCliExecutor 由 harness/index.ts 装配注入 */
  externalExecutor?: ExternalExecutorLike;
}

const DEFAULT_MAX_OPEN = 64;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 1000;

export class TaskBoard {
  private state: TaskBoardState = emptyBoard();
  private draining = false;
  /** 本轮 drain 有任务因 CONCURRENCY_LIMIT 回池:收兵改由退避定时器重派(2026-10-05 终审复审裁定) */
  private capacityDeferred = false;
  /** 本轮 drain 有任务移交 teammate 执行路径(M2:未指派留 claim / 指派入队但 worker 在飞未认领):
   *  收兵且不设定时器——teammate 单飞 worker 自持消化,消化完 finishExecution 尾 kick 重入;
   *  不收兵则 while(true) 立即重取同批仍 pending 的任务 = 纯微任务自旋(与 capacityDeferred 同病同防) */
  private claimDeferred = false;
  private deferredKick?: ReturnType<typeof setTimeout>;
  /** team 预算帽累计用量(spec §5.6):finishExecution 回写时累加(计入所有回写的 tokens,失败通常为 0)——
   *  与 artifact.tokens 同源,init 重放恢复(artifact.tokens 求和),跨重启帽语义续接不清零 */
  private teamTokensUsed = 0;
  /** 帽耗尽 notice 已发(终审 Item 3,板实例级 one-shot):静默停摆是设计终态(任务留 pending 等帽拆),
   *  可见性经 notice 单发——kick 重入不重发;板实例重建(重启)视为新一轮,重放后首个帽 break 再发一次 */
  private capNoticeEmitted = false;
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
    // team 帽用量重放恢复(T4 裁定):artifact.tokens 是事件流的投影,求和即历史累计——
    // 重启后帽语义续接,不因进程重启清零导致超额重放
    this.teamTokensUsed = Object.values(this.state.tasks).reduce((sum, t) => sum + (t.artifact?.tokens ?? 0), 0);
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

  /** 轮询等待板收敛（P2/T6；先例 harness/tasks.ts waitUntilSettled）：100ms 间隔快照，至「无 pending 且无
   *  claimed」（在飞/待派皆空 = 本轮无事可做）或超时，返回末态快照——超时与否由调用方检视任务态自判
   *  （直接给状态比 settled 布尔更通用）。注意：gated/依赖未满的 pending 会顶住收敛（等待 lead 审批/关单
   *  解锁下游），调用方（如 run-pipeline 板路径）应以审批/裁决推进后重入。钟走 Date.now（轮询节拍器，
   *  不入事件流时间戳，无需注入）。空板/全终态零等待即回。 */
  async settle(timeoutMs: number): Promise<TaskBoardState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const busy = Object.values(this.state.tasks).some((t) => t.status === 'pending' || t.status === 'claimed');
      if (!busy) return this.state;
      if (Date.now() >= deadline) return this.state;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 面板摘要行(工具 observation 与 TUI 共用,P2 英文化):`t1 [in-review] A (needs t2)` 形态 */
  summaryLines(): string[] {
    const lines = Object.values(this.state.tasks)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((t) => {
        const dep = t.dependsOn.length > 0 ? ` (needs ${t.dependsOn.join(',')})` : '';
        const gate = t.gated === true ? ' [gated]' : '';
        return `${t.id} [${t.status}]${gate} ${t.title}${dep}`;
      });
    // team 预算帽透出(T4):帽设置即尾行附用量供工具观察,达帽标注 exhausted(spec §5.6)
    if (this.deps.teamTokenCap !== undefined) {
      lines.push(this.teamTokensUsed >= this.deps.teamTokenCap
        ? `team budget exhausted (${this.teamTokensUsed}/${this.deps.teamTokenCap}) tokens`
        : `team budget ${this.teamTokensUsed}/${this.deps.teamTokenCap} tokens`);
    }
    return lines;
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

  /** lead 取消(终审 Item 2):pending(含 gated / blocked 派生)→ cancelled(LEGAL 既有边)——终态即
   *  出 open 计数,板容量可回收;claimed 在飞不可直接取消(须先 stop 收口,回写单点保证终态迁移);
   *  其余终态/非法迁移一律 INVALID_ARG。不发下游 task-blocked:cancelled 依赖的下游本就经派生 blocked
   *  语义顶住(§4.1 留人裁决),取消本身非执行失败 */
  cancel(taskId: string): Result<void> {
    const task = this.state.tasks[taskId];
    if (task === undefined) return fail('INVALID_ARG', `unknown task: ${taskId}`);
    if (task.status !== 'pending') {
      return fail('INVALID_ARG', task.status === 'claimed'
        ? `cannot cancel a claimed task mid-execution (${taskId}); stop it first`
        : `cancel expects a pending task (gated/blocked included), ${taskId} is ${task.status}`);
    }
    this.applyAndPersist({ t: 'status-changed', taskId, from: 'pending', to: 'cancelled', ts: this.now(), note: 'cancelled by lead' });
    this.emit('task-status-changed', { taskId, from: 'pending', status: 'cancelled', note: 'cancelled by lead' });
    return ok(undefined);
  }

  private applyAndPersist(ev: BoardEvent): void {
    this.state = applyBoardEvent(this.state, ev);
    this.deps.store.append(ev);
    this.deps.store.writeSnapshot(this.state);
  }

  private emit(type: SessionEvent['type'], payload: Record<string, unknown>, text?: string): void {
    this.deps.onEvent?.({ type, payload, ...(text !== undefined ? { text } : {}), ts: this.now() });
  }

  /** teammate 自取(M2 claim 循环):原子取首个 dispatchable 未指派任务 pending→claimed(事件化)。
   *  assignee 形参仅事件记账,不改任务指派——指派任务走 executeOne 派发路由,不进 claim。
   *  (同步单线程取置,两 teammate 不会取到同一任务;team 预算帽 T4 落地) */
  claim(assignee: string): BoardTask | undefined {
    // team 预算帽前置(与 drain 同检,spec §5.6):超帽 teammate 空手而归,任务留 pending 不失败
    if (this.deps.teamTokenCap !== undefined && this.teamTokensUsed >= this.deps.teamTokenCap) return undefined;
    const task = dispatchable(this.state).find((t) => t.assignee === undefined);
    if (task === undefined) return undefined;
    this.applyAndPersist({ t: 'status-changed', taskId: task.id, from: 'pending', to: 'claimed', ts: this.now() });
    this.emit('task-status-changed', { taskId: task.id, from: 'pending', status: 'claimed', claimedBy: assignee });
    return this.state.tasks[task.id];
  }

  /** 指派路由认领(M2,Teammate.execute 入口):pending→claimed(事件化)。幂等双口径:已 claimed 返回
   *  true(claim() 先行认领的同任务);非 pending(终态/被取走)返回 false,调用方静默放弃 */
  markClaimed(taskId: string): boolean {
    const task = this.state.tasks[taskId];
    if (task === undefined) return false;
    if (task.status === 'claimed') return true;
    if (task.status !== 'pending') return false;
    this.applyAndPersist({ t: 'status-changed', taskId, from: 'pending', to: 'claimed', ts: this.now() });
    this.emit('task-status-changed', { taskId, from: 'pending', status: 'claimed' });
    return true;
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
    // 双旗跨轮互清(2026-10-06 复审 Minor 3):capacity/claim 任一 break 分支只清己旗,对侧旗残留会让
    // 下一轮在首个批次后过早收兵——入口统一清零,本轮旗由 executeOne 重新置位
    this.capacityDeferred = false;
    this.claimDeferred = false;
    let defer = false;
    try {
      while (true) {
        // team 预算帽前置检查(spec §5.6 超帽留 pending 不失败):整板累计 tokens 达帽即收兵,不派发新批。
        // 不置 capacityDeferred/claimDeferred(无退避定时器、不归队 claim)——任务保持 pending,
        // 后续 review/create 的 kick 自然重入;用量透出走 summaryLines 尾行,不发阻塞事件。
        // 帽耗尽 one-shot notice(终审 Item 3):静默停摆是设计终态,但零信号会让 lead 误判板死锁——
        // 经既有 notice 事件单发一次(板实例级,TUI 渲染 system 行,零新增协议词汇;kick 重入不重发;
        // Ctrl+T 页脚用量随 P3 数据面)
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
          break; // 容量被占:本轮收兵,定时器让出事件循环(macrotask 完成回调才有机会释放容量)
        }
        if (this.claimDeferred) {
          this.claimDeferred = false;
          break; // 留给 claim:任务仍 pending,原地重取即自旋;teammate claim 循环消化后续轮由 review/create 再 kick
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
    // external-cli 路由(P2,先于 team 路由:任务级 executorHint 是显式声明,强于 assignee/teammate 缺省):
    // 注入在场才接管;缺席 = 提示退化记录,内部路径原样(与 P1 行为完全一致)
    if (task.executorHint === 'external-cli' && this.deps.externalExecutor !== undefined) {
      await this.executeExternal(task, this.deps.externalExecutor);
      return;
    }
    // M2 派发路由(先于本方法 claimed 落流,teammate 路径自含认领):assignee 命中活 teammate →
    // 交 runTask(markClaimed + 执行 + 回写 + 续 claim 自含,不 await 整批);未指派且有活 teammate →
    // 留给 claim 循环(不落 claimed);否则 P1 fork 路径原样(无 team/全停/指派已死 = 退化语义)
    if (this.deps.team !== undefined) {
      const tm = task.assignee !== undefined ? this.deps.team.get(task.assignee) : undefined;
      if (tm !== undefined && !tm.stopped) {
        void tm.runTask(task).catch(() => { /* 单任务异常不倒灌派发;回写缺失由恢复回池兜底 */ });
        // 入队不等于认领(worker 在飞上一任务时任务仍 pending):不收兵则下轮原地重派同任务
        // = 纯微任务自旋(worker 空闲时同步认领,此旗空转一轮无害)——收兵,worker 认领/消化后
        // finishExecution 尾 kick 重入
        this.claimDeferred = true;
        return;
      }
      if (task.assignee === undefined && this.deps.team.hasAlive()) {
        // 留给 claim:踢活 teammate 认领(可能空闲——claim 循环上次取空已退出)+ 本轮 drain 收兵
        for (const name of this.deps.team.aliveNames()) this.deps.team.get(name)?.kick();
        this.claimDeferred = true;
        return;
      }
    }
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
      this.finishExecution(task.id, { ok: true, by: 'fork', reply, tokens, durationMs }, ledger.id);
    } else {
      this.finishExecution(task.id, { ok: false, by: 'fork', error: { code: errCode, message: errMsg } }, ledger.id);
    }
  }

  /** external-cli 执行路径(P2):markClaimed 认领 → 委派生命周期事件(kind 'external-cli')→
   *  executor.run(deadline = 板超时换算)→ finishExecution 强制回写(失败 note 带 EXTERNAL code;
   *  external 任务的台账在执行体内部,ledgerId 缺省跳过)。黑盒口径:执行体无翻译产出时
   *  UI 仅见起止(delegation-started/ended),board 不透传其内部细节 */
  private async executeExternal(task: BoardTask, executor: ExternalExecutorLike): Promise<void> {
    if (!this.markClaimed(task.id)) return; // 非 pending(被取走/终态):静默放弃
    const delegationId = `task-${task.id}`;
    this.emit('delegation-started', { delegationId, kind: 'external-cli', label: delegationId });
    const startedAt = this.now();
    let r: { ok: boolean; reply: string; tokens: number };
    try {
      r = await executor.run({ id: task.id, title: task.title, spec: task.spec }, { deadlineAt: Date.now() + this.taskTimeoutMs });
    } catch (e) {
      // 执行体异常收口:作 EXTERNAL 失败回写(不向上抛——drain 不因单任务炸停)
      r = { ok: false, reply: e instanceof Error ? e.message : String(e), tokens: 0 };
    }
    const durationMs = this.now() - startedAt;
    if (r.ok) {
      this.finishExecution(task.id, { ok: true, by: 'external-cli', reply: r.reply, tokens: r.tokens, durationMs });
    } else {
      this.finishExecution(task.id, { ok: false, by: 'external-cli', durationMs, error: { code: 'EXTERNAL', message: r.reply } });
    }
    this.emit('delegation-ended', { delegationId, kind: 'external-cli', status: r.ok ? 'done' : 'failed', tokens: r.tokens });
  }

  /** 执行回写单点(P2 自 executeOne 抽取,T2 teammate/外部执行体路径复用):claimed→in-review/failed 强制迁移
   *  + task-status-changed 发射 + artifact 并入(conclusion/tokens/durationMs)+ 台账收口(ledgerId 缺省跳过)
   *  + 失败发直接下游 task-blocked(§4.1 不自动 skip)。失败 note 带 code+message(与台账 [failed] 行口径对称)。
   *  r.durationMs 由调用方计算传入(计时归执行路径,回写点不持钟);r.error 携带失败详情供 note 组装。 */
  finishExecution(taskId: string, r: { ok: boolean; by?: string; reply?: string; tokens?: number; durationMs?: number; error?: { code?: string; message?: string } }, ledgerId?: string): void {
    const failNote = `execution failed: ${r.error?.code ?? 'UNKNOWN'}: ${r.error?.message ?? 'no error detail'}`;
    // team 帽用量累计(T4):计入所有回写的 tokens(与 artifact 同源的 r.tokens),失败通常为 0——
    // ok/failed 均累加,幂等面由「finishExecution 每任务恰一次」的回写单点不变量保证
    this.teamTokensUsed += r.tokens ?? 0;
    this.applyAndPersist({
      t: 'status-changed', taskId, from: 'claimed', to: r.ok ? 'in-review' : 'failed', ts: this.now(),
      ...(r.by !== undefined ? { by: r.by } : {}),
      ...(r.ok
        ? { conclusion: r.reply ?? '', tokens: r.tokens ?? 0, ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) }
        : { note: failNote }),
    });
    this.emit('task-status-changed', { taskId, from: 'claimed', status: r.ok ? 'in-review' : 'failed', ...(r.by !== undefined ? { by: r.by } : {}), ...(r.ok ? {} : { note: failNote }) });
    if (r.ok) {
      if (ledgerId !== undefined) this.deps.registry.finish(ledgerId, 'done', { marker: `[conclusion] ${r.reply ?? ''}\n` });
    } else {
      if (ledgerId !== undefined) this.deps.registry.finish(ledgerId, 'failed');
      this.emitBlockedDownstream(taskId);
    }
    // 回写尾 kick(2026-10-06 复审 Critical 1):teammate/外部执行体路径的回写发生在 drain 之外,
    // 回写解锁的指派下游必须重入派发(P1 路径在 drain 内调用,闩挡重入零开销;claimDeferred 防自旋)
    this.kick();
  }
}
