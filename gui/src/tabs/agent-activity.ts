import type { SessionEvent } from '../../../src/types';
import { applySubagentChatEvent, initialChatState, type ChatState } from '../chat-reducer';

/**
 * G8d Agents 标签聚合 reducer（纯函数，task-3）：payload.subagent 标签流 → 按 label 聚卡。
 * App 事件分流单点把「子代理事件（标签在场）」与「delegation 起止（label 命中既有卡）」投到
 * 本归约——AgentsTab（services.agentActivities）只读消费。聚合口径对齐 TUI ChildPanel
 * （src/tui/child-panel.ts 子代理面板；gui 侧零 import 独立实现，两轨防形态漂移）。
 *
 * 裁定记录：
 * - 建卡：子代理事件首见 label 即建 running 卡（零先见 delegation 也行——delegation 事件无
 *   subagent 标签，不能作为建卡信号；delegation-started/ended 仅当 payload.label 命中既有卡
 *   时改状态：started → running（同名再派复活）、ended → done·failed→error（Runner 权威终语））。
 * - status：error 粘滞（子链 error 先发、done 必发是 reactor 收尾口径——done 不覆写 error）；
 *   running 态 done → done；delegation-ended 无条件落终态（后到的权威终语）。
 * - tokens：沿用 chat onUsage 口径的 turnTotal 水位增量——卡内以 tokens 既有值自持水位
 *   （首见即基线 0），回退/等值不增；子代理单 run 语义下与 TUI「直接采信」等价。
 * - lines：每卡尾部 20 行滑窗（tool 行名+入参摘要截 80 / token 行截 120）。
 * - 纯函数性：不变事件原引用返回（StrictMode 双调安全）；未动卡对象引用复用。
 */

/** 单卡活动面：label 键聚（AgentActivities 的 key） */
export interface AgentActivity {
  label: string;
  status: 'running' | 'done' | 'error';
  tokens: number;
  currentTool?: string;
  /** 任务内容=用户输入（teammate 任务带 step.taskBand；G14.175 主对话式渲染的用户气泡） */
  taskBand?: string;
  /**
   * 转录滑窗（G14.175 kind 扩 'thinking'：reasoning 事件流按相邻合并为一条思考行——
   * 渲染面映射为主对话三态：thinking→思考行 / token→assistant 正文 / tool→工具行）。
   * 卡面（Agents 页迷你转录）消费；整段转录页走 chat 全量。
   */
  lines: Array<{ kind: 'tool' | 'text' | 'token' | 'thinking'; text: string }>;
  /** G14.2xx 全量同源转录（chat-reducer 内核投影,与主对话逐字段同构:tool 行 name/input/
   *  result 全量)——子代理转录页直渲此流,替代旧有损文本滑窗反解析(空名帧退化「…」行病根) */
  chat: ChatState;
}

/** 聚合态：key = payload.subagent 标签 */
export type AgentActivities = Readonly<Record<string, AgentActivity>>;

/** 单卡转录滑窗（尾部保留行数；G14.164 提到 240——agent 只读标签页整段转录消费，卡面只显摘要行） */
const LINES_MAX = 240;
/** tool 行截断帽（名 + 入参摘要整行） */
const TOOL_LINE_MAX = 80;
/** token 行截断帽 */
const TOKEN_LINE_MAX = 120;

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** 入参摘要：input.path 字符串优先（文件类工具主判据），否则 JSON 全量；失败回落 String */
function inputSummary(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const pathArg = (input as { path?: unknown }).path;
    if (typeof pathArg === 'string' && pathArg.length > 0) return pathArg;
  }
  if (input === undefined) return '';
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return String(input);
  }
}

/** 行入列 + 滑窗（尾部 240;G14.175 kind 扩 thinking） */
function pushLine(lines: ReadonlyArray<AgentActivity['lines'][number]>, line: AgentActivity['lines'][number]): AgentActivity['lines'] {
  return [...lines, line].slice(-LINES_MAX);
}

/** turnTotal 水位累计（chat onUsage 同口径增量；回退/等值原卡返回） */
function bumpTokens(card: AgentActivity, payload: Record<string, unknown> | undefined): AgentActivity {
  const turnTotal = payload?.turnTotal;
  if (typeof turnTotal !== 'number' || turnTotal <= card.tokens) return card;
  return { ...card, tokens: turnTotal };
}

/**
 * 事件面单点：Agents 聚合纯归约。
 * - payload.subagent 非 string：仅 delegation-started/ended 的 payload.label 命中既有卡时改
 *   状态（未建卡不建——建卡只靠子代理事件首见）；其余原引用返回。
 * - 标签在场：tool-call → currentTool + 工具行；tool-result → ✓/✗ 行；token → 正文行（截 120）
 *   + turnTotal 若随行携带按水位累计；usage → 水位累计；error → error（粘滞）；done（running
 *   态）→ done。不变事件原引用返回。
 */
export function applyAgentEvent(s: AgentActivities, e: SessionEvent): AgentActivities {
  const p = e.payload as { subagent?: unknown; label?: unknown; status?: unknown; turnTotal?: unknown; ok?: unknown; tool?: unknown; input?: unknown; taskBand?: unknown } | undefined;
  const label = p?.subagent;
  if (typeof label !== 'string' || label.length === 0) {
    // delegation 系（无 subagent 标签）：payload.label 命中既有卡才改状态；其余/未命中原引用
    if (e.type !== 'delegation-started' && e.type !== 'delegation-ended') return s;
    const lbl = p?.label;
    if (typeof lbl !== 'string' || s[lbl] === undefined) return s;
    const status: AgentActivity['status'] = e.type === 'delegation-started' ? 'running' : p?.status === 'failed' ? 'error' : 'done';
    if (s[lbl]!.status === status) return s;
    return { ...s, [lbl]: { ...s[lbl]!, status } };
  }
  const card: AgentActivity = s[label] ?? { label, status: 'running', tokens: 0, lines: [], chat: initialChatState() };
  // G14.2xx 同源归约:凡动卡的子代理事件都过一遍 chat-reducer 内核投影(与主对话唯一实现
  // 同源),产全量字段条目;未动卡的事件原引用返回(投影亦幂等,省一次)
  const withChat = (next: AgentActivity): AgentActivities => ({ ...s, [label]: { ...next, chat: applySubagentChatEvent(next.chat, e) } });
  switch (e.type) {
    case 'tool-call': {
      const tool = e.text ?? '';
      const summary = inputSummary(p?.input);
      const next: AgentActivity = {
        ...card,
        ...(tool.length > 0 ? { currentTool: tool } : {}),
        lines: pushLine(card.lines, { kind: 'tool', text: clip(`${tool}${summary.length > 0 ? ` ${summary}` : ''}`, TOOL_LINE_MAX) }),
      };
      return withChat(next);
    }
    case 'tool-result': {
      const tool = typeof p?.tool === 'string' ? p.tool : '';
      const next: AgentActivity = {
        ...card,
        lines: pushLine(card.lines, { kind: 'tool', text: `${p?.ok === false ? '✗' : '✓'}${tool.length > 0 ? ` ${tool}` : ''}` }),
      };
      return withChat(next);
    }
    case 'reasoning': {
      // G14.175 思考流:reasoning 增量按相邻合并为一条思考行(渲染面=主对话思考行;截 2000 防单轮刷爆滑窗)
      const text = e.text ?? '';
      if (text === '') return s;
      const last = card.lines[card.lines.length - 1];
      if (last !== undefined && last.kind === 'thinking') {
        const merged = clip(last.text + text, 2000);
        return { ...s, [label]: { ...card, lines: [...card.lines.slice(0, -1), { kind: 'thinking', text: merged }] } };
      }
      return { ...s, [label]: { ...card, lines: pushLine(card.lines, { kind: 'thinking', text: clip(text, 2000) }) } };
    }
    case 'token': {
      const text = e.text ?? '';
      let next = bumpTokens(card, p); // 防御面：token 帧随行携带 turnTotal 则按水位累计（常态无）
      if (text.length > 0) next = { ...next, lines: pushLine(next.lines, { kind: 'token', text: clip(text, TOKEN_LINE_MAX) }) };
      if (next === card) return s; // 空文本且无 turnTotal：原引用
      return withChat(next);
    }
    case 'usage': {
      const next = bumpTokens(card, p);
      if (next === card) return s; // 无 turnTotal/不增：原引用
      return withChat(next);
    }
    case 'error': {
      if (card.status === 'error') return s; // error 幂等（粘滞）
      return withChat({ ...card, status: 'error' });
    }
    case 'done': {
      if (card.status !== 'running') return s; // error 粘滞/已 done：不动
      return withChat({ ...card, status: 'done' });
    }
    default: {
      // G14.175 任务带(teammate 派发的任务内容=子代理的用户输入):step.taskBand 捕获上浮
      if (e.type === 'step' && typeof p?.taskBand === 'string' && p.taskBand !== '' && card.taskBand !== p.taskBand) {
        return { ...s, [label]: { ...card, taskBand: p.taskBand } };
      }
      return s; // model-start/step/route… 不动卡（原引用）
    }
  }
}
