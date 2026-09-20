import type { ChatMessage, ContextItem, HistoryStep, ToolCallSpec } from '../../types';

/**
 * buildMessages 派生视图单点（原生 function calling 迁移 T3，规格 §4.1）：
 * 链为唯一事实源，消息是本函数的派生视图——任何进模型上下文的动态都经链行尾追承载，
 * 本函数只做「链序列 → 消息序列」的确定性映射，禁时变字段、禁对同一输入产生不同输出。
 *
 * 链行动作词汇（T4 接线约定）：
 * - task      → user（指令行：任务/plan 步/goal）
 * - reply     → assistant（收束正文）
 * - phase     → 待挂旁白：并入下一个工具批的 assistant content（无批则在链尾降级为纯 content assistant 消息）
 * - tool-call → 工具调用行（formatToolCallLine 单行格式）；连续行聚合为一个批 → assistant+tool_calls（id 按序合成 call_N）
 * - tool-result → 观察行 → role:'tool' 按序配对（toolCallId 对应批内调用）；无批可挂时降级 user
 * - notice/note/deficit/node 及其他未登记动作 → user 元信息消息
 *
 * id 合成口径：端点只要求 role:'tool' 消息内 tool_call_id 与前序 assistant.tool_calls[].id 自洽，
 * 不要求复现端点原 id；按全链序 running 计数（call_1, call_2, …）保证「链尾追一行 → 既有 id 零位移」（前缀稳定）。
 */

/** 链行动作词汇（T4 写入方按此登记；本单点为唯一权威） */
export const PHASE_ACTION = 'phase';
export const TOOL_CALL_ACTION = 'tool-call';
export const TOOL_RESULT_ACTION = 'tool-result';

/** 工具调用行的单行格式：`[tool] <name> <args-json>`（args 须为紧凑 JSON——JSON.stringify 无字面换行） */
export function formatToolCallLine(name: string, argsJson: string): string {
  return `[tool] ${name} ${argsJson}`;
}

/** 解析调用行为 {name, argsJson}；不合规行回 null（调用方降级 user 元信息） */
function parseToolCallLine(observation: string): { name: string; argsJson: string } | null {
  const prefix = '[tool] ';
  if (!observation.startsWith(prefix)) return null;
  const rest = observation.slice(prefix.length);
  const sp = rest.indexOf(' ');
  if (sp <= 0) return null;
  return { name: rest.slice(0, sp), argsJson: rest.slice(sp + 1) };
}

export interface BuildMessagesInput {
  /** 稳定段全文（身份/输出约定/工具选择政策/工作目录；system#1，逐字节冻结） */
  stableSegment: string;
  /** 会话冻结快照条目（SUNSHINE/技能清单/记忆索引；合并为 system#2 单条，刷新点语义在调用方） */
  snapshot: ContextItem[];
  /** 压缩块（唯一合法重写产物；每条一条 user 消息） */
  compacted: ContextItem[];
  /** 会话链（唯一事实源） */
  chain: HistoryStep[];
  /** 待置尾技能块（skillRef 消费即清语义由调用方持有） */
  pendingSkill?: string | null;
}

/** 链序列 → 消息序列（确定性纯函数；相邻调用仅尾部增长——前缀稳定回归钉子见 messages.test.ts） */
export function buildMessages(input: BuildMessagesInput): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: input.stableSegment }];
  if (input.snapshot.length > 0) {
    msgs.push({ role: 'system', content: input.snapshot.map((s) => s.content).join('\n') });
  }
  for (const c of input.compacted) {
    msgs.push({ role: 'user', content: c.content });
  }

  let callSeq = 0;
  let pendingPhase: string | null = null;
  let batch: { calls: ToolCallSpec[]; consumed: number } | null = null;

  const flushBatch = (): void => {
    if (batch === null) return;
    msgs.push({ role: 'assistant', content: pendingPhase ?? '', toolCalls: batch.calls });
    pendingPhase = null;
    batch = null;
  };

  for (const row of input.chain) {
    const action = row.action;
    if (action === TOOL_CALL_ACTION) {
      // 同批并行：上一批已有结果回填即闭合，另起新批
      if (batch !== null && batch.consumed > 0) flushBatch();
      const parsed = parseToolCallLine(row.observation);
      if (parsed === null) {
        flushBatch();
        msgs.push({ role: 'user', content: row.observation });
        continue;
      }
      callSeq += 1;
      batch = batch ?? { calls: [], consumed: 0 };
      batch.calls.push({ id: `call_${callSeq}`, name: parsed.name, argsJson: parsed.argsJson });
      continue;
    }
    if (action === TOOL_RESULT_ACTION) {
      if (batch !== null && batch.consumed < batch.calls.length) {
        const id = batch.calls[batch.consumed].id;
        batch.consumed += 1;
        msgs.push({ role: 'tool', content: row.observation, toolCallId: id });
        continue;
      }
      flushBatch();
      msgs.push({ role: 'user', content: row.observation });
      continue;
    }
    if (action === PHASE_ACTION) {
      flushBatch();
      pendingPhase = row.observation;
      continue;
    }
    // task/reply/notice/note/deficit/node 及未登记动作：批先闭合，reply→assistant，其余（含指令与元信息行）→user
    flushBatch();
    if (action === 'reply') {
      msgs.push({ role: 'assistant', content: row.observation });
    } else {
      msgs.push({ role: 'user', content: row.observation });
    }
  }
  flushBatch();
  // 链尾仍挂着的旁白（phase 后无任何批）：纯 content assistant 消息承载
  if (pendingPhase !== null) {
    msgs.push({ role: 'assistant', content: pendingPhase });
    pendingPhase = null;
  }
  if (input.pendingSkill != null && input.pendingSkill !== '') {
    msgs.push({ role: 'user', content: `[skill] ${input.pendingSkill}` });
  }
  return msgs;
}
