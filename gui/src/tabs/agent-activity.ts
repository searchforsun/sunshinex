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
  /** 已落入转录的 messageId。agent-message 与随后的 inbox drain step 同 id 只留一条气泡 */
  seenMessageIds?: readonly string[];
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
function messageIdOf(e: SessionEvent): string {
  const id = e.payload?.messageId;
  return typeof id === 'string' && id.length > 0 ? id : '';
}

/** 收件消息落入 label 的转录。同 messageId 已投影则原引用返回（agent-message 与 drain step 双通道）。 */
function projectInbound(s: AgentActivities, label: string, e: SessionEvent): AgentActivities {
  const id = messageIdOf(e);
  const prev = s[label];
  if (prev !== undefined && id !== '' && (prev.seenMessageIds?.includes(id) ?? false)) return s;
  const card: AgentActivity = prev ?? { label, status: 'running', tokens: 0, chat: initialChatState() };
  const tagged: SessionEvent = e.type === 'agent-message'
    ? { ...e, payload: { ...(e.payload ?? {}), subagent: label } }
    : e;
  const chat = applySubagentChatEvent(card.chat, tagged);
  const grew = chat.entries.length > card.chat.entries.length;
  if (chat === card.chat) return s;
  const seenMessageIds = id !== '' && grew ? [...(card.seenMessageIds ?? []), id] : card.seenMessageIds;
  return { ...s, [label]: { ...card, chat, ...(seenMessageIds !== undefined && seenMessageIds.length > 0 ? { seenMessageIds } : {}) } };
}

function isInboundStep(e: SessionEvent): boolean {
  if (e.type !== 'step' || e.payload === undefined) return false;
  const p = e.payload;
  if (typeof p.messageLine === 'string' && p.messageLine.length > 0) return true;
  return typeof p.from === 'string' && p.from.length > 0 && typeof p.text === 'string';
}

export function applyAgentEvent(s: AgentActivities, e: SessionEvent): AgentActivities {
  const p = e.payload as { subagent?: unknown; label?: unknown; status?: unknown; turnTotal?: unknown; ok?: unknown; tool?: unknown; input?: unknown; taskBand?: unknown; to?: unknown } | undefined;
  if (e.type === 'agent-message') {
    const to = typeof p?.to === 'string' ? p.to : '';
    // lead 的气泡在主会话;队友转录只收发给自己的
    if (to === '' || to === 'lead') return s;
    return projectInbound(s, to, e);
  }
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
  if (isInboundStep(e)) return projectInbound(s, label, e);
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
      // done 幂等守卫退役(2026-10-31 用户报障「重启后重复渲染时间线+底部永转」根修):done 必过
      // chat 投影——重复投递帧(attach seedShadow 突发×水合整替竞态第二份)的 done 若被「卡已 done」
      // 吞掉,其内核 run 永不闭合 → openRun 悬空 → 转录页永转。内核侧 done 无 run 可封时零条目
      // (applyEvent default 分支 sealSeg 空段透传),重复过投影幂等;状态仅 running 态迁移,
      // error 粘滞不覆写(口径不变)
      return withChat(card.status === 'running' ? { ...card, status: 'done' } : card);
    }
    default: {
      // 任务带→用户气泡入转录(每轮任务一条,与主对话用户条同形;仅改 taskBand 字段会丢掉上一轮)
      if (e.type === 'step' && typeof p?.taskBand === 'string' && p.taskBand !== '' && card.taskBand !== p.taskBand) {
        const userEv: SessionEvent = {
          type: 'user',
          text: p.taskBand,
          ts: e.ts,
          payload: { subagent: label },
        };
        const chatWithUser = applySubagentChatEvent(card.chat, userEv);
        return withChat({ ...card, taskBand: p.taskBand, chat: chatWithUser });
      }
      // G14.2xx b:model-start/step 等流内事件过 chat 投影(run 条开启=运行态/steps 计数——
      // 此前 default 原引用返回,转录页 status 恒 idle、steps 恒 0、run-live 行无数据的病根);
      // 不动卡(零变化透传兜底幂等)
      return withChat(card);
    }
  }
}
