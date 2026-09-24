import type { AskUserSeam } from '../types';
import { Harness } from '../harness';
import { LoopDeps, LoopRunResult } from '../loop/engine';
import { DEFAULT_GOAL_TEMPLATE, longTaskTemplate, resolveTemplate } from '../loop/templates';
import { ModelAdapter } from '../model/adapter';
import { ApprovalDecision, ApprovalRequest, HistoryStep, ModelTier, OutputStyle, ReasoningEffort, RunOutcome, SessionEvent, TodoItem } from '../types';

export interface TuiRuntimeOpts {
  /** 问询接缝（ask_question 消费方）：SessionController 缺省接自身问询管线；外部注入用于 headless/脚本 */
  onAskUser?: AskUserSeam;
  root: string;
  model?: ModelAdapter;
  /** 事件流旁路注入：TUI 渲染层经 SessionController 消费；缺省零副作用 */
  onEvent?: (e: SessionEvent) => void;
  /** 权限模式（缺省 dontAsk）；manual 时配合 onApproval 走终端化审批 */
  mode?: 'dontAsk' | 'manual' | 'plan';
  /** D3：CLI --add-dir 透传（与 settings permissions.additionalDirs 合并，三面同源） */
  addDirs?: string[];
  /** 用户级模型档位（run 级常量，对标 Claude Code 的模型选择）：/model 会话内切换经 runTask 逐次覆盖 */
  tier?: ModelTier;
  /** 缺省思考强度（run 级常量，对标 tier）：/model-effort 会话内切换经 runTask 逐次覆盖；缺省回适配器 cfg/env */
  effort?: ReasoningEffort;
  /** manual 模式审批回调（guard asker 装配点）；会话结束由调用方 clearSessionAllows */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** todo_write 接缝（todo_write 规格 D6）：模型更新清单的会话回调（setTodos）；缺省不注入＝Harness no-op */
  onTodos?: (items: TodoItem[]) => void;
  /** 输出样式分叉（交互面级，进稳定段）：缺省恒 terminal（TUI 面专属约束）；留参数仅为显式覆盖语义 */
  outputStyle?: OutputStyle;
}

/** `RunOutcome` 按全局约束登记在 `src/types.ts`（跨模块共享）；此处按原路径再导出，既有 `./runtime` 导入点无需改动 */
export type { RunOutcome };

export interface TuiRuntime {
  harness: Harness;
  /** scope 线程：session=主链（缺省）；fork=私有执行（零主链回写）——/init 与规划轮 fork 隔离用 */
  runTask(goal: string, opts?: { maxSteps?: number; seedHistory?: HistoryStep[]; tier?: ModelTier; effort?: ReasoningEffort; scope?: 'session' | 'fork'; signal?: AbortSignal }): Promise<RunOutcome>;
  /** /goal 完整修正环入口（规格 D2/D3）：resolveTemplate → engine.run，LoopRunResult 原样透传（零新类型）；不开放 scope/seedHistory——修正环恒主链 */
  runLoop(goal: string, opts?: { template?: string; tier?: ModelTier; effort?: ReasoningEffort; signal?: AbortSignal }): Promise<LoopRunResult>;
}

/** TUI 运行时接缝：同进程装配 Harness（数据底座全局数据目录天然同源）；GUI 阶段如需隔离可换 daemon 实现同契约 */
export function createRuntime(opts: TuiRuntimeOpts): TuiRuntime {
  const harness = new Harness({
    ...(opts.onAskUser ? { ask: opts.onAskUser } : {}),
    root: opts.root,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.onTodos ? { todos: { set: opts.onTodos } } : {}),
    ...(opts.addDirs ? { addDirs: opts.addDirs } : {}),
  });
  if (opts.mode === 'manual' && opts.onApproval) harness.security.setAsker(opts.onApproval);

  // 主链唯一入口（D5）：提交经 Loop 长任务模板（内嵌 Reactor），不再直连 harness.reactor
  const loopDeps: LoopDeps = {
    safety: harness.safety,
    registry: harness.tools,
    context: harness.context,
    model: harness.model,
    root: opts.root,
    runner: harness.runner,
    ...(harness.ledger ? { ledger: harness.ledger } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    // 运行中穿插（对标 CC queued messages）：循环内构造的 Reactor 与单发 Reactor 同源消费通道
    steer: () => harness.steering.drain(),
    // 沉淀双钩子与收尾管线（规格 §3.1/§3.5）：TUI 主链经 loop 构造 Reactor，钩子必须随 LoopDeps 透传才会触发
    ...harness.settleHooks,
    // MCP 装配生命周期透传：run 入口 await ready（工具注册完成才进首节点），dispose 收口防 stdio 子进程悬挂
    mcpReady: harness.mcpReady,
    mcpClose: harness.mcpClose,
    mcpWarnings: harness.mcpWarnings,
    // 输出样式分叉：TUI 文字面缺省恒 terminal——围栏带语言标签、图示走 ASCII（CLI 不注入、保持缺省通用约定）
    outputStyle: opts.outputStyle ?? 'terminal',
    pipeline: harness.pipeline,
  };

  // run 级覆盖统一构造：/model 档位与 /model-effort 逐次覆盖、scope 线程、中断 signal（runTask/runLoop 共用，防两处漂移）
  const buildRunDeps = (o?: { tier?: ModelTier; effort?: ReasoningEffort; scope?: 'session' | 'fork'; signal?: AbortSignal }): LoopDeps => ({
    ...loopDeps,
    ...(o?.tier ? { tier: o.tier } : {}),
    ...(o?.effort ? { effort: o.effort } : {}),
    ...(o?.scope ? { scope: o.scope } : {}),
    ...(o?.signal ? { signal: o.signal } : {}),
  });

  return {
    harness,
    runTask: async (goal, o) => {
      // 档位（run 级常量）：/model 的会话级切换以逐次覆盖下传（缺省沿用装配点 tier）；scope 线程至 LoopDeps
      const runDeps = buildRunDeps(o);
      const tpl = longTaskTemplate(runDeps, o?.maxSteps !== undefined ? { agentMaxSteps: o.maxSteps } : {});
      const r = await tpl.engine.run(
        goal,
        o?.seedHistory && o.seedHistory.length > 0 ? { state: { seedHistory: o.seedHistory } } : undefined,
      );
      return {
        done: r.status === 'done',
        ...(r.reply !== undefined ? { reply: r.reply } : {}),
        tokensUsed: r.tokensUsed,
        ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
        ...(r.history !== undefined && r.history.length > 0 ? { history: r.history } : {}),
      };
    },
    runLoop: async (goal, o) => {
      const runDeps = buildRunDeps(o);
      const tpl = resolveTemplate(runDeps, o?.template ?? DEFAULT_GOAL_TEMPLATE);
      return tpl.engine.run(goal);
    },
  };
}
