import type { AskUserSeam } from '../types';
import { Harness, SESSION_FACE_PROFILES } from '../harness';
import { buildHarness } from '../runtime';
import type { PermissionMode } from '../harness/security/modes';
import type { ToolDisplayMeta } from '../harness/tools';
import { setToolDisplayMeta } from '../tui/tool-verbs';
import { LoopDeps, LoopRunResult } from '../loop/engine';
import type { BackgroundTask } from '../harness/tasks';
import { DEFAULT_GOAL_TEMPLATE, longTaskTemplate, resolveTemplate } from '../loop/templates';
import { ModelAdapter } from '../model/adapter';
import { ApprovalDecision, ApprovalRequest, HistoryStep, ModelTier, OutputStyle, ReasoningEffort, RunOutcome, SessionEvent, SessionKind, TodoItem } from '../types';

export interface KernelRuntimeOpts {
  /** 问询接缝（ask_question 消费方）：SessionController 缺省接自身问询管线；外部注入用于 headless/脚本 */
  onAskUser?: AskUserSeam;
  root: string;
  model?: ModelAdapter;
  /** 事件流旁路注入：TUI 渲染层经 SessionController 消费；缺省零副作用 */
  onEvent?: (e: SessionEvent) => void;
  /** 权限模式（缺省 full-access）；acceptEdits 时配合 onApproval 走终端化审批——内核档位恒三档，
   *  'plan' 只存在于 serve SessionMode 层（流程标记），装配映射后传入（spec §3.2） */
  mode?: PermissionMode;
  /** D3：CLI --add-dir 透传（与 settings permissions.additionalDirs 合并，三面同源） */
  addDirs?: string[];
  /** 用户级模型档位（run 级常量，对标 Claude Code 的模型选择）：/model-tier 会话内切换经 runTask 逐次覆盖 */
  tier?: ModelTier;
  /** 缺省思考强度（run 级常量，对标 tier）：/model-effort 会话内切换经 runTask 逐次覆盖；缺省回适配器 cfg/env */
  effort?: ReasoningEffort;
  /** manual 模式审批回调（guard asker 装配点）；会话结束由调用方 clearSessionAllows */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** todo_write 接缝（todo_write 规格 D6）：模型更新清单的会话回调（setTodos）；缺省不注入＝Harness no-op */
  onTodos?: (items: TodoItem[]) => void;
  /** bg-wake 接缝透传（spec §3.1）：daemon/TUI 注入，CLI buildDeps 不注入＝无唤醒 */
  wake?: { onFinished(t: BackgroundTask): void; hint?: boolean };
  /** 输出样式分叉（交互面级，进稳定段）：缺省恒 terminal（TUI 面专属约束）；留参数仅为显式覆盖语义 */
  outputStyle?: OutputStyle;
  /** exit_plan 出牌接缝（2026-11-03 无感化;2026-11-04 泛化）：awaitDecision 弹卡阻塞等裁决,
   *  裁决即工具结果回喂——透传 buildHarness plan seam;缺省不注册 */
  plan?: {
    awaitDecision(name: string, doc: string): Promise<{ approved: boolean; mode?: string; feedback?: string }>;
  };
  /** 定时调度接缝（2026-11-15 sunx P2 Task 3）：schedule_wakeup/schedule_task 的 arm 出口——
   *  透传 buildHarness schedule seam（宿主 TimerController 承载）；缺省不注入=执行期 NOT_SUPPORTED */
  schedule?: {
    arm(rec: { fireAt: number; note: string; taskSpec?: string }): { id: string; replacedId?: string };
  };
  /** 会话形态（2026-11-14 sunx 设计）：与 HarnessOptions.kind 同名同域的装配接缝（TUI/daemon 装配单点入参面）。
   *  已透传（2026-11-15 提示词面 fix round 1）：buildHarness（→ 稳定段观测面 + 单发 Reactor）与 loopDeps
   *  （→ loop 主链 agent 节点 childDeps → Reactor）同源携带；缺席=standard */
  kind?: SessionKind;
  /** 实例品性原文（charter）：与 HarnessOptions.charter 同名同域。已透传（2026-11-15 提示词面 fix round 1）：
   *  buildHarness → ContextManager 会话冻结层（全局 → 项目 → 品性，随 ctx-snap 导出/回种）；缺席=无此层 */
  charter?: string;
  /** 持久化域目录（2026-11-15 sunx P3 Task 1 注入缝）：与 HarnessOptions.dataDir 同名同域——透传
   *  buildHarness（装配单点收编其内）；缺席=resolveDataDir(root) 既有推导（零变化）。后续任务给
   *  sunx 会话注入 ~/.sunshinex/sunx/<journalId>/data */
  dataDir?: string;
  /** 学习沉淀开关（2026-11-15 sunx P3 Task 2）：与 HarnessOptions.learnSkills 同名同域——sunx 装配
   *  传 false（编排轮不沉淀伪技能，P2 遗留义务清偿）；缺席=既有推导（resolveMemoryConfig）零变化 */
  learnSkills?: boolean;
}

/** `RunOutcome` 按全局约束登记在 `src/types.ts`（跨模块共享）；此处按原路径再导出，既有 `./runtime` 导入点无需改动 */
export type { RunOutcome };

export interface KernelRuntime {
  harness: Harness;
  /** 呈现表（2026-11-15 sunx P2 Task 1 去单例）：effective face 的 displayMeta 装配快照
   *  （sunx=白名单面 / standard=主链全量）。TUI 持有运行时的消费点显式注入本表（toolCallLine 第三参 /
   *  applyTaskState 透传）——混合 kind 两次 assemble 各自返回各自表互不覆盖；进程级 setToolDisplayMeta
   *  保留为 TUI 单会话兼容兜底，daemon 路径不再依赖（serve/GUI 零消费进程级表） */
  readonly toolDisplay: Readonly<Record<string, ToolDisplayMeta>>;
  /** scope 线程：session=主链（缺省）；fork=私有执行（零主链回写）——/init 与规划轮 fork 隔离用 */
  runTask(goal: string, opts?: { maxSteps?: number; seedHistory?: HistoryStep[]; tier?: ModelTier; effort?: ReasoningEffort; scope?: 'session' | 'fork'; signal?: AbortSignal }): Promise<RunOutcome>;
  /** /goal 完整修正环入口（规格 D2/D3）：resolveTemplate → engine.run，LoopRunResult 原样透传（零新类型）；不开放 scope/seedHistory——修正环恒主链 */
  runLoop(goal: string, opts?: { template?: string; tier?: ModelTier; effort?: ReasoningEffort; signal?: AbortSignal }): Promise<LoopRunResult>;
}

/** 内核运行时接缝（§10-5 正名,原 TuiRuntime):TUI 与 daemon 共用的装配单点——buildHarness 取
 *  Harness + Loop 主链入口（runTask/runLoop),随内核落位 src/session。D27 收敛：Harness 构造经共享
 *  装配单点 buildHarness（root/kb 共用面收编于该单点，新增 Harness 接缝只改那一处）；差异面
 *  （ask/model/mode/onEvent/todos/addDirs）经 opts 注入，接缝语义逐一保留 */
export function createKernelRuntime(opts: KernelRuntimeOpts): KernelRuntime {
  const harness = buildHarness(opts.root, {
    ...(opts.onAskUser ? { ask: opts.onAskUser } : {}),
    ...(opts.plan ? { plan: opts.plan } : {}),
    ...(opts.schedule !== undefined ? { schedule: opts.schedule } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.onTodos ? { todos: { set: opts.onTodos } } : {}),
    ...(opts.addDirs ? { addDirs: opts.addDirs } : {}),
    ...(opts.wake !== undefined ? { wake: opts.wake } : {}),
    // sunx 提示词面透传（2026-11-15 fix round 1）：kind→稳定段分支（观测面 + 单发 Reactor 同源，
    // prompts/shared.ts 单点）、charter→ContextManager 会话冻结层（全局 → 项目 → 品性）
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts.charter !== undefined ? { charter: opts.charter } : {}),
    // 持久化域目录透传（2026-11-15 sunx P3 Task 1 注入缝）：缺席=既有推导零变化
    ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
    // 学习沉淀开关透传（2026-11-15 sunx P3 Task 2）：缺席=既有推导零变化
    ...(opts.learnSkills !== undefined ? { learnSkills: opts.learnSkills } : {}),
  });
  // 工具面选择（2026-11-15 sunx P1 Task 3；D74 收敛 2026-11-16）：主链 face=会话形态档案表白名单
  // 派生（SESSION_FACE_PROFILES 单点,与装配注册钩同源）——loop 主链模型面（loopDeps.registry）与
  // TUI 呈现表（displayMeta）同源消费 effective face；无白名单档案恒 harness.tools 原样（face 基线字节不变）
  const faceTools = SESSION_FACE_PROFILES[opts.kind ?? 'standard'].faceTools;
  const face = faceTools !== undefined ? harness.tools.derive({ only: [...faceTools] }) : harness.tools;
  // 审批注入不再限 acceptEdits(2026-11-01 用户裁定「完全访问也要弹特殊确认」):asker 只服务
  // guard ask:true 决策(acceptEdits 交互面 + 插件 act 类强制问线——后者任何档位不自动放行);
  // full-access 的常规 ask 仍在 guard 层自动放行(不经 asker),注入无档位副作用
  if (opts.onApproval) harness.security.setAsker(opts.onApproval);
  // 工具呈现表接线（D26/J1；2026-11-15 P2 Task 1 去单例）：表随 effective face 装配快照进返回值
  // （toolDisplay）——TUI 持有运行时的消费点显式注入；进程级 set 保留为 TUI 单会话兼容兜底，
  // daemon 路径不再依赖（混合 kind 两次 assemble 各自返回各自表，末装配者不再覆盖先装配者）
  const toolDisplay = face.displayMeta();
  setToolDisplayMeta(toolDisplay);

  // 主链唯一入口（D5）：提交经 Loop 长任务模板（内嵌 Reactor），不再直连 harness.reactor
  const loopDeps: LoopDeps = {
    safety: harness.safety,
    registry: face,
    context: harness.context,
    model: harness.model,
    root: opts.root,
    runner: harness.runner,
    ...(harness.ledger ? { ledger: harness.ledger } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    // 运行中穿插（对标 CC queued messages）：循环内构造的 Reactor 与单发 Reactor 同源消费通道
    // （P5 内核化：取走口为可换插缝，会话层装配后挂内核实现——缺省空即无穿插）
    steer: () => harness.steerSource(),
    // 沉淀双钩子与收尾管线（规格 §3.1/§3.5）：TUI 主链经 loop 构造 Reactor，钩子必须随 LoopDeps 透传才会触发
    ...harness.settleHooks,
    // 渲染期图片历史半径透传（spec §3.2 settings 键）：loop 内构造的 Reactor 与单发 Reactor 同源消费
    imageHistoryLimit: harness.imageHistoryLimit,
    // MCP 装配生命周期透传：run 入口 await ready（工具注册完成才进首节点），dispose 收口防 stdio 子进程悬挂
    mcpReady: harness.mcpReady,
    mcpClose: harness.mcpClose,
    mcpWarnings: harness.mcpWarningsOnce, // 链面一次化（D59）：同文案只进链一次；TUI 展示面走全量
    // 输出样式分叉：TUI 文字面缺省恒 terminal——围栏带语言标签、图示走 ASCII（CLI 不注入、保持缺省通用约定）
    outputStyle: opts.outputStyle ?? 'terminal',
    // 会话形态随主链 Reactor 同源透传（sunx 稳定段分支，2026-11-15 fix round 1）：loop 内构造的
    // Reactor 与单发 Reactor 同源消费——agent 节点 childDeps 原样下传（LoopDeps.kind）
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    pipeline: harness.pipeline,
  };

  // run 级覆盖统一构造：/model-tier 档位与 /model-effort 逐次覆盖、scope 线程、中断 signal（runTask/runLoop 共用，防两处漂移）
  const buildRunDeps = (o?: { tier?: ModelTier; effort?: ReasoningEffort; scope?: 'session' | 'fork'; signal?: AbortSignal }): LoopDeps => ({
    ...loopDeps,
    ...(o?.tier ? { tier: o.tier } : {}),
    ...(o?.effort ? { effort: o.effort } : {}),
    ...(o?.scope ? { scope: o.scope } : {}),
    ...(o?.signal ? { signal: o.signal } : {}),
  });

  return {
    harness,
    toolDisplay,
    runTask: async (goal, o) => {
      // 档位（run 级常量）：/model-tier 的会话级切换以逐次覆盖下传（缺省沿用装配点 tier）；scope 线程至 LoopDeps
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
