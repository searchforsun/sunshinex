import type { SessionEvent } from '../../../src/types';
import { applySubagentChatEvent, initialChatState, type ChatState } from '../chat-reducer';

/**
 * G8d 子智能体活动聚合 reducer（纯函数，task-3）：payload.subagent 标签流 → 按 label 聚卡。
 * App 事件分流单点把「子智能体事件（标签在场）」与「delegation 起止（label 命中既有卡）」投到
 * 本归约——agent 只读转录页（registry 'agent'，services.agentActivities）只读消费。聚合口径
 * 对齐 TUI ChildPanel（src/tui/child-panel.ts 子智能体面板；gui 侧零 import 独立实现，两轨防形态漂移）。
 *
 * 裁定记录：
 * - 建卡：子智能体事件首见 label 即建 running 卡（零先见 delegation 也行——delegation 事件无
 *   subagent 标签，不能作为建卡信号；delegation-started/ended 仅当 payload.label 命中既有卡
 *   时改状态：started → running（同名再派复活）、ended → done·failed→error（Runner 权威终语））。
 * - status：error 粘滞（子链 error 先发、done 必发是 reactor 收尾口径——done 不覆写 error）；
 *   running 态 done → done；delegation-ended 无条件落终态（后到的权威终语）。
 * - tokens：沿用 chat onUsage 口径的 turnTotal 水位增量——卡内以 tokens 既有值自持水位
 *   （首见即基线 0），回退/等值不增；子智能体单 run 语义下与 TUI「直接采信」等价。
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
  /** G14.2xx 全量同源转录（chat-reducer 内核投影,与主对话逐字段同构:tool 行 name/input/
   *  result 全量)——子智能体转录页直渲此流,替代旧有损文本滑窗反解析(空名帧退化「…」行病根) */
  chat: ChatState;
}

/** 聚合态：key = payload.subagent 标签 */
export type AgentActivities = Readonly<Record<string, AgentActivity>>;

/** turnTotal 水位累计（chat onUsage 同口径增量；回退/等值原卡返回） */
function bumpTokens(card: AgentActivity, payload: Record<string, unknown> | undefined): AgentActivity {
  const turnTotal = payload?.turnTotal;
  if (typeof turnTotal !== 'number' || turnTotal <= card.tokens) return card;
  return { ...card, tokens: turnTotal };
}

/**
 * 事件面单点：Agents 聚合纯归约。
 * - payload.subagent 非 string：仅 delegation-started/ended 的 payload.label 命中既有卡时改
 *   状态（未建卡不建——建卡只靠子智能体事件首见）；其余原引用返回。
 * - 标签在场：tool-call → currentTool；token/usage → turnTotal 若随行携带按水位累计；
 *   error → error（粘滞）；done（running 态）→ done。凡动投影的事件同帧过 chat 内核投影
 *   （转录页条目单源）；不变事件原引用返回。
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
  const card: AgentActivity = s[label] ?? { label, status: 'running', tokens: 0, chat: initialChatState() };
  if (e.type === 'queue') return s; // 队列面事件不入转录投影(主对话 applyChatEvent 同款防御——防误闭合开启段)
  // G14.2xx 同源归约:凡动卡的子智能体事件都过一遍 chat-reducer 内核投影(与主对话唯一实现
  // 同源),产全量字段条目;未动卡的事件原引用返回(投影亦幂等,省一次)。
  // G14.2xx b:零变化透传下沉到 withChat——卡未动且投影零变化(applySubagentChatEvent
  // 原引用口径)即原 s 返回,StrictMode/未知事件(route 等)恒幂等
  const withChat = (next: AgentActivity): AgentActivities => {
    const chat = applySubagentChatEvent(next.chat, e);
    if (chat === next.chat && next === card) return s;
    return { ...s, [label]: { ...next, chat } };
  };
  switch (e.type) {
    case 'tool-call': {
      const tool = e.text ?? '';
      return withChat(tool.length > 0 ? { ...card, currentTool: tool } : card);
    }
    case 'tool-result': {
      // 完成态 currentTool 保留最后工具名(卡面/转录页无「正在做」语义的锚由 status 承担)
      return withChat(card);
    }
    case 'reasoning': {
      // 思考流:条目由 chat 内核投影承载(thinking 条目)——空增量无信息,原引用返回
      const text = e.text ?? '';
      if (text === '') return s;
      return withChat(card);
    }
    case 'token': {
      const next = bumpTokens(card, p); // 防御面：token 帧随行携带 turnTotal 则按水位累计（常态无）
      return withChat(next); // 无 turnTotal:withChat 零变化透传原 s
    }
    case 'usage': {
      const next = bumpTokens(card, p);
      return withChat(next); // 无 turnTotal/不增:零变化透传原 s
    }
    case 'error': {
      if (card.status === 'error') return s; // error 幂等（粘滞;内核 error 条目无幂等,重复帧不重复入转录）
      return withChat({ ...card, status: 'error' });
    }
    case 'done': {
      if (card.status === 'done') return s; // 已 done：幂等
      // error 粘滞时卡状态保持 error(done 不覆写),但 done 权威终语必过 chat 投影——
      // 封 run/合并终稿,防投影 openRun 悬空(运行态行永转)
      return withChat(card.status === 'running' ? { ...card, status: 'done' } : card);
    }
    default: {
      // G14.175 任务带(teammate 派发的任务内容=子智能体的用户输入):step.taskBand 捕获上浮
      if (e.type === 'step' && typeof p?.taskBand === 'string' && p.taskBand !== '' && card.taskBand !== p.taskBand) {
        return withChat({ ...card, taskBand: p.taskBand });
      }
      // G14.2xx b:model-start/step 等流内事件过 chat 投影(run 条开启=运行态/steps 计数——
      // 此前 default 原引用返回,转录页 status 恒 idle、steps 恒 0、run-live 行无数据的病根);
      // 不动卡(零变化透传兜底幂等)
      return withChat(card);
    }
  }
}
