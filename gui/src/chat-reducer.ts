import type { SessionEvent } from '../../src/types';

/**
 * G3 chat 投影 reducer（纯函数）：gui 对话流的事件面单点——token 流式拼接、done 终稿收段、
 * 工具 call/result 配对（乱序回填）、notice 系映射、status·tokens·steps 聚合。
 * 工具配对与 daemon 侧 TranscriptCollector 同构（gui 独立实现，不 import 主仓 serve/*——
 * 两轨并行：归档面（snapshot.messages）与实时面（事件流推导）形态一致，重连/直连所见等价）。
 *
 * 裁定记录：
 * - done 收段语义（事件面）：done.text 是终稿——与 streaming 条已累积文本重叠（互为前缀）时以
 *   终稿为准，不重叠则补入（md += text）；无 streaming 条时独立成条（对齐归档面「done 恒有终答条」）。
 * - usage 会话累计口径：事件载荷实际只有 turnTotal（reactor 单 run 累计，核 src/harness/reactor.ts
 *   emit('usage')——无 sessionTotalTokens 字段），故 gui 以「轮内增量、model-start 重置轮基线」
 *   自行累计会话总量；子代理 usage（payload.subagent）不进主链计数（G5 板面另聚）。
 * - seed 时 tokens 置 0（会话累计经事件续推；G4 若需精确可在 snapshot 加基线，记档）。
 * - streaming 条在 done/error/model-start/tool-call 收段——不留永久流式标（GUI 光标面）。
 */

/** 对话流条目（md 原文；kind 样式钩子在渲染面，streaming=true 流式光标态） */
export interface ChatEntry {
  key: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error';
  md: string;
  streaming?: boolean;
}

/** chat 投影状态：entries 对话流 + 状态栏三指标 */
export interface ChatState {
  entries: ChatEntry[];
  status: 'idle' | 'running';
  /** 会话累计 tokens（usage 事件续推；seed 归零，见文件头裁定） */
  tokens: number;
  steps: number;
  /** 内部记账（勿消费）：当前 run 的 usage.turnTotal 水位——model-start 重置；tokens 增量基线 */
  turnTokensBase?: number;
}

/** snapshot.messages 载荷形态（gui 侧契约声明，五 kind；对齐 daemon TranscriptEntry，不引其类型） */
export interface SnapshotTranscriptEntry {
  seq: number;
  ts?: number;
  kind: ChatEntry['kind'];
  md: string;
}

export function initialChatState(): ChatState {
  return { entries: [], status: 'idle', tokens: 0, steps: 0, turnTokensBase: 0 };
}

/** 用户提交的本地回显条（`> text` 引用块形态，与归档面 transcript.submit 同款——resync 后由快照条取代） */
export function appendUserMessage(s: ChatState, text: string): ChatState {
  return { ...s, entries: [...s.entries, { key: `u${s.entries.length}`, kind: 'user', md: `> ${text}` }] };
}

/** onResync 基线：snapshot.messages 直映射（md 原文、无 streaming；tokens/steps 0 起步——事件面续推） */
export function seedChatFromSnapshot(messages: readonly SnapshotTranscriptEntry[], status: 'idle' | 'running'): ChatState {
  return {
    entries: messages.map((m) => ({ key: `s${m.seq}`, kind: m.kind, md: m.md })),
    status,
    tokens: 0,
    steps: 0,
    turnTokensBase: 0,
  };
}

/* ===== 工具条两行形态（● verb / ⎿ result，占位 …）与配对记账 =====
 * 配对状态经 key 约定编码在 entries 里（ChatState 形态固定不另设池）：
 * - `tool:<callId>`：有 callId 的配对面（迟到者按 callId 回找；`~n` 后缀为重复 callId 的唯一化）
 * - `tool:#<n>`：无 callId 面（FIFO 兜底池）
 * 未配对 = 两行中有 … 占位；双占位/单占位均可被回填。 */

const PLACEHOLDER = '…';

function toolMd(verb: string, resultLine: string): string {
  return `● ${verb}\n⎿ ${resultLine}`;
}

/** 多行观察只取首行；空文本回落 … 占位 */
function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n')[0] ?? '';
  return line.length > 0 ? line : PLACEHOLDER;
}

function verbOf(md: string): string {
  const nl = md.indexOf('\n');
  return nl > 2 ? md.slice(2, nl) : PLACEHOLDER;
}

function resultOf(md: string): string {
  const m = md.indexOf('⎿ ');
  return m >= 0 ? md.slice(m + 2) : PLACEHOLDER;
}

/** 未配对条（含占位行）判定 */
function toolUnpaired(md: string): boolean {
  return verbOf(md) === PLACEHOLDER || resultOf(md) === PLACEHOLDER;
}

/** key 唯一化：重复 callId 复现（已配对条同 callId 再来一对手）时递增 `~n` 后缀防 React 撞 key */
function uniqueKey(base: string, entries: readonly ChatEntry[]): string {
  if (!entries.some((e) => e.key === base)) return base;
  let n = 2;
  while (entries.some((e) => e.key === `${base}~${n}`)) n += 1;
  return `${base}~${n}`;
}

/** 条目是否 callId=<callId> 的未配对工具面（key 前缀匹配，`tool:#` 无 callId 面除外） */
function isPendingCallTool(e: ChatEntry, callId: string): boolean {
  if (e.kind !== 'tool' || !e.key.startsWith(`tool:${callId}`)) return false;
  const rest = e.key.slice(`tool:${callId}`.length);
  return (rest === '' || rest.startsWith('~')) && toolUnpaired(e.md);
}

/** entries[idx] 原位替换（浅拷贝数组；其余条目引用复用） */
function replaceAt(entries: readonly ChatEntry[], idx: number, next: ChatEntry): ChatEntry[] {
  const copy = entries.slice();
  copy[idx] = next;
  return copy;
}

/** 收段：最后一个 streaming 条去 streaming 标（md 原样保留）——done/error/model-start/tool-call 共用 */
function sealStreaming(entries: readonly ChatEntry[]): { entries: ChatEntry[]; sealedIdx: number } {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.kind === 'assistant' && e.streaming === true) {
      const { streaming: _drop, ...rest } = e;
      return { entries: replaceAt(entries, i, rest), sealedIdx: i };
    }
  }
  return { entries: entries as ChatEntry[], sealedIdx: -1 };
}

/** token 增量并入当前 streaming 条（无则开条） */
function onToken(s: ChatState, text: string): ChatState {
  if (text === '') return s;
  for (let i = s.entries.length - 1; i >= 0; i -= 1) {
    const e = s.entries[i]!;
    if (e.kind === 'assistant' && e.streaming === true) {
      return { ...s, entries: replaceAt(s.entries, i, { ...e, md: e.md + text }) };
    }
  }
  return { ...s, entries: [...s.entries, { key: `a${s.entries.length}`, kind: 'assistant', md: text, streaming: true }] };
}

/** done 终稿与已累积的合并：互为前缀（重叠）→ 终稿为准；不重叠 → 补入 */
function mergeFinal(acc: string, fin: string): string {
  if (acc === '') return fin;
  if (fin === '') return acc;
  if (fin.startsWith(acc) || acc.startsWith(fin)) return fin.length >= acc.length ? fin : acc;
  return acc + fin;
}

function onDone(s: ChatState, e: SessionEvent): ChatState {
  const { entries, sealedIdx } = sealStreaming(s.entries);
  const text = e.text ?? '';
  if (sealedIdx < 0) {
    return { ...s, status: 'idle', entries: [...entries, { key: `a${entries.length}`, kind: 'assistant', md: text }] };
  }
  const sealed = entries[sealedIdx]!;
  return { ...s, status: 'idle', entries: replaceAt(entries, sealedIdx, { ...sealed, md: mergeFinal(sealed.md, text) }) };
}

function onError(s: ChatState, e: SessionEvent): ChatState {
  const { entries } = sealStreaming(s.entries);
  return { ...s, status: 'idle', entries: [...entries, { key: `e${entries.length}`, kind: 'error', md: e.text ?? 'error' }] };
}

/** tool-call：callId 命中未配对面（result 先到）→ verb 回填；否则 verb 行即时、result 行占位入列 */
function onToolCall(s: ChatState, e: SessionEvent): ChatState {
  const { entries } = sealStreaming(s.entries);
  const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : undefined;
  if (callId !== undefined) {
    const idx = entries.findIndex((t) => isPendingCallTool(t, callId));
    if (idx >= 0) {
      return { ...s, entries: replaceAt(entries, idx, { ...entries[idx]!, md: toolMd(e.text ?? PLACEHOLDER, resultOf(entries[idx]!.md)) }) };
    }
  }
  const key = uniqueKey(callId !== undefined ? `tool:${callId}` : `tool:#${entries.length}`, entries);
  return { ...s, entries: [...entries, { key, kind: 'tool', md: toolMd(e.text ?? PLACEHOLDER, PLACEHOLDER) }] };
}

/** tool-result：callId 命中未配对面（call 先到）→ result 回填；callId 缺场先入列占位；无 callId FIFO 配最老 / 孤儿独立成条 */
function onToolResult(s: ChatState, e: SessionEvent): ChatState {
  const { entries } = sealStreaming(s.entries);
  const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : undefined;
  const resultLine = firstLine(e.text);
  if (callId !== undefined) {
    const idx = entries.findIndex((t) => isPendingCallTool(t, callId));
    if (idx >= 0) {
      return { ...s, entries: replaceAt(entries, idx, { ...entries[idx]!, md: toolMd(verbOf(entries[idx]!.md), resultLine) }) };
    }
    return { ...s, entries: [...entries, { key: uniqueKey(`tool:${callId}`, entries), kind: 'tool', md: toolMd(PLACEHOLDER, resultLine) }] };
  }
  // FIFO：最老的无 callId（`tool:#`）未配对面——result 回填（result 先到的孤儿面：result 行被覆盖，verb 占位保留）
  const idx = entries.findIndex((t) => t.kind === 'tool' && t.key.startsWith('tool:#') && toolUnpaired(t.md));
  if (idx >= 0) {
    return { ...s, entries: replaceAt(entries, idx, { ...entries[idx]!, md: toolMd(verbOf(entries[idx]!.md), resultLine) }) };
  }
  const tool = e.payload?.tool;
  const verb = typeof tool === 'string' && tool.length > 0 ? tool : PLACEHOLDER;
  return { ...s, entries: [...entries, { key: `tool:#${entries.length}`, kind: 'tool', md: toolMd(verb, resultLine) }] };
}

/** 委派起止单行（`✻ label started|status`）：label 取 payload.label 回落 delegationId，status 回落 ended */
function delegationMd(e: SessionEvent): string {
  const p = e.payload as { label?: unknown; delegationId?: unknown; status?: unknown } | undefined;
  const label =
    typeof p?.label === 'string' && p.label.length > 0 ? p.label : typeof p?.delegationId === 'string' && p.delegationId.length > 0 ? p.delegationId : PLACEHOLDER;
  const status = e.type === 'delegation-started' ? 'started' : typeof p?.status === 'string' && p.status.length > 0 ? p.status : 'ended';
  return `✻ ${label} ${status}`;
}

/** usage 会话累计：turnTotal 轮内增量并入（基线 model-start 重置）；子代理用量/无数值载荷不动 */
function onUsage(s: ChatState, e: SessionEvent): ChatState {
  if (typeof e.payload?.subagent === 'string') return s;
  const turnTotal = e.payload?.turnTotal;
  if (typeof turnTotal !== 'number') return s;
  const base = s.turnTokensBase ?? 0;
  const delta = Math.max(0, turnTotal - base);
  if (delta === 0 && turnTotal === base) return s;
  return { ...s, tokens: s.tokens + delta, turnTokensBase: turnTotal };
}

/** 事件面单点：chat 投影纯归约（忽略 task-、gate-、route/ctx/model-end/reasoning/approval 系——板面/另轨） */
export function applyChatEvent(s: ChatState, e: SessionEvent): ChatState {
  switch (e.type) {
    case 'token':
      return onToken(s, e.text ?? '');
    case 'done':
      return onDone(s, e);
    case 'error':
      return onError(s, e);
    case 'notice':
      return { ...s, entries: [...s.entries, { key: `n${s.entries.length}`, kind: 'notice', md: e.text ?? '' }] };
    case 'tool-call':
      return onToolCall(s, e);
    case 'tool-result':
      return onToolResult(s, e);
    case 'model-start': {
      const { entries } = sealStreaming(s.entries);
      return { ...s, entries, status: 'running', turnTokensBase: 0 };
    }
    case 'step':
      return { ...s, steps: s.steps + 1 };
    case 'usage':
      return onUsage(s, e);
    case 'delegation-started':
    case 'delegation-ended':
      return { ...s, entries: [...s.entries, { key: `n${s.entries.length}`, kind: 'notice', md: delegationMd(e) }] };
    case 'agent-message': {
      const p = e.payload as { from?: unknown; to?: unknown; text?: unknown } | undefined;
      const from = typeof p?.from === 'string' && p.from.length > 0 ? p.from : '?';
      const to = typeof p?.to === 'string' && p.to.length > 0 ? p.to : '?';
      return { ...s, entries: [...s.entries, { key: `n${s.entries.length}`, kind: 'notice', md: `[${from} → ${to}] ${typeof p?.text === 'string' ? p.text : ''}` }] };
    }
    default:
      return s;
  }
}
