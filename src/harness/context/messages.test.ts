import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, formatToolCallLine, TOOL_CALL_ACTION, TOOL_RESULT_ACTION, PHASE_ACTION } from './messages';
import type { ContextItem, HistoryStep, ChatMessage } from '../../types';

/**
 * T3（原生 function calling 迁移）buildMessages 派生视图红灯（规格 §4.1 消息序列映射）：
 * ①system#1=稳定段逐字节冻结；system#2=会话冻结快照单条（SUNSHINE/技能清单/记忆索引合并，刷新点语义在调用方）
 * ②链行→消息全分支：task→user；reply→assistant；notice/note/deficit/node→user 元信息行；
 *   phase 行→pending 旁白（并入后续 assistant content）；tool-call 连续批→assistant+tool_calls（id 按序合成 call_N，
 *   端点只要求消息内自洽）；tool-result→role:tool 按序配对；孤立观察行（过渡期现行形态）降级 user 不炸
 * ③压缩块=单条 user 且折叠其后旧消息（不双份钉子）；技能块=置尾 user（[skill] 前缀）
 * ④前缀稳定钉子：链尾追一行→消息序列仅尾部增长（序列化逐字节前缀）；fork 首帧=主链末帧严格前缀
 */

const STABLE = 'You are the SunshineX agent: complete tasks by calling tools.';

function chain(rows: Array<Omit<HistoryStep, 'step'> & { step?: number }>): HistoryStep[] {
  return rows.map((r, i) => ({ step: r.step ?? i + 1, action: r.action, observation: r.observation }));
}

function serialize(msgs: ChatMessage[]): string {
  // 逐消息序列化后拼接：消息级前缀稳定才是真实不变量（整串拼接时尾部 ] 恒被改写，非产品缺陷信号）
  return msgs.map((m) => JSON.stringify(m)).join('\n');
}

test('空链：仅 system#1（稳定段原样单条）', () => {
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain: [] });
  assert.deepEqual(msgs, [{ role: 'system', content: STABLE }]);
});

test('快照合并为 system#2 单条；task 指令行→user；reply→assistant', () => {
  const snapshot: ContextItem[] = [
    { kind: 'system', content: 'SUNSHINE.md entries' },
    { kind: 'memory', content: '[memory] index' },
  ];
  const msgs = buildMessages({
    stableSegment: STABLE,
    snapshot,
    compacted: [],
    chain: chain([
      { action: 'task', observation: 'Current instruction: fix the bug' },
      { action: 'reply', observation: 'All done, bug fixed.' },
    ]),
  });
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs[0], { role: 'system', content: STABLE });
  assert.equal(msgs[1].role, 'system');
  assert.equal(msgs[1].content, 'SUNSHINE.md entries\n[memory] index');
  assert.deepEqual(msgs[2], { role: 'user', content: 'Current instruction: fix the bug' });
  assert.deepEqual(msgs[3], { role: 'assistant', content: 'All done, bug fixed.' });
});

test('notice/note/deficit/node 行→user 元信息消息', () => {
  const msgs = buildMessages({
    stableSegment: STABLE,
    snapshot: [],
    compacted: [],
    chain: chain([
      { action: 'notice', observation: '[memory] index changed' },
      { action: 'note', observation: 'Task ended without completion (deadline)' },
      { action: 'deficit', observation: '- still failing: test x' },
      { action: 'node', observation: '[reviewer] looks good' },
    ]),
  });
  assert.equal(msgs.length, 5);
  for (const m of msgs.slice(1)) {
    assert.equal(m.role, 'user');
  }
});

test('tool-call 批→assistant+tool_calls（id 按序合成）；tool-result→role:tool 按序配对；phase 行并入 assistant content', () => {
  const msgs = buildMessages({
    stableSegment: STABLE,
    snapshot: [],
    compacted: [],
    chain: chain([
      { action: 'task', observation: 'Current instruction: do it' },
      { action: PHASE_ACTION, observation: 'Reading the config files' },
      { action: TOOL_CALL_ACTION, observation: formatToolCallLine('read', '{"path":"a.ts"}') },
      { action: TOOL_CALL_ACTION, observation: formatToolCallLine('grep', '{"pattern":"x"}') },
      { action: TOOL_RESULT_ACTION, observation: 'file contents here' },
      { action: TOOL_RESULT_ACTION, observation: 'match at line 3' },
    ]),
  });
  const assistant = msgs.find((m) => m.role === 'assistant');
  assert.ok(assistant, 'assistant message with tool_calls must exist');
  if (assistant.role !== 'assistant') return;
  assert.equal(assistant.content, 'Reading the config files');
  assert.deepEqual(assistant.toolCalls, [
    { id: 'call_1', name: 'read', argsJson: '{"path":"a.ts"}' },
    { id: 'call_2', name: 'grep', argsJson: '{"pattern":"x"}' },
  ]);
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs, [
    { role: 'tool', content: 'file contents here', toolCallId: 'call_1' },
    { role: 'tool', content: 'match at line 3', toolCallId: 'call_2' },
  ]);
});

test('孤立观察行（过渡期现行形态，无前置 tool-call 批）降级 user 不炸', () => {
  const msgs = buildMessages({
    stableSegment: STABLE,
    snapshot: [],
    compacted: [],
    chain: chain([{ action: 'read', observation: 'file contents here' }]),
  });
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[1], { role: 'user', content: 'file contents here' });
});

test('压缩块=单条 user，且压缩后链切片不再出现（不双份）', () => {
  const compacted: ContextItem[] = [{ kind: 'system', content: '[Compacted summary checksum=abc] goals...' }];
  const msgs = buildMessages({
    stableSegment: STABLE,
    snapshot: [],
    compacted,
    chain: chain([{ action: 'task', observation: 'Current instruction: next' }]),
  });
  const comp = msgs.filter((m) => m.role === 'user' && m.content.startsWith('[Compacted summary'));
  assert.equal(comp.length, 1);
  assert.equal(msgs.filter((m) => m.role === 'system').length, 1, '压缩块不得混入 system#2');
});

test('技能块置尾：user（[skill] 前缀）位于消息序列末尾', () => {
  const msgs = buildMessages({
    stableSegment: STABLE,
    snapshot: [],
    compacted: [],
    chain: chain([{ action: 'task', observation: 'Current instruction: go' }]),
    pendingSkill: 'skill body here',
  });
  const last = msgs[msgs.length - 1];
  assert.deepEqual(last, { role: 'user', content: '[skill] skill body here' });
});

test('前缀稳定钉子：链尾追一行→消息序列仅尾部增长（序列化严格前缀）', () => {
  const base = {
    stableSegment: STABLE,
    snapshot: [{ kind: 'system' as const, content: 'snapshot text' }],
    compacted: [],
    chain: chain([
      { action: 'task', observation: 'Current instruction: go' },
      { action: TOOL_CALL_ACTION, observation: formatToolCallLine('read', '{"path":"a"}') },
      { action: TOOL_RESULT_ACTION, observation: 'contents' },
    ]),
  };
  const extended = { ...base, chain: [...base.chain, { step: 4, action: 'reply', observation: 'done reply' }] };
  const s1 = serialize(buildMessages(base));
  const s2 = serialize(buildMessages(extended));
  assert.ok(s2.startsWith(s1), 'first diff point must fall in the tail-appended segment');
  assert.ok(s2.length > s1.length);
});

test('fork 首帧=主链末帧（消息边界严格前缀）', () => {
  const mainChain = chain([
    { action: 'task', observation: 'Current instruction: main task' },
    { action: 'reply', observation: 'step reply' },
  ]);
  const forkSeed = { stableSegment: STABLE, snapshot: [], compacted: [], chain: mainChain };
  const forkFrame = { ...forkSeed, chain: [...mainChain, { step: 3, action: 'node', observation: '[child] private steps are not here' }] };
  const s1 = serialize(buildMessages(forkSeed));
  const s2 = serialize(buildMessages(forkFrame));
  assert.ok(s2.startsWith(s1), 'fork first frame must be a strict prefix of the main-chain frame');
});

test('formatToolCallLine：单行安全（argsJson 无字面换行），解析往返一致', () => {
  const line = formatToolCallLine('write', '{"path":"a","content":"line1\\nline2"}');
  assert.ok(!line.includes('\n'), 'call line must stay single-line');
  const rest = line.slice('[tool] '.length);
  const sp = rest.indexOf(' ');
  assert.equal(rest.slice(0, sp), 'write');
  assert.equal(JSON.parse(rest.slice(sp + 1)).content, 'line1\nline2');
});
