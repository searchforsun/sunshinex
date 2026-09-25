import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, formatToolCallLine } from './messages';
import type { ChatMessage } from '../../types';

/**
 * wire 序不变量（OpenAI function calling 协议序）：assistant(tool_calls) 消息必须先于其配对的
 * role:'tool' 消息出现；工具结果绝不允许排在产生它的 assistant 调用消息之前。
 * 全链序上任何一个批（tool-call 行…tool-result 行交替）都须映射为
 * [assistant(tool_calls), tool, tool, …] 的相对次序。
 *
 * 症状对应：phase 旁白行（模型的「好的，我重试…」自述）插在 tool-call 行之前时，
 * phase 应并入本批 assistant content，而不是把本批 tool_calls 拆到 tool 消息之后——
 * 拆序后端点侧模型上下文即错乱（工具结果被当作无来源输入、模型以对话口吻回「好的收到」并空转重试）。
 */

function wireOrder(msgs: ChatMessage[]): string[] {
  return msgs.map((m) => (m.role === 'tool' ? `tool(${m.toolCallId})` : m.role));
}

test('wire 序：批内次序恒为 assistant(tool_calls) 先于其 role:tool 配对消息', () => {
  const msgs = buildMessages({
    stableSegment: 'S',
    snapshot: [],
    compacted: [],
    chain: [
      { action: 'task', step: 0, observation: 'list deps' },
      { action: 'phase', step: 0, observation: 'Retrying directory listing.' },
      { action: 'tool-call', step: 0, observation: formatToolCallLine('exec', '{"command":"echo a && ls"}') },
      { action: 'tool-result', step: 0, observation: '=== root ===' },
      { action: 'tool-call', step: 0, observation: formatToolCallLine('exec', '{"command":"ls"}') },
      { action: 'tool-result', step: 0, observation: 'file.java' },
      { action: 'reply', step: 0, observation: 'done' },
    ],
  });
  const order = wireOrder(msgs);
  // 任一 role:tool 消息之前必须已出现携带其 toolCallId 的 assistant(tool_calls) 消息
  const seenCalls = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'assistant' && m.toolCalls) for (const t of m.toolCalls) seenCalls.add(t.id);
    if (m.role === 'tool') {
      assert.ok(seenCalls.has(m.toolCallId), `role:tool(${m.toolCallId}) 出现在其 assistant(tool_calls) 之前——wire 序违规`);
    }
  }
  // 具体形态：批1 assistant+tool 先于批1 tool；phase 并入批1 content
  assert.deepEqual(order.slice(2, 5), ['assistant', 'tool(call_1)', 'assistant'], '批间不拆序');
});

test('孤立 tool-result（无批可挂）降级 user 属合法回退、不产生孤儿 tool 消息', () => {
  const msgs = buildMessages({
    stableSegment: 'S',
    snapshot: [],
    compacted: [],
    chain: [
      { action: 'task', step: 0, observation: 't' },
      { action: 'tool-result', step: 0, observation: 'orphan observation' },
    ],
  });
  assert.ok(!msgs.some((m) => m.role === 'tool'), '无来源的观察行不得映射为 role:tool');
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content, 'orphan observation');
});
