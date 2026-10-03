import type { AskUserAnswer, AskUserRequest, AskUserSeam } from '../types';
import type { TodoItem } from '../types';
import { ApprovalDecision, ApprovalRequest, ModelTier, ReasoningEffort, SessionEvent } from '../types';
import { EFFORT_ORDER, parseEffort } from '../model/adapter';
import { t } from '../i18n';
import { formatDuration, formatTokens, formatContextBreakdown } from './format';
import { RunOutcome, TuiRuntime, TuiRuntimeOpts, createRuntime } from './runtime';
import { parseTier } from '../runtime';
import type { ModelSwitcher } from '../model/catalog';
import { isFenceLine, normalizeCjkLine, renderMd, stripAnsi } from './md-ansi';
import { toolCallLine } from './tool-verbs';
import { describeIncomplete } from './stop-reason';
import { ContextManager, chainToHistoryItems, runCompaction, contextBreakdown } from '../harness/context';
import { resolveRunWindow } from '../config/termination-config';
import { sunshineInitGoal } from '../harness/sunshine-init';
import { skillHeader } from '../harness/skills';
import * as fs from 'fs';
import * as path from 'path';
import { SessionJournal, listSessions, newSessionId, sessionsDir, parseJournalFile, reduceJournal, listAnchors, branchFrom, type SessionMeta } from './session-journal';
import { collectRestorePlan, applyRestorePlan } from './session-snapshots';
import { resolveDataDir } from '../config/data-dir';
import { SLASH_COMMANDS } from './slash-commands';
import { MemoryStore } from '../harness/memory/store';
import { resolveMemoryConfig, setMemorySessionOverride } from '../config/memory-config';
import { scanMemoryText } from '../harness/memory/guards';
import { consolidateMemory } from '../harness/memory/consolidate';
import { isModelSummarizer } from '../harness/context/summarizer';
import { LiveTaskState, applyTaskState, initialTaskState } from './task-state';
import { readSkillUsage, recordSkillUsage } from './skill-usage';
import { configureWindowsTerminal, wtSettingsCandidates } from './terminal-setup';
import { resolveKbEnv } from '../config/env';
import { indexKnowledgeDir } from '../harness/knowledge';

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
function spawnBaseLabel(input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  return str(obj.label) ?? str(obj.agent_id) ?? 'subagent';
}

/** 结构行多行内容续行序列化：续行一律 4 空格缩进（与思考 detail 同一口径）——解析镜像 segmentizeLines
 *  把缩进续行折回上一结构行；不缩进即被按行分流拆散成裸正文（真机「归档后委派词/工具输出整段漏成
 *  独立正文段——多余输入内容/多余工具行」病根）。旧档（无缩进）不回改，解析侧对旧形态维持原样 */
function serializeMultiline(text: string): string {
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

function slashHelp(): string[] {
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

/** 会话控制器：事件进 → 状态变更（渲染层订阅）；斜杠命令解析、FIFO 排队、审批挂起/回填；纯逻辑可独立单测 */
/** 空闲兜底节拍判据（规格 §3.5）：仅 idle（且无挂起审批）且后台队列非空才消费——无待办零调用零配额。
 *  抽为导出纯函数以钉死「运行中不消费」的负向证伪力（评审 Important-2）。 */
export function shouldPumpOnIdleBeat(status: string, hasPendingApproval: boolean, pending: number, hasPendingQuestion = false): boolean {
  return status === 'idle' && !hasPendingApproval && !hasPendingQuestion && pending > 0;
}

/** /plan 规划轮内部任务标签：规划提示词与 runInternalTask label 共用（D10：防两处漂移） */
export const PLAN_TASK_LABEL = 'Produce a numbered step plan';

export class SessionController {
  readonly runtime: TuiRuntime;
  /** 项目根：/init 生成 SUNSHINE.md 的基准目录（与 runtime 装配同源） */
  private readonly root: string;
  /** 行喂入缓冲（preprocess 需行级上下文：围栏内不归一） */
  private mdLineBuf = '';
  private mdInFence = false;
  /** 本轮流式已喂入通道的全量源（done 终稿前缀对齐基准）：跨 reply/thinking 交错块连续累积，
   *  closeLive 不清（通道生命周期独立于 live 块），mdSeal/mdClear 随通道一并归零 */
  private mdSource = '';
  /** 未消费块起点（源内偏移，mdTailStart 水位）：块缓冲期指向当前块首行，块边界（空行）放行后 undefined——LiveBlock.tailStart 镜像 */
  private mdTailStart: number | undefined;
  /** 块缓冲（2026-09-30 架构裁定「行距唯一权威 = markdown 结构」）：全部完成行紧排入缓冲，
   *  仅在块边界（空行）整块渲染入档（renderMd）——片段粒度 = markdown 块，行距成为源结构的纯函数，
   *  不随流式时序/喂入批次浮动（逐行发射、松散化插行等时变源全部退役的终版形态） */
  private mdHoldBuf = "";
  /** /plan 规划轮：计划正文只以确认卡上屏一次，流式切块与 done 终稿均不再重复入档（重复显示根因） */
  private planReplyNoArchive = false;
  /** usage 整场基线：每个模型轮开始前同步为当前累计，事件按「基线 + 本轮 per-run 值」聚合（/plan 步骤间不重置窗口） */
  private usageBase = { tokens: 0, cache: 0, prompt: 0 };
  private state: TuiState = {
    messages: [],
    todos: [],
    status: 'idle',
    metrics: { turnStartedAt: 0, turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, sessionCacheTokens: 0, sessionPromptTokens: 0, sessionTurns: 0, sessionSteps: 0, runs: 0, ctxUsed: 0, turnChildTokens: 0, sessionChildTokens: 0, sessionTotalTokens: 0 },
    children: [],
    task: initialTaskState(),
  };
  private listeners = new Set<(s: TuiState) => void>();
  /** 消息全局单调序号（Static 区 key 唯一性来源）；/new 清空消息但不回绕 */
  private msgSeq = 0;
  /** 会话事件日志（规格 2026-09-17-session-persistence D4 + 2026-09-22 事件级即时落盘）：持久化事件随产生落盘（惰性建档，空会话零文件） */
  private journal?: SessionJournal;
  /** 恢复携带的 UI 现场（--continue / /resume 重放产物；entry 经 takeRestoredUi 播种 retain，一次性取走） */
  private restoredUi?: { history: string[]; expandAll: boolean; latestFull: boolean };
  /** 子代理半行缓冲（label → 未成行）：token/reasoning 增量拼接、遇换行成行入 transcript */
  private childBufs = new Map<string, string>();
  /** 子代理委派提示词暂存（spawn tool-call 捕获 → 面板态创建时挂载 → 归档清理；规格 §4.2） */
  private childPrompts = new Map<string, string>();
  /** spawn 调用关联栈（FIFO）：主链 spawn tool-call 压栈（行 seq + 关联基名）、tool-result 弹出归档（规格 §4.4 配对语义）；
   *  后台两段式结果先行 → wait 标记延迟归档（子代理 done 触发），wait 条目不阻塞后续前台配对 */
  private spawnCalls: { seq: number; base: string; wait?: boolean; delegatedAt: number }[] = [];
  /** 运行中挂起的调用行（CC 模式延迟入档）：tool-call 挂起不进历史区（底部活动行唯一承载运行态），
   *  tool-result 回程时调用行+结果行成对定格入档；收尾未回程者补档不蒸发 */
  private pendingCalls: { callId?: string; text: string; input?: unknown; verb: string }[] = [];
  private pendingApproval?: { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void };
  /** 空闲兜底节拍（规格 §3.5）：仅 idle 且后台队列非空时消费；unref 不阻塞进程退出 */
  private kickTimer?: ReturnType<typeof setInterval>;
  /** 挂起的计划确认卡（/plan 流程）；confirmPlan 裁决后清除 */
  private pendingPlan?: { items: string[] };
  /** 最近一次压缩事件时的 ctx 水位（自动压缩留痕 before → after 用；/compact 路径不消费） */
  private compactWatermark = 0;
  /** compact 事件序号（1-based）：一次压缩 = applyCompaction + trimChainFront 恰两条，留痕按序配对消歧 */
  private compactEventSeq = 0;
  /** 任务轮首 miss 提示判定（规格 D 观测小件）：每任务轮首重置；提示一次后不再重复 */
  private turnMissHinted = false;
  /** 裁决权注入（SessionOpts.asker）：挂起语义不变，回填后咨询并以其为最终裁决 */
  private autoAsker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 会话内持久记忆开关（/memory on|off；undefined=随控制面）：写 setMemorySessionOverride 单点，仅本会话生效、不改盘，/new 清除 */
  private memoryOverride?: boolean;
  /** 多源多模型切换器（/model 数据面）：不在场 = 未配置 providers，/model 给配置指引 */
  private readonly modelSwitcher?: ModelSwitcher;
  /** 当前任务中断源（Esc/Ctrl+C）：任务起点建、closeTask 清；interrupt() 置 aborted 贯通模型/loop/reactor */
  private taskAbort?: AbortController;

  /** 任务统计基线（规格 §3.2）：任务流起点建（与 turnTokens 归零同点）、closeTask done 路径算差值产出统计行 */
  private taskStats?: { startedAt: number; startSteps: number; startTokens: number; startChildTokens: number };
  /** 中断抑制位：pushInterruptedNotice 单点置位——中断路径不产出收尾统计行 */
  private taskStatsSuppressed = false;

  /** 任务统计基线建立单点：任务流起点调用（同点 turnTokens 已归零，startTokens 即 0 起算主链增量） */
  private beginTaskStats(): void {
    this.taskStats = { startedAt: Date.now(), startSteps: this.state.metrics.sessionSteps, startTokens: this.state.metrics.turnTokens, startChildTokens: this.state.metrics.sessionChildTokens };
    this.taskStatsSuppressed = false;
  }

  /** AskQuestion 挂起态：问询管线挂起点与裁决回填口（AskQuestion 线 D5） */
  private pendingQuestion?: { req: AskUserRequest; resolve: (a: AskUserAnswer) => void };

  constructor(opts: SessionOpts) {
    this.root = opts.root;
    this.modelSwitcher = opts.models;
    // 主模型装配单点：切换器在场即以其为主模型（/model 换内芯即时贯通 reactor/子代理/压缩）；
    // 否则回落单模型适配器（无 providers 配置的既有形态）
    const mainModel = opts.models ?? opts.model;
    this.runtime = opts.runtime ?? createRuntime({
      root: opts.root,
      ...(mainModel ? { model: mainModel } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.tier ? { tier: opts.tier } : {}),
      ...(opts.addDirs ? { addDirs: opts.addDirs } : {}),
      onEvent: (e) => this.onEvent(e),
      onAskUser: opts.onAskUser ?? ((req) => this.askUser(req)),
      onTodos: (items) => this.setTodos(items),
    });
    const suspendAsker = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      // 终端化审批：guard ask → 挂起（awaiting-approval + 审批卡）→ 裁决回填 → 继续；
      // 有外部 asker（headless/脚本）时委托之，状态转换保持一致便于观测与渲染
      this.state = { ...this.state, status: 'awaiting-approval', approval: req, task: this.state.task.phase === 'tool-pending' ? { ...this.state.task, phase: 'tool-awaiting' } : this.state.task };
      this.notify();
      // 挂起等回填（App 模态/测试直调）；opts.asker 为裁决权注入，回填后咨询并以其为最终裁决
      let d = await new Promise<ApprovalDecision>((resolve) => {
        this.pendingApproval = { req, resolve };
      });
      if (this.autoAsker) d = await this.autoAsker(req);
      this.state = { ...this.state, approval: undefined, status: 'running', task: this.state.task.phase === 'tool-awaiting' ? { ...this.state.task, phase: 'tool-pending' } : this.state.task };
      this.notify();
      return d;
    };
    this.autoAsker = opts.asker;
    if (opts.mode === 'manual') this.runtime.harness.security.setAsker(suspendAsker);
    this.state = { ...this.state, metrics: { ...this.state.metrics, runs: this.runtime.harness.ledger.summary().runs } };
    if (opts.tier) this.state = { ...this.state, tier: opts.tier };
    if (opts.effort) this.state = { ...this.state, effort: opts.effort };
    // 装配期已选模型（providers 配置且主模型未显式配置时缺省取首个）：状态栏段同步初值
    if (opts.models && opts.models.currentId() !== undefined) this.state = { ...this.state, modelId: opts.models.currentId(), modelLabel: opts.models.label, ...(opts.models.contextWindow !== undefined ? { modelWindow: opts.models.contextWindow } : {}) };
    // 空闲兜底节拍（规格 §3.5）：仅 idle 且后台队列非空时消费（无待办零调用零配额）；
    // 主触发是 closeTask 的 kick，本定时器只是兜底；unref 保证不阻塞进程退出
    this.kickTimer = setInterval(() => {
      const p = this.runtime.harness.pipeline;
      if (shouldPumpOnIdleBeat(this.state.status, this.pendingApproval !== undefined, p.pending(), this.pendingQuestion !== undefined)) void p.drain();
    }, resolveMemoryConfig().memoryIdleKickMs);
    this.kickTimer.unref?.();
    // 会话日志订阅（规格 §5 单一事实源）：链/压缩变更 → 事件缓冲；任务必经 submit 建档，此后事件动态路由到当前 journal 实例。
    // 未建档时事件丢弃（订阅常驻、可选链路由）；restoreSession 直注入不触发订阅（重放零击穿）。
    this.runtime.harness.context.onContextChange((c) => {
      if (c.kind === 'append') this.journal?.log({ t: 'chain', steps: c.steps });
      else {
        this.journal?.log({ t: 'compact', chainFrom: c.chainFrom, compacted: c.compacted });
        // 自动压缩消息流留痕（CC auto-compact 口径）：一次压缩 = applyCompaction + trimChainFront 两条 compact 事件，
        // 以事件序号配对（重放按序覆盖同款语义）——成对第一/第二条都不上屏，第三条起（新一轮压缩首个事件）上屏；
        // 消歧靠任务态：/compact 自带回执（handleSlash 分支），此处仅任务运行中（自动路径）补水位留痕
        this.compactEventSeq++;
        const isPairSecond = this.compactEventSeq % 2 === 0; // 一次压缩 = 恰两条事件；第二条=折链收口
        if (isPairSecond && this.state.status === 'running') {
          const before = this.compactWatermark;
          const after = this.state.metrics.ctxUsed;
          this.pushMsg('system', t(`Context compacted (ctx ${before} → ${after} tokens)`, `上下文已压缩（水位 ${before} → ${after} tokens）`));
          this.compactWatermark = after;
        }
      }
    });
    if (opts.resumePicker) void this.resumeFlow();
    if (opts.continueLast) this.resumeLatest();
  }

  getState(): TuiState {
    return this.state;
  }

  /** 会话链账本（测试与高级用法读取；常规写入经 runTaskFlow / runInternalTask） */
  get context(): ContextManager {
    return this.runtime.harness.context;
  }

  /** 订阅状态变更（渲染层入口）；返回退订函数 */
  onState(cb: (s: TuiState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 提交输入：斜杠命令即时处理；自然语言任务运行中提交进 FIFO 队列 */
  async submit(input: string): Promise<void> {
    const text = input.trim();
    if (!text) return;
    // 会话日志（规格 D4/D6）：user 事件=输入历史还原源，先于回显入志
    const j = this.ensureJournal();
    j.start();
    j.log({ t: 'user', text });
    // 用户输入回显上屏（含斜杠命令）：消息流完整呈现对话轮次（/plan <目标> 此前整行蒸发）；内部 goal 提示词仍不上屏
    this.pushMsg('user', text);
    if (text.startsWith('/')) {
      await this.handleSlash(text);
      return;
    }
    this.mdClear();
    if (this.state.status === 'running' || this.state.status === 'awaiting-approval' || this.state.status === 'awaiting-question') {
      // 运行中穿插（对标 CC queued messages，用户→运行时方向、非模型工具面）：入 steering 通道，
      // reactor 步边界 drain 同轮消费；未被消费的行由收口兜底 drainQueue 补跑
      this.runtime.harness.steering.enqueue(text);
      this.pushMsg('system', t(`Queued: ${text}`, `已排队：${text}`));
      return;
    }
    await this.runTaskFlow(text);
    await this.drainQueue();
  }

  /** 回填当前挂起审批；无挂起时静默忽略 */
  async resolveApproval(d: ApprovalDecision): Promise<void> {
    const pending = this.pendingApproval;
    if (!pending) return;
    this.pendingApproval = undefined;
    this.state = { ...this.state, approval: undefined };
    this.notify();
    pending.resolve(d);
  }

  /** 用户中断（Esc/Ctrl+C，对标 Claude Code）：中止在途模型调用与后续步、待审批按拒绝、待确认计划放弃、排队任务一并丢弃。
   *  运行外状态 no-op（App 层据此分流退出/清输入）；返回是否实际发生中断 */
  /** AskQuestion 挂起管线（AskQuestion 线 D5，形态对标 suspendAsker）：prevStatus 记录挂起前态（running=任务中途问询、
   *  idle=/resume 选择器等本地问询），awaiting-question + 问题卡上屏 → 渲染层选择器接管键盘 → resolveAskAnswer 回填 → 恢复现场态 */
  askUser(req: AskUserRequest): Promise<AskUserAnswer> {
    const prevStatus = this.state.status;
    this.state = { ...this.state, status: 'awaiting-question', question: req };
    this.notify();
    return new Promise<AskUserAnswer>((resolve) => {
      this.pendingQuestion = {
        req,
        resolve: (a) => {
          this.pendingQuestion = undefined;
          this.state = { ...this.state, question: undefined, status: prevStatus };
          this.notify();
          resolve(a);
        },
      };
    });
  }

  /** 渲染层/测试裁决回填口：无挂起时静默忽略（幂等） */
  resolveAskAnswer(a: AskUserAnswer): void {
    this.pendingQuestion?.resolve(a);
  }

  /** 第一次 Ctrl+C（运行中）：挂起暂停确认卡——status 保持 running、abort 不触发，任务与子代理继续跑。
   *  已挂卡或非运行态返回 false（App 层据此回落既有分流） */
  requestPause(): boolean {
    if (this.state.status !== 'running' || this.state.pauseConfirm) return false;
    this.state = { ...this.state, pauseConfirm: true };
    this.notify();
    return true;
  }

  /** 撤回暂停确认卡（Esc/n/继续项）：回运行现场，任务零影响 */
  cancelPause(): void {
    if (!this.state.pauseConfirm) return;
    this.state = { ...this.state, pauseConfirm: undefined };
    this.notify();
  }

  /** 子代理全屏视图挂卡（UI 面）：无 running 门槛——后台子代理跨回合存续，主链 idle 时单停子代理仍可达；
   *  与 requestPause（主视图、running 门槛）同一张卡两种入口，确认动作随按键所在视图分流（App 分发层） */
  hangPauseCard(): void {
    if (this.state.pauseConfirm) return;
    this.state = { ...this.state, pauseConfirm: true };
    this.notify();
  }

  /** 停单个子代理（UI 面，2026-10-02 用户裁决「子agent暂停不应连带中断主agent」）：按 label 定位在跑
   *  child 的账本任务 → task_stop 工具同款单点（stop 句柄中止其模型调用 + finish('stopped')）；主链
   *  零影响——TASK_WAIT 收到 stopped 终态行自判续跑。面板即时置终态并走延迟归档（abort 级联不保证
   *  还有 done/error 事件，UI 真相兜底）；返回是否实际停止了在跑任务 */
  stopChild(label: string): boolean {
    const child = this.state.children.find((c) => c.label === label && !c.done);
    const taskId = child?.taskId;
    if (child === undefined || taskId === undefined) return false;
    const tasks = this.runtime.harness.tasks;
    const task = tasks.get(taskId);
    if (task === undefined || task.status !== 'running') {
      this.markChildStopped(label);
      return false;
    }
    task.stop?.();
    if (tasks.get(taskId)?.status === 'running') tasks.finish(taskId, 'stopped', { marker: '[stopped: user]' });
    this.markChildStopped(label);
    return true;
  }

  /** 停止后面板终态单点：done 置位 + 转录补停止标记行 + 延迟归档收口（与 done/error 事件路径同构） */
  private markChildStopped(label: string): void {
    const list = this.state.children;
    const idx = list.findIndex((c) => c.label === label && !c.done);
    if (idx < 0) return;
    const c = list[idx]!;
    this.commitChild(list, idx, { ...c, done: true, doneAt: Date.now(), transcript: [...c.transcript, { kind: 'text', text: '[stopped: user]' }], bufText: undefined, bufThink: undefined, thinkStartedAt: undefined }, '');
    this.archiveDeferred(label);
  }

  interrupt(): boolean {
    const active = this.state.status === 'running' || this.state.status === 'awaiting-approval' || this.state.status === 'awaiting-plan' || this.state.status === 'awaiting-question';
    if (!active) return false;
    // 暂停确认卡随真正中断一并清除（第二次 Ctrl+C 确认路径走这里）
    this.state = { ...this.state, pauseConfirm: undefined };
    this.taskAbort?.abort();
    this.taskAbort = undefined;
    // 待审批卡：中断即拒绝（deny 不落会话放行），任务经安全链 deny 语义自然停下
    const pending = this.pendingApproval;
    if (pending) {
      this.pendingApproval = undefined;
      this.state = { ...this.state, approval: undefined };
      pending.resolve('deny');
    }
    // 问询挂起：中断先以 dismissed 回填（管线自然恢复现场态），任务随 abort 信号停下；不遗留悬空 Promise
    if (this.pendingQuestion) {
      const pendingQ = this.pendingQuestion;
      this.pendingQuestion = undefined;
      this.state = { ...this.state, question: undefined };
      pendingQ.resolve({ type: 'dismissed' });
    }
    // 待确认计划：中断即放弃（与 confirmPlan(false) 同语义）
    if (this.pendingPlan) {
      this.pendingPlan = undefined;
      this.state = { ...this.state, status: 'idle' };
      this.pushMsg('system', t('Plan discarded, back to input', '已放弃执行计划，回到输入态'));
      this.notify();
      return true;
    }
    // 待投递穿插行随中断一并丢弃（用户意图是停，不是继续跑）；已消费穿插行已随步入链，不受影响
    if (this.runtime.harness.steering.pending() > 0) {
      const dropped = this.runtime.harness.steering.takePending().length;
      this.pushMsg('system', t(`Queued tasks dropped: ${dropped}`, `已丢弃排队任务：${dropped} 条`), { level: 'warn' });
    }
    this.notify();
    return true;
  }

  /** 中断回执单点：interrupted 终态由各任务流调用；warn 级（用户主动操作，非故障） */
  private pushInterruptedNotice(): void {
    this.taskStatsSuppressed = true; // 中断路径不产出收尾统计行（规格 §3.2 边界）
    this.pushMsg('system', t('Task interrupted (Esc/Ctrl+C) — completed steps kept on the chain', '已中断当前任务（Esc/Ctrl+C）——已完成步骤保留在会话链'), { level: 'warn' });
  }

  /** 等待会话回到 idle（队列清空且无挂起审批） */
  async waitIdle(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.state.status !== 'idle' || this.pendingApproval) {
      if (Date.now() > deadline) throw new Error(t('waitIdle timeout', 'waitIdle 超时'));
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** 计划确认卡裁决：true 逐项执行（待办同步勾选），false 放弃回 idle */
  async confirmPlan(yes: boolean): Promise<void> {
    const pending = this.pendingPlan;
    if (!pending) return;
    this.pendingPlan = undefined;
    if (!yes) {
      this.state = { ...this.state, status: 'idle', pauseConfirm: undefined }; // 同 closeTask 状态出口清卡（规划轮挂的卡可走到这）
      this.pushMsg('system', t('Plan discarded, back to input', '已放弃执行计划，回到输入态'));
      return;
    }
    // 确认项过期/冲突检测（规范 N1 动态改动尾追，对标 CC）：计划起草到确认之间磁盘会话常量可能已变化——
    // 执行前主动探测并把差异尾追进链（模型面）+ 回执（用户面），以最新为准；基线随探测前进，后续任务起点不重复告知
    const notices = this.runtime.harness.context.checkConstantsDrift();
    for (const n of notices) this.runtime.harness.context.appendChain([{ action: 'notice', observation: n }]);
    if (notices.length > 0) {
      this.pushMsg('system', t(
        `Session constants changed since the plan was drafted; the latest version applies:\n${notices.join('\n')}`,
        `计划起草后会话常量已变化，执行以最新为准：\n${notices.join('\n')}`,
      ), { level: 'warn' });
    }
    await this.runPlanItems(pending.items);
  }

  private async startPlanFlow(goal: string): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, turnChildTokens: 0, sessionTurns: this.state.metrics.sessionTurns + 1 },
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.beginTaskStats();
    this.turnMissHinted = false; // 新任务轮：轮首 miss 判定重置（观测小件）
    this.taskAbort = new AbortController();
    this.notify();
    let planText = '';
    this.planReplyNoArchive = true;
    try {
      // 规划段与执行段同链（H1）：经主链的 Loop 长任务模板。
      // 原实现是裸调 graph 角色节点——手工构造的 termination 无人读取（装饰性），
      // 且 loop → graph 会形成反向依赖；角色框定改为提示词级（依赖方向保持 graph → loop → harness）。
      // 规划段 fork 隔离：verbose 规划提示词与规划结论不进会话链（§11 边界登记——链只承载任务与执行轨迹），
      // 执行段（runPlanItems）才逐条指令行入链；角色框定保持提示词级（依赖方向 graph → loop → harness）
      const verbosePlanningPrompt = `${PLAN_TASK_LABEL} for the goal below, one step per line formatted "1. step"; output only step lines, no explanations, no code fences.\nGoal: ${goal}`;
      const r = await this.runInternalTask(verbosePlanningPrompt, PLAN_TASK_LABEL);
      if (!r.done) {
        // 用户中断（Esc/Ctrl+C）打断规划段：与主链任务同语义——中断回执+回 idle，不落 error 粘滞；
        // planReplyNoArchive 必须复位，否则中断后新任务的正文会被归档抑制位吞掉
        if (r.stopReason === 'interrupted') {
          this.planReplyNoArchive = false;
          this.pushInterruptedNotice();
          this.closeTask();
          return;
        }
        throw new Error(describeIncomplete(r.stopReason) || t('Planning incomplete', '规划未完成'));
      }
      planText = r.reply ?? '';
    } catch (e) {
      this.pushMsg('system', t('Planning failed: ', '规划失败：') + (e instanceof Error ? e.message : String(e)), { level: 'error' });
      this.closeTask();
      return;
    } finally {
      this.planReplyNoArchive = false;
    }
    const items = planText
      .split('\n')
      .map((l) => l.trim())
      .map((l) => l.replace(/^\d+[.、]\s*/, '').trim())
      .filter((l) => l.length > 0);
    if (items.length === 0) {
      this.pushMsg('system', t('No numbered steps produced (each line must be "1. xxx"), cancelled', '规划未产出编号步骤（每行需形如「1. xxx」），已取消'), { level: 'warn' });
      this.taskStats = undefined; // 失败路径不产出收尾统计行（规格 §3.2 边界）
      this.closeTask();
      return;
    }
    this.pendingPlan = { items };
    const card = [
      t('Plan confirmation (/plan)', '计划确认卡（/plan）'),
      ...items.map((item, i) => i + 1 + '. ' + item),
      t(items.length + ' items; confirm to execute step by step', '共 ' + items.length + ' 项，确认后逐项执行'),
    ].join('\n');
    this.pushMsg('system', card);
    this.state = { ...this.state, status: 'awaiting-plan' };
    this.notify();
  }

  /** 逐项执行计划：每项一个 run，完成即勾选待办（宁停不误：单项失败即暂停，剩余保持未完成） */
  private async runPlanItems(items: string[]): Promise<void> {
    this.taskAbort = new AbortController(); // plan 执行段整段一个中断源（Esc/Ctrl+C 中止当前步及后续步）
    this.state = { ...this.state, status: 'running' };
    this.setTodos(items.map((t) => ({ text: t, status: 'pending' as const })));
    this.notify();
    const ctx = this.runtime.harness.context;
    // 计划纪律走链（只增不改）：每轮只完成最后一条当前指令，不执行/预判/重排后续任务
    ctx.appendChain([{ action: 'note', observation: 'Plan discipline: each round completes only the last "Current instruction"; do not execute, anticipate, or reorder other tasks.' }]);
    for (let i = 0; i < items.length; i++) {
      this.pushMsg('step', `Step ${i + 1}/${items.length} — ${items[i]}`);
      this.state = {
        ...this.state,
        metrics: { ...this.state.metrics, turnStartedAt: Date.now() },
      };
      this.usageBase = { tokens: this.state.metrics.turnTokens, cache: this.state.metrics.turnCacheTokens, prompt: this.state.metrics.turnPromptTokens };
      this.notify();
      this.setTodos(this.state.todos.map((td) => (td.text === items[i] && td.status === 'pending' ? { ...td, status: 'in_progress' } : td)));
      ctx.appendInstructionLine(`Current instruction: ${items[i]}`);
      try {
        if (this.taskAbort?.signal.aborted) break; // 上一步被中断：不进下一 plan 步
        const r: RunOutcome = await this.runtime.runTask(items[i], {
          ...(this.state.tier ? { tier: this.state.tier } : {}),
          ...(this.state.effort ? { effort: this.state.effort } : {}),
          ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
        });
        if (r.stopReason === 'interrupted') { this.pushInterruptedNotice(); break; }
        if (!r.done) {
          this.reportIncomplete(r, 'warn');
          this.pushMsg('system', t(`Step incomplete: ${items[i]}; remaining steps paused`, `步骤未完成：${items[i]}；剩余步骤暂停`), { level: 'warn' });
          break;
        }
        this.setTodos(this.state.todos.map((td) => (td.text === items[i] ? { ...td, status: 'completed' } : td)));
        // 步骤全量轨迹与结论行已由 reactor 会话作用域自动入链（fork 模型：不再只留结论行）
        // 步骤正文已随流式管线入档（markdansi 行级 ansi 条目 + finish 收口），此处不再重复上屏（Step 切换时上一阶段正文重复的根因）
      } catch (e) {
        this.pushMsg('system', t('Step failed: ' + items[i] + ' (' + (e instanceof Error ? e.message : String(e)) + '); remaining steps paused', '步骤失败：' + items[i] + '（' + (e instanceof Error ? e.message : String(e)) + '）；剩余步骤暂停'), { level: 'error' });
        break;
      }
    }
    this.closeTask();
  }

  /** 任务收束：回 idle 并停表（turnStartedAt=0，idle 态不再显示耗时）。本轮 tokens/缓存命中保留为上一轮统计（下次提交进 running 时重置）；error 态保留现场便于回看出错时刻 */
  // ===== 会话持久化（规格 docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md）=====

  /** 会话日志单点获取：首个持久化事件建档；未建档直接返回实例（start 前事件丢弃=空会话零文件） */
  private ensureJournal(): SessionJournal {
    if (!this.journal) this.journal = new SessionJournal(resolveDataDir(this.root));
    return this.journal;
  }

  /** 快照型事件接线（规格 2026-09-22 D5）：变更点即时 log 的单点构造器，防四处拼装漂移 */
  private logModel(): void {
    this.journal?.log({ t: 'model', ...(this.state.tier ? { tier: this.state.tier } : {}), ...(this.state.effort ? { effort: this.state.effort } : {}), ...(this.state.modelId !== undefined ? { modelId: this.state.modelId } : {}) });
  }

  /** todo 清单唯一写点（规格 D6）：state 更新 + journal 即时落盘 + notify；模型工具/plan 引擎两条运行期路径共用。journal 重放为恢复路径，直接赋值不走此点（防重放自我回写） */
  private setTodos(items: TodoItem[]): void {
    this.state = { ...this.state, todos: items };
    this.logTodos();
    this.notify();
  }

  private logTodos(): void {
    this.journal?.log({ t: 'todos', items: this.state.todos });
  }

  /** 任务收口（规格 2026-09-22 D2/D8）：仅补拍本轮 write 影子快照清单（snapshots 事件）；其余事件已随产生落盘 */
  private sealJournal(): void {
    this.journal?.seal(this.runtime.harness.writeSnapshot.drain());
  }

  /** 视图两态变更记录（App 切换 Tab/Ctrl+O 调用；缓冲随收口落盘） */
  recordView(expandAll: boolean, latestFull: boolean): void {
    this.journal?.log({ t: 'view', expandAll, latestFull });
  }

  /** 恢复 UI 现场取用（entry 播种 retain 用；一次性） */
  takeRestoredUi(): { history: string[]; expandAll: boolean; latestFull: boolean } | undefined {
    const ui = this.restoredUi;
    this.restoredUi = undefined;
    return ui;
  }

  /** 输入框回填（/rewind //fork，规格 §7）：一次性取走，App 层 effect 消费；无回填时 no-op */
  takeBackfill(): string | undefined {
    const b = this.state.backfill;
    if (b !== undefined) {
      this.state = { ...this.state, backfill: undefined };
      this.notify();
    }
    return b;
  }

  /** 会话恢复选择卡（/resume 与 --resume 启动共用单点）：mtime 降序候选（排除当前在飞会话）→ askUser 挂起 → restoreFromSession */
  private async resumeFlow(): Promise<void> {
    const dataDir = resolveDataDir(this.root);
    // /resume 候选排除当前在飞会话（事件级落盘：命令输入自身即时建档，不排除会把本次命令的自建档选为最新恢复目标）
    const currentId = this.journal?.currentId;
    const sessions = listSessions(dataDir).filter((s) => s.id !== currentId);
    if (sessions.length === 0) {
      this.pushMsg('system', t('No saved sessions yet', '暂无已保存会话'), { level: 'warn' });
      return;
    }
    // >8 项切 filterable 卡（规格 D6/D8）：全量直出、渲染层筛选，一次问询直达；≤8 项维持既有循环形态不变
    if (sessions.length > 8) {
      const items = sessions.map((s) => ({ label: s.id, description: s.firstUser ? s.firstUser.slice(0, 60) : t('(no user input)', '（无用户输入）') }));
      const answer = await this.askUser({
        question: t('Resume which session? (type to filter)', '恢复哪个会话？（输入即筛选）'),
        options: items,
        filterable: true,
      });
      if (answer.type !== 'selected') {
        this.pushMsg('system', t('Resume cancelled', '已取消恢复'));
        return;
      }
      const pick = sessions.find((s) => s.id === answer.labels[0]);
      if (!pick) {
        this.pushMsg('system', t('No such session: ' + (answer.labels[0] ?? ''), '没有这个会话：' + (answer.labels[0] ?? '')), { level: 'warn' });
        return;
      }
      this.restoreFromSession(pick);
      return;
    }
    // ≤8 档全量直出（2026-09-30 翻页口径统一：滑窗自动翻页由渲染层承载，More…/Back… 循环退役）
    const answer = await this.askUser({
      question: t('Resume which session?', '恢复哪个会话？'),
      options: sessions.map((s) => ({ label: s.id, description: s.firstUser ? s.firstUser.slice(0, 60) : t('(no user input)', '（无用户输入）') })),
    });
    if (answer.type === 'dismissed') {
      this.pushMsg('system', t('Resume cancelled', '已取消恢复'));
      return;
    }
    const pickedId = answer.type === 'custom' ? answer.text.trim() : (answer.labels[0] ?? '');
    const pick = sessions.find((s) => s.id === pickedId);
    if (!pick) {
      this.pushMsg('system', t('No such session: ' + pickedId, '没有这个会话：' + pickedId), { level: 'warn' });
      return;
    }
    this.restoreFromSession(pick);
  }

  /** --continue（规格 D1/D3）：续接最近会话（listSessions mtime 降序首项，对标 CC -c）；无档提示后按新会话继续（不静默吞） */
  resumeLatest(): void {
    const dataDir = resolveDataDir(this.root);
    const meta = listSessions(dataDir)[0];
    if (!meta) {
      this.pushMsg('system', t('No saved session to continue; started a fresh one', '没有可续接的已保存会话，已开启新会话'), { level: 'warn' });
      return;
    }
    this.restoreFromSession(meta);
  }

  /** 恢复会话（规格 §6 恢复三面）：flush 当前 → 解析目标日志 → 版本守卫 → 三面直注入 → journal 续挂目标档 */
  private restoreFromSession(meta: SessionMeta): void {
    const parsed = parseJournalFile(meta.file);
    const replay = reduceJournal(parsed.events);
    if (replay.version !== 1) {
      this.pushMsg('system', t('Cannot restore this session: unsupported journal version', '无法恢复该会话：日志版本不受支持'), { level: 'error' });
      return;
    }
    // 三面还原（直注入不经 pushMsg/订阅——零重复入志、零前缀击穿）：链/压缩归 ContextManager；消息/待办/档位归控制器；UI 现场暂存供 entry 播种
    this.runtime.harness.context.restoreSession({ chain: replay.chain, chainFrom: replay.chainFrom, compacted: replay.compacted });
    this.msgSeq = replay.nextSeq;
    // 模型选择还原（/model）：档内 modelId 事件末值即目标态（undefined = 回缺省主模型，内芯一并复位）；
    // 配置漂移（id 已不在清单）保持当前不硬切、告警行随状态注入后上屏（注入前 push 会被 replay.messages 吞掉）
    let modelDriftWarn: string | undefined;
    let restoredModelId: string | undefined;
    if (this.modelSwitcher) {
      const ok = this.modelSwitcher.switchTo(replay.modelId);
      restoredModelId = this.modelSwitcher.currentId();
      if (!ok) modelDriftWarn = t(`Saved model "${replay.modelId}" is no longer in settings.json providers; keeping the current model`, `存档模型「${replay.modelId}」已不在 settings.json providers 清单，保持当前模型`);
    }
    this.state = {
      ...this.state,
      messages: replay.messages,
      todos: replay.todos,
      status: 'idle',
      ...(replay.tier !== undefined ? { tier: replay.tier } : {}),
      ...(replay.effort !== undefined ? { effort: replay.effort } : {}),
      ...(restoredModelId !== undefined
        ? { modelId: restoredModelId, modelLabel: this.modelSwitcher!.label, ...(this.modelSwitcher!.contextWindow !== undefined ? { modelWindow: this.modelSwitcher!.contextWindow } : { modelWindow: undefined }) }
        : { modelId: undefined, modelLabel: undefined, modelWindow: undefined }),
      approval: undefined,
      live: undefined,
      children: [],
    };
    this.restoredUi = { history: replay.history, expandAll: replay.view.expandAll, latestFull: replay.view.latestFull };
    this.ensureJournal().attach(meta.id);
    // 模型配置漂移告警（状态注入后上屏，防被 replay.messages 吞掉）
    if (modelDriftWarn !== undefined) this.pushMsg('system', modelDriftWarn, { level: 'warn' });
    // 横幅在状态注入后上屏（注入前 push 会被 messages 覆盖吞掉）；撕裂场景合并提示，保持「消息 + 单条提示行」
    if (parsed.truncated) {
      this.pushMsg('system', t('Session restored: ' + meta.id + ' — journal tail was truncated (previous crash?); restored up to the last complete event', '已恢复会话：' + meta.id + '（日志尾部截断，此前可能异常退出；已恢复到最后一条完整事件）'), { level: 'warn' });
    } else {
      this.pushMsg('system', t('Session restored: ' + meta.id, '已恢复会话：' + meta.id));
    }
  }

  /** /rewind //fork 共用分支流程（rewind/fork 规格 §7）：锚点选择 → 分档 → 装载 → 代码回退（可选）→ 回执 + 输入回填 */
  private async branchFlow(kind: 'rewind' | 'fork'): Promise<void> {
    const dataDir = resolveDataDir(this.root);
    const srcId = this.journal?.currentId;
    const srcFile = srcId ? path.join(sessionsDir(dataDir), srcId + '.jsonl') : undefined;
    if (!srcId || !srcFile || !fs.existsSync(srcFile)) {
      this.pushMsg('system', t(kind === 'rewind' ? 'No journaled session to rewind' : 'No journaled session to fork', kind === 'rewind' ? '当前会话没有可回退的日志' : '当前会话没有可分叉的日志'), { level: 'warn' });
      return;
    }
    const parsed = parseJournalFile(srcFile);
    const anchors = listAnchors(parsed);
    if (anchors.length === 0) {
      this.pushMsg('system', t(kind === 'rewind' ? 'No turns to rewind yet' : 'No turns to fork yet', kind === 'rewind' ? '暂无可回退的任务轮' : '暂无可分叉的任务轮'), { level: 'warn' });
      return;
    }
    const a = await this.askUser({
      question: t(kind === 'rewind' ? 'Rewind to which turn?' : 'Fork from which turn?', kind === 'rewind' ? '回退到哪一轮？' : '从哪一轮分叉？'),
      options: anchors.map((x, i) => ({
        label: String(i + 1),
        description: x.text.length > 48 ? x.text.slice(0, 48) + '…' : x.text,
      })),
    });
    if (a.type === 'dismissed') {
      this.pushMsg('system', t(kind === 'rewind' ? 'Rewind cancelled' : 'Fork cancelled', kind === 'rewind' ? '已取消回退' : '已取消分叉'));
      return;
    }
    const idx = Number.parseInt(a.type === 'custom' ? a.text.trim() : (a.labels[0] ?? ''), 10) - 1;
    const anchor = Number.isInteger(idx) && idx >= 0 && idx < anchors.length ? anchors[idx] : undefined;
    if (!anchor) {
      this.pushMsg('system', t('No such turn', '没有这一轮'), { level: 'warn' });
      return;
    }
    let codeAction = false;
    if (kind === 'rewind') {
      const hasFiles = collectRestorePlan(srcFile, anchor.line).length > 0;
      const opts = hasFiles ? ['code and conversation', 'conversation only', 'code only'] : ['conversation only'];
      const b = await this.askUser({
        question: t('What to restore?', '恢复哪些内容？'),
        options: opts.map((label) => ({ label })),
      });
      if (b.type === 'dismissed') {
        this.pushMsg('system', t('Rewind cancelled', '已取消回退'));
        return;
      }
      const picked = b.type === 'custom' ? b.text.trim() : (b.labels[0] ?? '');
      if (picked === 'code and conversation' || picked === 'code only') codeAction = true;
    } else {
      const c = await this.askUser({
        question: t('Fork a parallel session from this turn?', '从这一轮分叉出平行会话？'),
        options: [{ label: 'fork' }],
      });
      if (c.type === 'dismissed') {
        this.pushMsg('system', t('Fork cancelled', '已取消分叉'));
        return;
      }
    }
    let newId: string;
    try {
      newId = branchFrom(dataDir, srcId, anchor.line - 1, kind); // 锚点行不进新档（规格 §5.2）
    } catch (err) {
      this.pushMsg('system', t('Branch failed: ' + String((err as Error).message), '分档失败：' + String((err as Error).message)), { level: 'warn' });
      return;
    }
    // 续挂新档并切指针（不可变分档：源档零改动；事件级落盘下 restore 无收口写回面）
    this.journal?.attach(newId);
    this.restoreFromSession({ id: newId, file: path.join(sessionsDir(dataDir), newId + '.jsonl'), updatedAt: Date.now() });
    if (kind === 'rewind' && codeAction) {
      const plan = collectRestorePlan(srcFile, anchor.line); // 以分支前源档收集（规格 §6.2）
      const r = applyRestorePlan(this.root, plan, path.join(dataDir, 'sessions', '_blobs'));
      const parts = [
        r.restored.length > 0 ? `${r.restored.length} restored` : '',
        r.removed.length > 0 ? `${r.removed.length} removed` : '',
        r.skipped.length > 0 ? `${r.skipped.length} skipped` : '',
      ].filter(Boolean).join(', ');
      this.pushMsg('system', t('Code restored to turn start (' + parts + ')', '代码已回退到该轮起点（' + parts + '）'), r.skipped.length > 0 ? { level: 'warn' } : undefined);
    }
    const anchorIdx = anchors.indexOf(anchor) + 1;
    if (kind === 'rewind') {
      this.pushMsg('system', t(`Rewound to turn ${anchorIdx} — previous timeline kept, /resume to return`, `已回退到第 ${anchorIdx} 轮——原时间线保留，/resume 可回`));
    } else {
      this.pushMsg('system', t(`Forked new session from turn ${anchorIdx} — source session kept`, `已从第 ${anchorIdx} 轮分叉出新会话——源会话保留`));
    }
    this.state = { ...this.state, backfill: anchor.text }; // 锚点轮输入回填（重发经正常任务提交进链）
    this.notify();
  }

  /** 退出清理（规格 §3.5）：清空闲兜底节拍定时器——防长驻进程重挂/多实例测试下定时器累积（评审 Important-1）；幂等 */
  dispose(): void {
    if (this.kickTimer !== undefined) clearInterval(this.kickTimer);
    this.kickTimer = undefined;
    // MCP 连接收口：关闭 stdio 子进程防悬挂（fire-and-forget，退出路径零阻塞）
    void this.runtime.harness.mcpClose();
  }

  /** 未回程调用补入档单点（CC 模式延迟入档的兜底）：任务收尾/中断时挂起调用降级定格——
   *  调用行单独入档退出 pending（无结果行），产出不蒸发；正常回程路径不经此点 */
  private flushPendingCalls(): void {
    if (this.pendingCalls.length === 0) return;
    const flushed: ChatItem[] = this.pendingCalls.map((p) => ({
      role: 'tool', text: p.text, ts: Date.now(), seq: ++this.msgSeq,
      kind: 'call', pending: false, callId: p.callId,
    }));
    this.pendingCalls = [];
    this.appendMessages(flushed);
  }

  private closeTask(): void {
    if (this.state.status !== 'running' && this.state.status !== 'awaiting-plan') return;
    this.flushPendingCalls();
    this.taskAbort = undefined;
    // 任务收尾统计行（规格 2026-09-26-stats-enhancement §3.2）：done 正常完成路径产出（基线差值，含子代理合并口径）；中断经抑制位跳过；error 态不走 closeTask
    if (this.taskStats && !this.taskStatsSuppressed) {
      const ts = this.taskStats;
      const m = this.state.metrics;
      const mainTokens = Math.max(0, m.turnTokens - ts.startTokens);
      const childTokens = Math.max(0, m.sessionChildTokens - ts.startChildTokens);
      this.pushMsg('system', formatTaskStatsLine(Math.round((Date.now() - ts.startedAt) / 1000), m.sessionSteps - ts.startSteps, mainTokens + childTokens, childTokens));
    }
    this.taskStats = undefined;
    this.state = {
      ...this.state,
      status: 'idle',
      metrics: { ...this.state.metrics, turnStartedAt: 0 },
      // 暂停确认卡随状态出口清除（2026-10-02 状态卫生）：挂卡期任务自然收尾不清即残留——空闲态
      // Ctrl+C 被 App「第二次确认」分支吞掉成死键（interrupt() 非 active 不清卡即 return）
      pauseConfirm: undefined,
      // 生命周期清理（规格 §4.4）：运行中子代理（后台两段式）跨回合保留，done 归档收口；
      // 生命周期清理（规格 §4.4）：已归档者本已离场；运行中子代理（后台两段式）跨回合保留，done 归档收口
      children: this.state.children.filter((c) => !c.done),
    };
    this.childBufs.clear();
    // 待归档锚点全保留（archiveChild 统一回队：栈中条目要么已配对消费、要么等 done 收口，无第三态）
    this.sealJournal(); // 快照清单补拍（事件级：其余事件已随产生落盘，规格 2026-09-22 D2/D8）
    this.runtime.harness.pipeline.kick(); // 回 idle 即踢一次后台消化（规格 §3.5）：队列非空才消费、无待办零调用
    this.notify();
  }

  /** 内部 verbose 任务（/init）：fork 隔离执行——提示词不进会话链（§11 边界登记），终态零主链回写 */
  private async runInternalTask(prompt: string, label: string): Promise<RunOutcome> {
    const ctx = this.runtime.harness.context;
    const base = ctx.chainView();
    return this.runtime.runTask(label, {
      scope: 'fork',
      seedHistory: [...base, { step: (base.length > 0 ? base[base.length - 1].step : 0) + 1, action: 'task', observation: prompt }],
      ...(this.state.tier ? { tier: this.state.tier } : {}),
      ...(this.state.effort ? { effort: this.state.effort } : {}),
      ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
    });
  }

  /** 未完成终止提示上屏（D10 收敛）：describeIncomplete 非空即以 system 消息推送；done/model-error 为空串天然跳过 */
  private reportIncomplete(r: RunOutcome, level?: 'warn'): void {
    const note = describeIncomplete(r.stopReason);
    if (note.length > 0) this.pushMsg('system', note, level ? { level } : undefined);
  }

  private async runTaskFlow(goal: string, opts?: { forkInstruction?: string }): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, turnChildTokens: 0, sessionTurns: this.state.metrics.sessionTurns + 1 },
      live: undefined,
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.beginTaskStats();
    this.turnMissHinted = false; // 新任务轮：轮首 miss 判定重置（观测小件）
    this.taskAbort = new AbortController();
    this.notify();
    // MCP 降级警告上屏（warn 级系统消息）：服务器失败只损失该服务器工具，任务不阻断
    for (const w of this.runtime.harness.mcpWarnings()) {
      this.pushMsg('system', t(`MCP warning: ${w}`, `MCP 警告：${w}`), { level: 'warn' });
    }
    try {
      const ctx = this.runtime.harness.context;
      if (opts?.forkInstruction) {
        // 内部 verbose 任务（/init 等）：fork 隔离——提示词经 fork 尾追承载、不进会话链（防污染对话流）
        const base = ctx.chainView();
        const r = await this.runtime.runTask(goal, {
          scope: 'fork',
          seedHistory: [...base, { step: (base.length > 0 ? base[base.length - 1].step : 0) + 1, action: 'task', observation: opts.forkInstruction }],
          ...(this.state.tier ? { tier: this.state.tier } : {}),
          ...(this.state.effort ? { effort: this.state.effort } : {}),
          ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
        });
        if (r.stopReason === 'interrupted') this.pushInterruptedNotice();
        this.reportIncomplete(r, 'warn');
        this.closeTask();
        return;
      }
      // 主链任务（§11 只增不改）：当前指令行尾追进链，reactor 会话作用域收束自动回写全量步骤与结论/补丁行
      ctx.appendInstructionLine(`Current instruction: ${goal}`);
      const r = await this.runtime.runTask(goal, {
        ...(this.state.tier ? { tier: this.state.tier } : {}),
        ...(this.state.effort ? { effort: this.state.effort } : {}),
        ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
      });
      if (r.stopReason === 'interrupted') this.pushInterruptedNotice();
      this.reportIncomplete(r, 'warn');
      this.closeTask();
    } catch (e) {
      this.pushMsg('system', t(`Error: ${e instanceof Error ? e.message : String(e)}`, `发生错误：${e instanceof Error ? e.message : String(e)}`), { level: 'error' });
      this.state = { ...this.state, status: 'error', pauseConfirm: undefined }; // 同 closeTask 状态出口清卡
      this.notify();
      return; // error 态保留计时现场（sticky），下次提交进 running 时重置
    }
  }

  /** /goal 完整修正环（规格 2026-09-15-tui-goal D2/D3 + 2026-09-16-goal-template D2/D5）：模板为内部装配机制，用户面零暴露；
   *  任务行入链带 /goal 标注 → runLoop（缺省标准环）→ 终态回执（status/iterations/criteria/tokens）→ closeTask。
   *  异常路径同 runTaskFlow 切 error 粘滞（保留现场）；已入链任务行不回滚（append-only，失败以链上轨迹为准） */
  private async runGoalFlow(goal: string): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, turnChildTokens: 0, sessionTurns: this.state.metrics.sessionTurns + 1 },
      live: undefined,
    };
    this.usageBase = { tokens: 0, cache: 0, prompt: 0 };
    this.beginTaskStats();
    this.turnMissHinted = false; // 新任务轮：轮首 miss 判定重置（观测小件）
    this.taskAbort = new AbortController();
    this.notify();
    try {
      this.runtime.harness.context.appendInstructionLine(`Current instruction: ${goal} (/goal)`);
      this.pushMsg('system', t(`✻ /goal: ${goal}`, `✻ /goal：${goal}`));
      const r = await this.runtime.runLoop(goal, {
        ...(this.state.tier ? { tier: this.state.tier } : {}),
        ...(this.state.effort ? { effort: this.state.effort } : {}),
        ...(this.taskAbort ? { signal: this.taskAbort.signal } : {}),
      });
      // interrupted 的用户回执由下方 incomplete 分支承载（引擎 error 已含中断文案），不重复发
      const lines = (r.criteria ?? []).map((c) => `  ${c.passed ? '✓' : '✗'} ${c.id} ${c.desc}`);
      if (r.status === 'done') {
        this.pushMsg('system', [
          t(
            `✻ /goal done: ${r.iterations} iteration(s) · ${r.tokensUsed} tokens`,
            `✻ /goal 完成：${r.iterations} 轮 · ${r.tokensUsed} tokens`,
          ),
          ...lines,
        ].join('\n'));
      } else {
        this.pushMsg('system', [
          t(
            `✻ /goal incomplete: ${r.status}${r.error ? ` — ${r.error}` : ''}`,
            `✻ /goal 未完成：${r.status}${r.error ? ` — ${r.error}` : ''}`,
          ),
          ...(r.status === 'paused'
            ? [t('Run /goal again to continue (the session chain keeps the context)', '重跑 /goal 可续走（会话链保留上下文）')]
            : []),
          ...lines,
          describeIncomplete(r.stopReason),
        ].filter((l) => l.length > 0).join('\n'));
      }
      this.closeTask();
    } catch (e) {
      this.pushMsg('system', t(`Error: ${e instanceof Error ? e.message : String(e)}`, `发生错误：${e instanceof Error ? e.message : String(e)}`), { level: 'error' });
      this.state = { ...this.state, status: 'error', pauseConfirm: undefined }; // 同 closeTask 状态出口清卡
      this.notify();
      return;
    }
  }

  /** 待投递穿插行数（TUI 队列展示/撤回判定用） */
  steeringPending(): number {
    return this.runtime.harness.steering.pending();
  }

  /** 撤回取回（对标 CC Up 键取回队列）：取走全部未投递穿插行（按入队序）；App 层回填输入框逐行编辑或清空丢弃 */
  takeBackQueued(): string[] {
    return this.runtime.harness.steering.takePending();
  }

  /** 运行中穿插收口兜底（对标 CC「turn 结束仍有排队→最旧者作下一轮」）：未被步边界消费的行按入队序补跑为新任务 */
  private async drainQueue(): Promise<void> {
    for (const line of this.runtime.harness.steering.takePending()) {
      await this.runTaskFlow(line);
    }
  }

  /** 斜杠命令分发面：命令只认裸形式（规格 D2），选择卡经 askUser 挂起回填 */
  private async handleSlash(text: string): Promise<void> {
    const cmd = text.split(/\s+/)[0] ?? text;
    // 命令只认裸形式（规格 D2）：一切带参枚举形态与不在清单的命令词统一无法识别；
    // 自由文本参数命令（目标/关注点/记忆内容/目录路径）不在枚举范围，带参放行
    const FREE_TEXT_ARGS = new Set(['/compact', '/plan', '/goal', '/memory-add', '/add-dir', '/kb-index']);
    // 技能命令（规格 2026-09-22-skill-as-command D4）：意图尾参为自由文本，与 FREE_TEXT_ARGS 同豁免；命中与否由尾部技能分发面裁决
    const isSkillCommand = this.skillCommandIds().includes(cmd.slice(1));
    if (!FREE_TEXT_ARGS.has(cmd) && !isSkillCommand && text !== cmd) {
      this.pushMsg('system', t('Unrecognized command. Use /help to see available commands', '无法识别命令，使用 /help 查看使用方法'), { level: 'warn' });
      return;
    }
    if (cmd === '/help') {
      this.pushMsg('system', slashHelp().join('\n'));
      return;
    }
    if (cmd === '/init') {
      // Claude Code /init 同款模型驱动：发起真实分析任务，模型自行 read/ls/grep 感知代码库并 write 生成/完善 SUNSHINE.md；
      // 写盘经安全链（manual 模式经 asker 审批），装载走 ContextLoader 每轮 assemble 从磁盘读取，写盘即对后续轮次生效
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /init unavailable now', '当前有任务进行中，暂不能执行 /init'), { level: 'warn' });
        return;
      }
      const p = path.join(this.root, 'SUNSHINE.md');
      const existed = fs.existsSync(p);
      // 提示词属内部实现不上屏，仅一行启动提示；分析过程经工具实时流可见；fork 隔离——verbose 提示词不进会话链
      this.pushMsg('system', existed ? t('/init: analyzing project, updating SUNSHINE.md…', '/init：分析项目，完善 SUNSHINE.md…') : t('/init: analyzing project, generating SUNSHINE.md…', '/init：分析项目，生成 SUNSHINE.md…'));
      await this.runTaskFlow(t('/init: analyze project and write SUNSHINE.md', '/init：分析项目并写入 SUNSHINE.md'), { forkInstruction: sunshineInitGoal(this.root, existed) });
      // 回执只按落盘事实（模型经安全链 write；任务中断时不虚报成功）
      const written = fs.existsSync(p);
      if (written) {
        // G 项刷新点：/init 是显式写盘者——重载快照使新内容立即可见（其余中途改盘仍冻结）
        this.runtime.harness.context.reloadContext();
        this.pushMsg('system', existed ? t('SUNSHINE.md written (updated); reloaded into session context', '已写入 SUNSHINE.md（完善）：已重载入会话上下文') : t('SUNSHINE.md written (created); loaded into session context', '已写入 SUNSHINE.md（新建）：已载入会话上下文'));
      } else {
        this.pushMsg('system', t('SUNSHINE.md not written: task incomplete, rerun /init', 'SUNSHINE.md 未生成：任务未完成，可重新执行 /init'), { level: 'warn' });
      }
      return;
    }
    if (cmd === '/status') {
      const s = this.runtime.harness.ledger.summary();
      this.pushMsg('system', t(`Ledger: ${s.runs} runs / ${s.tokens} tokens; messages: ${this.state.messages.length}; todos: ${this.state.todos.length}`, `账本：${s.runs} runs / ${s.tokens} tokens；消息 ${this.state.messages.length} 条；待办 ${this.state.todos.length} 项`));
      return;
    }
    if (cmd === '/terminal-setup') {
      // Shift+Enter 换行键的终端侧一次性配置（CC /terminal-setup 同款自动化）：终端缺省 Shift+Enter
      // 与 Enter 同发 \r 不可区分，运行时只认 \x1b\r——此处把 WT 键位写好（绑定 + Alt+Enter 解绑）
      const existing = wtSettingsCandidates().filter((p) => fs.existsSync(p));
      if (existing.length === 0) {
        this.pushMsg('system', t(
          'Windows Terminal settings.json not found. VSCode: keybindings.json add {"key":"shift+enter","command":"workbench.action.terminal.sendSequence","when":"terminalFocus","args":{"text":"\\u001b\\r"}}',
          '未找到 Windows Terminal settings.json。VSCode：keybindings.json 加 {"key":"shift+enter","command":"workbench.action.terminal.sendSequence","when":"terminalFocus","args":{"text":"\\u001b\\r"}}',
        ), { level: 'warn' });
        return;
      }
      const lines: string[] = [t('Terminal setup (Shift+Enter newline):', '终端设置（Shift+Enter 换行）：')];
      for (const p of existing) {
        const r = configureWindowsTerminal(p);
        if (!r.ok) lines.push(t(`✗ ${p}: ${r.message}`, `✗ ${p}：${r.message}`));
        else if (r.changed) lines.push(t(`✓ ${p}\n  backup: ${r.backup}\n  restart Windows Terminal to take effect`, `✓ ${p}\n  备份：${r.backup}\n  重启 Windows Terminal 后生效`));
        else lines.push(t(`✓ ${p}: already configured`, `✓ ${p}：已配置，无需改动`));
      }
      this.pushMsg('system', lines.join('\n'));
      return;
    }
    if (cmd === '/add-dir') {
      const arg = text.slice(cmd.length).trim();
      if (arg === '') {
        this.pushMsg('system', t('/add-dir requires a directory path', '/add-dir 需要目录路径'), { level: 'error' });
        return;
      }
      const r = this.runtime.harness.addAdditionalDir(arg);
      this.pushMsg('system', r.ok
        ? t(`trusted directory added: ${r.message}`, `信任目录已添加：${r.message}`)
        : t(`failed to add directory: ${r.message}`, `信任目录添加失败：${r.message}`), r.ok ? undefined : { level: 'error' });
      return;
    }
    if (cmd === '/tasks') {
      // 后台任务表（规格 D7，对标 CC /tasks）：id/kind/status/label + 输出路径；模型可 read 查看输出、task_wait 等待到终态、task_stop 停止
      const list = this.runtime.harness.tasks.list();
      if (list.length === 0) {
        this.pushMsg('system', t('No background tasks.', '暂无后台任务。'));
        return;
      }
      const rows = list.map((x) => `${x.id}\t${x.kind}\t${x.status}\t${x.label}\t(output: ${x.outputFilePath})`);
      this.pushMsg('system', t(
        `Background tasks:\n${rows.join('\n')}\nInspect output with read; wait for completion with the task_wait tool; stop with the task_stop tool.`,
        `后台任务：\n${rows.join('\n')}\n输出可用 read 查看；可用 task_wait 工具等待到终态；可用 task_stop 工具停止。`,
      ));
      return;
    }
    if (cmd === '/skill') {
      // 技能选择卡（规格 D1/D5）：裸形式、单选选定即链尾追加载；带参形态由裸形式守卫统一无法识别
      await this.skillFlow();
      return;
    }
    if (cmd === '/new') {
      // /new 轮转化（规格 D2）：旧会话收口归档 → 换新 sessionId（header 立即落盘、指针随即改指新会话）→ 软重置；旧档 /resume 可找回
      this.journal?.rotate(newSessionId());
      this.runtime.harness.security.clearSessionAllows();
      this.memoryOverride = undefined;
      setMemorySessionOverride(undefined); // /new = 新会话起点：会话内覆盖清除（快照重读随刷新点对齐磁盘与控制面）
      this.taskStats = undefined; // 新会话起点：任务统计基线一并清除
      this.mdClear();
      this.state = {
        messages: [],
        todos: [],
        status: 'idle',
        metrics: {
          turnStartedAt: 0,
          turnTokens: 0,
          turnCacheTokens: 0,
          turnPromptTokens: 0,
          ctxUsed: 0,
          runs: this.state.metrics.runs,
          sessionCacheTokens: 0,
          sessionPromptTokens: 0,
          sessionTurns: 0,
          sessionSteps: 0,
          turnChildTokens: 0,
          sessionChildTokens: 0,
          sessionTotalTokens: 0,
        },
        children: [],
        task: initialTaskState(),
        ...(this.state.tier ? { tier: this.state.tier } : {}),
        ...(this.state.modelId !== undefined ? { modelId: this.state.modelId, modelLabel: this.state.modelLabel, modelWindow: this.state.modelWindow } : {}),
        live: undefined,
      };
      this.childBufs.clear();
      this.childPrompts.clear();
      this.spawnCalls = [];
      this.pendingCalls = [];
      this.runtime.harness.context.resetSession();
      this.pushMsg('system', t('Soft reset: messages, todos, session chain and compacted summary cleared; session approvals cleared (memory & ledger kept)', '软重置：消息、待办、会话链与压缩摘要已清空，会话级审批登记已清除（记忆与账本保留）'));
      return;
    }
    if (cmd === '/model') {
      // 多源多模型切换（settings providers 键）：选择卡即选即切，对后续任务生效（整场恒定，CLAUDE.md §11 重算事件口径）
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /model unavailable now', '当前有任务进行中，暂不能执行 /model'), { level: 'warn' });
        return;
      }
      const sw = this.modelSwitcher;
      if (!sw || sw.choices().length === 0) {
        this.pushMsg('system', t(
          'No switchable models: add a "providers" array to settings.json (each entry: name + baseUrl + models), then restart',
          '无可切换模型：在 settings.json 增加 "providers" 数组（每项 name + baseUrl + models）后重启',
        ), { level: 'warn' });
        return;
      }
      const current = sw.currentId();
      const options = [
        // default 仅在主模型显式配置（model 键 / SUNSHINEX_MODEL）时露出：未配置时缺省内芯本就是首个 provider 模型
        ...(sw.hasExplicitDefault() ? [{ label: 'default', description: current === undefined ? t('current (main model)', '当前（主模型）') : undefined }] : []),
        ...sw.choices().map((c) => ({
          label: c.id,
          description: c.id === current
            ? t('current', '当前')
            : [c.baseUrl, c.contextWindow !== undefined ? formatTokens(c.contextWindow) : undefined, c.reasoningEffort !== undefined ? `effort ${c.reasoningEffort}` : undefined].filter((x) => x !== undefined).join(' · '),
        })),
      ];
      const answer = await this.askUser({
        question: t(current ? `Switch model (current: ${current})` : 'Switch model (current: main model)', current ? `切换模型（当前 ${current}）` : '切换模型（当前主模型）'),
        options,
      });
      if (answer.type !== 'selected') {
        this.pushMsg('system', t('Model unchanged', '模型未变更'));
        return;
      }
      const picked = answer.labels[0] ?? '';
      if (picked === 'default') {
        sw.switchTo(undefined);
        this.state = { ...this.state, modelId: undefined, modelLabel: undefined, modelWindow: undefined };
        this.notify();
        this.logModel();
        this.pushMsg('system', t('Model cleared; the main model applies to subsequent tasks', '模型已清除；后续任务用主模型'));
        return;
      }
      if (!sw.switchTo(picked)) return; // 选择卡来源即清单，正常不可达；防御配置漂移
      this.state = { ...this.state, modelId: picked, modelLabel: sw.label, ...(sw.contextWindow !== undefined ? { modelWindow: sw.contextWindow } : { modelWindow: undefined }) };
      this.notify();
      this.logModel();
      this.pushMsg('system', t(`Model set to ${picked}; applies to subsequent tasks`, `模型已设为 ${picked}；对后续任务生效`));
      return;
    }
    if (cmd === '/model-tier') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /model-tier unavailable now', '当前有任务进行中，暂不能执行 /model-tier'), { level: 'warn' });
        return;
      }
      const current = this.state.tier;
      const answer = await this.askUser({
        question: t(current ? `Switch model tier (current: ${current})` : 'Switch model tier (current: default)', current ? `切换模型档位（当前 ${current}）` : '切换模型档位（当前默认）'),
        options: (['small', 'medium', 'large'] as const).map((tier) => ({ label: tier, description: tier === current ? t('current', '当前档') : undefined })),
      });
      if (answer.type !== 'selected') {
        this.pushMsg('system', t('Model tier unchanged', '模型档位未变更'));
        return;
      }
      const tier = parseTier(answer.labels[0] ?? '');
      if (!tier) return;
      this.state = { ...this.state, tier };
      this.notify();
      this.logModel();
      this.pushMsg('system', t(`Model tier set to ${tier}; applies to subsequent tasks`, `模型档位已设为 ${tier}；对后续任务生效`));
      return;
    }
    if (cmd === '/model-effort') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /model-effort unavailable now', '当前有任务进行中，暂不能执行 /model-effort'), { level: 'warn' });
        return;
      }
      const current = this.state.effort;
      const answer = await this.askUser({
        question: t(current ? `Switch reasoning effort (current: ${current})` : 'Switch reasoning effort (current: adapter default)', current ? `切换思考强度（当前 ${current}）` : '切换思考强度（当前适配器缺省）'),
        options: [...EFFORT_ORDER, 'default' as const].map((v) => ({ label: v, description: v === current ? t('current override', '当前覆盖') : undefined })),
      });
      if (answer.type !== 'selected') {
        this.pushMsg('system', t('Reasoning effort unchanged', '思考强度未变更'));
        return;
      }
      const value = answer.labels[0] ?? '';
      if (value === 'default') {
        this.state = { ...this.state, effort: undefined };
        this.notify();
        this.logModel();
        this.pushMsg('system', t('Reasoning effort cleared; adapter default applies to subsequent tasks', '思考强度已清除；后续任务回适配器缺省'));
        return;
      }
      const effort = parseEffort(value);
      if (!effort) return;
      this.state = { ...this.state, effort };
      this.notify();
      this.logModel();
      // 回执回显实际生效档（规格 §5.2）：端点不支持时探测降级，取 adapter 探测缓存；接口未实现/未探测时与请求档一致
      const resolved = this.runtime.harness.model.resolvedEffort?.(effort) ?? effort;
      this.pushMsg('system', t(`Reasoning effort set to ${resolved}; applies to subsequent tasks`, `思考强度已设为 ${resolved}；对后续任务生效`));
      return;
    }
    if (cmd === '/resume') {
      // 恢复入口（规格 §6/D6）：无参选择卡（mtime 降序 + 首条输入摘要）；>8 条 filterable 全量卡（筛选在渲染层）；翻页统一渲染层滑窗（2026-09-30 口径）
      // 带参形态已由裸形式守卫统一无法识别——此处只认无参
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /resume unavailable now', '当前有任务进行中，暂不能执行 /resume'), { level: 'warn' });
        return;
      }
      await this.resumeFlow();
      return;
    }
    if (cmd === '/rewind' || cmd === '/fork') {
      // 会话回退/分叉（rewind/fork 规格 §7）：idle 守卫沿 /resume 先例，运行中拒绝
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; ' + cmd + ' unavailable now', '当前有任务进行中，暂不能执行 ' + cmd), { level: 'warn' });
        return;
      }
      await this.branchFlow(cmd === '/rewind' ? 'rewind' : 'fork');
      return;
    }
    if (cmd === '/compact') {
      // 压缩协调单点（与 Reactor 自动压缩同链路，规格 D5）：补链参与（chainView 转 history 条目）→ 压缩 → 摘要（会话模型，失败回退）→ 折链
      const ctx = this.runtime.harness.context;
      const chainItems = chainToHistoryItems(ctx.chainView());
      const items = ctx.assemble(chainItems);
      const before = ctx.window.estimate(items).used;
      const focus = text.trim().split(/\s+/).slice(1).join(' ').trim();
      const r = await runCompaction(ctx, items, {
        summaryTokenBudget: 2000,
        rereadTokenBudget: 2000,
        chainFoldedCount: chainItems.length,
        summaryModel: this.runtime.harness.model,
        ...(focus.length > 0 ? { focus } : {}),
      });
      const after = ctx.window.estimate(ctx.assemble()).used;
      this.state = { ...this.state, metrics: { ...this.state.metrics, ctxUsed: after } };
      this.pushMsg('system', t(`Compressed: ${r.chunks.length} summary chunks re-injected (ctx ${before} → ${after} tokens)`, `已压缩：${r.chunks.length} 个摘要块重注入（水位 ${before} → ${after} tokens）`));
      return;
    }
    if (cmd === '/context') {
      // 上下文构成观测（只读零副作用）：分段与 buildMessages 消息面同构（稳定段+快照三段+压缩块+链+技能块），
      // 窗口分母与 Reactor 压缩判定同源；技能块走 peek 不消费、不经 assemble、不写链——观测不改变被观测面
      const ctx = this.runtime.harness.context;
      const parts = ctx.snapshotPartsView();
      const b = contextBreakdown({
        stableSegment: this.runtime.harness.reactor.stableSegment(),
        instructions: parts.instructions,
        skills: parts.skills,
        memory: parts.memory,
        compacted: ctx.compactedView(),
        chain: ctx.chainView(),
        skill: ctx.peekSkill(),
        window: resolveRunWindow(this.runtime.harness.model),
        chainFrom: ctx.chainFromView(),
      });
      this.pushMsg('system', formatContextBreakdown(b));
      return;
    }
    if (cmd === '/plan') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; planning unavailable now', '当前有任务进行中，暂不能开始规划'), { level: 'warn' });
        return;
      }
      const goal = text.slice(cmd.length).trim();
      if (!goal) {
        this.pushMsg('system', t('Usage: /plan <goal> — plan numbered steps first, confirm, then execute step by step', '用法：/plan <目标>——先规划产出编号步骤，确认后逐项执行'), { level: 'warn' });
        return;
      }
      await this.startPlanFlow(goal);
      return;
    }
    if (cmd === '/goal') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /goal unavailable now', '当前有任务进行中，暂不能执行 /goal'), { level: 'warn' });
        return;
      }
      // 模板为内部装配机制（规格 2026-09-16-goal-template D1/D5）：/goal 后一切即目标文本，恒走缺省标准环
      const goal = text.slice(cmd.length).trim();
      if (!goal) {
        this.pushMsg('system', t(
          'Usage: /goal <goal> — runs the verify-fix loop until your condition is met; state the goal as one measurable end state (e.g. /goal all tests in src/auth pass), or embed multiple criteria inline (验收标准：t1=…)',
          '用法：/goal <目标>——运行验收修正环，直至目标条件满足；目标用一句可度量的终态描述（如 /goal src/auth 测试全绿），复杂目标可内嵌多判据（验收标准：t1=…）',
        ), { level: 'warn' });
        return;
      }
      await this.runGoalFlow(goal);
      return;
    }
    if (cmd === '/memory') return this.memoryList();
    if (cmd === '/memory-add') return this.memoryAdd(text.slice(cmd.length).trim());
    if (cmd === '/memory-rm') return this.memoryRm();
    if (cmd === '/memory-gc') return this.memoryGc();
    if (cmd === '/kb-index') return this.kbIndex(text.slice(cmd.length).trim());
    if (cmd === '/memory-on' || cmd === '/memory-off') {
      const on = cmd === '/memory-on';
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t(`A task is running; ${cmd} unavailable now`, `当前有任务进行中，暂不能执行 ${cmd}`), { level: 'warn' });
        return;
      }
      this.memoryOverride = on;
      setMemorySessionOverride(on); // 会话内覆盖单点：提取/注入/写闸门逐次判门读取（§7 控制面）
      this.pushMsg('system', t(`Persistent memory ${on ? 'on' : 'off'} for this session (persist with the SUNSHINEX_AUTO_MEMORY env var)`, `本会话持久记忆已${on ? '开启' : '关闭'}（持久化请设环境变量 SUNSHINEX_AUTO_MEMORY）`));
      return;
    }
    // 技能命令分发（规格 2026-09-22-skill-as-command D2–D5）：内置命令全部落空后查注册表（内置优先 D1——撞名技能不注册，此处天然不可达）
    if (this.skillCommandIds().includes(cmd.slice(1))) {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t(`A task is running; ${cmd} unavailable now`, `当前有任务进行中，暂不能执行 ${cmd}`), { level: 'warn' });
        return;
      }
      const loaded = this.loadSkill(cmd.slice(1));
      const intent = text.slice(cmd.length).trim();
      // D4：确定性加载成功后意图原样派发标准环（与 /goal 同款解析）；裸形式无意图止于加载（D3）；failed 不派发
      if (loaded !== 'failed' && intent) await this.runTaskFlow(intent);
      return;
    }
    this.pushMsg('system', t('Unrecognized command. Use /help to see available commands', '无法识别命令，使用 /help 查看使用方法'), { level: 'warn' });
  }

  /** 技能命令注册表（规格 2026-09-22-skill-as-command D6 单点）：list() 现读磁盘（学习沉淀即时可见）；
   *  按 D2 字符集过滤、D1 内置词排除（内置优先——撞名技能不注册，仅可经 /skill 卡加载），id 字典序 */
  skillCommandIds(): string[] {
    return this.skillManifestsForCommands().map((m) => m.id).sort();
  }

  /** 命令面技能清单共用过滤（D1/D2 单点）：字符集合法 + 撞名内置词排除；skillCommandIds 与
   *  skillMenuEntries 同源消费，防两清单漂移 */
  private skillManifestsForCommands() {
    const builtin = new Set(SLASH_COMMANDS.map((c) => c.slice(1)));
    return this.runtime.harness.skills.list().filter((m) => /^[a-z0-9][a-z0-9_-]*$/.test(m.id) && !builtin.has(m.id));
  }

  /** 纵向命令面板技能源（2026-09-30 对标 CC）：清单口径与 skillCommandIds 同源，附 name/description
   *  与最近使用时间——最近使用在前（用户裁决「skills 默认显示最近常用的」）、平局回落数字典序；
   *  调用方（App）挂载 + 回合边界刷新，不逐键读盘 */
  skillMenuEntries(): { id: string; name: string; description: string; lastUsedAt?: number }[] {
    const usage = readSkillUsage(this.root);
    return this.skillManifestsForCommands()
      .map((m) => ({ id: m.id, name: m.name, description: m.description, lastUsedAt: usage[m.id] }))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 技能加载单点（规格 D3，自 skillFlow 尾段提取）：链上去重 → resolve → 链尾追持久注入 → 回执；
   *  /skill 选择卡与 /<技能id> 命令同源消费；failed 不派发后续任务（D4）；
   *  成功/去重两径记录最近使用（2026-09-30 纵向命令面板排序源），failed 不记 */
  private loadSkill(id: string): 'loaded' | 'already' | 'failed' {
    if (this.runtime.harness.context.chainView().some((s) => s.action === 'skill' && s.observation.includes(`(id=${id} v=`))) {
      this.pushMsg('system', t(`Skill ${id} already loaded in this session`, `技能 ${id} 本会话已加载`));
      recordSkillUsage(this.root, id);
      return 'already';
    }
    const r = this.runtime.harness.skills.resolve(id);
    if (!r.ok) {
      this.pushMsg('system', t(`Skill load failed: ${r.error.message}`, `技能加载失败：${r.error.message}`), { level: 'warn' });
      return 'failed';
    }
    const m = r.value.manifest;
    // 链尾追持久注入（先例 D2）：头行对齐 loop skillRef 既有格式，正文随后续每帧经链携带
    this.runtime.harness.context.appendChain([{ action: 'skill', observation: `${skillHeader(m)}\n\n${r.value.body}` }]);
    this.pushMsg('system', t(`Skill loaded: ${m.name} (id=${m.id}) — included in context for subsequent tasks`, `技能已加载：${m.name}（id=${m.id}）——随后续任务进上下文`));
    recordSkillUsage(this.root, id);
    return 'loaded';
  }

  /** /memory：无参列索引（查看态） */
  private memoryList(): void {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /memory unavailable now', '当前有任务进行中，暂不能执行 /memory'), { level: 'warn' });
      return;
    }
    const store = new MemoryStore(this.root);
    const records = store.list();
    const capacity = store.capacityNotice();
    if (records.length === 0) {
      this.pushMsg('system', [t('No memories yet — /memory-add <text> to add one', '暂无记忆——用 /memory-add <内容> 添加一条'), this.memoryStateLine(), ...(capacity ? [capacity] : [])].join('\n'));
      return;
    }
    const lines = records.map((r) => `- ${r.slug} [${r.type}] (${r.created}) ${r.description}`);
    this.pushMsg('system', [t(`Persistent memories (${records.length}):`, `持久记忆（${records.length} 条）：`), ...lines, this.memoryStateLine(), ...(capacity ? [capacity] : [])].join('\n'));
  }

  /** /memory-add：自由文本内容写入（与自动提取同一写时闸门）；空内容按规格 D2 落统一无法识别文案 */
  private memoryAdd(rest: string): void {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /memory-add unavailable now', '当前有任务进行中，暂不能执行 /memory-add'), { level: 'warn' });
      return;
    }
    if (!rest) {
      this.pushMsg('system', t('Unrecognized command. Use /help to see available commands', '无法识别命令，使用 /help 查看使用方法'), { level: 'warn' });
      return;
    }
    const store = new MemoryStore(this.root);
    const flagged = scanMemoryText(rest);
    if (flagged) {
      this.pushMsg('system', t(`Rejected: session-scoped or unsafe content (${flagged}); not persisted`, `已拒绝：会话性内容或含注入特征（${flagged}），不落盘`), { level: 'warn' });
      return;
    }
    const r = store.add({ type: 'project', description: rest, body: rest });
    if (r.ok) {
      this.pushMsg('system', t(`Added memory: ${r.value.slug} (applies from the next session or refresh point)`, `已添加记忆：${r.value.slug}（下个会话或刷新点生效）`));
    } else if (r.error.code === 'MEMORY_DUPLICATE') {
      this.pushMsg('system', t(`Duplicate memory rejected: ${rest}`, `重复记忆已拒绝：${rest}`), { level: 'warn' });
    } else {
      this.pushMsg('system', r.error.message, { level: 'error' });
    }
  }

  /** /skill 技能选择卡（规格 D1–D5）：单选选定即加载；正文经链尾追持久注入（与模型 skill 工具观察同语义），
   *  链上同 id 去重；>8 项 filterable（筛选在渲染层，会话层全量直出） */
  private async skillFlow(): Promise<void> {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /skill unavailable now', '当前有任务进行中，暂不能执行 /skill'), { level: 'warn' });
      return;
    }
    const manifests = [...this.runtime.harness.skills.list()].sort((a, b) =>
      a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1,
    );
    if (manifests.length === 0) {
      this.pushMsg('system', t('No skills available — add .sunshinex/skills/<id>/SKILL.md', '暂无可用技能——放置 SKILL.md 到 .sunshinex/skills/<id>/ 目录'), { level: 'warn' });
      return;
    }
    const labelToId = new Map<string, string>();
    const options = manifests.map((m) => {
      const label = labelToId.has(m.name) ? `${m.name} (${m.id})` : m.name;
      labelToId.set(label, m.id);
      return { label, description: m.description.length > 128 ? `${m.description.slice(0, 128)}…` : m.description };
    });
    const answer = await this.askUser({
      question: t('Load which skill? (type to filter)', '加载哪个技能？（输入即筛选）'),
      options,
      ...(options.length > 8 ? { filterable: true } : {}),
    });
    if (answer.type !== 'selected') return; // dismissed 静默（规格 D4，沿既有卡取消语义）
    const id = labelToId.get(answer.labels[0] ?? '');
    if (id === undefined) return;
    const loaded = this.runtime.harness.context.chainView().some((s) => s.action === 'skill' && s.observation.includes(`(id=${id} v=`));
    if (loaded) {
      this.pushMsg('system', t(`Skill ${id} already loaded in this session`, `技能 ${id} 本会话已加载`));
      return;
    }
    const r = this.runtime.harness.skills.resolve(id);
    if (!r.ok) {
      this.pushMsg('system', t(`Skill load failed: ${r.error.message}`, `技能加载失败：${r.error.message}`), { level: 'warn' });
      return;
    }
    this.loadSkill(id);
  }

  /** /memory-rm：多选卡批删（规格 D5/D6）：Space 勾选、Enter 批删、Esc 取消零删除；>8 条 filterable 全量卡（渲染层筛选）；翻页统一渲染层滑窗（2026-09-30 口径） */
  private async memoryRm(): Promise<void> {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /memory-rm unavailable now', '当前有任务进行中，暂不能执行 /memory-rm'), { level: 'warn' });
      return;
    }
    const store = new MemoryStore(this.root);
    const records = store.list();
    if (records.length === 0) {
      this.pushMsg('system', t('No memories yet — /memory-add <text> to add one', '暂无记忆——用 /memory-add <内容> 添加一条'), { level: 'warn' });
      return;
    }
    const items = records.map((r) => ({ label: r.slug, description: `${r.type} · ${r.description} (${r.created})` }));
    // >8 条切 filterable 卡（规格 D6/D8）：一次问询勾选批删；≤8 条全量直出（翻页由渲染层滑窗承载）
    if (items.length > 8) {
      const answer = await this.askUser({
        question: t('Select memories to delete (Space to toggle, Enter to delete; type to filter)', '选择要删除的记忆（Space 勾选，Enter 批量删除；输入即筛选）'),
        options: items,
        multiple: true,
        filterable: true,
      });
      if (answer.type !== 'selected' || answer.labels.length === 0) {
        this.pushMsg('system', t('No memories removed', '未删除任何记忆'));
        return;
      }
      this.applyMemoryRemoval(store, answer.labels);
      return;
    }
    // ≤8 条全量直出（2026-09-30 翻页口径统一：滑窗自动翻页由渲染层承载，More…/Back… 跨页累积循环退役）
    const answer = await this.askUser({
      question: t('Select memories to delete (Space to toggle, Enter to delete)', '选择要删除的记忆（Space 勾选，Enter 批量删除）'),
      options: items,
      multiple: true,
    });
    if (answer.type !== 'selected') {
      this.pushMsg('system', t('No memories removed', '未删除任何记忆'));
      return;
    }
    this.applyMemoryRemoval(store, answer.labels);
  }

  /** 批删执行面（/memory-rm 两形态共用单点）：去重→逐条删除→回执 */
  private applyMemoryRemoval(store: MemoryStore, picked: string[]): void {
    const unique = [...new Set(picked)];
    if (unique.length === 0) {
      this.pushMsg('system', t('No memories removed', '未删除任何记忆'));
      return;
    }
    let ok = 0;
    let fail = 0;
    for (const slug of unique) {
      const r = store.remove(slug);
      if (r.ok) ok += 1;
      else fail += 1;
    }
    const capacity = store.capacityNotice();
    this.pushMsg('system', [
      t(ok === 1 ? `Removed 1 memory${fail ? ` (${fail} failed)` : ''}` : `Removed ${ok} memories${fail ? ` (${fail} failed)` : ''}`, `已删除 ${ok} 条${fail ? `（失败 ${fail} 条）` : ''}`),
      ...(capacity ? [capacity] : []),
    ].join('\n'));
  }

  /** /memory-gc：显式整理入口（阈值外 force），与自动整理同一 consolidate 函数 */
  private async memoryGc(): Promise<void> {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /memory-gc unavailable now', '当前有任务进行中，暂不能执行 /memory-gc'), { level: 'warn' });
      return;
    }
    const store = new MemoryStore(this.root);
    if (!isModelSummarizer(this.runtime.harness.model)) {
      this.pushMsg('system', t('Consolidation requires a real model (current channel is stub/scripted)', '整理需要真实模型（当前通道为 stub/scripted）'), { level: 'warn' });
      return;
    }
    if (store.count() === 0) {
      this.pushMsg('system', t('No memories yet — nothing to consolidate', '暂无记忆——没有可整理的内容'), { level: 'warn' });
      return;
    }
    await consolidateMemory({ model: this.runtime.harness.model, root: this.root, force: true });
    this.pushMsg('system', t(`Consolidated persistent memory: ${store.count()} records`, `持久记忆已整理：${store.count()} 条`));
  }

  /** /kb-index（D28）：显式构建 KB 索引——与 CLI kb-index 子命令共用 knowledge 层单点 indexKnowledgeDir，
 *  索引对目录内全部 md/txt 走真实计费 embedding（用户显式触发，成本可控性由文件数决定）；
 *  经会话装配的同一实例写入，kb_search 本会话即时可见（不因实例过期需重启） */
  private async kbIndex(dirArg: string): Promise<void> {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /kb-index unavailable now', '当前有任务进行中，暂不能执行 /kb-index'), { level: 'warn' });
      return;
    }
    const target = dirArg === '' ? this.root : path.resolve(this.root, dirArg);
    this.pushMsg('system', t(`Indexing ${target} (embedding md/txt files…)`, `正在为 ${target} 构建索引（md/txt 文件 embedding…）`));
    let r;
    try {
      r = await indexKnowledgeDir(resolveKbEnv(process.env as Record<string, string | undefined>), this.root, target);
    } catch (e) {
      this.pushMsg('system', t(`Knowledge base assembly failed: ${e instanceof Error ? e.message : String(e)}`, `知识库装配失败：${e instanceof Error ? e.message : String(e)}`), { level: 'error' });
      return;
    }
    if (!r.ok) {
      if (r.reason === 'not-configured') {
        this.pushMsg('system', t(
          `Knowledge base not configured — missing ${r.missing.join(', ')}. Set the embedding env (see MANUAL.md section 2), then rerun /kb-index.`,
          `知识库未配置——缺 ${r.missing.join('、')}。请配置 embedding 环境变量（见 MANUAL.md 第二节）后重跑 /kb-index。`,
        ), { level: 'warn' });
      } else {
        this.pushMsg('system', t(`Not a directory: ${r.dir}`, `目录不存在或不是目录：${r.dir}`), { level: 'error' });
      }
      return;
    }
    this.pushMsg('system', t(
      `Knowledge base index built: ${r.chunks} chunks (backend=${r.backend}, dataDir=${r.dataDir}) — kb_search sees it this session`,
      `知识库索引已构建：${r.chunks} 块（backend=${r.backend}，数据目录 ${r.dataDir}）——kb_search 本会话即时可用`,
    ));
  }

  private onEvent(e: SessionEvent): void {
    // 子代理事件分流（规格 §4.1）：带 payload.subagent 标签的事件路由至面板态，不触达主链任何分支
    const sub = e.payload?.subagent;
    if (typeof sub === 'string' && sub.length > 0) {
      this.onChildEvent(e, sub);
      return;
    }
    this.state = { ...this.state, task: applyTaskState(this.state.task, e) };
    switch (e.type) {
      case 'notice':
        // 收口说明行用户面（规格 §10）：记忆/技能沉淀以一行增量告知（内容为英文链行原文，照原样不译）
        this.pushMsg('system', String(e.payload?.text ?? e.text ?? ''));
        return;
      case 'token':
        // chat 主通道正文增量直连（token 承载纯正文，无协议骨架过滤层）：live 累积 + markdansi 行级喂入（片段即时入档）
        this.appendLive('reply', e.text ?? '');
        return;
      case 'reasoning':
        this.appendLive('thinking', e.text ?? '');
        return;
      case 'ctx': {
        // reactor 旁路水位：exact=true 为端点真实 usage.prompt_tokens（直接采信，允许回落）；
        // exact=false 为装配面估算（只向上预告）。死代码分支「promptTokens 优先」自此真正接通
        const m = this.state.metrics;
        const incoming = typeof e.payload?.used === 'number' ? e.payload.used : 0;
        const used = applyCtxWatermark(m.ctxUsed, incoming, e.payload?.exact === true);
        if (used === m.ctxUsed) return;
        this.state = { ...this.state, metrics: { ...m, ctxUsed: used } };
        this.notify();
        return;
      }
      case 'usage': {
        if (typeof e.payload?.turnTotal !== 'number') return; // 无数值载荷不更新
        // 轮首 miss 提示（观测小件）：本轮首个 usage 事件且 cache=0 且 prompt≥50k → 提示一次（只提示不归因展开）
        if (!this.turnMissHinted) {
          this.turnMissHinted = true;
          const firstCache = typeof e.payload?.cacheHitTotal === 'number' ? e.payload.cacheHitTotal : 0;
          const firstPrompt = typeof e.payload?.promptTotal === 'number' ? e.payload.promptTotal : 0;
          if (firstCache === 0 && firstPrompt >= 50_000) {
            this.pushMsg('system', t('Round-first prompt cache miss (0 cached): the endpoint cache may have expired (TTL); correctness is not affected', '轮首缓存未命中（cached=0）：端点缓存可能已过期（TTL），不影响正确性'), { level: 'warn' });
          }
        }
        // per-run 值叠加任务级基线：/plan 逐步执行本轮持续累计（步骤切换不重置）
        const turnTokensTotal = this.usageBase.tokens + e.payload.turnTotal;
        const c = this.usageBase.cache + (typeof e.payload.cacheHitTotal === 'number' ? e.payload.cacheHitTotal : 0);
        const p = this.usageBase.prompt + (typeof e.payload.promptTotal === 'number' ? e.payload.promptTotal : 0);
        const m = this.state.metrics;
        if (turnTokensTotal === m.turnTokens && c === m.turnCacheTokens && p === m.turnPromptTokens) return; // 数值未变的重复 usage 不触发重渲染
        // 会话累计按本轮增量并入（Σcached/Σprompt：跨任务不清零、/new 归零）——轮首 miss 只稀释会话均值，不再把状态栏砸成 0%
        this.state = {
          ...this.state,
          metrics: {
            ...m,
            turnTokens: turnTokensTotal,
            turnCacheTokens: c,
            turnPromptTokens: p,
            sessionCacheTokens: m.sessionCacheTokens + Math.max(0, c - m.turnCacheTokens),
            sessionPromptTokens: m.sessionPromptTokens + Math.max(0, p - m.turnPromptTokens),
            sessionTotalTokens: m.sessionTotalTokens + Math.max(0, turnTokensTotal - m.turnTokens),
          },
        };
        this.notify();
        return;
      }
      case 'tool-call': {
        this.sealReply();
        const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : undefined;
        // 调用行延迟入档（CC 模式）：运行中调用行由动态区活动行唯一承载，历史区零 pending 行；
        // 回程时调用行+结果行成对定格（动态区紧贴转录末尾，定格视觉即原地完成）
        const entry = {
          callId,
          text: toolCallLine(e.text ?? '', e.payload?.input),
          input: e.payload?.input,
          verb: e.text ?? '',
        };
        this.pendingCalls = [...this.pendingCalls.filter((p) => p.callId === undefined || p.callId !== callId), entry];
        // 委派提示词捕获（规格 §4.2）：spawn 的 input.prompt 按基名暂存，子面板态创建时挂载、归档清理
        if (e.text === 'spawn') {
          const pin = e.payload?.input as Record<string, unknown> | undefined;
          const prompt = typeof pin?.prompt === 'string' && pin.prompt.length > 0 ? pin.prompt : undefined;
          if (prompt !== undefined) this.childPrompts.set(spawnBaseLabel(pin), prompt);
        }
        // 即时通知（b705855 延迟入档重构时随 pushMsg 一起丢失）：挂起清单变更与底部活动行出现都依赖本通知，
        // 缺失即委派期动态区零变化、观感像卡住
        this.notify();
        return;
      }
      case 'tool-result': {
        const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : undefined;
        // 取回挂起调用行（callId 命中优先，undefined FIFO 兜底——与旧乱序插回同口径）
        const idx = this.pendingCalls.findIndex((p) => (callId !== undefined ? p.callId === callId : p.callId === undefined));
        const pending = this.pendingCalls.splice(idx >= 0 ? idx : 0, 1)[0];
        const callItem: ChatItem = {
          role: 'tool', text: pending?.text ?? '', ts: Date.now(), seq: ++this.msgSeq,
          kind: 'call', pending: false, callId,
        };
        const item: ChatItem = {
          role: 'tool', text: e.text ?? '', ts: Date.now(), seq: ++this.msgSeq,
          kind: 'result', ok: e.payload?.ok === true,
          // callId 随行入档（2026-09-28 真机残留修复）：历史区 SPAWN 行整对剔除以 result.callId → call 行 seq
          // 配对，结果行缺 callId 即永不命中、spawn 结果行整对泄漏进主时间线
          callId,
          detail: typeof e.payload?.full === 'string' ? e.payload.full : undefined,
        };
        this.appendMessages([callItem, item]);
        if (e.payload?.tool === 'spawn' && pending !== undefined) {
          // spawn 调用关联栈：调用行此刻才入档，压栈其真实 seq 与委派时刻（浏览列表委派时间序数据源），成对语义下紧随其后弹出归档
          this.spawnCalls.push({ seq: callItem.seq, base: spawnBaseLabel(pending?.input), delegatedAt: callItem.ts });
          this.archiveChild();
        }
        return;
      }
      case 'step': {
        // 步数计账：模型动作步（done 收尾帧不计、子代理事件已分流不达此处），会话累计、/new 归零（状态栏 turns/steps 段数据源）
        // phase 叙述通道已退役（2026-09-30 用户裁决，单一权威源）：叙述只走 token→正文一条通道
        //（流式 delta / 非流式单帧补发，reactor 发射点保证），本事件只承载步号计账不上屏
        if (e.text !== 'done') {
          this.state = { ...this.state, metrics: { ...this.state.metrics, sessionSteps: this.state.metrics.sessionSteps + 1 } };
        }
        return;
      }
      case 'done': {
        const draft = this.state.live?.kind === 'reply' ? this.state.live.text : '';
        const source = this.mdSource; // 已推源在冲刷前取样（mdSeal 随通道归零）
        this.closeLive();
        this.flushPendingCalls();
        if (this.planReplyNoArchive) {
          // 规划轮终稿不重复入档：计划正文仅以确认卡形态上屏一次
          this.mdClear();
          this.refreshMetrics();
          return;
        }
        if (e.payload?.stopReason === 'model-error') {
          // D6：模型失败已由 error 通道上屏，done 收尾帧携带的同一错误文案不再以 assistant 终答身份重复入档
          this.mdClear();
          this.refreshMetrics();
          return;
        }
        const finalText = e.text && e.text.length > 0 ? e.text : source.length > 0 ? source : draft;
        // 冲刷收口：行尾残段成行喂入 + 缓冲块整体渲染入档（未闭合表格/围栏整块收口），
        // 随后通道置空；流式已入档部分终稿 dedup 天然成立（已入档条目不重发，差量走前缀对齐）
        this.mdSeal();
        if (finalText.length > 0) {
          // 终稿与已推源的前缀对齐（已推源跨 reply/thinking 交错块连续，非末 live 块）：前缀命配 →
          // 差量（非流式整帧/终稿多出尾段）单点渲染补齐；前缀失配（协议异常防御）→ 公共前缀差量
          // 降级渲染，不重复已流式呈现的内容
          let common = source.length;
          if (!finalText.startsWith(source)) {
            common = 0;
            const n = Math.min(finalText.length, source.length);
            while (common < n && finalText[common] === source[common]) common += 1;
          }
          const rest = finalText.slice(common);
          if (rest.length > 0) this.mdPushFragment(renderMd(rest, this.mdWidth()));
        }
        this.refreshMetrics();
        return;
      }
      case 'error':
        this.closeLive();
        this.mdClear();
        this.flushPendingCalls();
        this.pushMsg('system', t(`Error: ${e.text ?? '(no detail)'}`, `错误：${e.text ?? '（无说明）'}`), { level: 'error' });
        this.refreshMetrics();
        return;
      default:
        return; // route / approval-* 不落消息区
    }
  }

  /** 记忆开关状态行（/memory 无参列表尾追；外观面 t() 双语） */
  private memoryStateLine(): string {
    const on = this.memoryOverride ?? resolveMemoryConfig().autoMemory;
    if (this.memoryOverride !== undefined) {
      return this.memoryOverride
        ? t('Persistent memory: ON for this session (session override, not persisted)', '持久记忆：本会话开启（会话内覆盖，不落盘）')
        : t('Persistent memory: OFF for this session (session override, not persisted)', '持久记忆：本会话关闭（会话内覆盖，不落盘）');
    }
    return on
      ? t('Persistent memory: ON', '持久记忆：开启')
      : t('Persistent memory: OFF', '持久记忆：关闭');
  }

  private pushMsg(role: ChatRole, text: string, extra?: Partial<Pick<ChatItem, 'kind' | 'ok' | 'pending' | 'callId' | 'detail' | 'level' | 'ansi'>>): void {
    this.appendMessages([{ role, text, ts: Date.now(), seq: ++this.msgSeq, ...(extra ?? {}) }]);
  }

  /** 消息区唯一追加写点（单一挂钩点）：改 state + 逐条落 journal + 通知三件套单点——pushMsg（单条）、
   *  tool-result 成对入档、flushPendingCalls 批量兜底共用；任何绕过此点手拼 messages 的路径都会让
   *  未来加在写点上的不变量静默失效（b705855 丢 notify 真机前科）。恢复注入不经此处（零重复入志，文档化特例） */
  private appendMessages(items: ChatItem[]): void {
    if (items.length === 0) return;
    this.state = { ...this.state, messages: [...this.state.messages, ...items] };
    for (const item of items) this.journal?.log({ t: 'msg', item });
    this.notify();
  }

  /** 已入档消息的唯一覆盖写点：同 seq 原位替换 + 'msg-update' 回写（归档富化唯一消费方） */
  private updateMessage(item: ChatItem): void {
    this.state = { ...this.state, messages: this.state.messages.map((m) => (m.seq === item.seq ? item : m)) };
    this.journal?.log({ t: 'msg-update', item });
    this.notify();
  }

  /** 测试注入口：直喂 SessionEvent 走完整分流路径（等价 runtime onEvent 回调），生产路径零改动 */
  onEventForTest(e: SessionEvent): void {
    this.onEvent(e);
  }

  /** 活任务三态只读视图（渲染层与测试消费；交互面只读不重推导） */
  taskState(): LiveTaskState {
    return this.state.task;
  }

  /** 子代理事件处理（规格 §4.3）：首事件创建面板态；增量行化、结构事件即时行化；不触达主链任何分支。
   *  流式双缓冲（2026-09-29 对标主 agent session 态）：reasoning 独立累积（bufThink，视图 6 行滚动窗实时预览）、
   *  非 reasoning 事件到达即收束为 ✻ 摘要行（对标 closeLive「Thought for Ns」+ detail 全文）；
   *  正文 token 半行遇结构边界冲刷保序（2026-09-30，见 flushBuf），空行保留（段落边界——视图增量入 Static 的稳态切割点）。 */
  private onChildEvent(e: SessionEvent, label: string): void {
    let list = this.state.children;
    let idx = list.findIndex((c) => c.label === label);
    if (idx < 0) {
      const taskId = typeof e.payload?.subagentTaskId === 'string' ? e.payload.subagentTaskId : undefined;
      list = [...list, { label, startedAt: Date.now(), steps: 0, tokens: 0, transcript: [], done: false, prompt: this.childPrompts.get(label), ...(taskId !== undefined ? { taskId } : {}) }];
      idx = list.length - 1;
    }
    const child = list[idx]!;
    let buf = this.childBufs.get(label) ?? '';
    let transcript = child.transcript;
    let steps = child.steps;
    let tokens = child.tokens;
    let bufThink = child.bufThink;
    let thinkStartedAt = child.thinkStartedAt;
    /** 结构边界冲刷（2026-09-30 时序保序，替代 2026-09-28「不冲刷防碎片」）：正文半行先行入档再落结构行——
     *  否则未换行正文滞留缓冲、跨过全部工具行后与后续步正文粘连沉底（真机「工具/阶段说明集中最后」病根）；
     *  冲出的孤立半行在视图 md 段合并下不再显碎片（相邻正文自动拼段，工具行隔断处即 CC 形态——
     *  正文片段先于其后的工具块，时间线与主 agent 同构） */
    const flushBuf = (): void => {
      if (buf.length === 0) return;
      transcript = [...transcript, { kind: 'text' as const, text: buf }];
      buf = '';
    };
    /** 思考段收束（对标主 agent closeLive）：折为 ✻ 摘要行 + detail 全文（视图 Tab 展开） */
    const closeThink = (): void => {
      if (bufThink === undefined || bufThink.length === 0) {
        bufThink = undefined;
        thinkStartedAt = undefined;
        return;
      }
      const secs = Math.max(1, Math.round((Date.now() - (thinkStartedAt ?? Date.now())) / 1000));
      transcript = [...transcript, { kind: 'thinking', text: `Thought for ${secs}s`, detail: bufThink }];
      bufThink = undefined;
      thinkStartedAt = undefined;
    };
    switch (e.type) {
      case 'reasoning': {
        // 思考开段前冲刷正文半行：思考摘要行必须落在其后正文之后（时序保序）
        flushBuf();
        const delta = e.text ?? '';
        if (delta.length > 0 && bufThink === undefined) thinkStartedAt = Date.now();
        bufThink = (bufThink ?? '') + delta;
        break;
      }
      case 'token': {
        closeThink();
        // CR 剥除（2026-09-30 真机幻影高度/错位碎片实锤）：Windows 子进程输出 CRLF，
        // split 后残留行尾 CR，渲染时光标回卷产生错位碎片与凭空高度
        buf += (e.text ?? '').replace(/\r/g, '');
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        // 空行保留（段落边界）：正文增量入 Static 按空行稳态切割（对标主 agent 行级喂入的段落边界语义），Markdown 段落语义不再丢失
        transcript = [...transcript, ...parts.map((l) => ({ kind: 'text' as const, text: l }))];
        break;
      }
      case 'tool-call': {
        flushBuf();
        closeThink();
        const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
        transcript = [...transcript, { kind: 'call', text: toolCallLine(e.text ?? '', e.payload?.input), ...(callId ? { callId } : {}) }];
        const calls = callId
          ? [...(child.calls ?? []).filter((c) => c.callId !== callId), { callId, target: toolCallLine(e.text ?? '', e.payload?.input), startedAt: Date.now() }]
          : child.calls;
        this.commitChild(list, idx, { ...child, transcript, steps, tokens, calls, bufText: buf || undefined, bufThink, thinkStartedAt }, buf);
        return;
      }
      case 'tool-result': {
        // 同 tool-call：半行冲刷保序，随后结果行入档；callId 随行（并行批视图按 callId 归位到对应调用行下）
        flushBuf();
        closeThink();
        const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
        transcript = [...transcript, { kind: 'result', text: e.text ?? '', ok: e.payload?.ok === true, ...(callId ? { callId } : {}) }];
        const calls = callId ? (child.calls ?? []).filter((c) => c.callId !== callId) : child.calls;
        this.commitChild(list, idx, { ...child, transcript, steps, tokens, calls, bufText: buf || undefined, bufThink, thinkStartedAt }, buf);
        return;
      }
      case 'step':
        flushBuf();
        closeThink();
        steps = child.steps + 1;
        break;
      case 'usage':
        // per-run turnTotal 为该子代理 run 的累计值（单一 run），直接采信
        tokens = typeof e.payload?.turnTotal === 'number' ? e.payload.turnTotal : child.tokens;
        // 子代理 token 两级累计（规格 2026-09-26-stats-enhancement §3.3）：per-run 累计值取对子代理前值的增量并入，
        // 归档不清零、仅 /new 归零；状态栏 ↑tokens 合并项与任务收尾统计行差值基线的同一数据源
        {
          const cm = this.state.metrics;
          const delta = Math.max(0, tokens - child.tokens);
          if (delta > 0) {
            this.state = { ...this.state, metrics: { ...cm, turnChildTokens: cm.turnChildTokens + delta, sessionChildTokens: cm.sessionChildTokens + delta, sessionTotalTokens: cm.sessionTotalTokens + delta } };
          }
        }
        break;
      case 'done':
      case 'error': {
        // 完成态即时落面板（并行批早完成者显终标、不再转圈）：归档锚点在主链 tool-result。
        // 终稿去重（2026-09-28 真机大段重复病根）：后台两段式/无流式场景终稿照常入档；与流式正文逐字重复则跳过
        const isError = e.type === 'error';
        const finalLine = e.text && e.text.length > 0 ? e.text : isError ? 'failed' : 'done';
        closeThink();
        // 尾部半行收口：done 即整段收束，未成行半行作为完整行入档（正文终稿不依赖 conclusion 兜底重复补齐）
        flushBuf();
        const streamText = transcript.filter((l) => l.kind === 'text').map((l) => l.text).join('\n');
        const isRealFinal = finalLine !== 'done' && finalLine !== 'failed';
        if (isRealFinal && !streamText.includes(finalLine)) {
          transcript = [...transcript, { kind: 'text', text: finalLine }];
        }
        this.commitChild(list, idx, { ...child, transcript, steps, tokens, done: true, doneAt: Date.now(), conclusion: isRealFinal ? finalLine : undefined, bufText: undefined, bufThink: undefined, thinkStartedAt: undefined }, '');
        // 后台两段式延迟归档（结果先行语义）：done/error 即归档锚点，转录折回原 spawn 调用行
        this.archiveDeferred(label);
        return;
      }
      default:
        return; // ctx/route/approval-* 不入面板态（done/error 已置终态；归档锚点在主链 tool-result）
    }
    this.commitChild(list, idx, { ...child, transcript, steps, tokens, bufText: buf || undefined, bufThink, thinkStartedAt }, buf);
  }

  /** 面板态收尾单点：半行留存 + 尾流派生 + 节流通知（常规事件与 done/error 终态共用） */
  private commitChild(list: ChildLiveState[], idx: number, next: ChildLiveState, buf: string): void {
    const label = next.label;
    if (buf) this.childBufs.set(label, buf);
    else this.childBufs.delete(label);
    this.state = { ...this.state, children: list.map((c, i) => (i === idx ? next : c)) };
    this.notifyThrottled();
  }

  /** spawn 结果归档（规格 §4.4）：每条 spawn 结果经 pending.input 拿到**自己的**基名（权威关联——结果序≠
   *  完成序的并行批下栈序≠基名序），child 已完成即归档，未完成/未创建一律转 wait 延迟归档（done 的
   *  archiveDeferred 按基名收口）。旧形态两处病根（真机「5 个只显示 1 个」）：① FIFO 兜底 idx=0 把
   *  面板里**别人的**子代理归进本行——链条一错全错，错配行永远等不到自己的 meta（Ctrl+B 只剩 1）；
   *  ② child 在跑即中途归档——面板条目被抽走、半份转录冻结进 detail，终态永不回填 */
  private archiveChild(): void {
    const pending = this.spawnCalls.shift();
    if (pending === undefined) return;
    const list = this.state.children;
    let idx = list.findIndex((c) => c.label === pending.base);
    if (idx < 0) idx = list.findIndex((c) => c.label.startsWith(`${pending.base}#`));
    if (idx >= 0 && list[idx]!.done) {
      this.archiveInto(pending, list[idx]!);
      return;
    }
    this.spawnCalls.unshift({ ...pending, wait: true });
  }

  /** 延迟归档收口（后台两段式）：按基名在栈中找本基名条目（不看 wait 标记——并行批下栈中靠后条目
   *  未及经 archiveChild 转位即带不上标记，按标记过滤就是真机「5 个只显示 1 个」的第二病根），折回其调用行 */
  private archiveDeferred(label: string): void {
    const idx = this.spawnCalls.findIndex((p) => p.base === label || label.startsWith(`${p.base}#`));
    if (idx < 0) return;
    const [pending] = this.spawnCalls.splice(idx, 1);
    const child = this.state.children.find((c) => c.label === label);
    if (pending !== undefined && child !== undefined) this.archiveInto(pending, child);
  }

  /** 归档落点单点：结论精简 detail（委派提示词 + 结论 + 统计行，2026-09-28 用户裁决：已完成 spawn 只展输入/输出/统计）
   *  + subagentMeta；归档即从面板离场（历史区 SPAWN 行 detail 为唯一回看面，Ctrl+B 直接浏览全部已完成） */
  private archiveInto(pending: { seq: number; base: string; delegatedAt: number }, child: ChildLiveState): void {
    this.childBufs.delete(child.label);
    // 委派词按「消歧 label → 基名」取（同名并发 #N 前缀匹配归档时登记键为基名）；取后一并清登记
    const prompt = this.childPrompts.get(child.label) ?? this.childPrompts.get(pending.base);
    this.childPrompts.delete(child.label);
    this.childPrompts.delete(pending.base);
    const durS = Math.max(0, Math.round((Date.now() - child.startedAt) / 1000));
    // 结论不双份：done 时终稿未与流式正文重复会追加进 transcript 末尾，conclusion 段仅在转录未含时补
    //（与 done 事件去重同口径——流式正文 includes 终稿即跳过）
    const transcriptText = child.transcript.filter((l) => l.kind === 'text').map((l) => l.text).join('\n');
    const detail = [
      ...(prompt ? [`⏺ ${t('delegated prompt', '委派提示词')}：${serializeMultiline(prompt)}`] : []),
      // 完整时间线随 detail 折入（2026-09-28 用户裁决：归档子代理与运行中/主 agent 同构，Tab 展开时间线）——
      // 结构行序列化与 ChildInspector archived 分流互为镜像：result 行 ⎿ ✓/✗（多行输出续行缩进折入）、
      // call 行原样（首词动词分流还原）、text 行原样、thinking 行 ✻ 摘要 + 4 空格缩进 detail 续行
      // （与 MessageList ThinkingRow 呈现缩进同口径）；序列化前并行结果归位（pairChildResults 单点）：
      // 结果行落对应调用行下，归档回看不再结果堆叠
      ...pairChildResults(child.transcript).map((l) =>
        l.kind === 'result'
          ? `⎿ ${l.ok === false ? '✗' : '✓'} ${serializeMultiline(l.text)}`
          : l.kind === 'thinking'
            ? `✻ ${l.text}${l.detail !== undefined && l.detail.length > 0 ? '\n' + l.detail.split('\n').map((x) => `    ${x}`).join('\n') : ''}`
            : l.text,
      ),
      ...(child.conclusion && !transcriptText.includes(child.conclusion) ? [child.conclusion] : []),
      `${formatDuration(durS)} · ${Math.max(1, child.steps)} steps · ↑${formatTokens(child.tokens)} tokens`,
    ].join('\n');
    const subagentMeta = { steps: Math.max(1, child.steps), durationMs: Math.max(0, Date.now() - child.startedAt), tokens: child.tokens, delegatedAt: pending.delegatedAt, prompt };
    // 富化回写（2026-09-30）：调用行已在档（'msg' 事件先行），归档富化以 'msg-update' 终态覆盖回写——
    // 不回写则 resume/rewind 回放退回裸调用行（无 detail/subagentMeta），Ctrl+B 历史归档全消失（真机「6 个只显示 1 个」病根）；
    // 覆盖写经 updateMessage 单点（journal 回写 + 通知与追加写点同一纪律）
    this.state = { ...this.state, children: this.state.children.filter((c) => c.label !== child.label) };
    const target = this.state.messages.find((m) => m.seq === pending.seq);
    if (target !== undefined) this.updateMessage({ ...target, detail, subagentMeta });
    else this.notify();
  }

  /** 追加实时区内容：同类续接；异类先收束旧块（thinking 折叠为摘要行；reply→thinking 交错经 sealReply
   *  尾段成块入档+通道复位，其余 reply 收束走 closeLive、终稿收口由 done/seal 接管） */
  private appendLive(kind: LiveBlock['kind'], delta: string): void {
    if (!delta) return;
    const live = this.state.live;
    if (live && live.kind !== kind) {
      // 正文→思考交错（2026-10-02「流式输入框跳到中间」）：reply 尾段必须经 sealReply 成块入档。
      // 旧路径 closeLive 只丢 live 块——MdBufferPreview 整段塌掉零静态补偿，动态帧瞬矮 p+1 行，
      // ink 帧顶锚定重写即把帧底输入框抬到屏幕中部；且 md 通道不清（mdSource/mdTailStart 跨块存续），
      // 新正文 live.text 重起算与 mdSource 坐标错位，tailStart 越界即预览恒空（正文隐形流式直到块边界）。
      // sealReply 与工具边界旁白封口同款零位移交换：预览 p 行 → 静态 p+1 行 + 思考窗 6 行（净增滚动、无跳变）
      if (live.kind === 'reply' && kind === 'thinking') this.sealReply();
      else this.closeLive();
    }
    const cur = this.state.live;
    if (cur && cur.kind === kind) {
      this.state = { ...this.state, live: { ...cur, text: cur.text + delta } };
      if (kind === 'reply') this.mdConsume(delta);
      this.notifyThrottled();
      return;
    }
    this.state = { ...this.state, live: { kind, text: delta, startedAt: Date.now() } };
    if (kind === 'reply') this.mdConsume(delta);
    this.notify(); // 块首帧即时上屏：保证流式可观测与首字延迟，后续增量并入合帧窗口
  }

  /** markdansi 流式通道宽度（块渲染与终稿兜底渲染共用基准） */
  private mdWidth(): number {
    return process.stdout.columns ?? 80;
  }

  /** 行级喂入 + 块边界放行（2026-09-30 架构终版）：全部完成行紧排入块缓冲，仅在 markdown 块边界
   *  （空行）整块渲染入档——片段粒度 = markdown 块（段落/列表/表格/围栏），行距成为源结构
   *  的纯函数：块内紧排（0 空行）、块间单空行（margin），不随流式时序/喂入批次浮动。
   *  mdTailStart 水位指向当前未放行块首行（镜像 LiveBlock.tailStart 供 MdBufferPreview 实时渲染
   *  未成型块——表格/围栏/段落随生成 WYSIWYG 长出）；空行放行后水位复位。
   *  围栏行翻转 mdInFence 供归一（围栏内代码不归一），围栏内的空行不拆块（代码空行属于围栏块）。 */
  private mdConsume(delta: string): void {
    this.mdLineBuf += delta;
    this.mdSource += delta;
    let nl = this.mdLineBuf.indexOf('\n');
    while (nl >= 0) {
      const lineStart = this.mdSource.length - this.mdLineBuf.length;
      const line = this.mdLineBuf.slice(0, nl + 1);
      this.mdLineBuf = this.mdLineBuf.slice(nl + 1);
      const normalized = normalizeCjkLine(line, this.mdInFence);
      const fence = isFenceLine(line);
      if (fence) this.mdInFence = !this.mdInFence;
      if (!this.mdInFence && normalized.trim().length === 0) {
        // 空行 = markdown 块边界：当前块整体渲染入档，空行本身不产出条目
        // （块间视觉间隔由入档条目 margin 承载）；水位复位——下一块从后续行重新起算
        this.mdFlushHold();
        this.mdTailStart = undefined;
      } else {
        // 非空行（散文/列表/表格行/围栏行/围栏内空行）：紧排入当前块缓冲
        if (this.mdTailStart === undefined) this.mdTailStart = lineStart;
        this.mdHoldBuf += normalized;
      }
      nl = this.mdLineBuf.indexOf('\n');
    }
    if (this.state.live?.kind === 'reply') {
      this.state = { ...this.state, live: { ...this.state.live, tailStart: this.mdTailStart } };
    }
  }

  /** 块缓冲放行：整块 renderMd 渲染，产物经 mdPushFragment 入档，水位复位 */
  private mdFlushHold(): void {
    if (this.mdHoldBuf.length === 0) return;
    const buf = this.mdHoldBuf;
    this.mdHoldBuf = '';
    this.mdTailStart = undefined;
    // 水位镜像必须先于入档通知（2026-10-02「纯正文流式输入框反复跳中」真凶）：pushMsg→notify 同步
    // 触发提交渲染，若此刻 state.live.tailStart 仍是旧值（指向刚提交的块首），MdBufferPreview 会在
    // 提交帧里把已入档的整块再演一遍——「静态 + 预览」双份超高帧滚动，80ms 后水位落定（mdConsume
    // 末尾镜像）帧再塌回去：输入框每段落一跳（跳到中部、随下一段预览重新往下长，循环往复）。
    // 镜像先写，提交帧即恒为「静态 p+1 行 + 空预览」零位移交换，帧底不动
    if (this.state.live?.kind === 'reply') {
      this.state = { ...this.state, live: { ...this.state.live, tailStart: undefined } };
    }
    this.mdPushFragment(renderMd(buf, this.mdWidth()));
  }

  /** 片段入档单点：末尾换行恒归一为单 \n（2026-10-01 行距裁决：无尾 \n 的 markdansi 块——heading——
   *  也补齐，尾部空行成为每个 ansi 条目的自体 margin，MessageList 层块间 marginBottom 折 0 的前提）；
   *  剥 ANSI 后纯空白则跳过（视觉间隔由条目 margin 承载）；规划轮正文不入档（确认卡唯一上屏）；
   *  否则即时入档为 ansi 条目（滚动缓冲随生成滚入，对标 CC 打字机） */
  private mdPushFragment(frag: string): void {
    if (frag.length === 0) return;
    const norm = frag.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
    if (stripAnsi(norm).trim().length === 0) return;
    if (this.planReplyNoArchive) return;
    this.pushMsg('assistant', norm, { ansi: true });
  }

  /** 冲刷收口（工具边界 sealReply / done 共用）：行尾残段先成行喂入（围栏判定照走），
   *  未闭合表格/围栏经 renderMd 整块渲染自动收口（盒线补全），尾段同样入档，随后通道整体置空 */
  private mdSeal(): void {
    this.mdTailStart = undefined;
    // 行尾残段先并入块缓冲（同段续行不拆块），再整体放行渲染（未闭合结构整块收口）
    if (this.mdLineBuf.length > 0) {
      const line = this.mdLineBuf;
      this.mdLineBuf = '';
      this.mdHoldBuf += normalizeCjkLine(line, this.mdInFence);
      if (isFenceLine(line)) this.mdInFence = !this.mdInFence;
    }
    this.mdFlushHold();
    this.mdClear();
  }

  /** 通道整体清空（不冲刷不入档）：error 中断 / 规划轮终稿 / 新回合兜底 */
  private mdClear(): void {
    this.mdTailStart = undefined;
    this.mdHoldBuf = '';
    this.mdLineBuf = '';
    this.mdInFence = false;
    this.mdSource = '';
  }

  /** 收束实时区：thinking 折叠为一行摘要；reply 不落消息（终稿由 done 接管） */
  private closeLive(): void {
    const live = this.state.live;
    if (!live) return;
    this.state = { ...this.state, live: undefined };
    if (live.kind === 'thinking') {
      const secs = Math.max(1, Math.round((Date.now() - live.startedAt) / 1000));
      this.pushMsg('thinking', `Thought for ${secs}s`, { detail: live.text });
      return;
    }
    this.notify();
  }

  /** 工具边界旁白封口（2026-09-30，phase 通道退役的配套收口）：live reply 经 mdSeal 冲刷——行尾残段成行
   *  喂入、未闭合表格/围栏整块渲染收口（盒线补全），尾段落为 assistant ansi 消息（规划轮照旧不入档）。
   *  旁白先于其后的工具行定格入档（CC 交错形态：叙述段 → 工具行），不再依赖段落空行边界、也不再被
   *  closeLive 丢弃（旧形态下旁白 token 副本在工具边界被扔、上屏的只有 phase 副本，▶ 行退役后该丢弃即
   *  旁白整体蒸发）。终稿轮不经此点（done 自带冲刷收口），随后通道整体置空（下一旁白段全新通道） */
  private sealReply(): void {
    const live = this.state.live;
    if (!live) return;
    if (live.kind !== 'reply') {
      this.closeLive();
      return;
    }
    this.state = { ...this.state, live: undefined };
    this.mdSeal();
    this.notify();
  }

  /** done/error 后刷新账本 runs（缓存命中率已升格会话累计口径，随 usage 事件增量更新） */
  private refreshMetrics(): void {
    this.state = {
      ...this.state,
      metrics: { ...this.state.metrics, runs: this.runtime.harness.ledger.summary().runs },
    };
    this.notify();
  }

  /** 高频增量（token/reasoning 逐 delta）合帧节流窗口：约 80ms 通知一次，终态与结构事件仍即时放行 */
  private static readonly NOTIFY_THROTTLE_MS = 80; // 流式合帧窗口（2026-09-30 流畅度裁决）：ink 无逐行 diff，动态区任一行变化即全帧重写——帧率与擦写面积耦合：正文流式改 markdansi 通道逐行入档后动态区行数有界，80ms（~12 帧/s）擦写肉眼不可感、流式爬行观感显著更顺；旧 120ms 是 20+ 行大预览区时代的防闪灼取舍，区域收敛后钝感即卡顿感
  private notifyTimer?: NodeJS.Timeout;

  private notify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    for (const cb of this.listeners) cb(this.state);
  }

  /** 增量合帧：窗口内多次状态变更只通知一次（监听方取到的总是最新状态）；定时器不持有进程引用 */
  private notifyThrottled(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.notify();
    }, SessionController.NOTIFY_THROTTLE_MS);
    this.notifyTimer.unref();
  }
}

