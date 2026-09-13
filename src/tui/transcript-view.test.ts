import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatItem } from './session';
import { buildTranscriptDecisions } from './transcript-view';

let seq = 0;
const item = (role: ChatItem['role'], text: string, extra?: Partial<ChatItem>): ChatItem => ({
  role,
  text,
  ts: 0,
  seq: ++seq,
  ...extra,
});

test('锚点分组：默认态最近锚点组全行、历史组折叠为首个工具调用对', () => {
  const messages = [
    item('user', '调研'),
    item('step', '检索阶段'),
    item('tool', 'READ a.txt', { kind: 'call' }),
    item('tool', 'ok', { kind: 'result', ok: true }),
    item('tool', 'READ b.txt', { kind: 'call' }),
    item('tool', 'ok2', { kind: 'result', ok: true }),
    item('step', '汇总阶段'),
    item('assistant', '结论正文'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(d[0].visible, '序组（用户输入）不受折叠影响');
  assert.ok(d[1].visible && d[6].visible, '▶ 阶段行恒可见（锚点标识）');
  assert.ok(d[2].visible && d[3].visible, '历史组保留首个工具调用对');
  assert.ok(!d[4].visible && !d[5].visible, '历史组非首个动作折叠隐藏');
  assert.ok(d[7].visible, '最近锚点正文恒可见');
  assert.ok(!d[2].full && !d[4].full, 'latestFull=false 时内容保持摘要');
});

test('锚点分组：Tab 只切行维度，Ctrl+O 只切最近锚点组内容深度，两键正交', () => {
  const messages = [
    item('step', '检索'), // g0
    item('tool', 'READ a.txt', { kind: 'call' }), // 首个调用：保留
    item('tool', 'r1', { kind: 'result', ok: true, detail: '全文A' }),
    item('tool', 'READ c.txt', { kind: 'call' }), // 非首个：折叠
    item('tool', 'r3', { kind: 'result', ok: true, detail: '全文C' }),
    item('thinking', 'Thought for 1s', { detail: '思考全文' }), // 首个思考：保留
    item('step', '汇总'), // g1（最近锚点组）
    item('tool', 'READ b.txt', { kind: 'call' }),
    item('tool', 'r2', { kind: 'result', ok: true, detail: '全文B' }),
    item('thinking', 'Thought for 2s', { detail: '思考全文B' }),
    item('assistant', '结论'),
  ];
  const collapsed = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(!collapsed[3].visible && !collapsed[4].visible, '历史组非首个动作隐藏');
  assert.ok(collapsed[1].visible && collapsed[2].visible && collapsed[5].visible, '历史组保留首个工具调用对与首个思考行');
  assert.ok(collapsed[7].visible && collapsed[8].visible && collapsed[9].visible, '最近锚点组全行');
  assert.ok(!collapsed[5].full && !collapsed[8].full, '默认内容全部摘要');

  const expanded = buildTranscriptDecisions(messages, { expandAll: true, latestFull: false });
  assert.ok(expanded[3].visible && expanded[4].visible, 'Tab 后历史组全部动作可见');
  assert.ok(!expanded[5].full && !expanded[8].full, 'Tab 仅行维度，内容仍摘要');

  const deep = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(!deep[3].visible, 'latestFull 不解除行折叠（正交）');
  assert.ok(deep[8].full && deep[9].full, '最近锚点组思考与工具结果全文');
  assert.ok(!deep[5].full, '历史组内容不随 latestFull 展开');

  const both = buildTranscriptDecisions(messages, { expandAll: true, latestFull: true });
  assert.ok(both[3].visible && both[8].full, '两键叠加：全行 + 最近锚点组全文');
  assert.ok(!both[5].full, '历史组内容仍摘要（latestFull 作用域仅最近锚点组）');
});

test('锚点分组：进行中阶段（正文未出）保持全行，新阶段开始自动收拢上一阶段', () => {
  const messages = [
    item('step', '阶段一'), // g0
    item('tool', 'READ a.txt', { kind: 'call' }),
    item('tool', 'r1', { kind: 'result', ok: true, detail: '全文A' }),
    item('tool', 'READ c.txt', { kind: 'call' }),
    item('tool', 'r3', { kind: 'result', ok: true, detail: '全文C' }),
    item('assistant', '阶段一正文'),
    item('step', '阶段二'), // g1（最近锚点组）
    item('tool', 'READ b.txt', { kind: 'call' }),
    item('tool', 'r2', { kind: 'result', ok: true, detail: '全文B' }),
    item('tool', 'READ d.txt', { kind: 'call' }),
    item('tool', 'r4', { kind: 'result', ok: true, detail: '全文D' }),
    item('assistant', '阶段二正文'),
    item('step', '阶段三'), // g2（进行中，正文未出）
    item('tool', 'READ e.txt', { kind: 'call' }),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: false });
  assert.ok(!d[3].visible && !d[4].visible, '上一阶段（g0）非首个动作在锚点出现后自动收拢');
  assert.ok(d[1].visible && d[2].visible && d[5].visible, '上一阶段保留首个工具对与正文');
  assert.ok(d[7].visible && d[9].visible && d[11].visible, '最近锚点组（g1）全行');
  assert.ok(d[12].visible && d[13].visible, '进行中组（g2）不折叠——流式动作行不消失');
  const d2 = buildTranscriptDecisions(messages, { expandAll: true, latestFull: false });
  assert.ok(d2[3].visible && d2[4].visible, 'Tab 后上一阶段折叠的动作全部可见');
});

test('锚点分组：无阶段行时退化为 expandAll 口径，latestFull 无作用域', () => {
  const messages = [
    item('user', '读文件'),
    item('tool', 'READ a.txt', { kind: 'call' }),
    item('tool', 'ok', { kind: 'result', ok: true, detail: '全文' }),
    item('assistant', '答复'),
  ];
  const d = buildTranscriptDecisions(messages, { expandAll: false, latestFull: true });
  assert.ok(d[1].visible && d[2].visible, '无组不隐藏行');
  assert.ok(!d[2].full, '无组时 latestFull 不生效');
  const d2 = buildTranscriptDecisions(messages, { expandAll: true, latestFull: false });
  assert.ok(d2[2].full, 'expandAll 展开摘要（单步任务既有语义）');
});
