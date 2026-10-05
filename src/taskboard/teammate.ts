/** Teammate 长驻执行体(spec §5 P2):独立 ContextManager(零主链污染)+ 逐任务 fork-scope Reactor
 *  (事件经 tagger 打 payload.subagent 标,复用 ChildPanel 委派通道)+ 单飞 worker(指派队列优先、
 *  空则 claim,MemoryPipeline 闩形态)+ 派发路由退化语义(无活 teammate = P1 fork 原样)。
 *  与 SubagentRunner 的分工:Runner 是主链按需 fork 的无状态单元;Teammate 是跨任务存续的有状态执行体,
 *  自有链(role 行 + 历次 task 行)即其记忆——每任务 Reactor 的 seed 经缺省 chainView() 取自 own chain。 */
import type { SessionEvent } from '../types';
import { reactorMaxStepsEnv, subagentTokenCapEnv } from '../config/termination-config';
import { fail, ok, Result } from '../result';
import { Reactor, RunResult } from '../harness/reactor';
import { ContextManager } from '../harness/context';
import type { SafetyChain } from '../harness/security/chain';
import type { ModelAdapter } from '../model/adapter';
import type { ToolRegistry } from '../harness/tools';
import type { StorageAdapter } from '../storage/adapter';
import type { TaskBoard } from './board';
import type { BoardTask } from './model';

/** 队伍帽(spec §5.8 团队规模上限):主链上下文带宽是共享资源, teammate 转录都进同一条事件流 */
export const MAX_TEAMMATES = 4;

export interface TeammateDeps {
  safety: SafetyChain;
  model: ModelAdapter;
  registry: ToolRegistry;
  /** 项目根绝对路径(own ContextManager 同根构造) */
  root: string;
  store: StorageAdapter;
  board: TaskBoard;
  onEvent?: (e: SessionEvent) => void;
  /** 单任务执行预算上限(ms),缺省 30 分钟(与 board 同口径) */
  taskTimeoutMs?: number;
  /** 工具面工厂(T3 注入真派生面):缺省 base.derive({ exclude: [] }) 全克隆——工具无状态、
   *  执行期安全链注入,克隆面与 base 行为等价(T3 落地收窄面前保持全量) */
  registryFactory?: (base: ToolRegistry) => ToolRegistry;
}

/** teammate 注册表:帽 4 + 名字索引 + 存活聚合(派发路由的退化判据) */
export class TeamRegistry {
  private teammates = new Map<string, Teammate>();

  /** 注册(帽 MAX_TEAMMATES):同名重注册 = 替换语义,旧实例先停(防双 claim 循环) */
  register(t: Teammate): Result<void> {
    if (this.teammates.size >= MAX_TEAMMATES && this.teammates.get(t.name) === undefined) {
      return fail('INVALID_ARG', `teammate limit reached (${MAX_TEAMMATES})`);
    }
    this.teammates.get(t.name)?.stop();
    this.teammates.set(t.name, t);
    return ok(undefined);
  }

  get(name: string): Teammate | undefined {
    return this.teammates.get(name);
  }

  /** 任一未停即活:executeOne 未指派分支的「留给 claim」判据(全停 → 回退 P1 fork) */
  hasAlive(): boolean {
    for (const t of this.teammates.values()) if (!t.stopped) return true;
    return false;
  }

  /** 单停(幂等:Teammate.stop 自身幂等,未注册静默) */
  stop(name: string): void {
    this.teammates.get(name)?.stop();
  }

  stopAll(): void {
    for (const t of this.teammates.values()) t.stop();
  }

  aliveNames(): string[] {
    return [...this.teammates.values()].filter((t) => !t.stopped).map((t) => t.name);
  }
}

/** 长驻执行体:一次装配跨任务存续;kick 起 claim 循环单飞消化未指派任务,runTask 承接指派路由 */
export class Teammate {
  readonly name: string;
  private readonly framing: string;
  private readonly deps: TeammateDeps;
  /** 独立上下文(每 teammate 一份,永不共享主链):role/task 行的落点与每任务 Reactor 的 seed 源 */
  private readonly ctx: ContextManager;
  private readonly abort = new AbortController();
  private readonly taskTimeoutMs: number;
  private stoppedFlag = false;
  private busy = false;
  /** 单飞闩(MemoryPipeline drain 先例):kick 重入共享在飞 worker,绝不并发第二个 execute */
  private claiming = false;
  private framed = false;
  /** 指派队列(executeOne 派发路由入队):单 worker 每轮先取此队、空则 board.claim——指派与自主认领
   *  统一单飞,同一时刻至多一个 execute 在飞(own ctx / Reactor seed 串行不变量,2026-10-06 复审裁定) */
  private assignedQueue: BoardTask[] = [];

  constructor(opts: { name: string; framing: string; deps: TeammateDeps }) {
    this.name = opts.name;
    this.framing = opts.framing;
    this.deps = opts.deps;
    this.ctx = new ContextManager(opts.deps.root, opts.deps.store);
    this.taskTimeoutMs = opts.deps.taskTimeoutMs ?? 30 * 60 * 1000;
  }

  /** 已停观测(TeamRegistry.hasAlive / executeOne 派发路由判据) */
  get stopped(): boolean {
    return this.stoppedFlag;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** 空闲踢点:起单飞 worker(在飞则共享,已停不起)——board 留 claim 分支与 runTask 入队共用此口 */
  kick(): void {
    if (this.claiming || this.stoppedFlag) return;
    this.claiming = true;
    void this.worker();
  }

  /** 单 worker 消费循环(MemoryPipeline runWorker 形态):每轮先取指派队列(FIFO,显式指派优先),
   *  空则自主认领 board.claim(name);都无则收兵。单飞闩 + 队列收敛 = 同批多指派、指派与认领并发、
   *  busy 期间 drain 踢点,全部归一到「同一时刻至多一个 execute」——own ctx 永不被并发写 */
  private async worker(): Promise<void> {
    try {
      while (!this.stoppedFlag) {
        const next = this.assignedQueue.length > 0 ? this.assignedQueue.shift() : this.deps.board.claim(this.name);
        if (next === undefined) break;
        this.busy = true;
        try {
          await this.execute(next);
        } catch {
          // 认领/链预置/回写异常吞并(worker 存续,MemoryPipeline runWorker 先例);终态缺口由恢复回池兜底
        } finally {
          this.busy = false;
        }
      }
    } finally {
      this.claiming = false;
    }
  }

  /** 停(AbortController.abort + 置 stopped):busy 任务跑完(在途步边界即刻中止)回写收口后不续取;
   *  幂等——重复 abort 无副作用,kick/worker 对 stopped 短路;队列余项放弃(pending 留板,恢复回池兜底) */
  stop(): void {
    this.stoppedFlag = true;
    this.abort.abort();
  }

  /** board 指派路径入口(executeOne 派发路由经 void 调用,不 await 整批):入指派队列 + 踢点——
   *  不直接执行,由单 worker 串行消化(并发 runTask 共享 ctx 的竞态由此消除);
   *  同任务重复入队去重(worker 在飞上一任务期间 drain 重复派发的窗口) */
  async runTask(task: BoardTask): Promise<void> {
    if (this.assignedQueue.some((t) => t.id === task.id)) return;
    this.assignedQueue.push(task);
    this.kick();
  }

  /** 单任务执行(claim 循环与 runTask 共用):认领 → own chain 预置 → 逐任务 Reactor(fork) → 强制回写 */
  private async execute(task: BoardTask): Promise<void> {
    if (!this.deps.board.markClaimed(task.id)) return; // 已被取走/非 pending:静默放弃(claim() 先行者已 claimed,幂等放行)
    // own chain 预置:首任务前 role 行(角色框定),每任务前 task 行(自包含指令)——seed 经 Reactor 缺省取 own chain
    if (!this.framed) {
      this.framed = true;
      this.ctx.appendChain([{ action: 'role', observation: this.framing }]);
    }
    this.ctx.appendChain([{ action: 'task', observation: `Task ${task.id}: ${task.title}\n${task.spec}` }]);
    // delegation 生命周期事件(与 P1 executeOne 同形,delegationId 对齐台账口径 task-tN):直接走 deps.onEvent,
    // 不带转录标——生命周期归会话公共面,transcript 才按 teammate 归属
    const delegationId = `task-${task.id}`;
    const emitDelegation = (type: 'delegation-started' | 'delegation-ended', status?: 'done' | 'failed', tokens?: number): void => {
      this.deps.onEvent?.({
        type,
        ts: Date.now(),
        payload: { delegationId, kind: 'subagent', label: delegationId, ...(status !== undefined ? { status } : {}), ...(tokens !== undefined ? { tokens } : {}) },
      });
    };
    emitDelegation('delegation-started');
    const startedAt = Date.now();
    // 转录事件打标(payload.subagent = name,复用 ChildPanel 通道,与 SubagentRunner tagger 同构)
    const tagger = (e: SessionEvent): void => {
      this.deps.onEvent?.({ ...e, payload: { ...(e.payload ?? {}), subagent: this.name } });
    };
    // 逐任务 Reactor:fork 作用域(零主链回写);不传 runner——两 reactor 共享 runner 会互相覆盖
    // attachParent 挂载位(reactor.ts run 起止挂摘),teammate 自身不持 spawn 预算源(T3 派生面落地同点评估)
    const reactor = new Reactor({
      registry: (this.deps.registryFactory ?? ((base: ToolRegistry) => base.derive({ exclude: [] })))(this.deps.registry),
      safety: this.deps.safety,
      context: this.ctx,
      model: this.deps.model,
      root: this.deps.root,
      onEvent: tagger,
      signal: this.abort.signal,
    });
    let r: RunResult;
    try {
      const tokenCap = subagentTokenCapEnv();
      r = await reactor.run(
        { goal: `task ${task.id}` },
        {
          scope: 'fork',
          maxSteps: reactorMaxStepsEnv() ?? 400,
          ...(tokenCap !== undefined ? { tokenCap } : {}),
          deadlineAt: Date.now() + this.taskTimeoutMs,
        },
      );
    } catch (e) {
      // 异常收口:delegation failed + THROWN 回写(不向上抛——claim 循环/runTask 不因单任务炸停)
      const message = e instanceof Error ? e.message : String(e);
      emitDelegation('delegation-ended', 'failed', 0);
      this.deps.board.finishExecution(task.id, {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: { code: 'THROWN', message },
      });
      return;
    }
    emitDelegation('delegation-ended', r.done ? 'done' : 'failed', r.tokensUsed ?? 0);
    // harness 强制回写单点(P1 finishExecution):claimed→in-review/failed,不依赖模型自觉
    this.deps.board.finishExecution(task.id, {
      ok: r.done,
      ...(r.reply !== undefined ? { reply: r.reply } : {}),
      ...(r.tokensUsed !== undefined ? { tokens: r.tokensUsed } : {}),
      durationMs: Date.now() - startedAt,
      ...(r.done ? {} : { error: { code: 'INCOMPLETE', message: r.stopReason ?? 'did not finish' } }),
    });
  }
}
