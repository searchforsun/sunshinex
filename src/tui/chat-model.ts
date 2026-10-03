import type { ApprovalDecision, ApprovalRequest, AskUserRequest, AskUserSeam, ModelTier, ReasoningEffort, TodoItem } from '../types';
import { t } from '../i18n';
import { formatDuration, formatTokens } from './format';
import type { ModelSwitcher } from '../model/catalog';
import type { TuiRuntime, TuiRuntimeOpts } from './runtime';
import type { LiveTaskState } from './task-state';

// D17 拆分件步1（docs/TECH-DEBT-SURVEY.md H1）：会话纯模型层——类型与零 this 依赖的纯函数原样迁出；
// session.ts 转发导出保持既有导入面（组件与测试零改动）。本文件只允许依赖类型与纯工具，不得回引 SessionController。

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system' | 'thinking' | 'step';

export interface ChatItem {
  role: ChatRole;
  text: string;
  ts: number;
  /** 全局单调序号：TUI Static 区 key 的唯一性来源，跨 /new 递增不回绕 */
  seq: number;
  /** tool 行细分：call（● 调用行）/ result（⎿ 结果行） */
  kind?: 'call' | 'result';
  /** tool 结果行成功标记 */
  ok?: boolean;
  /** tool 调用行等待态：已发射调用、结果未回（并发批中各调用行独立呈现 pending→✓/✗） */
  pending?: boolean;
  /** tool 行调用标识：结果行据此插到其调用行之后（并发批内乱序返回时配对不漂移） */
  callId?: string;
  /** system 消息级别：info 状态回执（缺省）/ warn 警示 / error 失败——渲染层据此选色 */
  level?: 'info' | 'warn' | 'error';
  /** 可展开原文：thinking 折叠行的思考全文 / tool 结果行的完整 observation（入档后折叠打印，供后续 transcript 视图） */
  detail?: string;
  /** 子代理归档摘要（SPAWN call 行专属）：steps=子代理步数、durationMs=归档时刻-startedAt、tokens=子代理 token 消耗、
   *  delegatedAt=委派时刻（spawnCalls 入栈时刻，动态区子代理列表按委派时间排序的单点数据源）；零子事件即败时缺省 */
  subagentMeta?: { steps: number; durationMs: number; tokens: number; delegatedAt?: number; prompt?: string };
  /** markdansi 渲染结果条目（2026-09-30 替换批次）：text 承载 ANSI（非 markdown 源），渲染层直嵌 <Text>；
   *  journal 按原样序列化，resume 回放照显 */
  ansi?: true;
  /** 段中续块（2026-09-30 完整流式裁决）：本 assistant 块由上一块逐行入档续接而来（上一块不以空行结尾=
   *  同一 Markdown 段）——渲染层折叠块间 marginBottom，逐行块与整段块呈现恒等 */
  cont?: true;
}

export type { TodoItem, TodoStatus } from '../types';
export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'awaiting-plan' | 'awaiting-question' | 'error';

export interface StatusMetrics {
  turnStartedAt: number;
  turnTokens: number;
  /** 本轮 prompt 缓存命中 tokens（usage 事件 cacheHitTotal 聚合；中间量，不再直接驱动状态栏 cache 段） */
  turnCacheTokens: number;
  /** 本轮 prompt tokens（usage 事件 promptTotal 聚合；与 turnCacheTokens 同量纲） */
  turnPromptTokens: number;
  /** 会话累计缓存命中 tokens（Σcached：同会话跨任务不清零、仅 /new 归零；状态栏 cache 段分子） */
  sessionCacheTokens: number;
  /** 会话累计 prompt tokens（Σprompt：cache 段分母，与 sessionCacheTokens 同量纲） */
  sessionPromptTokens: number;
  /** 会话累计任务轮次（任务起点 +1：跨任务累加、仅 /new 归零；状态栏 turns 段） */
  sessionTurns: number;
  /** 会话累计模型动作步数（step 事件计步、done 收尾帧不计；状态栏 steps 段） */
  sessionSteps: number;
  /** 本轮子代理 tokens（payload.subagent usage 增量聚合；随任务流起点与 turnTokens 同步归零；状态栏 ↑tokens 合并项） */
  turnChildTokens: number;
  /** 会话累计子代理 tokens（跨任务不清零、仅 /new 归零；任务收尾统计行的子代理差值基线） */
  sessionChildTokens: number;
  /** 会话累计总 tokens（主链+子代理；跨任务不清零、仅 /new 归零；状态栏 ↑tokens 数据源） */
  sessionTotalTokens: number;
  runs: number;
  /** 当前上下文占用水位估算 tokens（最新模型轮装配面估算；分母为 SUNSHINEX_CONTEXT_WINDOW 配置窗口） */
  ctxUsed: number;
}

export interface LiveBlock {
  kind: 'reply' | 'thinking';
  text: string;
  startedAt: number;
  /** 未消费结构起点（markdansi 批次，2026-09-30 真机「渲染+原文同屏」回归修复）：mdTailStart 水位镜像——
   *  块缓冲期（表格 hold/围栏开栏/未完行）MdBufferPreview 由此切原文，已入档内容不再以裸文本重演；
   *  undefined = 无未消费结构（预览只显示当前未完行） */
  tailStart?: number;
}

/** 子代理转录结构行（规格 §4.1）：归档 detail 与全屏查看视图共用同源。
 *  thinking 行对标主 agent ThinkingRow：text=收束摘要（Thought for Ns）、detail=思考全文（Tab 展开呈现）。 */
export interface ChildLine {
  kind: 'call' | 'result' | 'text' | 'thinking';
  text: string;
  ok?: boolean;
  detail?: string;
  /** call 关联 id（2026-09-30 并行结果归位）：call 行带自身 callId、result 行带所配对的 callId——
   *  并行批「先全量 call 后按完成序 result」时视图按 callId 把结果归位到对应调用行下（主 agent ToolRow 同构） */
  callId?: string;
}

/** 并行结果归位（2026-09-30 对标主 agent ToolRow 配对形态）：result 行按 callId 归位到对应 call 行之后——
 *  并行批「先全量 call、后按完成序 result」的真实时序下，视图/归档时间线不再「调用块后结果堆叠」；
 *  缺 callId 的 result 按 FIFO 归到最早未配对的 call（延迟入档同口径）；无宿主 call 的孤立 result 原位保留。
 *  text/thinking 行打断配对（已归位组先冲刷，时序不回改）。live 视图与归档序列化同源消费（单点防漂移）。 */
export function pairChildResults(items: ChildLine[]): ChildLine[] {
  const out: ChildLine[] = [];
  const open: { call: ChildLine; results: ChildLine[] }[] = [];
  const byId = new Map<string, { call: ChildLine; results: ChildLine[] }>();
  const flush = (): void => {
    for (const g of open) out.push(g.call, ...g.results);
    open.length = 0;
    byId.clear();
  };
  for (const l of items) {
    if (l.kind === 'call') {
      const g = { call: l, results: [] as ChildLine[] };
      open.push(g);
      if (l.callId) byId.set(l.callId, g);
      continue;
    }
    if (l.kind === 'result') {
      const g = (l.callId ? byId.get(l.callId) : undefined) ?? open.find((x) => x.results.length === 0);
      if (g) g.results.push(l);
      else out.push(l); // 无宿主 call（旧档/孤儿）：原位保留
      continue;
    }
    flush();
    out.push(l);
  }
  flush();
  return out;
}

/** 子代理运行中面板态（规格 §4.2）：带 payload.subagent 标签的事件路由至此，主链零污染 */
export interface ChildLiveState {
  label: string;
  /** 后台账本任务 id（b1…，payload.subagentTaskId 随事件携带）：UI 停单个子代理（stopChild）的定位锚；
   *  前台 spawn 无（随主链信号，不可单点停） */
  taskId?: string;
  startedAt: number;
  steps: number;
  tokens: number;
  /** 全量结构行（归档与全屏查看同源）：工具行/结果行/流式文本/思考摘要行 */
  transcript: ChildLine[];
  /** 完成态：done/error 事件置位——并行批中早完成者即时显终标而非一直转圈（归档锚点在主链 tool-result，晚于兄弟完成） */
  done?: boolean;
  /** 完成时刻（done/error 事件置位）：done 行耗时冻结在完成时刻，不随渲染帧跳动 */
  doneAt?: number;
  /** 终稿结论（done/error 事件置位）：与流式正文逐字重复时不进 transcript（去重），归档 detail 的「输出」段数据源 */
  conclusion?: string;
  /** 工具活动行（规格 §4.2 面板增强）：当前未决调用的 {调用名, 起始时刻}——呈现层消费，归档零依赖 */
  calls?: { callId: string; target: string; startedAt: number }[];
  /** 主 agent 委派提示词（spawn input.prompt，全屏视图头部呈现；规格 §4.2） */
  prompt?: string;
  /** 正文流式半行（token 增量未成行）：全屏视图动态区实时预览消费（对标主 agent LiveArea 尾段窗） */
  bufText?: string;
  /** 思考流式尾段（reasoning 增量累积未收束）：全屏视图 6 行滚动窗实时预览；非 reasoning 事件到达即收束为 ✻ 摘要行 */
  bufThink?: string;
  /** 当前思考段起点（收束摘要耗时口径，对标主 agent closeLive） */
  thinkStartedAt?: number;
}

/** spawn 调用关联基名（规格 §4.4）：label ?? agent_id ?? 'subagent'（与 Runner 解析同源；消歧后缀不含入内） */
export function spawnBaseLabel(input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  return str(obj.label) ?? str(obj.agent_id) ?? 'subagent';
}

/** 结构行多行内容续行序列化：续行一律 4 空格缩进（与思考 detail 同一口径）——解析镜像 segmentizeLines
 *  把缩进续行折回上一结构行；不缩进即被按行分流拆散成裸正文（真机「归档后委派词/工具输出整段漏成
 *  独立正文段——多余输入内容/多余工具行」病根）。旧档（无缩进）不回改，解析侧对旧形态维持原样 */
export function serializeMultiline(text: string): string {
  return text.split('\n').join('\n    ');
}

/** 任务收尾统计行（规格 2026-09-26-stats-enhancement §3.2）：done 正常完成路径尾追入档；无子代理消耗省略子代理段 */
export function formatTaskStatsLine(durationS: number, steps: number, totalTokens: number, childTokens: number): string {
  const base = `${formatDuration(Math.max(0, durationS))} · ${Math.max(0, steps)} steps · ↑${formatTokens(Math.max(0, totalTokens))} tokens`;
  return childTokens > 0
    ? t(`${base} (subagents ${formatTokens(childTokens)})`, `${base}（含子代理 ${formatTokens(childTokens)}）`)
    : t(base, base);
}

export interface TuiState {
  messages: ChatItem[];
  approval?: ApprovalRequest;
  todos: TodoItem[];
  status: SessionStatus;
  metrics: StatusMetrics;
  live?: LiveBlock;
  /** 运行中子代理面板态（规格 §4）：首事件创建、spawn 结果归档移除、回合边界清空 */
  children: ChildLiveState[];
  /** 活任务三态（规格 §4）：事件流经 applyTaskState 纯函数推导，瞬态不进 journal */
  task: LiveTaskState;
  /** 用户级模型档位（/model-tier 会话内切换；undefined = 缺省档，run 级常量不随步重估） */
  tier?: ModelTier;
  /** 当前模型选择 id（/model 会话内切换，`源/模型`；undefined = 缺省主模型） */
  modelId?: string;
  /** 状态栏模型段实况（选择在场为 `源/模型` id；undefined = 回 banner 主模型标签，与单模型形态一致） */
  modelLabel?: string;
  /** 当前模型窗口 tokens（选择在场且模型带 contextWindow 时；undefined = 回全局 env 分母，既有形态） */
  modelWindow?: number;
  /** 缺省思考强度（/model-effort 会话内切换；undefined = 适配器 cfg/env 缺省，run 级常量） */
  effort?: ReasoningEffort;
  /** AskQuestion 挂起卡（ask_question 工具或本地问询期间非空；渲染层选择器接管键盘） */
  question?: AskUserRequest;
  /** 输入框回填文本（/rewind //fork 锚点轮输入；瞬态不进 journal，App 取走即消费） */
  backfill?: string;
  /** 暂停确认卡（第一次 Ctrl+C 挂起；瞬态不进 journal）：status 保持 running、abort 不触发——任务与子代理
   *  继续跑，再按 Ctrl+C / 确认项才走 interrupt() 真正中断（2026-10-02 用户裁决「两次 Ctrl+C 确认暂停」） */
  pauseConfirm?: boolean;
}

export interface SessionOpts extends TuiRuntimeOpts {
  /** 启动即续接最近会话（CLI --continue；规格 D1/D5）。无档位时提示并以新会话继续，不静默吞 */
  continueLast?: boolean;
  /** 启动即弹会话选择卡（--resume） */
  resumePicker?: boolean;
  /** 多源多模型切换器（settings providers 键装配）：在场时作为 harness 主模型（/model 会话内切换的内芯） */
  models?: ModelSwitcher;
  /** manual 模式审批回调（终端化审批装配点；渲染层注入交互实现） */
  asker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 问询接缝覆盖（headless/脚本注入；缺省会话装配把 seam 接到本控制器问询管线） */
  onAskUser?: AskUserSeam;
  /** 运行时注入位：缺省自建 createRuntime(opts)；测试可注入假实现以隔离长任务 */
  runtime?: TuiRuntime;
}

/** ctx 水位消费策略：真实 usage 口径（exact）直接采信——压缩回落 / plan 新步骤最小化回落都是真实语义；
 *  估算口径只作向上预告，不得覆盖更准的真实水位（消除同轮内估算↔真实的往复抖动） */
export function applyCtxWatermark(current: number, incoming: number, exact: boolean): number {
  if (!(incoming > 0)) return current;
  return exact ? incoming : Math.max(current, incoming);
}

// 选择卡翻页口径（2026-09-30 用户裁决）：More…/Back… 导航行分页退役（原 paginateOptions 已删）——
// 所有选择卡超窗翻页由渲染层 OptionSelector 光标跟随滑窗统一承载（命令面板式自动翻页），
// 会话层恒传全量 options

export function slashHelp(): string[] {
  const lines = [
    t('Commands:', '命令：'),
    t('  /init          analyze & write SUNSHINE.md', '  /init          分析生成/完善 SUNSHINE.md'),
    t('  /goal          run the verify-fix loop: /goal <goal>', '  /goal          运行完整验收修正环：/goal <目标>'),
    t('  /plan          plan first, execute on approval: /plan <goal>', '  /plan          先规划后执行：/plan <目标>'),
    t('  /new           new session (soft reset)', '  /new           新会话（软重置）'),
    t('  /resume        resume a saved session (selector, auto-scroll window)', '  /resume        恢复已保存会话（选择卡，滑窗自动翻页）'),
    t('  /rewind        rewind current session to an earlier turn', '  /rewind        回退当前会话到更早的任务轮'),
    t('  /fork          fork a parallel session from any past turn', '  /fork          从任意历史轮分叉出平行会话'),
    t('  /compact       compress context: /compact [focus]', '  /compact       压缩上下文：/compact [关注点]'),
    t('  /context       context usage breakdown (parts, size, share)', '  /context       上下文构成（各段大小与占比）'),
    t('  /model         switch model (provider list from settings.json)', '  /model         切换模型（settings.json 多源清单选择卡）'),
    t('  /model-tier    switch model tier (selector)', '  /model-tier    切换模型档位（选择卡）'),
    t('  /model-effort  switch reasoning effort (selector)', '  /model-effort  切换思考强度（选择卡）'),
    t('  /add-dir <dir>  extend trusted directories (read+write, this session)', '  /add-dir <dir>  扩展信任目录（读写，本会话内生效）'),
    t('  /kb-index [dir] build the knowledge-base index (md/txt, billed embedding)', '  /kb-index [目录] 构建知识库索引（md/txt，走计费 embedding）'),
    t('  /memory        list persistent memories', '  /memory        列出持久记忆'),
    t('  /memory-add    add a memory: /memory-add <text>', '  /memory-add    添加记忆：/memory-add <内容>'),
    t('  /memory-rm     delete memories (multi-select)', '  /memory-rm     删除记忆（多选卡）'),
    t('  /memory-gc     consolidate memories now', '  /memory-gc     立即整理记忆'),
    t('  /memory-on     enable memory for this session', '  /memory-on     本会话开启持久记忆'),
    t('  /memory-off    disable memory for this session', '  /memory-off    本会话关闭持久记忆'),
    t('  /tasks         list background tasks (id/kind/status/label, output path)', '  /tasks         列出后台任务（id/类型/状态/标签，输出路径）'),
    t('  /skill         load a skill into context (selector, type to filter)', '  /skill         加载技能进上下文（选择卡，输入筛选）'),
    t('  /status        session & ledger summary', '  /status        会话与账本摘要'),
    t('  /terminal-setup configure terminal keys (Shift+Enter newline, Windows Terminal)', '  /terminal-setup 配置终端键位（Shift+Enter 换行，Windows Terminal）'),
    t('  /help          show this list', '  /help          本清单'),
  ];
  // 技能命令一行引导：完整列表经 /skill 选择卡筛选（type-to-filter），/<技能id> 直调形态同源分发
  lines.push(t('  Skills: invoke /<skill-id> directly; browse with /skill', '  技能命令：直接 /<技能id> 调用；完整列表经 /skill 筛选'));
  return lines;
}

/** 空闲兜底节拍判据（规格 §3.5）：仅 idle（且无挂起审批）且后台队列非空才消费——无待办零调用零配额。
 *  抽为导出纯函数以钉死「运行中不消费」的负向证伪力（评审 Important-2）。 */
export function shouldPumpOnIdleBeat(status: string, hasPendingApproval: boolean, pending: number, hasPendingQuestion = false): boolean {
  return status === 'idle' && !hasPendingApproval && !hasPendingQuestion && pending > 0;
}

/** /plan 规划轮内部任务标签：规划提示词与 runInternalTask label 共用（D10：防两处漂移） */
export const PLAN_TASK_LABEL = 'Produce a numbered step plan';
